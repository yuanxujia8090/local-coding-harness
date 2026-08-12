import type { HarnessEvent } from "../base/events";
import type { Directive, Policy } from "../base/policy";
import type { HarnessState } from "../base/state";
import type { TaskCompletionLedger } from "../mechanisms/ledger";

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
			// task_complete 的证据校验只能在注册工具 execute 内进行：Pi 先触发
			// tool_call hook，预执行 block 会让唯一调用 ledger.complete() 的路径不可达。
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