import { DEFAULT_WATCHDOG_THRESHOLD_PERCENT, WATCHDOG_RESUME_MARGIN_PERCENT } from "./config";

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