import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ContextWatchdog,
	ContractGate,
	FileLeaseLock,
	LoopGuard,
	SessionTelemetry,
	TaskCompletionLedger,
	buildCodingProtocol,
	buildContractBlockReason,
	buildGateSteerMessage,
	formatTaskCompletionReport,
	formatTelemetryReport,
	isManagedLocalModel,
	isStateChangingTool,
	isVerificationCommand,
	loadHarnessConfig,
	parseToolProbe,
	toolCallSignature,
	type HarnessConfig,
} from "../src/core";

const tempPaths: string[] = [];

afterEach(async () => {
	await Promise.all(tempPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function writeTempConfig(content: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "local-model-harness-"));
	tempPaths.push(directory);
	const path = join(directory, "local-model-harness.json");
	await writeFile(path, content, "utf8");
	return path;
}

function testConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
	return {
		provider: "lmstudio",
		models: ["test-model-7b", "test-model-32b"],
		lockPath: join(tmpdir(), "local-model-harness-test.lock"),
		watchdogEnabled: true,
		watchdogThresholdPercent: 80,
		loopGuardEnabled: true,
		loopGuardWindow: 3,
		protocolLanguage: "en",
		gateEnabled: true,
		...overrides,
	};
}

describe("loadHarnessConfig", () => {
	test("loads a minimal config with defaults", async () => {
		const path = await writeTempConfig(JSON.stringify({ models: ["model-a"] }));

		const result = loadHarnessConfig(path);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.provider).toBe("lmstudio");
		expect(result.config.models).toEqual(["model-a"]);
		expect(result.config.watchdogEnabled).toBe(true);
		expect(result.config.watchdogThresholdPercent).toBe(80);
		expect(result.config.loopGuardEnabled).toBe(true);
		expect(result.config.loopGuardWindow).toBe(3);
		expect(result.config.lockPath).toContain("local-model-harness.lock");
	});

	test("rejects a missing file with setup guidance", () => {
		const result = loadHarnessConfig(join(tmpdir(), "does-not-exist-local-model-harness.json"));

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("Config file not found");
	});

	test("rejects invalid JSON", async () => {
		const path = await writeTempConfig("{ not json");

		const result = loadHarnessConfig(path);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("not valid JSON");
	});

	test("rejects an empty models list", async () => {
		const path = await writeTempConfig(JSON.stringify({ models: [] }));

		const result = loadHarnessConfig(path);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain('"models"');
	});

	test("honours watchdog and loop guard overrides", async () => {
		const path = await writeTempConfig(JSON.stringify({
			provider: "ollama",
			models: ["model-a", "model-a", " model-b "],
			contextWatchdog: { enabled: false, thresholdPercent: 70 },
			loopGuard: { enabled: false, window: 4 },
			protocolLanguage: "zh",
		}));

		const result = loadHarnessConfig(path);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.provider).toBe("ollama");
		expect(result.config.models).toEqual(["model-a", "model-b"]);
		expect(result.config.watchdogEnabled).toBe(false);
		expect(result.config.watchdogThresholdPercent).toBe(70);
		expect(result.config.loopGuardEnabled).toBe(false);
		expect(result.config.loopGuardWindow).toBe(4);
		expect(result.config.protocolLanguage).toBe("zh");
	});

	test("falls back to English protocol for unknown protocolLanguage values", async () => {
		const path = await writeTempConfig(JSON.stringify({ models: ["model-a"], protocolLanguage: "fr" }));

		const result = loadHarnessConfig(path);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.protocolLanguage).toBe("en");
	});

	test("honours gate.enabled=false as an escape hatch", async () => {
		const path = await writeTempConfig(JSON.stringify({ models: ["model-a"], gate: { enabled: false } }));

		const result = loadHarnessConfig(path);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.gateEnabled).toBe(false);
	});
});

