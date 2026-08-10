import type { HarnessConfig } from "../config";
import type { HarnessEvent } from "../events";
import type { Directive, Policy } from "../policy";
import type { HarnessState } from "../state";
import { evolveWatchdog, type WatchdogState } from "../watchdog";

/** 上下文压力政策（原 watchdog.ts + index turn_end 路径）。
 *  - turn.end 带 contextPercent：达阈值 -> compact；compaction 后仍高 -> pause。
 *  - context.compacted：注入完整上下文投影（protocol + verification +
 *    task state）。注入内容不由 policy 拼装，而是来自 adapter 传入的共享
 *    投影函数——它与 legacy before_agent_start 的注入是同一个函数（同一个
 *    verification projection），保证两条路径内容一致、可被同一 dedupe 缓存
 *    覆盖（审查第三轮 P1 / 第四轮：共享完整 verification projection）。
 *    之所以传回调：verification pending 存在 adapter 的 telemetry sidecar，
 *    Policy 不持有该数据，只能由 wiring 层投影。 */
export function createContextPolicy(projection: () => string): Policy {
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
					message: projection(),
					// 每次压缩后各注入一次：用回合号作窗口 key（compactions 只在
					// watchdog 的 compact 指令下递增，手动 /compact 不会），
					// 保证手动压缩与 watchdog 压缩都各得一次注入（审查 F1）。
					dedupeKey: `post-compact-${state.session.turns}`,
				}];
			}

			return [];
		},
	};
}