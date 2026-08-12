import { afterEach, describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import localModelHarness from "../index";
import { FileLeaseLock } from "../src/core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Managed Pi lifecycle integration fixture（审查 F5）。
 * 用 stub 的 ExtensionAPI 驱动真实 registerActiveHarness，捕获 sendUserMessage /
 * notify / compact 副作用，验证「Pi hook 事件 -> controller policy -> 实际干预」整链。
 * 覆盖三个回归场景：
 *  1. turn_start 发 turn.started -> quality 每回合一条 steer（P0 防回归）；
 *  2. session_compact 发 context.compacted -> 压缩后注入 + 仍高则 pause（P1 防回归）；
 *  3. 新 session 重置去重 -> 再次触发 steer。
 */

const tempPaths: string[] = [];

afterEach(async () => {
	await Promise.all(tempPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
	process.env.LOCAL_MODEL_HARNESS_CONFIG = "";
});

async function writeTempConfig(content: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "local-model-harness-adapter-"));
	tempPaths.push(directory);
	const path = join(directory, "local-model-harness.json");
	await writeFile(path, content, "utf8");
	return path;
}

type Stub = {
	pi: ExtensionAPI;
	handlers: Map<string, (arg0: unknown, arg1: unknown) => unknown>;
	userMessages: string[];
	notifications: string[];
	tools: Map<string, (arg0: unknown, arg1: unknown) => unknown>;
	entries: Array<{ type: string; at: string; [key: string]: unknown }>;
};

function createPiStub(): Stub {
	const handlers = new Map<string, (arg0: unknown, arg1: unknown) => unknown>();
	const stub: Stub = {
		pi: {} as ExtensionAPI,
		handlers,
		userMessages: [],
		notifications: [],
		tools: new Map(),
		entries: [],
	};
	const pi = {
		on(event: unknown, handler: (arg0: unknown, arg1: unknown) => unknown) {
			handlers.set(event as string, handler);
		},
		registerTool(definition: { name: string; execute: (arg0: unknown, arg1: unknown) => unknown }) {
			stub.tools.set(definition.name, definition.execute);
		},
		registerCommand() {},
		appendEntry(type: string, data: Record<string, unknown>) {
			stub.entries.push({ type, at: String(data.at ?? ""), ...data });
		},
		sendMessage() {},
		sendUserMessage(message: unknown) {
			stub.userMessages.push(String(message));
		},
	} as unknown as ExtensionAPI;
	stub.pi = pi;
	return stub;
}

type ManagedContext = {
	ctx: ExtensionContext;
	compactCalls: number;
	notifications: string[];
};

