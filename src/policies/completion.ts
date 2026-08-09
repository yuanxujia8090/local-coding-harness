import type { HarnessEvent } from "../events";
import type { Directive, Policy } from "../policy";
import type { HarnessState } from "../state";
import type { TaskCompletionLedger } from "../ledger";

type CompletionPolicyDeps = {
	ledger: TaskCompletionLedger;
};

const TASK_FOLLOW_UP_DEDUPE_KEY = "task-follow-up";

/** 契约门禁的完成侧（原 ledger + index 路径）：任务未完成时的
 *  settled 续跑 steer、task_complete 完成判定。只返回 directives。 */
export function createCompletionPolicy(deps: CompletionPolicyDeps): Policy {
	return {
		id: "completion",
		evaluate(event: HarnessEvent, _state: Readonly<HarnessState>): readonly Directive[] {
			const { ledger } = deps;
			if (event.type === "tool.requested" && event.tool === "task_complete") {
				const task = ledger.snapshot();
				if (!task.completed) {
					return [{ kind: "block", policy: "completion", reason: `Task incomplete. Missing evidence: ${task.missingConditions.join(", ") || "call task_complete with evidence"}.` }];
				}
				return [];
			}
			if (event.type === "agent.settled") {
				const task = ledger.snapshot();
				if (task.mutationToolCalls.length > 0 && !task.completed) {
					return [{
						kind: "steer",
						policy: "completion",
						message: `Task remains incomplete. Missing completion evidence: ${task.missingConditions.join(", ") || "call task_complete with evidence"}. Continue the current task; do not report completion yet.`,
						dedupeKey: TASK_FOLLOW_UP_DEDUPE_KEY,
					}];
				}
			}
			return [];
		},
	};
}