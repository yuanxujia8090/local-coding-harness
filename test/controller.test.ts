import { describe, expect, test } from "vitest";
import { HarnessController } from "../src/controller";
import type { Directive, Policy } from "../src/policy";
import type { HarnessEvent } from "../src/events";
import type { HarnessConfig } from "../src/config";
import type { HarnessState } from "../src/state";

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

function recordingPolicy(id: string, events: string[], produce: Directive[] = []): Policy & { evaluated: string[] } {
	return {
		id,
		evaluated: [],
		evaluate(event: HarnessEvent): Directive[] {
			if (events.includes(event.type)) {
				this.evaluated.push(event.type);
			}
			return produce;
		},
	};
}

describe("HarnessController", () => {
	test("reduce 先于 policy：policy 能看到事件已更新状态", () => {
		const seenTurnCounts: number[] = [];
		const turnSpy: Policy = {
			id: "turn-spy",
			evaluate(event: HarnessEvent, state: Readonly<HarnessState>) {
				if (event.type === "turn.started") seenTurnCounts.push(state.session.turns);
				return [];
			},
		};
		const controller = new HarnessController(testConfig(), [turnSpy]);
		controller.handle({ type: "turn.started" });
		controller.handle({ type: "turn.started" });
		expect(seenTurnCounts).toEqual([1, 2]);
	});

	test("policies 按传入顺序执行", () => {
		const order: string[] = [];
		const a: Policy = {
			id: "a",
			evaluate(event: HarnessEvent) {
				order.push("a");
				return [];
			},
		};
		const b: Policy = {
			id: "b",
			evaluate(event: HarnessEvent) {
				order.push("b");
				return [];
			},
		};
		const controller = new HarnessController(testConfig(), [a, b]);
		controller.handle({ type: "turn.started" });
		expect(order).toEqual(["a", "b"]);
	});

	test("block 覆盖 allow", () => {
		const allow: Policy = {
			id: "allow-policy",
			evaluate() {
				return [{ kind: "allow" }];
			},
		};
		const block: Policy = {
			id: "block-policy",
			evaluate() {
				return [{ kind: "block", policy: "block-policy", reason: "denied" }];
			},
		};
		const controller = new HarnessController(testConfig(), [allow, block]);
		const directives = controller.handle({ type: "tool.requested", callId: "c1", tool: "write", input: {} });
		expect(directives.some((directive) => directive.kind === "block")).toBe(true);
		expect(directives.some((directive) => directive.kind === "allow")).toBe(false);
	});

	test("同一事件只保留最高优先级 steer", () => {
		const low: Policy = {
			id: "low",
			evaluate(event: HarnessEvent) {
				return event.type === "agent.settled"
					? [{ kind: "steer", policy: "low", message: "low steer", dedupeKey: "low" }]
					: [];
			},
		};
		const high: Policy = {
			id: "high",
			evaluate(event: HarnessEvent) {
				return event.type === "agent.settled"
					? [{ kind: "steer", policy: "high", message: "high steer", dedupeKey: "high" }]
					: [];
			},
		};
		// policy 数组顺序即固定优先级（arch 4.4），高优先级在前。
		const controller = new HarnessController(testConfig(), [high, low]);
		const directives = controller.handle({ type: "agent.settled" });
		const steers = directives.filter((directive) => directive.kind === "steer");
		expect(steers).toHaveLength(1);
		expect(steers[0].policy).toBe("high");
	});

	test("相同 dedupeKey 不重复返回", () => {
		const policy: Policy = {
			id: "steerer",
			evaluate(event: HarnessEvent) {
				return event.type === "agent.settled"
					? [{ kind: "steer", policy: "steerer", message: "please continue", dedupeKey: "continue" }]
					: [];
			},
		};
		const controller = new HarnessController(testConfig(), [policy]);
		expect(controller.handle({ type: "agent.settled" })).toHaveLength(1);
		expect(controller.handle({ type: "agent.settled" })).toHaveLength(0);
	});

	test("snapshot 不暴露可写内部引用", () => {
		const controller = new HarnessController(testConfig(), []);
		controller.handle({ type: "turn.started" });
		const snapshot = controller.snapshot();
		(snapshot as { session: { turns: number } }).session.turns = 999;
		(snapshot.interventions as { blocks: number }).blocks = 999;
		expect(controller.snapshot().session.turns).toBe(1);
		expect(controller.snapshot().interventions.blocks).toBe(0);
	});

	test("non-discriminated 事件被拒绝", () => {
		const controller = new HarnessController(testConfig(), []);
		expect(() => controller.handle({ type: "bogus.bogus" } as unknown as HarnessEvent)).toThrow();
	});

	test("context.compacted 缺 projection 时被拒绝", () => {
		const controller = new HarnessController(testConfig(), []);
		expect(() => controller.handle({ type: "context.compacted" } as unknown as HarnessEvent)).toThrow();
	});
});