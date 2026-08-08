import { isStateChangingTool } from "./shell";
import type { TelemetrySnapshot } from "./session";

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