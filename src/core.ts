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
	readGuardEnabled: boolean;
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

	const readGuardConfig = readSection(root.readGuard);
	const readGuardEnabled = typeof readGuardConfig.enabled === "boolean" ? readGuardConfig.enabled : false;

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
			readGuardEnabled,
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
- After a state change, run a successful read-only check (ls/test/grep/git status...) before task_verify; task_verify requires it.
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
- 状态变更后、task_verify 之前，先运行一次成功的只读检查（ls/test/grep/git status 等）；task_verify 会强制要求这一条。
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
	emptyResponses: number;
	emptyToolCalls: number;
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
	private emptyResponses = 0;
	private emptyToolCalls = 0;

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

	recordQuality(verdict: QualityVerdict): void {
		if (!verdict.ok) {
			if (verdict.reason === "empty_response") this.emptyResponses++;
			else if (verdict.reason === "empty_tool_call") this.emptyToolCalls++;
		}
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
			emptyResponses: this.emptyResponses,
			emptyToolCalls: this.emptyToolCalls,
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

// ---------------------------------------------------------------------------
// Shell / bash read-only analysis. Structural (quote-aware), not a flat regex:
// chains split on unquoted operators & newlines, heredoc bodies stripped,
// `$()` substitutions and `for/while/if` blocks unwrapped recursively.
// Pattern-ported from little-coder's shell-write.ts (scan/strip/split).
// ---------------------------------------------------------------------------

/** Walk `text` char-by-char tracking quote state; visit receives each char
 *  plus whether it sits inside a quoted run. Backslash escapes hide the next
 *  character outside quotes. This is what keeps subsequent split / write
 *  detection from firing on text that merely looks like shell syntax
 *  (`grep "a > b"` writes nothing). */
function shellScan(text: string, visit: (ch: string, index: number, quoted: boolean) => void): void {
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote === null) {
			if (ch === "\\") {
				i++;
				continue;
			}
			if (ch === '"' || ch === "'") {
				quote = ch;
				continue;
			}
			visit(ch, i, false);
			continue;
		}
		if (ch === quote) {
			quote = null;
			continue;
		}
		visit(ch, i, true);
	}
}

// `<< DELIM`, `<<-DELIM`, `<<'DELIM'`, `<<"DELIM"`. `<<<` is a here-string
// (single-line data) and must never match — hence the call-site check for a
// third `<`.
const HEREDOC_START = /<<-?[ \t]*(?:'([^']*)'|"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*))/;

/** Strip heredoc bodies, leaving only the opening lines. A heredoc payload is
 *  data, not shell syntax — analyzing it produces noise in both directions
 *  (`>` in `if a > b:` looks like a redirect; an apostrophe in `don't` wedges
 *  the quote scanner). The write we care about (`cat > f <<'EOF'`) always sits
 *  on the opening line, so dropping bodies loses nothing. */
function stripHeredocBodies(command: string): string {
	let out = command;
	let searchFrom = 0;
	for (let pass = 0; pass < 32; pass++) {
		const rest = out.slice(searchFrom);
		const match = HEREDOC_START.exec(rest);
		if (!match || match.index === undefined) break;
		const at = searchFrom + match.index;
		if (out[at + 2] === "<") {
			searchFrom = at + 3;
			continue;
		}
		const delimiter = match[1] ?? match[2] ?? match[3] ?? "";
		const bodyStart = out.indexOf("\n", at + match[0].length);
		if (bodyStart === -1 || !delimiter) {
			searchFrom = at + match[0].length;
			continue;
		}
		const lines = out.slice(bodyStart + 1).split("\n");
		let consumed = 0;
		let closed = false;
		for (const line of lines) {
			consumed += line.length + 1;
			if (line.trim() === delimiter) {
				closed = true;
				break;
			}
		}
		const bodyEnd = closed ? Math.min(bodyStart + consumed, out.length) : out.length;
		out = out.slice(0, at) + out.slice(bodyEnd);
		searchFrom = at;
	}
	return out;
}

