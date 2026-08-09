import type { HarnessConfig } from "../config";
import type { HarnessEvent } from "../events";
import type { Directive, Policy } from "../policy";
import type { HarnessState } from "../state";
import { assessResponseQuality, type QualityBlock } from "../quality";

const MAX_CONSECUTIVE_STEERS = 2;

/** 空回复与空参数质量检测（原 quality.ts + index turn_end 路径）。
 *  连续异常先 steer，超过上限降级为 notify；计数器经 record 回写 state。 */
export function createQualityPolicy(): Policy {
	return {
		id: "quality",
		evaluate(event: HarnessEvent, state: Readonly<HarnessState>, _config: HarnessConfig): readonly Directive[] {
			if (event.type !== "turn.end") return [];
			const content = event.content;
			if (!Array.isArray(content)) return [];
			// aborted / error 回合不含真实产出，跳过避免误报（与原 turn_end 判定一致）。
			if (event.stopReason === "aborted" || event.stopReason === "error") return [];

			const verdict = assessResponseQuality(content as readonly QualityBlock[]);
			if (verdict.ok) {
				return [{ kind: "record", policy: "quality", event: "consecutive-reset", data: { consecutiveSteers: 0 } }];
			}

			const next = state.quality.consecutiveSteers + 1;
			const data: Record<string, unknown> = { consecutiveSteers: next };
			if (verdict.reason === "empty_response") {
				data.emptyResponses = state.quality.emptyResponses + 1;
				data.verdict = { reason: "empty_response" };
			} else if (verdict.reason === "empty_tool_call") {
				data.emptyToolCalls = state.quality.emptyToolCalls + 1;
				data.verdict = { reason: "empty_tool_call", tool: verdict.tool };
			}

			const directives: Directive[] = [
				{ kind: "record", policy: "quality", event: "verdict", data },
			];

			if (next <= MAX_CONSECUTIVE_STEERS) {
				const message = verdict.reason === "empty_response"
					? `[local-model-harness] The last response contained no text and no tool call. Produce a concrete next step: read a file, run a command, or report findings — do not reply with an empty or thinking-only message.`
					: `[local-model-harness] The ${verdict.tool} tool call had no arguments. Every tool call needs its parameters filled in; re-read the tool description and call it with real input.`;
				directives.push({
					kind: "steer",
					policy: "quality",
					message,
					// 原 index 每个异常回合都重复投递质量纠正（靠连续计数封顶）。
					// 用 turn 整体唯一 key 绕过跨事件 dedupe，保持每个异常回合各发一次。
					dedupeKey: `quality-${verdict.reason}-${state.session.turns}`,
				});
			} else {
				directives.push({
					kind: "notify",
					policy: "quality",
					level: "warning",
					message: `local-model-harness: backing off quality corrections after ${next} in a row — the model is not responding to them.`,
				});
			}
			return directives;
		},
	};
}