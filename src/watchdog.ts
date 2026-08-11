import { WATCHDOG_RESUME_MARGIN_PERCENT } from "./config";

export type WatchdogDecision =
	| { action: "none"; reason?: string }
	| { action: "compact" }
	| { action: "pause"; reason: string }
	| { action: "resume" };

/** watchdog 决策所需的共享状态。 */
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