/** Split a command line at top-level (unquoted) `&&`, `||`, `;`, `|`, `&` and
 *  newlines, honoring quotes. Heredoc bodies stripped first so payload text is
 *  never split into fake segments. Returns trimmed non-empty segments. */
function splitCommandChain(command: string): string[] {
	const cuts: Array<{ at: number; len: number }> = [];
	shellScan(command, (_ch, i, quoted) => {
		if (quoted) return;
		const ch = command[i];
		if (ch === ";") {
			cuts.push({ at: i, len: 1 });
		} else if (ch === "&") {
			// `2>&1` / `&>`-style fd plumbing: the `&` right after `>` is not
			// an operator, leave it inside the segment.
			if (command[i - 1] === ">") return;
			const len = command[i + 1] === "&" || command[i + 1] === ">" ? 2 : 1;
			cuts.push({ at: i, len });
		} else if (ch === "|") {
			cuts.push({ at: i, len: command[i + 1] === "|" ? 2 : 1 });
		} else if (ch === "\n") {
			cuts.push({ at: i, len: 1 });
		}
	});
	const segments: string[] = [];
	let start = 0;
	for (const cut of cuts) {
		segments.push(command.slice(start, cut.at));
		start = cut.at + cut.len;
	}
	segments.push(command.slice(start));
	return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Walk the command collecting the text of every `$(...)` substitution
 * (nested-aware, quote-aware). Semicolons/pipe/&& inside a body are preserved
 * by swapping them for newlines so the inner text re-parses as its own chain.
 */
function extractSubstitutions(command: string): string[] {
	const inners: string[] = [];
	shellScan(command, (_ch, i, quoted) => {
		if (quoted || command[i] !== "$" || command[i + 1] !== "(") return;
		let depth = 0;
		let inner = "";
		for (let j = i + 2; j < command.length; j++) {
			const c = command[j];
			if (c === "(") {
				depth++;
				inner += c;
				continue;
			}
			if (c === ")") {
				if (depth === 0) break;
				depth--;
				inner += c;
				continue;
			}
			if (c === ";" || c === "|" || c === "&" || c === "\n") inner += "\n";
			else inner += c;
		}
		inners.push(inner);
	});
	return inners;
}

/**
 * True when executing `segment` cannot change the filesystem (or other
 * long-lived state). Conservative by default: a command not proven read-only
 * is treated as state-changing.
 */
function isReadOnlyBashSegment(segment: string): boolean {
	const stripped = segment.trim().replace(/^!\s+/, "");
	if (!stripped) return false;

	if (/^true\b/.test(stripped) || /^:\s*$/.test(stripped)) return true;
	if (/^(?:npm|npx|pnpm|yarn)\s+(?:test|t|run\s+test|list|view|config\s+get|info)\b/.test(stripped)) return true;
	if (/^(?:node|bun)\s+\S*(?:test|spec)\S*\.(?:js|mjs|cjs|ts|mts|cts)\b/.test(stripped)) return true;
	if (/^(?:node|bun)\s+.*\b--test\b/.test(stripped)) return true;
	if (/^find\b/.test(stripped) && /-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/.test(stripped)) return false;

	// Pure-write commands: never read-only regardless of other args.
	if (/^(?:cp|mv|rm|rmdir|touch|mkdir|mkdirp|install|ln|chmod|chown|truncate|unlink|tee|dd|tar|zip|unzip|gzip|bzip2|xz|sed)\s+-i\b/.test(stripped)) return false;

	// fd plumbing (`2>&1`, `2>/dev/null`) and `/dev/null` redirects never write
	// a real file — normalize them away, then any residual unquoted `>` means
	// the segment writes a real file.
	const line = stripHeredocBodies(stripped)
		.replace(/[12]>(?:&[12]|\/dev\/(?:null|stdout|stderr|stdin|tty|zero|full|random|urandom))/g, " ")
		.replace(/>\s*\/dev\/(?:null|stdout|stderr|stdin|tty|zero|full|random|urandom)/g, " ");
	let writes = false;
	shellScan(line, (ch, _i, quoted) => {
		if (!quoted && ch === ">") writes = true;
	});
	if (writes) return false;

	// Input redirections (`< file`, `<< EOF`, `<<< str`) read, never write.
	// If a segment is nothing but an input redirect, it is read-only.
	const noInput = line.replace(/[0-9]*<\s*(?:&[0-9]+|[^\s>=;|&]+)/g, " ").trim();
	if (noInput === "") return true;

	if (/<<\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.test(stripped)) return false;

	if (/^(?:git\s+(?:add|commit|rm|mv|reset|checkout|push|pull|merge|rebase|stash|clean|restore|switch|apply|archive|format-patch)\b)/.test(stripped)) return false;
	if (/^(?:curl|wget)\s+(?:-o|--output|-O)\b/.test(stripped)) return false;

	return /^(?:pwd|command\s+-v\b|which\b|type\b|test\b|\[(?:[^]]*\]|$)|echo\b|printf\b|stat\b|dirname\b|basename\b|realpath\b|readlink\b|read\b|git\s+(?:status|diff|log|show|blame|rev-parse|branch\s+--show-current)\b|npm\s+(?:list|view|config\s+get)\b|(?:ls|rg|grep|cat|head|tail|find|wc|sort|uniq|cut|tr)\b)/.test(stripped);
}

