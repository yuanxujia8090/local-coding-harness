import { describe, expect, test } from "vitest";
import { ContractGate } from "../src/gate";
import { ReadGuard } from "../src/readguard";
import { TaskCompletionLedger } from "../src/ledger";
import { createMutationPolicy } from "../src/policies/mutation";
import { HarnessController } from "../src/controller";
import type { HarnessConfig } from "../src/config";

function testConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
	return {
		provider: "lmstudio",
		models: ["test-model-7b"],
		lockPath: "/tmp/local-model-harness-test.lock",
		watchdogEnabled: true,
		watchdogThresholdPercent: 80,
		loopGuardEnabled: true,
		loopGuardWindow: 3,
		researchDriftEnabled: true,
		researchDriftThreshold: 8,
		turnCapEnabled: false,
		turnCapMaxTurns: 40,
		protocolLanguage: "en",
		gateEnabled: true,
		gateExtraReadOnlyTools: [],
		readGuardEnabled: false,
		...overrides,
	};
}

function makeController(config: HarnessConfig, ledger: TaskCompletionLedger, readGuard: ReadGuard, contractGate: ContractGate) {
	const mutation = createMutationPolicy({ ledger, readGuard, contractGate });
	return new HarnessController(config, [mutation], undefined, () => ledger.snapshot());
}

const write = { type: "tool.requested" as const, callId: "c1", tool: "write", input: { path: "README.md" } };
const read = { type: "tool.requested" as const, callId: "c2", tool: "read", input: { path: "README.md" } };

describe("MutationPolicy", () => {
	test("首次状态变更前无契约 -> block", () => {
		const ledger = new TaskCompletionLedger();
		const controller = makeController(testConfig(), ledger, new ReadGuard(), new ContractGate());
		const directives = controller.handle(write);
		expect(directives.some((directive) => directive.kind === "block")).toBe(true);
		const block = directives.find((directive) => directive.kind === "block");
		expect(block?.kind === "block" && block.reason).toContain("task_contract");
	});

	test("只读命令不要求契约", () => {
		const ledger = new TaskCompletionLedger();
		const controller = makeController(testConfig(), ledger, new ReadGuard(), new ContractGate());
		const directives = controller.handle({
			type: "tool.requested",
			callId: "c3",
			tool: "bash",
			input: { command: "git status --short" },
		});
		expect(directives.some((directive) => directive.kind === "block")).toBe(false);
	});

	test("契约建立后状态变更放行", () => {
		const ledger = new TaskCompletionLedger();
		ledger.setContract({
			intent: "update readme",
			scope: ["README.md"],
			doneWhen: ["readme updated"],
			verificationPlan: ["read readme"],
			unresolved: [],
		});
		const controller = makeController(testConfig(), ledger, new ReadGuard(), new ContractGate());
		const directives = controller.handle(write);
		expect(directives.some((directive) => directive.kind === "block")).toBe(false);
	});

	test("edit 前未 read -> block（readGuard 开启时）", () => {
		const ledger = new TaskCompletionLedger();
		ledger.setContract({
			intent: "update readme",
			scope: ["README.md"],
			doneWhen: ["readme updated"],
			verificationPlan: ["read readme"],
			unresolved: [],
		});
		const controller = makeController(testConfig({ readGuardEnabled: true }), ledger, new ReadGuard(), new ContractGate());
		const directives = controller.handle(write);
		expect(directives.some((directive) => directive.kind === "block")).toBe(true);
	});

	test("先 read 后 edit -> 放行", () => {
		const ledger = new TaskCompletionLedger();
		ledger.setContract({
			intent: "update readme",
			scope: ["README.md"],
			doneWhen: ["readme updated"],
			verificationPlan: ["read readme"],
			unresolved: [],
		});
		const controller = makeController(testConfig({ readGuardEnabled: true }), ledger, new ReadGuard(), new ContractGate());
		expect(controller.handle(read).some((directive) => directive.kind === "block")).toBe(false);
		expect(controller.handle(write).some((directive) => directive.kind === "block")).toBe(false);
	});

	test("gate 第三次 block 后产生 steer", () => {
		const ledger = new TaskCompletionLedger();
		const controller = makeController(testConfig(), ledger, new ReadGuard(), new ContractGate());
		controller.handle(write);
		controller.handle({ ...write, callId: "c4" });
		controller.handle({ ...write, callId: "c5" });
		expect(controller.snapshot().interventions.blocks).toBe(3);
	});
});