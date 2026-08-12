import type { QualityVerdict } from "./quality";

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

// ponytail: 纯文档改动没有可跑的验证命令，豁免 pending；需要 .rst/.txt 等再扩。
const DOCS_ONLY_EXTENSIONS = [".md", ".mdx"];

export function isDocsOnlyFile(path: string): boolean {
	return DOCS_ONLY_EXTENSIONS.some((extension) => path.endsWith(extension));
}

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
		const hasCodeChanges = [...this.changedFiles].some((file) => !isDocsOnlyFile(file));
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
			verificationPending: this.verificationPending && hasCodeChanges,
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