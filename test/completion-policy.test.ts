import { describe, expect, test } from "vitest";
import { TaskCompletionLedger } from "../src/ledger";
import { createCompletionPolicy } from "../src/policies/completion";
import { HarnessController } from "../src/controller";
import type { HarnessConfig } from "../src/config";

function testConfig(): HarnessConfig {
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
	};
}

const contract = {
	intent: "remove an application",
	scope: ["application package", "application config"],
	doneWhen: ["package absent", "config absent"],
	verificationPlan: ["inspect package", "inspect config"],
	unresolved: [],
};

function makeController(ledger: TaskCompletionLedger) {
	const completion = createCompletionPolicy({ ledger });
	return new HarnessController(testConfig(), [completion], undefined, () => ledger.snapshot());
}

const settled = { type: "agent.settled" as const };

describe("CompletionPolicy", () => {
	test("无活动任务 -> settled 不干预", () => {
		const ledger = new TaskCompletionLedger();
		const controller = makeController(ledger);
		expect(controller.handle(settled)).toEqual([]);
	});

	test("成功只读结果可绑定 task_verify", () => {
		const ledger = new TaskCompletionLedger();
		ledger.setContract(contract);
		ledger.recordToolCall("m1", "bash", { command: "npm uninstall -g example-tool" });
		ledger.recordToolResult("m1", "bash", { command: "npm uninstall -g example-tool" }, false);
		ledger.recordToolCall("c1", "bash", { command: "npm list -g example-tool" });
		ledger.recordToolResult("c1", "bash", { command: "npm list -g example-tool" }, false);
		expect(ledger.verify("package absent")).toEqual({ ok: true });
	});

	test("agent settled 且任务未完成 -> 一条 deduped steer", () => {
		const ledger = new TaskCompletionLedger();
		ledger.setContract(contract);
		ledger.recordToolCall("m1", "bash", { command: "npm uninstall -g example-tool" });
		ledger.recordToolResult("m1", "bash", { command: "npm uninstall -g example-tool" }, false);
		const controller = makeController(ledger);
		const first = controller.handle(settled);
		const second = controller.handle(settled);
		expect(first.filter((directive) => directive.kind === "steer")).toHaveLength(1);
		expect(second.filter((directive) => directive.kind === "steer")).toHaveLength(0);
	});

	test("doneWhen 未全部验证 -> task_complete block", () => {
		const ledger = new TaskCompletionLedger();
		ledger.setContract(contract);
		ledger.recordToolCall("m1", "bash", { command: "npm uninstall -g example-tool" });
		ledger.recordToolResult("m1", "bash", { command: "npm uninstall -g example-tool" }, false);
		const controller = makeController(ledger);
		const directives = controller.handle({ type: "tool.requested", callId: "c9", tool: "task_complete", input: {} });
		expect(directives.some((directive) => directive.kind === "block")).toBe(true);
	});

	test("全部验证后 task_complete 放行", () => {
		const ledger = new TaskCompletionLedger();
		ledger.setContract(contract);
		for (const [toolCallId, condition, command] of [
			["m1", null, "npm uninstall -g example-tool"],
			["v1", "package absent", "npm list -g example-tool"],
			["v2", "config absent", "test ! -e ~/.config/example-tool"],
		] as const) {
			ledger.recordToolCall(toolCallId, "bash", { command });
			ledger.recordToolResult(toolCallId, "bash", { command }, false);
			if (condition) expect(ledger.verify(condition)).toEqual({ ok: true });
		}
		expect(ledger.complete().ok).toBe(true);
		const controller = makeController(ledger);
		const directives = controller.handle({ type: "tool.requested", callId: "c9", tool: "task_complete", input: {} });
		expect(directives.some((directive) => directive.kind === "block")).toBe(false);
	});
});