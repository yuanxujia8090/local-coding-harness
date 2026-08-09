import type { HarnessConfig } from "../config";
import type { HarnessEvent } from "../events";
import type { Directive, Policy } from "../policy";
import type { HarnessState } from "../state";
import { evolveWatchdog, type WatchdogState } from "../watchdog";
import { buildCodingProtocol } from "../protocol";
import { formatTaskCompletionReport } from "../ledger";

/** 上下文压力政策（原 watchdog.ts + index turn_end 路径）。
 *  - turn.end 带 contextPercent：达阈值 -> compact；compaction 后仍高 -> pause。
 *  - context.compacted：注入 protocol 与未完成任务状态（compaction 会让模型
 *    丢动态上下文，必须重建）。
 *  状态经 record 回写 code 的 paused/pendingCompact。 */
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
				const sections = [buildCodingProtocol(config.protocolLanguage)];
				if (state.task.intent && !state.task.completed) {
					sections.push(`## Task State\n${formatTaskCompletionReport(state.task)}\n- Finish the pending completion evidence before reporting done.`);
				}
				return [{
					kind: "inject",
					policy: "context",
					message: sections.join("\n\n"),
					dedupeKey: `post-compact-${state.interventions.compactions}`,
				}];
			}

			return [];
		},
	};
}