function managedContext(percent: number | undefined, notifications: string[]): ManagedContext {
	const holder = { compact: 0 };
	const ctx = {
		get compactCalls() {
			return holder.compact;
		},
		ui: {
			notify: (message: string) => {
				notifications.push(String(message));
			},
			setStatus: () => {},
			setWorkingMessage: () => {},
		},
		mode: "json",
		hasUI: false,
		cwd: process.cwd(),
		sessionManager: undefined as unknown as ExtensionContext["sessionManager"],
		modelRegistry: undefined as unknown as ExtensionContext["modelRegistry"],
		model: { provider: "lmstudio", id: "managed-model" } as ExtensionContext["model"],
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => true,
		shutdown: () => {},
		getContextUsage: () => (percent === undefined ? undefined : { percent }),
		compact: () => {
			holder.compact += 1;
		},
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
	return {
		ctx,
		get compactCalls() {
			return holder.compact;
		},
		notifications,
	};
}

const harnessConfig = JSON.stringify({
	provider: "lmstudio",
	models: ["managed-model"],
	watchdogThresholdPercent: 80,
});

async function setupHarness(overrides: Record<string, unknown> = {}): Promise<Stub> {
	const configPath = await writeTempConfig(JSON.stringify({ ...JSON.parse(harnessConfig), ...overrides }));
	process.env.LOCAL_MODEL_HARNESS_CONFIG = configPath;
	const stub = createPiStub();
	localModelHarness(stub.pi);
	return stub;
}

describe("adapter lifecycle: turn_start -> turn.started (F0/P0)", () => {
	test("连续两个空回合各发一条 quality steer；第三个降级为 notify", async () => {
		const stub = await setupHarness();
		await stub.handlers.get("session_start")!({}, managedContext(undefined, stub.notifications).ctx);
		const turn = (content: unknown, percent?: number) => {
			const { ctx } = managedContext(percent, stub.notifications);
			stub.handlers.get("turn_start")!({}, ctx);
			return { ctx, result: stub.handlers.get("turn_end")!({ message: { content, stopReason: "end_turn" } }, ctx) };
		};
		await turn([]);
		await turn([]);
		await turn([]);

		// 两次 steer 一次 notify：前两次是质量纠正，第三次降级为 backing off。
		const steers = stub.userMessages.filter((message) => message.includes("[local-model-harness]"));
		expect(steers).toHaveLength(2);
		expect(steers.every((message) => !message.includes("backing off"))).toBe(true);
		expect(stub.notifications.some((message) => message.includes("backing off"))).toBe(true);
	});
});

describe("adapter lifecycle: session_compact -> context.compacted (F1/P1)", () => {
	test("上下文高 -> compact；压缩事件后注入；仍高则 pause 而非重复 compact", async () => {
		const stub = await setupHarness();
		await stub.handlers.get("session_start")!({}, managedContext(undefined, stub.notifications).ctx);

		// 回合 1：上下文 90% > 阈值 80，触发 compact。
		const first = managedContext(90, stub.notifications);
		stub.handlers.get("turn_start")!({}, first.ctx);
		await stub.handlers.get("turn_end")!({ message: { content: [{ type: "text", text: "real work" }], stopReason: "end_turn" } }, first.ctx);
		expect(first.compactCalls).toBe(1);

		// 压缩完成（Pi 触发 session_compact）：应注入协议与任务状态。
		await stub.handlers.get("session_compact")!({}, first.ctx);
		expect(stub.userMessages.some((message) => message.includes("Coding Protocol"))).toBe(true);

		// 回合 2：压缩后仍高 -> pause notify，不再重复 compact。
		const second = managedContext(95, stub.notifications);
		stub.handlers.get("turn_start")!({}, second.ctx);
		await stub.handlers.get("turn_end")!({ message: { content: [{ type: "text", text: "still high" }], stopReason: "end_turn" } }, second.ctx);
		expect(second.compactCalls).toBe(0);
		expect(stub.notifications.some((message) => message.includes("after compaction"))).toBe(true);
	});
});

describe("adapter lifecycle: session restart resets dedupe (P0 防回归)", () => {
	test("新 session 后相同空回复再次触发 steer", async () => {
		const stub = await setupHarness();
		await stub.handlers.get("session_start")!({}, managedContext(undefined, stub.notifications).ctx);
		stub.handlers.get("turn_start")!({}, managedContext(undefined, stub.notifications).ctx);
		await stub.handlers.get("turn_end")!({ message: { content: [], stopReason: "end_turn" } }, managedContext(undefined, stub.notifications).ctx);

		// 第二个 session：去重窗口应清空。
		await stub.handlers.get("session_start")!({}, managedContext(undefined, stub.notifications).ctx);
		stub.handlers.get("turn_start")!({}, managedContext(undefined, stub.notifications).ctx);
		await stub.handlers.get("turn_end")!({ message: { content: [], stopReason: "end_turn" } }, managedContext(undefined, stub.notifications).ctx);

		expect(stub.userMessages.filter((message) => message.includes("[local-model-harness]"))).toHaveLength(2);
	});
});

describe("adapter lifecycle: compact 后不重复注入 (复审 P1)", () => {
	test("session_compact -> 再次 before_agent_start 不重发 protocol", async () => {
		const stub = await setupHarness();
		await stub.handlers.get("session_start")!({}, managedContext(undefined, stub.notifications).ctx);

		// 首次 agent start：注入静态 block（协议 + 任务状态），并缓存指纹。
		const first = managedContext(undefined, stub.notifications);
		const firstStart = stub.handlers.get("before_agent_start")!({}, first.ctx) as { message?: unknown } | undefined;
		expect(firstStart?.message).toBeTruthy();

		// 回合：上下文 90% > 阈值 -> 触发 compact。
		const high = managedContext(90, stub.notifications);
		stub.handlers.get("turn_start")!({}, high.ctx);
		await stub.handlers.get("turn_end")!(
			{ message: { content: [{ type: "text", text: "real work" }], stopReason: "end_turn" } },
			high.ctx,
		);
		expect(high.compactCalls).toBe(1);

		// compact 注入的唯一 owner 是 ContextPolicy：sendUserMessage 恰好一次 protocol。
		await stub.handlers.get("session_compact")!({}, high.ctx);
		const protocolInjection = stub.userMessages.filter((message) => message.includes("Coding Protocol"));
		expect(protocolInjection).toHaveLength(1);

		// 再次 agent start：缓存保留 -> 不重发完整 block，protocol 不重复出现。
		const secondStart = stub.handlers.get("before_agent_start")!({}, first.ctx) as { message?: unknown } | undefined;
		expect(secondStart?.message).toBeUndefined();
		expect(stub.userMessages.filter((message) => message.includes("Coding Protocol"))).toHaveLength(1);
	});
});

describe("adapter lifecycle: contract-aware compact 去重 (审查第三轮 P1)", () => {
	test("建立 task_contract 后 compact 注入，再次 before_agent_start 不重复 task block", async () => {
		const stub = await setupHarness();
		await stub.handlers.get("session_start")!({}, managedContext(undefined, stub.notifications).ctx);

		// 初次 agent start：此时无契约，缓存为 protocol-only block。
		const first = managedContext(undefined, stub.notifications);
		const firstStart = stub.handlers.get("before_agent_start")!({}, first.ctx) as { message?: unknown } | undefined;
		expect(firstStart?.message).toBeTruthy();
		const firstBlock = (firstStart!.message as { content: string }).content;
		expect(firstBlock).toContain("Coding Protocol");
		expect(firstBlock).not.toContain("Task State");

		// 建立契约：ledger 出现 intent/scope/doneWhen，但 lastInjectedBlock 不变。
		await stub.tools.get("task_contract")!("call-1", {
			intent: "Fix the bug",
			scope: ["src/index.ts"],
			doneWhen: ["tests pass"],
			verificationPlan: ["npm test"],
			unresolved: [],
		});

		// 回合：上下文 90% -> 触发 compact。
		const high = managedContext(90, stub.notifications);
		stub.handlers.get("turn_start")!({}, high.ctx);
		await stub.handlers.get("turn_end")!(
			{ message: { content: [{ type: "text", text: "real work" }], stopReason: "end_turn" } },
			high.ctx,
		);
		expect(high.compactCalls).toBe(1);

		// compact 注入 protocol + Task State（ContextPolicy 唯一 owner），并同步 cache。
		await stub.handlers.get("session_compact")!({}, high.ctx);
		expect(stub.userMessages.filter((message) => message.includes("Coding Protocol"))).toHaveLength(1);
		expect(stub.userMessages.filter((message) => message.includes("Task State"))).toHaveLength(1);

		// 再次 agent start：buildInjectionBlock 与 cache（compact 后同一 payload）
		// 相同 -> 去重，不重发 task block。
		const secondStart = stub.handlers.get("before_agent_start")!({}, first.ctx) as { message?: unknown } | undefined;
		expect(secondStart?.message).toBeUndefined();
		expect(stub.userMessages.filter((message) => message.includes("Coding Protocol"))).toHaveLength(1);
		expect(stub.userMessages.filter((message) => message.includes("Task State"))).toHaveLength(1);
	});
});

describe("adapter lifecycle: compact 共享 verification projection (审查第四轮)", () => {
	test("edit 后 verificationPending 时 compact 注入包含 Verification State", async () => {
		const stub = await setupHarness();
		await stub.handlers.get("session_start")!({}, managedContext(undefined, stub.notifications).ctx);

		// edit 成功 -> telemetry verificationPending = true。
		stub.handlers.get("tool_result")!(
			{ toolCallId: "c1", toolName: "edit", input: { path: "src/index.ts" }, isError: false },
			managedContext(undefined, stub.notifications).ctx,
		);

		// 上下文 90% -> compact。
		const high = managedContext(90, stub.notifications);
		stub.handlers.get("turn_start")!({}, high.ctx);
		await stub.handlers.get("turn_end")!(
			{ message: { content: [{ type: "text", text: "edited" }], stopReason: "end_turn" } },
			high.ctx,
		);
		expect(high.compactCalls).toBe(1);

		// compact 注入 = 同一 buildInjectionBlock 投影，含 Coding Protocol 与 Verification State。
		await stub.handlers.get("session_compact")!({}, high.ctx);
		const injected = stub.userMessages.filter((message) => message.includes("Coding Protocol"));
		expect(injected).toHaveLength(1);
		expect(injected[0]).toContain("Verification State");
		expect(injected[0]).toContain("unverified");

		// 同一投影 -> 后续 agent start 不再重复投递。
		const restart = managedContext(undefined, stub.notifications);
		const nextStart = stub.handlers.get("before_agent_start")!({}, restart.ctx) as { message?: unknown } | undefined;
		expect(nextStart?.message).toBeUndefined();
		expect(stub.userMessages.filter((message) => message.includes("Coding Protocol"))).toHaveLength(1);
	});

	test("同一回合连续 compact 均重新注入完整 projection", async () => {
		const stub = await setupHarness();
		await stub.handlers.get("session_start")!({}, managedContext(undefined, stub.notifications).ctx);
		stub.handlers.get("tool_result")!(
			{ toolCallId: "c1", toolName: "edit", input: { path: "src/index.ts" }, isError: false },
			managedContext(undefined, stub.notifications).ctx,
		);

		const compact = managedContext(undefined, stub.notifications);
		await stub.handlers.get("session_compact")!({}, compact.ctx);
		await stub.handlers.get("session_compact")!({}, compact.ctx);

		const injected = stub.userMessages.filter((message) => message.includes("Coding Protocol"));
		expect(injected).toHaveLength(2);
		expect(injected.every((message) => message.includes("Verification State"))).toBe(true);
	});
});

describe("adapter lifecycle: task_complete 执行顺序", () => {
	test("已验证任务先通过 tool_call，再由注册工具完成账本", async () => {
		const stub = await setupHarness();
		const { ctx } = managedContext(undefined, stub.notifications);
		await stub.handlers.get("session_start")!({}, ctx);

		await stub.tools.get("task_contract")!("contract-1", {
			intent: "Create GitHub introduction",
			scope: ["GITHUB_INTRO.md"],
			doneWhen: ["GitHub introduction exists"],
			verificationPlan: ["test -f GITHUB_INTRO.md"],
			unresolved: [],
		});
		stub.handlers.get("tool_call")!(
			{ toolCallId: "write-1", toolName: "write", input: { path: "GITHUB_INTRO.md", content: "intro" } },
			ctx,
		);
		stub.handlers.get("tool_result")!(
			{ toolCallId: "write-1", toolName: "write", input: { path: "GITHUB_INTRO.md", content: "intro" }, isError: false },
			ctx,
		);
		stub.handlers.get("tool_call")!(
			{ toolCallId: "verify-1", toolName: "bash", input: { command: "test -f GITHUB_INTRO.md" } },
			ctx,
		);
		stub.handlers.get("tool_result")!(
			{ toolCallId: "verify-1", toolName: "bash", input: { command: "test -f GITHUB_INTRO.md" }, isError: false },
			ctx,
		);
		await stub.tools.get("task_verify")!("task-verify-1", { condition: "GitHub introduction exists" });

		const completionRequest = stub.handlers.get("tool_call")!(
			{ toolCallId: "complete-1", toolName: "task_complete", input: {} },
			ctx,
		);
		expect(completionRequest).toBeUndefined();
		await expect(stub.tools.get("task_complete")!("complete-1", {})).resolves.toBeTruthy();
		expect(stub.entries.at(-1)).toMatchObject({
			type: "local-task",
			snapshot: { completed: true, missingConditions: [] },
		});
	});
});

describe("adapter lifecycle: tool execution releases model lock", () => {
	test("工具开始后，另一受管理 session 可立即获得锁", async () => {
		const directory = await mkdtemp(join(tmpdir(), "local-model-harness-tool-lock-"));
		tempPaths.push(directory);
		const lockPath = join(directory, "model.lock");
		const first = await setupHarness({ lockPath });
		const second = await setupHarness({ lockPath });
		const firstContext = managedContext(undefined, first.notifications).ctx;
		const secondContext = managedContext(undefined, second.notifications).ctx;

		await first.handlers.get("before_provider_request")!({}, firstContext);
		expect(existsSync(lockPath)).toBe(true);
		expect(first.handlers.has("tool_execution_start")).toBe(true);

		await first.handlers.get("tool_execution_start")!({}, firstContext);
		expect(existsSync(lockPath)).toBe(false);
		await second.handlers.get("before_provider_request")!({}, secondContext);
		expect(existsSync(lockPath)).toBe(true);
		await second.handlers.get("agent_end")!({}, secondContext);
	});
});

describe("adapter lifecycle: cancellation cleans model lock", () => {
	test("agent_end 释放已持有的模型锁", async () => {
		const directory = await mkdtemp(join(tmpdir(), "local-model-harness-cancel-"));
		tempPaths.push(directory);
		const lockPath = join(directory, "model.lock");
		const stub = await setupHarness({ lockPath });
		const { ctx } = managedContext(undefined, stub.notifications);

		await stub.handlers.get("before_provider_request")!({}, ctx);
		expect(existsSync(lockPath)).toBe(true);
		expect(stub.handlers.has("agent_end")).toBe(true);

		await stub.handlers.get("agent_end")!({}, ctx);
		expect(existsSync(lockPath)).toBe(false);
	});

	test("等待锁时取消会清除等待状态", async () => {
		const directory = await mkdtemp(join(tmpdir(), "local-model-harness-cancel-"));
		tempPaths.push(directory);
		const lockPath = join(directory, "model.lock");
		const owner = new FileLeaseLock(lockPath);
		expect(await owner.tryAcquire()).toBe(true);

		const stub = await setupHarness({ lockPath });
		const abort = new AbortController();
		const { ctx } = managedContext(undefined, stub.notifications);
		const statuses: Array<[string, string | undefined]> = [];
		const working: Array<string | undefined> = [];
		ctx.signal = abort.signal;
		ctx.ui.setStatus = (key: string, value?: string) => statuses.push([key, value]);
		ctx.ui.setWorkingMessage = (message?: string) => working.push(message);

		const waiting = stub.handlers.get("before_provider_request")!({}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		abort.abort();
		await waiting;

		expect(statuses).toContainEqual(["local-model-lock", undefined]);
		expect(working).toContain(undefined);
		await owner.release();
	});
});

describe("adapter resilience: hook 异常不冒泡 (review 问题 1)", () => {
	test("sendUserMessage 抛错 -> turn_end 不抛、错误落 local-error、后续 hook 仍工作", async () => {
		const stub = await setupHarness();
		await stub.handlers.get("session_start")!({}, managedContext(undefined, stub.notifications).ctx);
		const emptyTurn = () =>
			stub.handlers.get("turn_end")!({ message: { content: [], stopReason: "end_turn" } }, managedContext(undefined, stub.notifications).ctx);

		stub.handlers.get("turn_start")!({}, managedContext(undefined, stub.notifications).ctx);
		await emptyTurn();
		stub.pi.sendUserMessage = () => {
			throw new Error("boom: inject failed");
		};
		stub.handlers.get("turn_start")!({}, managedContext(undefined, stub.notifications).ctx);
		await expect(emptyTurn()).resolves.not.toThrow();

		const errors = stub.entries.filter((entry) => entry.type === "local-error");
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((entry) => String(entry.hook).includes("applyDirectives"))).toBe(true);

		stub.pi.sendUserMessage = (message: unknown) => {
			stub.userMessages.push(String(message));
		};
		stub.handlers.get("turn_start")!({}, managedContext(undefined, stub.notifications).ctx);
		await stub.handlers.get("turn_end")!({ message: { content: [], stopReason: "end_turn" } }, managedContext(undefined, stub.notifications).ctx);
		expect(stub.userMessages.some((message) => message.includes("[local-model-harness]"))).toBe(true);
	});

	test("getContextUsage 抛错 -> turn_end 不抛且锁仍释放，后续可重新取得", async () => {
		const stub = await setupHarness();
		await stub.handlers.get("session_start")!({}, managedContext(undefined, stub.notifications).ctx);

		const ctx = managedContext(undefined, stub.notifications).ctx;
		const brokenCtx = {
			...ctx,
			getContextUsage: () => {
				throw new Error("boom: usage unavailable");
			},
		} as ExtensionContext;

		await expect(
			stub.handlers.get("turn_end")!({ message: { content: [{ type: "text", text: "work" }], stopReason: "end_turn" } }, brokenCtx),
		).resolves.not.toThrow();

		await expect(stub.handlers.get("session_shutdown")!({}, ctx)).resolves.not.toThrow();
		const acquireCtx = managedContext(undefined, stub.notifications).ctx;
		await expect(stub.handlers.get("before_provider_request")!({}, acquireCtx)).resolves.not.toThrow();
	});

	test("干预副作用抛错时契约门禁仍返回 block（fail-closed）", async () => {
		const stub = await setupHarness();
		await stub.handlers.get("session_start")!({}, managedContext(undefined, stub.notifications).ctx);
		stub.pi.sendUserMessage = () => {
			throw new Error("boom");
		};

		const result = stub.handlers.get("tool_call")!(
			{ toolCallId: "c1", toolName: "edit", input: { path: "src/index.ts" } },
			managedContext(undefined, stub.notifications).ctx,
		) as { block?: boolean; reason?: string } | undefined;
		expect(result).toMatchObject({ block: true });
		expect(String(result?.reason)).toContain("contract");
	});
});

describe("model 切换语义 (review 问题 2)", () => {
	test("云端模型不触发干预，切回名单内本地模型恢复", async () => {
		const stub = await setupHarness();
		await stub.handlers.get("session_start")!({}, managedContext(undefined, stub.notifications).ctx);
		const cloud = {
			...managedContext(undefined, stub.notifications).ctx,
			model: { provider: "openai", id: "gpt-4o" },
		} as ExtensionContext;
		const local = managedContext(undefined, stub.notifications).ctx;

		stub.handlers.get("turn_start")!({}, cloud);
		await stub.handlers.get("turn_end")!({ message: { content: [], stopReason: "end_turn" } }, cloud);
		stub.handlers.get("turn_start")!({}, cloud);
		await stub.handlers.get("turn_end")!({ message: { content: [], stopReason: "end_turn" } }, cloud);
		expect(stub.userMessages.filter((m) => m.includes("[local-model-harness]"))).toHaveLength(0);

		stub.handlers.get("turn_start")!({}, local);
		await stub.handlers.get("turn_end")!({ message: { content: [], stopReason: "end_turn" } }, local);
		expect(stub.userMessages.some((m) => m.includes("[local-model-harness]"))).toBe(true);
	});

	test("model_select 切换时 status 与 turnCap 边界重置", async () => {
		const stub = await setupHarness();
		const statuses: Array<[string, string | undefined]> = [];
		const ctx = managedContext(undefined, stub.notifications).ctx;
		ctx.ui.setStatus = (key: string, value?: string) => statuses.push([key, value]);

		stub.handlers.get("model_select")!({ model: { provider: "openai", id: "gpt-4o" } }, ctx);
		expect(statuses).toContainEqual(["local-model-harness", undefined]);

		statuses.splice(0);
		stub.handlers.get("model_select")!({ model: { provider: "lmstudio", id: "managed-model" } }, ctx);
		expect(statuses).toContainEqual(["local-model-harness", "active"]);
	});
});