describe("isManagedLocalModel", () => {
	test("accepts only configured provider models", () => {
		const config = testConfig();

		expect(isManagedLocalModel({ provider: "lmstudio", id: "test-model-7b" }, config)).toBe(true);
		expect(isManagedLocalModel({ provider: "lmstudio", id: "test-model-32b" }, config)).toBe(true);
		expect(isManagedLocalModel({ provider: "lmstudio", id: "other-model" }, config)).toBe(false);
		expect(isManagedLocalModel({ provider: "openai", id: "test-model-7b" }, config)).toBe(false);
		expect(isManagedLocalModel(undefined, config)).toBe(false);
	});
});

describe("buildCodingProtocol", () => {
	test("requires inspect, targeted verification, and an honest final report", () => {
		const protocol = buildCodingProtocol("en");

		expect(protocol).toContain("Read project instructions and relevant code before editing.");
		expect(protocol).toContain("Run the smallest relevant verification after changes.");
		expect(protocol).toContain("State clearly when verification was not run.");
		expect(protocol).toContain("Reply to the user in the language the user is using.");
	});

	test("provides a semantically equivalent Chinese protocol", () => {
		const protocol = buildCodingProtocol("zh");

		expect(protocol).toContain("## 本地编码协议");
		expect(protocol).toContain("编辑前先阅读项目说明和相关代码。");
		expect(protocol).toContain("修改后运行最小相关验证。");
		expect(protocol).toContain("没有运行验证时必须明确说明。");
		expect(protocol).toContain("用用户使用的语言回复。");
	});

	test("defaults to English", () => {
		expect(buildCodingProtocol()).toContain("## Local Coding Protocol");
	});
});

describe("parseToolProbe", () => {
	test("accepts an OpenAI tool-call response for the requested probe tool", () => {
		const result = parseToolProbe({
			choices: [{
				finish_reason: "tool_calls",
				message: { tool_calls: [{ function: { name: "pi_local_probe" } }] },
			}],
		}, "pi_local_probe");

		expect(result.ok).toBe(true);
	});

	test("rejects a prose response without the requested tool call", () => {
		const result = parseToolProbe({
			choices: [{ finish_reason: "stop", message: { content: "I cannot call tools." } }],
		}, "pi_local_probe");

		expect(result).toEqual({ ok: false, reason: "No pi_local_probe tool call in response." });
	});
});

