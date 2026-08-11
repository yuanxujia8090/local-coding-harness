import { describe, expect, test } from "vitest";
import { HarnessController } from "../src/controller";
import { createLoopPolicy } from "../src/policies/loop";
import { createQualityPolicy } from "../src/policies/quality";
import { createContextPolicy } from "../src/policies/context";
import type { HarnessConfig } from "../src/config";
import type { Directive, Policy } from "../src/policy";
import type { QualityBlock } from "../src/quality";

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

function makeController(config: HarnessConfig, policies: readonly Policy[]): HarnessController {
	return new HarnessController(config, policies);
}

function steers(directives: readonly Directive[]): Directive[] {
	return directives.filter((directive) => directive.kind === "steer");
}

const text = (content: string): QualityBlock => ({ type: "text", text: content });
const toolCall = (name: string, args: Record<string, unknown>): QualityBlock => ({ type: "toolCall", name, arguments: args });
const thinking = (thought: string): QualityBlock => ({ type: "thinking", thinking: thought });

function turnEnd(blocks: readonly QualityBlock[], overrides: Partial<{ stopReason: string; contextPercent: number }> = {}): { type: "turn.end"; content: readonly QualityBlock[]; stopReason?: string; contextPercent?: number } {
	return { type: "turn.end", content: blocks, ...overrides };
}

const emptyTurn = turnEnd([]);

