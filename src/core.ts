import { existsSync, readFileSync } from "node:fs";
import { open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const DEFAULT_PROVIDER = "lmstudio";
export const DEFAULT_LOCK_FILENAME = "local-model-harness.lock";
export const DEFAULT_WATCHDOG_THRESHOLD_PERCENT = 80;
export const WATCHDOG_RESUME_MARGIN_PERCENT = 10;
export const DEFAULT_LOOP_WINDOW = 3;
export const DEFAULT_LOCAL_BASE_URL = "http://localhost:1234/v1";

export type ProtocolLanguage = "en" | "zh";

export type HarnessConfig = {
	provider: string;
	models: string[];
	lockPath: string;
	watchdogEnabled: boolean;
	watchdogThresholdPercent: number;
	loopGuardEnabled: boolean;
	loopGuardWindow: number;
	protocolLanguage: ProtocolLanguage;
	gateEnabled: boolean;
};

export type ConfigLoadResult =
	| { ok: true; config: HarnessConfig; path: string }
	| { ok: false; reason: string; path: string };

export function defaultConfigPath(): string {
	return join(homedir(), ".pi", "agent", "local-model-harness.json");
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return isAbsolute(path) ? path : resolve(path);
}

function readSection(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function loadHarnessConfig(path: string = defaultConfigPath()): ConfigLoadResult {
	if (!existsSync(path)) {
		return {
			ok: false,
			path,
			reason: `Config file not found at ${path}. Create it with a "models" array of managed model IDs (see local-model-harness.example.json).`,
		};
	}

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return { ok: false, path, reason: `Config is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, path, reason: "Config root must be a JSON object." };
	}

	const root = raw as Record<string, unknown>;

	const provider = root.provider ?? DEFAULT_PROVIDER;
	if (typeof provider !== "string" || !provider.trim()) {
		return { ok: false, path, reason: '"provider" must be a non-empty string.' };
	}

	const models = root.models;
	if (!Array.isArray(models) || models.length === 0 || !models.every((model) => typeof model === "string" && model.trim().length > 0)) {
		return { ok: false, path, reason: '"models" must be a non-empty array of model ID strings.' };
	}

	const lockPath = typeof root.lockPath === "string" && root.lockPath.trim().length > 0
		? expandHome(root.lockPath.trim())
		: join(homedir(), ".pi", "agent", DEFAULT_LOCK_FILENAME);

	const watchdog = readSection(root.contextWatchdog);
	const watchdogEnabled = typeof watchdog.enabled === "boolean" ? watchdog.enabled : true;
	const watchdogThresholdPercent = typeof watchdog.thresholdPercent === "number" && Number.isFinite(watchdog.thresholdPercent)
		? Math.min(95, Math.max(10, watchdog.thresholdPercent))
		: DEFAULT_WATCHDOG_THRESHOLD_PERCENT;

	const loopGuard = readSection(root.loopGuard);
	const loopGuardEnabled = typeof loopGuard.enabled === "boolean" ? loopGuard.enabled : true;
	const loopGuardWindow = typeof loopGuard.window === "number" && Number.isInteger(loopGuard.window) && loopGuard.window >= 2
		? loopGuard.window
		: DEFAULT_LOOP_WINDOW;

	const protocolLanguage: ProtocolLanguage = root.protocolLanguage === "zh" ? "zh" : "en";

	const gate = readSection(root.gate);
	const gateEnabled = typeof gate.enabled === "boolean" ? gate.enabled : true;

	return {
		ok: true,
		path,
		config: {
			provider: provider.trim(),
			models: [...new Set(models.map((model) => (model as string).trim()))],
			lockPath,
			watchdogEnabled,
			watchdogThresholdPercent,
			loopGuardEnabled,
			loopGuardWindow,
			protocolLanguage,
			gateEnabled,
		},
	};
}

export type ModelReference = {
	provider?: unknown;
	id?: unknown;
};

export type ToolProbeResult =
	| { ok: true }
	| { ok: false; reason: string };

export function isManagedLocalModel(model: ModelReference | undefined, config: HarnessConfig): boolean {
	return model?.provider === config.provider
		&& typeof model.id === "string"
		&& config.models.includes(model.id);
}

const PROTOCOL_EN = `
## Local Coding Protocol
- Read project instructions and relevant code before editing.
- For non-trivial work, state a short plan before changing files.
- Make the smallest change that satisfies the request; preserve existing user changes.
- Run the smallest relevant verification after changes.
- Inspect the diff before reporting completion.
- Diagnose failed verification before changing code again.
- State clearly when verification was not run.
- Reply to the user in the language the user is using.
`.trim();

const PROTOCOL_ZH = `
## 本地编码协议
- 编辑前先阅读项目说明和相关代码。
- 非平凡任务，修改文件前先给出简短计划。
- 做满足需求的最小改动；保留用户已有的修改。
- 修改后运行最小相关验证。
- 报告完成前检查 diff。
- 验证失败先诊断原因，再改代码。
- 没有运行验证时必须明确说明。
- 用用户使用的语言回复。
`.trim();

export function buildCodingProtocol(language: ProtocolLanguage = "en"): string {
	return language === "zh" ? PROTOCOL_ZH : PROTOCOL_EN;
}

export type TelemetrySnapshot = {
	model: string;
	durationMs: number;
	providerRequests: number;
	lockWaitMs: number;
	lockWaits: number;
	lockWaitMaxMs: number;
	toolCalls: number;
	toolErrors: number;
	toolErrorsByTool: Record<string, number>;
	changedFiles: string[];
	verificationPending: boolean;
	verificationCommands: string[];
	contextPeakPercent: number | null;
	compactions: number;
	loopInterventions: number;
	watchdogCompactions: number;
};

const VERIFICATION_COMMANDS = [
	/(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|build)\b/,
	/(?:^|\s)(?:vitest|jest|pytest|ruff)\b/,
	/(?:^|\s)cargo\s+(?:test|clippy)\b/,
	/(?:^|\s)go\s+test\b/,
	/(?:^|\s)tsc\b/,
];

export function isVerificationCommand(command: string): boolean {
	return VERIFICATION_COMMANDS.some((pattern) => pattern.test(command));
}

export class SessionTelemetry {
	private readonly startedAt: number;
	private model: string;
	private providerRequests = 0;
	private lockWaitMs = 0;
	private lockWaits = 0;
	private lockWaitMaxMs = 0;
	private toolCalls = 0;
	private toolErrors = 0;
	private readonly toolErrorsByTool = new Map<string, number>();
	private readonly changedFiles = new Set<string>();
	private verificationPending = false;
	private readonly verificationCommands: string[] = [];
	private contextPeakPercent: number | null = null;
	private compactions = 0;
	private loopInterventions = 0;
	private watchdogCompactions = 0;

	constructor(model = "unknown model", startedAt = Date.now()) {
		this.model = model;
		this.startedAt = startedAt;
	}

	setModel(model: string): void {
		this.model = model;
	}

	recordProviderRequest(lockWaitMs: number): void {
		this.providerRequests++;
		const normalized = Math.max(0, Math.round(lockWaitMs));
		this.lockWaitMs += normalized;
		if (normalized >= 500) this.lockWaits++;
		this.lockWaitMaxMs = Math.max(this.lockWaitMaxMs, normalized);
	}

	recordToolResult(toolName: string, input: Record<string, unknown>, isError: boolean): void {
		this.toolCalls++;
		if (isError) {
			this.toolErrors++;
			this.toolErrorsByTool.set(toolName, (this.toolErrorsByTool.get(toolName) ?? 0) + 1);
		}

		if ((toolName === "edit" || toolName === "write") && !isError && typeof input.path === "string") {
			this.changedFiles.add(input.path);
			this.verificationPending = true;
		}

		if (toolName === "bash" && !isError && typeof input.command === "string" && isVerificationCommand(input.command)) {
			this.verificationCommands.push(input.command);
			this.verificationPending = false;
		}
	}

	recordContextPercent(percent: number | null | undefined): void {
		if (percent == null || !Number.isFinite(percent)) return;
		const normalized = Math.round(Math.max(0, percent) * 10) / 10;
		this.contextPeakPercent = this.contextPeakPercent == null
			? normalized
			: Math.max(this.contextPeakPercent, normalized);
	}

	recordCompaction(): void {
		this.compactions++;
	}

	recordLoopIntervention(): void {
		this.loopInterventions++;
	}

	recordWatchdogCompaction(): void {
		this.watchdogCompactions++;
	}

	snapshot(now = Date.now()): TelemetrySnapshot {
		const toolErrorsByTool: Record<string, number> = {};
		for (const [tool, count] of [...this.toolErrorsByTool.entries()].sort((a, b) => b[1] - a[1])) {
			toolErrorsByTool[tool] = count;
		}
		return {
			model: this.model,
			durationMs: Math.max(0, now - this.startedAt),
			providerRequests: this.providerRequests,
			lockWaitMs: this.lockWaitMs,
			lockWaits: this.lockWaits,
			lockWaitMaxMs: this.lockWaitMaxMs,
			toolCalls: this.toolCalls,
			toolErrors: this.toolErrors,
			toolErrorsByTool,
			changedFiles: [...this.changedFiles].sort(),
			verificationPending: this.verificationPending,
			verificationCommands: [...this.verificationCommands],
			contextPeakPercent: this.contextPeakPercent,
			compactions: this.compactions,
			loopInterventions: this.loopInterventions,
			watchdogCompactions: this.watchdogCompactions,
		};
	}
}

export type TaskContract = {
	intent: string;
	scope: string[];
	doneWhen: string[];
	verificationPlan: string[];
	unresolved: string[];
};

export type TaskCompletionResult = {
	ok: boolean;
	missingConditions: string[];
};

export type TaskCompletionSnapshot = {
	intent: string | null;
	scope: string[];
	doneWhen: string[];
	mutationToolCalls: string[];
	completed: boolean;
	missingConditions: string[];
};

function isReadOnlyBashSegment(segment: string): boolean {
	if (!segment) return false;
	if (/^find\b/.test(segment) && /-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/.test(segment)) return false;

	return /^(?:pwd|command\s+-v\b|which\b|type\b|test\b|git\s+(?:status|diff|log|show)\b|git\s+branch\s+--show-current\b|npm\s+(?:list|view|config\s+get)\b|(?:ls|rg|grep|cat|head|tail|find|wc|sort|uniq)\b)/.test(segment);
}

function isReadOnlyBashCommand(command: string): boolean {
	const normalized = command.trim();
	if (!normalized) return false;
	if (/[;&`]|>>?|<|\$\(|\|\||&&/.test(normalized)) return false;

	const segments = normalized.split("|").map((segment) => segment.trim());
	return segments.length > 0 && segments.every((segment) => isReadOnlyBashSegment(segment));
}

export function buildContractBlockReason(language: ProtocolLanguage = "en"): string {
	if (language === "zh") {
		return `[local-model-harness] 状态变更前需要先建立任务契约。请先调用 task_contract 工具，例如：
task_contract({
  intent: "<用户最终想要的结果>",
  scope: ["<允许触碰的文件/资源>"],
  doneWhen: ["<可观察的最终状态>"],
  verificationPlan: ["<每个 doneWhen 对应的只读检查方法>"],
  unresolved: []
})
契约建立后继续原来的操作即可。只读操作（read/grep/ls/git status 等）不需要契约。`;
	}
	return `[local-model-harness] Task contract required before state changes. Call the task_contract tool first, for example:
task_contract({
  intent: "<what the user ultimately wants>",
  scope: ["<files/resources you may touch>"],
  doneWhen: ["<observable end states>"],
  verificationPlan: ["<read-only check for each doneWhen>"],
  unresolved: []
})
Then continue with the original operation. Read-only actions (read/grep/ls/git status...) never need a contract.`;
}

export const CONTRACT_GATE_STEER_AFTER = 3;
export const CONTRACT_GATE_NOTIFY_AFTER = 6;

export type ContractGateEscalation = {
	blocks: number;
	steer: boolean;
	notify: boolean;
};

export class ContractGate {
	private blocks = 0;

	constructor(
		private readonly steerAfter: number = CONTRACT_GATE_STEER_AFTER,
		private readonly notifyAfter: number = CONTRACT_GATE_NOTIFY_AFTER,
	) {}

	reset(): void {
		this.blocks = 0;
	}

	get blockCount(): number {
		return this.blocks;
	}

	recordBlock(): ContractGateEscalation {
		this.blocks++;
		return {
			blocks: this.blocks,
			steer: this.blocks === this.steerAfter,
			notify: this.blocks === this.notifyAfter,
		};
	}
}

export function buildGateSteerMessage(blocks: number, language: ProtocolLanguage = "en"): string {
	if (language === "zh") {
		return `[local-model-harness] 本会话已有 ${blocks} 次状态变更调用因缺少任务契约被拦截。请立即调用 task_contract（intent/scope/doneWhen/verificationPlan/unresolved）建立契约，然后继续任务；不要再尝试绕过。只读操作不受影响。`;
	}
	return `[local-model-harness] ${blocks} state-changing calls have been blocked in this session for missing a task contract. Call task_contract now (intent/scope/doneWhen/verificationPlan/unresolved), then continue the task; do not try to work around the gate. Read-only actions are unaffected.`;
}

export function isStateChangingTool(toolName: string, input: Record<string, unknown>): boolean {
	if (["read", "grep", "find", "ls", "task_contract", "task_verify", "task_complete"].includes(toolName)) return false;
	if (toolName !== "bash") return true;
	return typeof input.command !== "string" || !isReadOnlyBashCommand(input.command);
}

type TaskToolCall = {
	toolName: string;
	isStateChanging: boolean;
	order: number;
	succeeded: boolean;
};

export class TaskCompletionLedger {
	private contract: TaskContract | undefined;
	private readonly mutationToolCalls = new Set<string>();
	private readonly toolCalls = new Map<string, TaskToolCall>();
	private readonly verifiedConditions = new Map<string, string>();
	private completed = false;
	private missingConditions: string[] = [];
	private nextToolCallOrder = 0;
	private lastMutationOrder = 0;

	setContract(contract: TaskContract): { ok: boolean; reason?: string } {
		const normalized = {
			intent: contract.intent.trim(),
			scope: contract.scope.map((value) => value.trim()).filter(Boolean),
			doneWhen: contract.doneWhen.map((value) => value.trim()).filter(Boolean),
			verificationPlan: contract.verificationPlan.map((value) => value.trim()).filter(Boolean),
			unresolved: contract.unresolved.map((value) => value.trim()).filter(Boolean),
		};
		if (!normalized.intent || normalized.scope.length === 0 || normalized.doneWhen.length === 0 || normalized.verificationPlan.length === 0) {
			return { ok: false, reason: "Task contract requires intent, scope, doneWhen, and verificationPlan." };
		}
		if (normalized.unresolved.length > 0) return { ok: false, reason: "Task contract has unresolved items." };
		if (new Set(normalized.doneWhen).size !== normalized.doneWhen.length) {
			return { ok: false, reason: "Task contract doneWhen conditions must be unique." };
		}
		this.contract = normalized;
		this.completed = false;
		this.verifiedConditions.clear();
		this.missingConditions = [...normalized.doneWhen];
		return { ok: true };
	}

	needsContractFor(toolName: string, input: Record<string, unknown>): boolean {
		return !this.contract && isStateChangingTool(toolName, input);
	}

	recordToolCall(toolCallId: string, toolName: string, input: Record<string, unknown>): void {
		const isStateChanging = isStateChangingTool(toolName, input);
		const order = ++this.nextToolCallOrder;
		this.toolCalls.set(toolCallId, { toolName, isStateChanging, order, succeeded: false });
		if (isStateChanging) {
			this.mutationToolCalls.add(toolCallId);
			this.lastMutationOrder = order;
		}
	}

	recordToolResult(toolCallId: string, _toolName: string, _input: Record<string, unknown>, isError: boolean): void {
		const toolCall = this.toolCalls.get(toolCallId);
		if (toolCall && !isError) toolCall.succeeded = true;
	}

	verify(condition: string): { ok: boolean; reason?: string } {
		if (!this.contract) return { ok: false, reason: "No active task contract." };
		if (!this.contract.doneWhen.includes(condition)) return { ok: false, reason: "Unknown completion condition." };
		if (this.verifiedConditions.has(condition)) return { ok: true };
		const usedToolCalls = new Set(this.verifiedConditions.values());
		const candidate = [...this.toolCalls.entries()]
			.reverse()
			.find(([toolCallId, toolCall]) => (
				toolCall.succeeded
				&& !toolCall.isStateChanging
				&& toolCall.order > this.lastMutationOrder
				&& !["task_contract", "task_verify", "task_complete"].includes(toolCall.toolName)
				&& !usedToolCalls.has(toolCallId)
			));
		if (!candidate) return { ok: false, reason: "Run a successful read-only verification after the last state change first." };
		this.verifiedConditions.set(condition, candidate[0]);
		return { ok: true };
	}

	complete(): TaskCompletionResult {
		if (!this.contract) return { ok: false, missingConditions: ["task contract"] };
		this.missingConditions = this.contract.doneWhen.filter((condition) => !this.verifiedConditions.has(condition));
		this.completed = this.missingConditions.length === 0;
		return { ok: this.completed, missingConditions: [...this.missingConditions] };
	}

	snapshot(): TaskCompletionSnapshot {
		return {
			intent: this.contract?.intent ?? null,
			scope: this.contract?.scope ?? [],
			doneWhen: this.contract?.doneWhen ?? [],
			mutationToolCalls: [...this.mutationToolCalls],
			completed: this.completed,
			missingConditions: [...this.missingConditions],
		};
	}
}

export function formatTaskCompletionReport(snapshot: TaskCompletionSnapshot): string {
	if (!snapshot.intent) return "Task completion: not started";
	if (snapshot.completed) return `Task completion: completed (${snapshot.intent})`;
	return `Task completion: pending (${snapshot.missingConditions.join(", ")})`;
}

export function formatDuration(durationMs: number): string {
	if (!Number.isFinite(durationMs) || durationMs < 0) return "0m 0s";
	const seconds = Math.floor(durationMs / 1_000);
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatTelemetryReport(snapshot: TelemetrySnapshot): string {
	const changedFileLabel = `${snapshot.changedFiles.length} changed ${snapshot.changedFiles.length === 1 ? "file" : "files"}`;
	const verification = snapshot.verificationPending
		? `pending (${changedFileLabel})`
		: snapshot.verificationCommands.length > 0
			? `passed (${snapshot.verificationCommands.length} command${snapshot.verificationCommands.length === 1 ? "" : "s"})`
			: "not recorded";
	const contextPeak = snapshot.contextPeakPercent == null ? "not recorded" : `${snapshot.contextPeakPercent}%`;
	const errorBreakdown = Object.entries(snapshot.toolErrorsByTool)
		.map(([tool, count]) => `${tool} ${count}`)
		.join(", ");
	const toolErrors = snapshot.toolErrors > 0
		? `${snapshot.toolErrors} errors${errorBreakdown ? `: ${errorBreakdown}` : ""}`
		: "0 errors";
	const lockWait = snapshot.lockWaits > 0
		? `${snapshot.lockWaitMs}ms (${snapshot.lockWaits} wait${snapshot.lockWaits === 1 ? "" : "s"} >500ms, max ${snapshot.lockWaitMaxMs}ms)`
		: `${snapshot.lockWaitMs}ms`;

	return [
		`Model: ${snapshot.model}`,
		`Duration: ${formatDuration(snapshot.durationMs)}`,
		`Provider requests: ${snapshot.providerRequests}`,
		`Lock wait: ${lockWait}`,
		`Tool calls: ${snapshot.toolCalls} (${toolErrors})`,
		`Changed files: ${snapshot.changedFiles.length > 0 ? snapshot.changedFiles.join(", ") : "none"}`,
		`Verification: ${verification}`,
		`Context peak: ${contextPeak}`,
		`Compactions: ${snapshot.compactions} (${snapshot.watchdogCompactions} watchdog-triggered)`,
		`Loop interventions: ${snapshot.loopInterventions}`,
	].join("\n");
}

export function parseToolProbe(response: unknown, toolName: string): ToolProbeResult {
	const choices = (response as { choices?: unknown })?.choices;
	if (!Array.isArray(choices)) {
		return { ok: false, reason: "Response has no choices array." };
	}

	for (const choice of choices) {
		const toolCalls = (choice as { message?: { tool_calls?: unknown } })?.message?.tool_calls;
		if (!Array.isArray(toolCalls)) continue;
		if (toolCalls.some((call) => (call as { function?: { name?: unknown } })?.function?.name === toolName)) {
			return { ok: true };
		}
	}

	return { ok: false, reason: `No ${toolName} tool call in response.` };
}

function processExists(pid: unknown): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export type LockOwner = {
	pid: number;
	acquiredAt: string;
};

export class FileLeaseLock {
	private handle: Awaited<ReturnType<typeof open>> | undefined;

	constructor(private readonly path: string) {}

	static async peekOwner(path: string): Promise<LockOwner | null> {
		try {
			const owner = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown; acquiredAt?: unknown };
			if (typeof owner.pid !== "number") return null;
			return { pid: owner.pid, acquiredAt: typeof owner.acquiredAt === "string" ? owner.acquiredAt : "" };
		} catch {
			return null;
		}
	}

	async tryAcquire(): Promise<boolean> {
		if (this.handle) return true;

		try {
			this.handle = await open(this.path, "wx");
			await this.handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}

		try {
			const owner = JSON.parse(await readFile(this.path, "utf8")) as { pid?: unknown };
			if (processExists(owner.pid)) return false;
			await unlink(this.path);
			return this.tryAcquire();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.tryAcquire();
			return false;
		}
	}

	async release(): Promise<void> {
		if (!this.handle) return;
		await this.handle.close();
		this.handle = undefined;
		try {
			await unlink(this.path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

export function toolCallSignature(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "bash" && typeof input.command === "string") return `bash:${input.command.trim()}`;
	if (typeof input.path === "string") return `${toolName}:${input.path}`;
	let serialized: string;
	try {
		serialized = JSON.stringify(input) ?? "{}";
	} catch {
		serialized = "{}";
	}
	return `${toolName}:${serialized.slice(0, 200)}`;
}

export class LoopGuard {
	private recent: string[] = [];
	private readonly notified = new Set<string>();

	constructor(private readonly window: number = DEFAULT_LOOP_WINDOW) {}

	reset(): void {
		this.recent = [];
		this.notified.clear();
	}

	record(toolName: string, input: Record<string, unknown>): string | null {
		const signature = toolCallSignature(toolName, input);
		this.recent.push(signature);
		if (this.recent.length > this.window) this.recent.shift();

		if (
			this.recent.length === this.window
			&& this.recent.every((entry) => entry === signature)
			&& !this.notified.has(signature)
		) {
			this.notified.add(signature);
			return signature;
		}
		return null;
	}
}

export type WatchdogDecision =
	| { action: "none" }
	| { action: "compact" }
	| { action: "pause"; reason: string }
	| { action: "resume" };

export class ContextWatchdog {
	private pendingCompact = false;
	private paused = false;

	constructor(private readonly thresholdPercent: number = DEFAULT_WATCHDOG_THRESHOLD_PERCENT) {}

	get isPaused(): boolean {
		return this.paused;
	}

	reset(): void {
		this.pendingCompact = false;
		this.paused = false;
	}

	observe(percent: number | null | undefined): WatchdogDecision {
		if (percent == null || !Number.isFinite(percent)) return { action: "none" };

		if (this.paused) {
			if (percent < this.thresholdPercent - WATCHDOG_RESUME_MARGIN_PERCENT) {
				this.paused = false;
				return { action: "resume" };
			}
			return { action: "none" };
		}

		if (this.pendingCompact) {
			this.pendingCompact = false;
			if (percent >= this.thresholdPercent) {
				this.paused = true;
				return {
					action: "pause",
					reason: `Context still at ${Math.round(percent)}% after compaction; watchdog paused. Run /compact manually or start a fresh session.`,
				};
			}
			return { action: "none" };
		}

		if (percent >= this.thresholdPercent) {
			this.pendingCompact = true;
			return { action: "compact" };
		}
		return { action: "none" };
	}
}
