import type { ProtocolLanguage } from "../base/config";

export function buildContractBlockReason(language: ProtocolLanguage = "en"): string {
	if (language === "zh") {
		return `[local-model-harness] 状态变更前需要先建立任务契约。请先调用 task_contract 工具，例如：
task_contract({
  intent: "<用户最终想要的结果>",
  scope: ["<允许触碰的文件/资源>"],
  doneWhen: ["<可观察的最终状态>"],
  verificationPlan: ["<每个 doneWhen 对应的只读检查方法>"],
  unresolved: []
})
契约建立后继续原来的操作即可。只读操作（read/grep/ls/git status 等）不需要契约。`;
	}
	return `[local-model-harness] Task contract required before state changes. Call the task_contract tool first, for example:
task_contract({
  intent: "<what the user ultimately wants>",
  scope: ["<files/resources you may touch>"],
  doneWhen: ["<observable end states>"],
  verificationPlan: ["<read-only check for each doneWhen>"],
  unresolved: []
})
Then continue with the original operation. Read-only actions (read/grep/ls/git status...) never need a contract.`;
}

export const CONTRACT_GATE_STEER_AFTER = 3;
export const CONTRACT_GATE_NOTIFY_AFTER = 6;

export type ContractGateEscalation = {
	blocks: number;
	steer: boolean;
	notify: boolean;
};

export class ContractGate {
	private blocks = 0;

	constructor(
		private readonly steerAfter: number = CONTRACT_GATE_STEER_AFTER,
		private readonly notifyAfter: number = CONTRACT_GATE_NOTIFY_AFTER,
	) {}

	reset(): void {
		this.blocks = 0;
	}

	get blockCount(): number {
		return this.blocks;
	}

	recordBlock(): ContractGateEscalation {
		this.blocks++;
		return {
			blocks: this.blocks,
			steer: this.blocks === this.steerAfter,
			notify: this.blocks === this.notifyAfter,
		};
	}
}

export function buildGateSteerMessage(blocks: number, language: ProtocolLanguage = "en"): string {
	if (language === "zh") {
		return `[local-model-harness] 本会话已有 ${blocks} 次状态变更调用因缺少任务契约被拦截。请立即调用 task_contract（intent/scope/doneWhen/verificationPlan/unresolved）建立契约，然后继续任务；不要再尝试绕过。只读操作不受影响。`;
	}
	return `[local-model-harness] ${blocks} state-changing calls have been blocked in this session for missing a task contract. Call task_contract now (intent/scope/doneWhen/verificationPlan/unresolved), then continue the task; do not try to work around the gate. Read-only actions are unaffected.`;
}