describe("LoopPolicy", () => {
	test("重复签名未达窗口 -> 不干预", () => {
		const controller = makeController(testConfig(), [createLoopPolicy()]);
		const directives = controller.handle({ type: "tool.requested", callId: "c1", tool: "bash", input: { command: "ls -la" } });
		expect(steers(directives)).toHaveLength(0);
	});

	test("重复签名达到窗口 -> steer", () => {
		const controller = makeController(testConfig({ loopGuardWindow: 3 }), [createLoopPolicy()]);
		controller.handle({ type: "tool.requested", callId: "c1", tool: "bash", input: { command: "ls -la" } });
		controller.handle({ type: "tool.requested", callId: "c2", tool: "bash", input: { command: "ls -la" } });
		const third = controller.handle({ type: "tool.requested", callId: "c3", tool: "bash", input: { command: "ls -la" } });
		expect(steers(third)).toHaveLength(1);
		const steer = steers(third)[0];
		expect(steer.kind === "steer" && steer.message).toContain("3 times in a row");
	});

	test("只读工具同签名重复也达到窗口 -> steer", () => {
		const controller = makeController(testConfig({ loopGuardWindow: 3 }), [createLoopPolicy()]);
		const path = "/pi/context-mode/SKILL.md";
		for (let i = 0; i < 3; i++) {
			const directives = controller.handle({ type: "tool.requested", callId: `r${i}`, tool: "read", input: { path } });
			if (i === 2) expect(steers(directives)).toHaveLength(1);
			else expect(steers(directives)).toHaveLength(0);
		}
	});

	test("签名变化重置计数", () => {
		const controller = makeController(testConfig({ loopGuardWindow: 3 }), [createLoopPolicy()]);
		controller.handle({ type: "tool.requested", callId: "c1", tool: "bash", input: { command: "ls -la" } });
		controller.handle({ type: "tool.requested", callId: "c2", tool: "bash", input: { command: "ls -la" } });
		controller.handle({ type: "tool.requested", callId: "c3", tool: "read", input: { path: "README.md" } });
		const fourth = controller.handle({ type: "tool.requested", callId: "c4", tool: "bash", input: { command: "ls -la" } });
		expect(steers(fourth)).toHaveLength(0);
	});

	test("同签名已通知过不重复 steer", () => {
		const controller = makeController(testConfig({ loopGuardWindow: 3 }), [createLoopPolicy()]);
		controller.handle({ type: "tool.requested", callId: "c1", tool: "bash", input: { command: "ls -la" } });
		controller.handle({ type: "tool.requested", callId: "c2", tool: "bash", input: { command: "ls -la" } });
		const third = controller.handle({ type: "tool.requested", callId: "c3", tool: "bash", input: { command: "ls -la" } });
		expect(steers(third)).toHaveLength(1);
		controller.handle({ type: "tool.requested", callId: "c4", tool: "bash", input: { command: "ls -la" } });
		controller.handle({ type: "tool.requested", callId: "c5", tool: "bash", input: { command: "ls -la" } });
		controller.handle({ type: "tool.requested", callId: "c6", tool: "bash", input: { command: "ls -la" } });
		const sixth = controller.handle({ type: "tool.requested", callId: "c6", tool: "bash", input: { command: "ls -la" } });
		expect(steers(sixth)).toHaveLength(0);
	});

	test("可配置只读工具不影响 loop 判定", () => {
		const controller = makeController(testConfig({ loopGuardWindow: 2, gateExtraReadOnlyTools: ["read"] }), [createLoopPolicy()]);
		controller.handle({ type: "tool.requested", callId: "c1", tool: "bash", input: { command: "ls -la" } });
		controller.handle({ type: "tool.requested", callId: "c2", tool: "bash", input: { command: "ls -la" } });
		controller.handle({ type: "tool.requested", callId: "c3", tool: "read", input: { path: "README.md" } });
		controller.handle({ type: "tool.requested", callId: "c4", tool: "bash", input: { command: "ls -la" } });
		const directives = controller.handle({ type: "tool.requested", callId: "c5", tool: "bash", input: { command: "ls -la" } });
		// read 隔离了两次 ls，窗口内不再全是相同签名；read 为只读工具不推进窗口。
		expect(steers(directives)).toHaveLength(0);
	});

	test("research drift 达到阈值前不干预，达到后 steer", () => {
		const controller = makeController(testConfig({ researchDriftThreshold: 3 }), [createLoopPolicy()]);
		for (let i = 0; i < 2; i++) {
			const directives = controller.handle(turnEnd([toolCall("read", { path: `file-${i}.md` })]));
			expect(steers(directives)).toHaveLength(0);
		}
		const third = controller.handle(turnEnd([toolCall("read", { path: "file-2.md" })]));
		expect(steers(third)).toHaveLength(1);
		const steer = steers(third)[0];
		expect(steer.kind === "steer" && steer.message).toContain("drifting");
	});

	test("research drift 中任一回合有产出 -> reset", () => {
		const controller = makeController(testConfig({ researchDriftThreshold: 3 }), [createLoopPolicy()]);
		controller.handle(turnEnd([toolCall("read", { path: "a.md" })]));
		controller.handle(turnEnd([toolCall("read", { path: "b.md" })]));
		controller.handle(turnEnd([text("Found the bug in parseToolProbe.")]));
		controller.handle(turnEnd([toolCall("read", { path: "c.md" })]));
		// reset 后只累计了 1 个只读，未达阈值。
		const oneAfterReset = controller.handle(turnEnd([toolCall("read", { path: "d.md" })]));
		expect(steers(oneAfterReset)).toHaveLength(0);
		// 第 3 个（c、d、e）才达到阈值，触发 steer。
		const thirdAfterReset = controller.handle(turnEnd([toolCall("read", { path: "e.md" })]));
		expect(steers(thirdAfterReset)).toHaveLength(1);
	});
});

