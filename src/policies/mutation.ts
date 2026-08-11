import type { HarnessConfig } from "../base/config";
import type { HarnessEvent } from "../base/events";
import type { Directive, Policy } from "../base/policy";
import type { HarnessState } from "../base/state";
import type { TaskCompletionLedger } from "../mechanisms/ledger";
import type { ContractGate } from "../mechanisms/gate";
import type { ReadGuard } from "../mechanisms/readguard";
import { buildContractBlockReason, buildGateSteerMessage } from "../mechanisms/gate";

type MutationPolicyDeps = {
	ledger: TaskCompletionLedger;
	contractGate: ContractGate;
	readGuard: ReadGuard;
};

/** 状态变更识别、无契约阻断、read-before-edit（原 gate.ts + readguard.ts 路径）。
 *  只返回 directives；消息文本、gate reason、配置默认值与迁移前一致。 */
export function createMutationPolicy(deps: MutationPolicyDeps): Policy {
	return {
		id: "mutation",
		evaluate(event: HarnessEvent, state: Readonly<HarnessState>, config: HarnessConfig): readonly Directive[] {
			if (event.type !== "tool.requested") return [];
			const { ledger, contractGate, readGuard } = deps;
			const directives: Directive[] = [];

			if (config.gateEnabled && ledger.needsContractFor(event.tool, event.input as Record<string, unknown>)) {
				const escalation = contractGate.recordBlock();
				if (escalation.steer) {
					directives.push({ kind: "steer", policy: "mutation", message: buildGateSteerMessage(escalation.blocks, config.protocolLanguage), dedupeKey: `gate-steer-${escalation.blocks}` });
				}
				if (escalation.notify) {
					directives.push({ kind: "notify", policy: "mutation", level: "warning", message: `local-model-harness: ${escalation.blocks} calls blocked without a task contract. The model is refusing to call task_contract; consider intervening.` });
				}
				directives.push({ kind: "block", policy: "mutation", reason: buildContractBlockReason(config.protocolLanguage) });
				return directives;
			}

			readGuard.recordRead(event.tool, event.input as Record<string, unknown>);
			if (config.readGuardEnabled) {
				const unreadPath = readGuard.needsReadForEdit(event.tool, event.input as Record<string, unknown>);
				if (unreadPath) {
					directives.push({
						kind: "steer",
						policy: "mutation",
						message: `[local-model-harness] You are editing ${unreadPath} without having read it first. Read the file (read tool) so the edit is based on the actual current content, then retry the ${event.tool}.`,
						dedupeKey: `read-before-edit-${unreadPath}`,
					});
					directives.push({ kind: "block", policy: "mutation", reason: `Read ${unreadPath} before editing it.` });
					return directives;
				}
			}

			// ledger.recordToolCall 由 adapter 负责（非 managed session 也要记录证据），
			// policy 只做判断，不在此写入。
			return [];
		},
	};
}