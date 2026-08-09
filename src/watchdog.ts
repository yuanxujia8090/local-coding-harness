import { DEFAULT_WATCHDOG_THRESHOLD_PERCENT, WATCHDOG_RESUME_MARGIN_PERCENT } from "./config";

export type WatchdogDecision =
	| { action: "none"; reason?: string }
	| { action: "compact" }
	| { action: "pause"; reason: string }
	| { action: "resume" };

/** watchdog 决策所需的共享状态（等价于旧 ContextWatchdog 私有字段）。 */
export type WatchdogState = {
	paused: boolean;
	pendingCompact: boolean;
};

/** 纯决策：输入当前状态与上下文占用率，输出动作与新状态。不写任何内部字段，
 *  状态推进由调用方（policy -> controller record）回写，保证可测试与可重放。 */
export function evolveWatchdog(
	current: Readonly<WatchdogState>,
	thresholdPercent: number,
	percent: number | null | undefined,
): { decision: WatchdogDecision; next: WatchdogState } {
	if (percent == null || !Number.isFinite(percent)) return { decision: { action: "none" }, next: { ...current } };

	if (current.paused) {
		if (percent < thresholdPercent - WATCHDOG_RESUME_MARGIN_PERCENT) {
			return {
				decision: { action: "resume" },
				next: { paused: false, pendingCompact: false },
			};
		}
		return { decision: { action: "none" }, next: { ...current } };
	}

	if (current.pendingCompact) {
		const next: WatchdogState = { paused: false, pendingCompact: false };
		if (percent >= thresholdPercent) {
			return {
				decision: {
					action: "pause",
					reason: `Context still at ${Math.round(percent)}% after compaction; watchdog paused. Run /compact manually or start a fresh session.`,
				},
				next: { ...next, paused: true },
			};
		}
		return { decision: { action: "none" }, next };
	}

	if (percent >= thresholdPercent) {
		return {
			decision: { action: "compact" },
			next: { paused: false, pendingCompact: true },
		};
	}
	return { decision: { action: "none" }, next: { ...current } };
}

/** 向后兼容（Task 6 之前 index 仍通过实例观察）。新逻辑请使用 decideWatchdog。 */
export class ContextWatchdog {
	private readonly state: WatchdogState = { paused: false, pendingCompact: false };

	constructor(private readonly thresholdPercent: number = DEFAULT_WATCHDOG_THRESHOLD_PERCENT) {}

	get isPaused(): boolean {
		return this.state.paused;
	}

	reset(): void {
		this.state.paused = false;
		this.state.pendingCompact = false;
	}

	observe(percent: number | null | undefined): WatchdogDecision {
		const { decision, next } = evolveWatchdog(this.state, this.thresholdPercent, percent);
		this.state.paused = next.paused;
		this.state.pendingCompact = next.pendingCompact;
		return decision;
	}
}