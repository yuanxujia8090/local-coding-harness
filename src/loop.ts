import { DEFAULT_LOOP_WINDOW, DEFAULT_DRIFT_THRESHOLD } from "./config";
import { isStateChangingTool } from "./shell";
import type { QualityBlock } from "./quality";

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

	constructor(
		private readonly window: number = DEFAULT_LOOP_WINDOW,
		private readonly extraReadOnlyTools: ReadonlySet<string> = new Set(),
	) {}

	reset(): void {
		this.recent = [];
		this.notified.clear();
	}

	record(toolName: string, input: Record<string, unknown>): string | null {
		const signature = toolCallSignature(toolName, input);
		const stateChanged = isStateChangingTool(toolName, input, this.extraReadOnlyTools);
		// A *new* state-changing call changes the environment, so a repeated call
		// after it is legitimate progress, not a loop (issue #81 in little-coder).
		// A repeat of the same state-changing call still accumulates — an
		// identical mutation retried unchanged is exactly the loop we watch for.
		if (stateChanged && this.recent.length > 0 && this.recent[this.recent.length - 1] !== signature) {
			this.recent = [];
		}
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

/** Hard cap on turns per agent run (port of little-coder's turn-cap). Counts
 *  turn_start events; once the count passes maxTurns the caller aborts the
 *  loop. Guards against any non-terminating loop — research drift, identical
 *  repeats, or a model that keeps going without converging. */
export class TurnCap {
	private count = 0;

	constructor(
		private readonly maxTurns: number,
		private readonly enabled: boolean,
	) {}

	reset(): void {
		this.count = 0;
	}

	record(): boolean {
		this.count++;
		return this.enabled && this.maxTurns > 0 && this.count > this.maxTurns;
	}
}

/** Detects research drift: many consecutive turns that only perform read-only
 *  lookups without producing a textual finding, a completion signal, or a state
 *  change. A cancelled turn (empty content) neither resets nor accumulates. */
export class ResearchDriftGuard {
	private consecutiveReadOnlyTurns = 0;
	private notified = false;

	constructor(
		private readonly threshold: number = DEFAULT_DRIFT_THRESHOLD,
		private readonly extraReadOnlyTools: ReadonlySet<string> = new Set(),
	) {}

	reset(): void {
		this.consecutiveReadOnlyTurns = 0;
		this.notified = false;
	}

	record(blocks: readonly QualityBlock[]): boolean {
		const hasText = blocks.some((block) => block.type === "text" && (block as { text: string }).text.trim().length > 0);
		const toolCalls = blocks.filter((block) => block.type === "toolCall") as Array<{ name: string; arguments: Record<string, unknown> }>;
		const completionSignal = toolCalls.some((call) => call.name === "task_verify" || call.name === "task_complete");
		const mutation = toolCalls.some((call) => isStateChangingTool(call.name, call.arguments, this.extraReadOnlyTools));

		if (hasText || completionSignal || mutation) {
			this.consecutiveReadOnlyTurns = 0;
			this.notified = false;
			return false;
		}

		const allReadOnly = toolCalls.length > 0 && toolCalls.every((call) => !isStateChangingTool(call.name, call.arguments, this.extraReadOnlyTools));
		if (!allReadOnly) return false;

		this.consecutiveReadOnlyTurns++;
		if (this.consecutiveReadOnlyTurns >= this.threshold && !this.notified) {
			this.notified = true;
			return true;
		}
		return false;
	}
}