describe("QualityPolicy", () => {
	// 质量纠正按回合投递：每个异常回合前都要有 turn.started（事件模型语义）。
	function nextTurn(controller: HarnessController, blocks: readonly QualityBlock[], overrides: Parameters<typeof turnEnd>[1] = {}) {
		controller.handle({ type: "turn.started" });
		return controller.handle(turnEnd(blocks, overrides));
	}

	test("空回复不超过阈值 -> steer", () => {
		const controller = makeController(testConfig(), [createQualityPolicy()]);
		const directives = nextTurn(controller, []);
		expect(steers(directives)).toHaveLength(1);
		const steer = steers(directives)[0];
		expect(steer.kind === "steer" && steer.message).toContain("empty");
	});

	test("空参数工具调用 -> steer 按其 tool 名称", () => {
		const controller = makeController(testConfig(), [createQualityPolicy()]);
		const directives = nextTurn(controller, [toolCall("read", {})]);
		expect(steers(directives)).toHaveLength(1);
		const steer = steers(directives)[0];
		expect(steer.kind === "steer" && steer.message).toContain("read");
	});

	test("无空参数工具单参（task_complete 允许空参数）", () => {
		const controller = makeController(testConfig(), [createQualityPolicy()]);
		const directives = nextTurn(controller, [toolCall("task_complete", {})]);
		expect(steers(directives)).toHaveLength(0);
	});

	test("连续异常超过阈值 -> notify 降级而非 steer", () => {
		const controller = makeController(testConfig(), [createQualityPolicy()]);
		const maxSteers = 2;
		for (let i = 0; i < maxSteers; i++) {
			const directives = nextTurn(controller, []);
			expect(steers(directives)).toHaveLength(1);
		}
		const third = nextTurn(controller, []);
		expect(steers(third)).toHaveLength(0);
		expect(third.some((directive) => directive.kind === "notify")).toBe(true);
	});

	test("正常回合重置 consecutive 计数", () => {
		const controller = makeController(testConfig(), [createQualityPolicy()]);
		nextTurn(controller, []);
		nextTurn(controller, []);
		nextTurn(controller, [text("normal response with content")]);
		const again = nextTurn(controller, []);
		// 重置后从 1 开始，仍 <=2，应 steer 而不是 notify
		expect(steers(again)).toHaveLength(1);
		expect(again.some((directive) => directive.kind === "notify")).toBe(false);
	});

	test("aborted / error 回合不触发质量判定", () => {
		const controller = makeController(testConfig(), [createQualityPolicy()]);
		const aborted = controller.handle(turnEnd([], { stopReason: "aborted" }));
		expect(steers(aborted)).toHaveLength(0);
	});
});

describe("ContextPolicy", () => {
	test("上下文达到阈值 -> compact；未超阈值不 compact", () => {
		const controller = makeController(testConfig({ watchdogThresholdPercent: 80 }), [createContextPolicy()]);
		const low = controller.handle(turnEnd([], { contextPercent: 55 }));
		expect(low.some((directive) => directive.kind === "compact")).toBe(false);
		const high = controller.handle(turnEnd([], { contextPercent: 82 }));
		expect(high.some((directive) => directive.kind === "compact")).toBe(true);
	});

	test("margin 内不重复 compact", () => {
		const controller = makeController(testConfig({ watchdogThresholdPercent: 80 }), [createContextPolicy()]);
		controller.handle(turnEnd([], { contextPercent: 82 }));
		// 收缩到 margin 内（70% 到 80-10）不重复
		const second = controller.handle(turnEnd([], { contextPercent: 72 }));
		expect(second.some((directive) => directive.kind === "compact")).toBe(false);
		// 回落低于 margin 后允许再次
		const third = controller.handle(turnEnd([], { contextPercent: 60 }));
		expect(third.some((directive) => directive.kind === "compact")).toBe(false);
		const fourth = controller.handle(turnEnd([], { contextPercent: 84 }));
		expect(fourth.some((directive) => directive.kind === "compact")).toBe(true);
	});

	test("compaction 后注入事件携带的完整投影", () => {
		const controller = makeController(testConfig(), [createContextPolicy()]);
		controller.handle(turnEnd([], { contextPercent: 84 }));
		const directives = controller.handle({
			type: "context.compacted",
			projection: "Coding Protocol\n\n## Verification State\n\n## Task State\n…",
		});
		const inject = directives.find((directive) => directive.kind === "inject");
		expect(inject).toBeDefined();
		expect(inject?.kind === "inject" && inject.message).toBe("Coding Protocol\n\n## Verification State\n\n## Task State\n…");
	});
});