describe("SessionTelemetry", () => {
	test("recognises successful project verification commands", () => {
		expect(isVerificationCommand("pnpm test -- --runInBand")).toBe(true);
		expect(isVerificationCommand("pytest tests/auth_test.py")).toBe(true);
		expect(isVerificationCommand("npm run typecheck")).toBe(true);
		expect(isVerificationCommand("git status --short")).toBe(false);
	});

	test("tracks pending changes until successful verification", () => {
		const telemetry = new SessionTelemetry("test-model-7b", 1_000);

		telemetry.recordToolResult("edit", { path: "src/auth.ts" }, false);
		telemetry.recordToolResult("bash", { command: "npm test" }, true);
		expect(telemetry.snapshot(2_000)).toMatchObject({
			changedFiles: ["src/auth.ts"],
			verificationPending: true,
			verificationCommands: [],
		});

		telemetry.recordToolResult("bash", { command: "npm test" }, false);
		expect(telemetry.snapshot(3_000)).toMatchObject({
			verificationPending: false,
			verificationCommands: ["npm test"],
		});
	});

	test("formats a concise local report", () => {
		const report = formatTelemetryReport({
			model: "test-model-7b",
			durationMs: 65_000,
			providerRequests: 3,
			lockWaitMs: 125,
			lockWaits: 0,
			lockWaitMaxMs: 125,
			toolCalls: 7,
			toolErrors: 1,
			toolErrorsByTool: { bash: 1 },
			changedFiles: ["src/auth.ts"],
			verificationPending: true,
			verificationCommands: [],
			contextPeakPercent: 48,
			compactions: 1,
			loopInterventions: 1,
			watchdogCompactions: 1,
		});

		expect(report).toContain("Model: test-model-7b");
		expect(report).toContain("Duration: 1m 5s");
		expect(report).toContain("Provider requests: 3");
		expect(report).toContain("Lock wait: 125ms");
		expect(report).toContain("Changed files: src/auth.ts");
		expect(report).toContain("Verification: pending (1 changed file)");
		expect(report).toContain("Context peak: 48%");
		expect(report).toContain("Compactions: 1 (1 watchdog-triggered)");
		expect(report).toContain("Loop interventions: 1");
	});

	test("reports lock contention and per-tool error breakdown", () => {
		const report = formatTelemetryReport({
			model: "test-model-7b",
			durationMs: 1_000,
			providerRequests: 41,
			lockWaitMs: 137_230,
			lockWaits: 12,
			lockWaitMaxMs: 45_000,
			toolCalls: 35,
			toolErrors: 6,
			toolErrorsByTool: { bash: 4, edit: 2 },
			changedFiles: [],
			verificationPending: false,
			verificationCommands: ["npm test"],
			contextPeakPercent: 16.3,
			compactions: 0,
			loopInterventions: 0,
			watchdogCompactions: 0,
		});

		expect(report).toContain("Lock wait: 137230ms (12 waits >500ms, max 45000ms)");
		expect(report).toContain("Tool calls: 35 (6 errors: bash 4, edit 2)");
		expect(report).toContain("Context peak: 16.3%");
	});

	test("reports provider, lock, tool, context, compaction, and intervention counters", () => {
		const telemetry = new SessionTelemetry("test-model-32b", 1_000);

		telemetry.recordProviderRequest(250);
		telemetry.recordProviderRequest(1_200);
		telemetry.recordToolResult("read", {}, false);
		telemetry.recordToolResult("bash", { command: "git status" }, true);
		telemetry.recordToolResult("bash", { command: "git diff" }, true);
		telemetry.recordToolResult("edit", { path: "src/a.ts" }, true);
		telemetry.recordContextPercent(48.12345);
		telemetry.recordContextPercent(31);
		telemetry.recordCompaction();
		telemetry.recordLoopIntervention();
		telemetry.recordWatchdogCompaction();

		expect(telemetry.snapshot(6_000)).toEqual({
			model: "test-model-32b",
			durationMs: 5_000,
			providerRequests: 2,
			lockWaitMs: 1_450,
			lockWaits: 1,
			lockWaitMaxMs: 1_200,
			toolCalls: 4,
			toolErrors: 3,
			toolErrorsByTool: { bash: 2, edit: 1 },
			changedFiles: [],
			verificationPending: false,
			verificationCommands: [],
			contextPeakPercent: 48.1,
			compactions: 1,
			loopInterventions: 1,
			watchdogCompactions: 1,
		});
	});
});

