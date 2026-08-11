import type { HarnessConfig } from "../config";
import type { HarnessEvent } from "../events";
import type { Directive, Policy } from "../policy";
import type { HarnessState } from "../state";
import { evolveWatchdog, type WatchdogState } from "../watchdog";

/** 上下文压力政策（原 watchdog.ts + index turn_end 路径）。
 *  - turn.end 带 contextPercent：达阈值 -> compact；compaction 后仍高 -> pause。
 *  - context.compacted：注入 adapter 在事件边界计算的完整上下文投影
 *    （protocol + verification + task state）。projection 是不可变事件载荷，
 *    使 Policy 输出仍只依赖 event/state/config（审查第五轮 P1）。 */
export function createContextPolicy(): Policy {
	return {
		id: "context",
		evaluate(event: HarnessEvent, state: Readonly<HarnessState>, config: HarnessConfig): readonly Directive[] {
			if (event.type === "turn.end") {
				if (!config.watchdogEnabled) return [];
				const percent = event.contextPercent;
				const current: WatchdogState = {
					paused: state.context.paused,
					pendingCompact: state.context.pendingCompact,
				};
				const { decision, next } = evolveWatchdog(current, config.watchdogThresholdPercent, percent);

				const directives: Directive[] = [
					{ kind: "record", policy: "context", event: "watchdog", data: { paused: next.paused, pendingCompact: next.pendingCompact } },
				];
				if (decision.action === "compact") {
					directives.push({ kind: "compact", policy: "context", reason: `Context at ${Math.round(percent ?? 0)}% exceeds watchdog threshold ${config.watchdogThresholdPercent}%.` });
				} else if (decision.action === "pause") {
					directives.push({ kind: "notify", policy: "context", level: "warning", message: `local-model-harness: ${decision.reason}` });
				}
				return directives;
			}

			if (event.type === "context.compacted") {
				return [{
					kind: "inject",
					policy: "context",
					message: event.projection,
					// reducer 为每个 context.compacted 事件递增 epoch，因此同一回合
					// 连续手动 compact 也各自恢复一次动态状态（审查第七轮 P1）。
					dedupeKey: `post-compact-${state.context.compactionEpoch}`,
				}];
			}

			return [];
		},
	};
}