/**
 * True when `command` is read-only.
 *
 * Recursive structure walk:
 *  - `$()` substitutions are re-parsed as their own chains.
 *  - Compound `for`/`while`/`until`/`if` blocks are flattened onto their
 *    keyword boundaries and every inner piece must be read-only.
 *  - Every top-level `&&`/`||`/`;`/`|`/newline segment must be read-only.
 *  - `name=value` assignments are read-only on their own.
 * Anything not proven read-only is treated as state-changing (conservative).
 */
function isReadOnlyBashCommand(command: string, depth = 0): boolean {
	if (depth > 16) return false;
	const normalized = stripHeredocBodies(command.trim());
	if (!normalized) return false;

	// A bare `&` backgrounds the command (`cmd &`) — the harness cannot
	// observe side effects of a forked job, so it is not read-only. `&&`,
	// `&>` and `2>&1` are connectors, not backgrounding.
	{
		let bg = false;
		shellScan(normalized, (_ch, i, quoted) => {
			if (quoted || normalized[i] !== "&") return;
			const prev = normalized[i - 1];
			const next = normalized[i + 1];
			if (prev === "&" || prev === ">") return;
			if (next === "&" || next === ">" || (next >= "0" && next <= "9")) return;
			bg = true;
		});
		if (bg) return false;
	}

	// `$(...)` bodies checked first — before their host segment is split.
	for (const inner of extractSubstitutions(normalized)) {
		if (!isReadOnlyBashCommand(inner, depth + 1)) return false;
	}

	// Flatten compound blocks (`for …; do … done`, `if …; then … fi`) by
	// splitting around their keywords so header and body re-parse as segments.
	// Structural keywords are inert; `for|until|case` headers are inert too
	// (their `$( )` bodies were already checked above). `while|if` headers are
	// real conditions, so they must themselves read as read-only.
	if (/(?<![\w-])(?:for|while|until|if|do|done|then|else|elif|fi|case|esac)\b/.test(normalized)) {
		const parts = splitCommandChain(normalized.replace(/;[ \t]*(do|done|then|fi|else|elif)\b/g, "\n$1"));
		for (const part of parts) {
			const p = part.trim();
			if (!p || /^(?:do|done|then|fi|else|elif|in|esac)$/.test(p)) continue;
			const peeled = p.replace(/^(?:do|then|else|elif|done|fi)\s+/, "");
			const hdr = /^(for|while|until|if|case)\b/.exec(peeled);
			if (hdr) {
				if (hdr[1] === "for" || hdr[1] === "case") continue;
				const cond = peeled.slice(hdr[1].length).trim();
				if (!cond || !isReadOnlyBashCommand(cond, depth + 1)) return false;
				continue;
			}
			if (!isReadOnlyBashCommand(peeled, depth + 1)) return false;
		}
		return true;
	}

	// Bare assignment never touches the filesystem. `name=$(cmd)` and quoted
	// values are safe because the `$( )` body was already verified above.
	const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(normalized);
	if (m && m[2]) {
		const v = m[2].trim();
		if (
			(v.startsWith("$(") && v.endsWith(")")) ||
			/^("[^"]*"|'[^']*'|[A-Za-z0-9_./:~=+-]*)$/.test(v)
		)
			return true;
	}

	const segments = splitCommandChain(normalized);
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
		const candidate = [...this.toolCalls.entries()]
			.reverse()
			.find(([_toolCallId, toolCall]) => (
				toolCall.succeeded
				&& !toolCall.isStateChanging
				&& toolCall.order > this.lastMutationOrder
				&& !["task_contract", "task_verify", "task_complete"].includes(toolCall.toolName)
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
		`Quality: ${snapshot.emptyResponses + snapshot.emptyToolCalls} anomalies (${snapshot.emptyResponses} empty, ${snapshot.emptyToolCalls} empty tool call)`,
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

export type QualityBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; name: string; arguments: Record<string, unknown> };

export type QualityVerdict =
	| { ok: true }
	| { ok: false; reason: "empty_response" }
	| { ok: false; reason: "empty_tool_call"; tool: string };

export type QualitySnapshot = {
	emptyResponses: number;
	emptyToolCalls: number;
};

export function assessResponseQuality(blocks: readonly QualityBlock[]): QualityVerdict {
	const text = blocks.filter((block) => block.type === "text").map((block) => (block as { text: string }).text.trim()).join(" ");
	const thinking = blocks.some((block) => block.type === "thinking");
	const toolCalls = blocks.filter((block) => block.type === "toolCall") as Array<{ name: string; arguments: Record<string, unknown> }>;

	if (!text && !thinking && toolCalls.length === 0) return { ok: false, reason: "empty_response" };

	for (const call of toolCalls) {
		if (!call.arguments || Object.keys(call.arguments).length === 0) {
			return { ok: false, reason: "empty_tool_call", tool: call.name };
		}
	}

	return { ok: true };
}

export class QualityMonitor {
	private emptyResponses = 0;
	private emptyToolCalls = 0;

	reset(): void {
		this.emptyResponses = 0;
		this.emptyToolCalls = 0;
	}

	record(blocks: readonly QualityBlock[]): QualityVerdict {
		const verdict = assessResponseQuality(blocks);
		if (!verdict.ok) {
			if (verdict.reason === "empty_response") this.emptyResponses++;
			else if (verdict.reason === "empty_tool_call") this.emptyToolCalls++;
		}
		return verdict;
	}

	snapshot(): QualitySnapshot {
		return { emptyResponses: this.emptyResponses, emptyToolCalls: this.emptyToolCalls };
	}
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls", "rg", "cat", "head", "tail"]);
const EDIT_TOOLS = new Set(["edit", "write"]);

function toolPath(toolName: string, input: Record<string, unknown>): string | null {
	const path = typeof input.path === "string" ? input.path
		: typeof input.filePath === "string" ? input.filePath
			: null;
	if (!path) return null;
	try {
		return resolve(path);
	} catch {
		return null;
	}
}

export class ReadGuard {
	private readonly readFiles = new Set<string>();

	reset(): void {
		this.readFiles.clear();
	}

	recordRead(toolName: string, input: Record<string, unknown>): void {
		if (!READ_TOOLS.has(toolName)) return;
		const path = toolPath(toolName, input);
		if (path) this.readFiles.add(path);
	}

	needsReadForEdit(toolName: string, input: Record<string, unknown>): string | null {
		if (!EDIT_TOOLS.has(toolName)) return null;
		const path = toolPath(toolName, input);
		if (!path) return null;
		return this.readFiles.has(path) ? null : path;
	}

	readFilesCount(): number {
		return this.readFiles.size;
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