describe("TaskCompletionLedger", () => {
	const contract = {
		intent: "remove an application",
		scope: ["application package", "application config"],
		doneWhen: ["package absent", "config absent"],
		verificationPlan: ["inspect package", "inspect config"],
		unresolved: [],
	};

	test("treats only known read operations as safe without a contract", () => {
		expect(isStateChangingTool("read", { path: "README.md" })).toBe(false);
		expect(isStateChangingTool("task_verify", { condition: "result observed" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "git status --short" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "find . -name '*.ts'" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "find . -delete" })).toBe(true);
		expect(isStateChangingTool("bash", { command: "touch /tmp/side-effect" })).toBe(true);
	});

	test("treats read-only pipelines as safe and mixed pipelines as state-changing", () => {
		expect(isStateChangingTool("bash", { command: "git status --short | head -30" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "find . -maxdepth 2 | head -80" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "ls -R src | grep test | wc -l" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "cat foo > bar" })).toBe(true);
		expect(isStateChangingTool("bash", { command: "git status; rm -rf /tmp/x" })).toBe(true);
		expect(isStateChangingTool("bash", { command: "ls || rm fallback" })).toBe(true);
		expect(isStateChangingTool("bash", { command: "ls && rm something" })).toBe(true);
		expect(isStateChangingTool("bash", { command: "find . | xargs rm" })).toBe(true);
	});

	test("requires a contract before a state-changing tool call", () => {
		const ledger = new TaskCompletionLedger();

		expect(ledger.needsContractFor("bash", { command: "npm uninstall -g example-tool" })).toBe(true);
		expect(ledger.setContract(contract).ok).toBe(true);
		expect(ledger.needsContractFor("bash", { command: "npm uninstall -g example-tool" })).toBe(false);
	});

	test("rejects a completion claim when a condition lacks successful evidence", () => {
		const ledger = new TaskCompletionLedger();
		ledger.setContract(contract);
		ledger.recordToolCall("remove", "bash", { command: "npm uninstall -g example-tool" });
		ledger.recordToolResult("remove", "bash", { command: "npm uninstall -g example-tool" }, false);
		ledger.recordToolCall("check-package", "bash", { command: "npm list -g example-tool" });
		ledger.recordToolResult("check-package", "bash", { command: "npm list -g example-tool" }, false);
		expect(ledger.verify("package absent")).toEqual({ ok: true });

		expect(ledger.complete()).toEqual({
			ok: false,
			missingConditions: ["config absent"],
		});
	});

	test("completes only after every condition cites a distinct successful tool result", () => {
		const ledger = new TaskCompletionLedger();
		ledger.setContract(contract);
		ledger.recordToolCall("check-package", "bash", { command: "command -v example-tool" });
		ledger.recordToolResult("check-package", "bash", { command: "command -v example-tool" }, false);
		expect(ledger.verify("package absent")).toEqual({ ok: true });
		ledger.recordToolCall("check-config", "bash", { command: "test ! -e ~/.config/example-tool" });
		ledger.recordToolResult("check-config", "bash", { command: "test ! -e ~/.config/example-tool" }, false);
		expect(ledger.verify("config absent")).toEqual({ ok: true });

		expect(ledger.complete()).toEqual({ ok: true, missingConditions: [] });
		expect(ledger.snapshot()).toMatchObject({ completed: true, mutationToolCalls: [] });
	});

	test("reports missing completion conditions", () => {
		const ledger = new TaskCompletionLedger();
		ledger.setContract(contract);
		ledger.recordToolCall("remove", "bash", { command: "npm uninstall -g example-tool" });

		expect(formatTaskCompletionReport(ledger.snapshot())).toContain("Task completion: pending (package absent, config absent)");
	});
});

describe("FileLeaseLock", () => {
	test("allows only one owner until release", async () => {
		const directory = await mkdtemp(join(tmpdir(), "local-model-harness-lock-"));
		tempPaths.push(directory);
		const first = new FileLeaseLock(join(directory, "provider.lock"));
		const second = new FileLeaseLock(join(directory, "provider.lock"));

		expect(await first.tryAcquire()).toBe(true);
		expect(await second.tryAcquire()).toBe(false);
		await first.release();
		expect(await second.tryAcquire()).toBe(true);
		await second.release();
	});

	test("peekOwner exposes the holder pid while locked and null when free", async () => {
		const directory = await mkdtemp(join(tmpdir(), "local-model-harness-lock-"));
		tempPaths.push(directory);
		const lockPath = join(directory, "provider.lock");
		const lock = new FileLeaseLock(lockPath);

		expect(await FileLeaseLock.peekOwner(lockPath)).toBeNull();
		await lock.tryAcquire();
		const owner = await FileLeaseLock.peekOwner(lockPath);
		expect(owner?.pid).toBe(process.pid);
		expect(owner?.acquiredAt).not.toBe("");
		await lock.release();
		expect(await FileLeaseLock.peekOwner(lockPath)).toBeNull();
	});
});

