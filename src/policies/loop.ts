import type { HarnessConfig } from "../config";
import type { HarnessEvent } from "../events";
import type { Directive, Policy } from "../policy";
import type { HarnessState } from "../state";
import { toolCallSignature } from "../loop";
import { isStateChangingTool } from "../shell";
import type { QualityBlock } from "../quality";

/** 死循环与 research drift 政策（原 loop.ts 路径）。只读 state 中的窗口
 *  与 drift 计数做判定，通过 record 指令把推进后的状态写回 controller。 */
export function createLoopPolicy(): Policy {
	return {
		id: "loop",
		evaluate(event: HarnessEvent, state: Readonly<HarnessState>, config: HarnessConfig): readonly Directive[] {
			if (event.type === "tool.requested") {
				if (!config.loopGuardEnabled) return [];
				const windowSize = config.loopGuardWindow;
				const signature = toolCallSignature(event.tool, event.input as Record<string, unknown>);
				const stateChanged = isStateChangingTool(event.tool, event.input as Record<string, unknown>, new Set(config.gateExtraReadOnlyTools)) === false;

				let recent = [...state.loop.recentSignatures];
				if (stateChanged && recent.length > 0 && recent[recent.length - 1] !== signature) {
					recent = [];
				}
				recent.push(signature);
				if (recent.length > windowSize) recent = recent.slice(-windowSize);

				const notified = state.loop.notifiedSignatures;
				const loopHit = recent.length === windowSize
					&& recent.every((entry) => entry === signature)
					&& !notified.includes(signature);

				const directives: Directive[] = [];
				if (loopHit) {
					directives.push({
						kind: "steer",
						policy: "loop",
						message: `[local-model-harness] The same ${event.tool} call has now repeated ${windowSize} times in a row. Do not retry it unchanged: re-read the last output, check your assumptions, try a different approach, or report the blocker to the user.`,
						dedupeKey: `loop-steer-${signature}`,
					});
					directives.push({
						kind: "record",
						policy: "loop",
						event: "exhausted",
						data: { recent, notified: [...notified, signature] },
					});
				} else {
					directives.push({
						kind: "record",
						policy: "loop",
						event: "progress",
						data: { recent, notified },
					});
				}
				return directives;
			}

			if (event.type === "turn.end" && config.researchDriftEnabled) {
				// aborted/error 回合无真实产出，跳过（与原 turn_end 判定一致）。
				if (event.stopReason === "aborted" || event.stopReason === "error") return [];
				const blocks = (event.content ?? []) as readonly QualityBlock[];
				const threshold = config.researchDriftThreshold;
				const extra = new Set(config.gateExtraReadOnlyTools);

				const hasText = blocks.some((block) => block.type === "text" && (block as { text: string }).text.trim().length > 0);
				const toolCalls = blocks.filter((block) => block.type === "toolCall") as Array<{ name: string; arguments: Record<string, unknown> }>;
				const completionSignal = toolCalls.some((call) => call.name === "task_verify" || call.name === "task_complete");
				const mutation = toolCalls.some((call) => isStateChangingTool(call.name, call.arguments, extra));
				const allReadOnly = toolCalls.length > 0 && toolCalls.every((call) => isStateChangingTool(call.name, call.arguments, extra) === false);

				if (hasText || completionSignal || mutation) {
					return [{ kind: "record", policy: "loop", event: "drift-reset", data: { drift: 0, driftNotified: false } }];
				}
				if (!allReadOnly) return [];

				const drift = state.loop.driftTurns;
				const notified = state.loop.driftNotified;
				if (drift + 1 < threshold) {
					return [{ kind: "record", policy: "loop", event: "drift-advance", data: { drift: drift + 1, driftNotified: false } }];
				}
				if (drift + 1 >= threshold && !notified) {
					return [
						{
							kind: "steer",
							policy: "loop",
							message: `[local-model-harness] Research appears to be drifting: the last ${threshold} turns only performed read-only lookups without reporting any findings. Converge now: summarize what you have learned, state a concrete conclusion, or explicitly name the missing evidence and ask the user to confirm scope. Continuing to gather files without reaching a conclusion wastes time.`,
							dedupeKey: `drift-steer`,
						},
						{ kind: "record", policy: "loop", event: "drift-advance", data: { drift: drift + 1, driftNotified: true } },
					];
				}
				return [{ kind: "record", policy: "loop", event: "drift-advance", data: { drift: drift + 1, driftNotified: notified } }];
			}

			return [];
		},
	};
}