describe("LoopGuard", () => {
	test("flags the same call repeated window times in a row", () => {
		const guard = new LoopGuard(3);

		expect(guard.record("bash", { command: "npm test" })).toBeNull();
		expect(guard.record("bash", { command: "npm test" })).toBeNull();
		expect(guard.record("bash", { command: "npm test" })).toBe("bash:npm test");
	});

	test("does not flag interleaved calls", () => {
		const guard = new LoopGuard(3);

		guard.record("bash", { command: "npm test" });
		guard.record("read", { path: "src/index.ts" });
		guard.record("bash", { command: "npm test" });
		expect(guard.record("bash", { command: "npm test" })).toBeNull();
	});

	test("notifies once per signature until reset", () => {
		const guard = new LoopGuard(2);

		expect(guard.record("bash", { command: "ls" })).toBeNull();
		expect(guard.record("bash", { command: "ls" })).toBe("bash:ls");
		expect(guard.record("bash", { command: "ls" })).toBeNull();
		guard.reset();
		expect(guard.record("bash", { command: "ls" })).toBeNull();
		expect(guard.record("bash", { command: "ls" })).toBe("bash:ls");
	});

	test("signatures distinguish tools and inputs", () => {
		expect(toolCallSignature("bash", { command: "npm test" })).toBe("bash:npm test");
		expect(toolCallSignature("edit", { path: "src/a.ts" })).toBe("edit:src/a.ts");
		expect(toolCallSignature("task_verify", { condition: "done" })).toBe('task_verify:{"condition":"done"}');
	});
});

describe("ContractGate", () => {
	test("escalates at the third and sixth block", () => {
		const gate = new ContractGate();

		expect(gate.recordBlock()).toEqual({ blocks: 1, steer: false, notify: false });
		expect(gate.recordBlock()).toEqual({ blocks: 2, steer: false, notify: false });
		expect(gate.recordBlock()).toEqual({ blocks: 3, steer: true, notify: false });
		expect(gate.recordBlock()).toEqual({ blocks: 4, steer: false, notify: false });
		expect(gate.recordBlock()).toEqual({ blocks: 5, steer: false, notify: false });
		expect(gate.recordBlock()).toEqual({ blocks: 6, steer: false, notify: true });
	});

	test("resets after a contract is established", () => {
		const gate = new ContractGate();

		gate.recordBlock();
		gate.recordBlock();
		gate.reset();
		expect(gate.blockCount).toBe(0);
		expect(gate.recordBlock()).toEqual({ blocks: 1, steer: false, notify: false });
	});
});

describe("buildContractBlockReason", () => {
	test("identifies the harness and shows a contract example", () => {
		const reason = buildContractBlockReason("en");

		expect(reason).toContain("[local-model-harness]");
		expect(reason).toContain("task_contract");
		expect(reason).toContain("doneWhen");
		expect(reason).toContain("Read-only actions");
	});

	test("provides a Chinese version", () => {
		const reason = buildContractBlockReason("zh");

		expect(reason).toContain("[local-model-harness]");
		expect(reason).toContain("任务契约");
		expect(reason).toContain("只读操作");
	});

	test("steer message reports the block count", () => {
		expect(buildGateSteerMessage(3, "en")).toContain("3 state-changing calls");
		expect(buildGateSteerMessage(3, "zh")).toContain("3 次状态变更调用");
	});
});

describe("ContextWatchdog", () => {
	test("stays quiet below threshold and unknown usage", () => {
		const watchdog = new ContextWatchdog(80);

		expect(watchdog.observe(55)).toEqual({ action: "none" });
		expect(watchdog.observe(null)).toEqual({ action: "none" });
		expect(watchdog.observe(undefined)).toEqual({ action: "none" });
	});

	test("triggers compaction at threshold, then verifies the result", () => {
		const watchdog = new ContextWatchdog(80);

		expect(watchdog.observe(82)).toEqual({ action: "compact" });
		expect(watchdog.observe(45)).toEqual({ action: "none" });
		expect(watchdog.observe(83)).toEqual({ action: "compact" });
	});

	test("pauses when compaction fails to free enough context", () => {
		const watchdog = new ContextWatchdog(80);

		expect(watchdog.observe(85)).toEqual({ action: "compact" });
		const paused = watchdog.observe(84);
		expect(paused.action).toBe("pause");
		expect(watchdog.isPaused).toBe(true);
		expect(watchdog.observe(86)).toEqual({ action: "none" });
	});

	test("resumes once usage drops clearly below threshold", () => {
		const watchdog = new ContextWatchdog(80);

		watchdog.observe(85);
		watchdog.observe(84);
		expect(watchdog.observe(69)).toEqual({ action: "resume" });
		expect(watchdog.isPaused).toBe(false);
		expect(watchdog.observe(81)).toEqual({ action: "compact" });
	});
});
