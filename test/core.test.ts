import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import localModelHarness from "../index";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ContractGate,
	FileLeaseLock,
	ReadGuard,
	SessionTelemetry,
	TaskCompletionLedger,
	TurnCap,
	assessResponseQuality,
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
		expect(result.config.researchDriftEnabled).toBe(true);
		expect(result.config.researchDriftThreshold).toBe(8);
		expect(result.config.turnCapEnabled).toBe(false);
		expect(result.config.turnCapMaxTurns).toBe(40);
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
			researchDrift: { enabled: false, threshold: 6 },
			turnCap: { enabled: true, maxTurns: 20 },
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
		expect(result.config.researchDriftEnabled).toBe(false);
		expect(result.config.researchDriftThreshold).toBe(6);
		expect(result.config.turnCapEnabled).toBe(true);
		expect(result.config.turnCapMaxTurns).toBe(20);
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
			emptyResponses: 1,
			emptyToolCalls: 0,
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
			emptyResponses: 0,
			emptyToolCalls: 0,
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
		telemetry.recordQuality({ ok: false, reason: "empty_response" });
		telemetry.recordQuality({ ok: false, reason: "empty_tool_call", tool: "bash" });

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
			emptyResponses: 1,
			emptyToolCalls: 1,
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
		expect(isStateChangingTool("bash", { command: "test ! -f scripts/fakeapp-cli.js && echo verified" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "ls -la config/ && test -d config && echo ok" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "test -f foo || echo missing" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "grep fakeapp package.json || echo no-ref" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "test -f foo && rm bar" })).toBe(true);
		expect(isStateChangingTool("bash", { command: "python server.py &" })).toBe(true);
		expect(isStateChangingTool("bash", { command: "cat foo &" })).toBe(true);
		expect(isStateChangingTool("bash", { command: "ls && echo ok" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "ls scripts/fakeapp-cli.js 2>&1 || true" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "ls config 2>/dev/null || echo missing" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "test -f foo && :" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "echo hi > /tmp/out" })).toBe(true);
		expect(isStateChangingTool("bash", { command: "! grep -q fakeapp package.json && echo clean" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "! test -f foo" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "! rm -rf /tmp/x" })).toBe(true);
		expect(isStateChangingTool("bash", { command: "test ! -f foo || echo gone" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "node test.js" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "node test.js && echo verified" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "npm test" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "node src/setup.js" })).toBe(true);
		expect(isStateChangingTool("bash", { command: "find . -name '*.test.js' | head -5; cat package.json" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "git status; rm -rf /tmp/x" })).toBe(true);
		expect(isStateChangingTool("bash", { command: "ls *.js; cat package.json" })).toBe(false);

		// Compound loops / conditionals: body must be read-only.
		expect(isStateChangingTool("bash", { command: "for f in *.txt; do head -1 \"$f\"; done" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "for d in /path/*/; do name=$(basename \"$d\"); echo \"$name\"; done" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "for f in *.txt; do head -1 \"$f\"; done; echo all-done" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "while read -r line; do echo \"$line\"; done < config.txt" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "if test -f x; then echo exists; fi" })).toBe(false);

		// Compound blocks with a write inside must stay state-changing.
		expect(isStateChangingTool("bash", { command: "for f in *.txt; do rm \"$f\"; done" })).toBe(true);
		expect(isStateChangingTool("bash", { command: "for f in $(rm -rf x); do echo ok; done" })).toBe(true);
		expect(isStateChangingTool("bash", { command: "for f in *.txt; do echo hi > /tmp/out; done" })).toBe(true);

		// Regression (session 019fdf33): read-only operations that were
		// misclassified as state-changing and gated without reason.
		expect(isStateChangingTool("bash", { command: "echo \"=== A ===\" && ls /Users/x/.pi/agent/skills/ 2>/dev/null && echo \"\" && ls /Users/x/.agents/skills/ 2>/dev/null" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "find /Users/x/.agents -maxdepth 2 -name \"SKILL.md\" -o -name \"*.skill\" 2>/dev/null | sort && cat /Users/x/rules.json 2>/dev/null" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "python3 -c \"\nimport json\nwith open('/Users/x/rules.json') as f:\n    rules = json.load(f)\nprint(len(rules))\n\" 2>/dev/null" })).toBe(false);
		expect(isStateChangingTool("bash", { command: "for skill_dir in /Users/x/skills/*/; do name=$(basename \"$skill_dir\"); md=\"$skill_dir/SKILL.md\"; if [ -f \"$md\" ]; then head -1 \"$md\"; fi; done" })).toBe(false);
	});

	test("treats non-bash tools as read-only by default and honors extra read-only tools", () => {
		// Third-party read-only tools (e.g. shepherd_rules) default to read-only.
		expect(isStateChangingTool("shepherd_rules", { action: "list", verbose: true })).toBe(false);
		expect(isStateChangingTool("shepherd_rules", { action: "list" }, new Set(["shepherd_rules"]))).toBe(false);
		// Known write tools remain state-changing.
		expect(isStateChangingTool("edit", { path: "README.md" })).toBe(true);
		expect(isStateChangingTool("write", { path: "x.md" })).toBe(true);
	});

	test("requires a contract before a state-changing tool call", () => {
		const ledger = new TaskCompletionLedger();

		expect(ledger.needsContractFor("bash", { command: "npm uninstall -g example-tool" })).toBe(true);
		expect(ledger.setContract(contract).ok).toBe(true);
		expect(ledger.needsContractFor("bash", { command: "npm uninstall -g example-tool" })).toBe(false);
	});

	test("honors configured extra read-only tool names in the ledger", () => {
		const ledger = new TaskCompletionLedger(new Set(["shepherd_rules"]));

		expect(ledger.needsContractFor("shepherd_rules", { action: "list" })).toBe(false);
		expect(ledger.needsContractFor("bash", { command: "git status" })).toBe(false);
		expect(ledger.needsContractFor("bash", { command: "git commit -m x" })).toBe(true);
		expect(ledger.needsContractFor("write", { path: "x.md" })).toBe(true);
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

describe("toolCallSignature", () => {
	test("signatures distinguish tools and inputs", () => {
		expect(toolCallSignature("bash", { command: "npm test" })).toBe("bash:npm test");
		expect(toolCallSignature("edit", { path: "src/a.ts" })).toBe("edit:src/a.ts");
		expect(toolCallSignature("task_verify", { condition: "done" })).toBe('task_verify:{"condition":"done"}');
	});
});

describe("TurnCap", () => {
	test("flags once the turn count exceeds the cap", () => {
		const cap = new TurnCap(3, true);

		expect(cap.record()).toBe(false);
		expect(cap.record()).toBe(false);
		expect(cap.record()).toBe(false);
		expect(cap.record()).toBe(true);
	});

	test("does nothing when disabled", () => {
		const cap = new TurnCap(3, false);

		expect(cap.record()).toBe(false);
		expect(cap.record()).toBe(false);
		expect(cap.record()).toBe(false);
		expect(cap.record()).toBe(false);
	});

	test("resets the counter", () => {
		const cap = new TurnCap(2, true);

		cap.record();
		cap.record();
		expect(cap.record()).toBe(true);
		cap.reset();
		expect(cap.record()).toBe(false);
		expect(cap.record()).toBe(false);
		expect(cap.record()).toBe(true);
	});
});

describe("assessResponseQuality", () => {
	test("accepts a normal text response", () => {
		expect(assessResponseQuality([{ type: "text", text: "Running the test suite." }])).toEqual({ ok: true });
	});

	test("accepts text plus a tool call", () => {
		expect(assessResponseQuality([
			{ type: "text", text: "Checking the file." },
			{ type: "toolCall", name: "read", arguments: { path: "src/index.ts" } },
		])).toEqual({ ok: true });
	});

	test("flags an empty response with no text and no tool call", () => {
		expect(assessResponseQuality([])).toEqual({ ok: false, reason: "empty_response" });
	});

	test("does not flag a thinking-only response as empty", () => {
		expect(assessResponseQuality([{ type: "thinking", thinking: "planning next move..." }])).toEqual({ ok: true });
	});

	test("flags a tool call with empty arguments", () => {
		expect(assessResponseQuality([
			{ type: "toolCall", name: "bash", arguments: {} },
		])).toEqual({ ok: false, reason: "empty_tool_call", tool: "bash" });
	});

	test("allows zero-argument tools (e.g. task_complete) with empty arguments", () => {
		expect(assessResponseQuality([
			{ type: "toolCall", name: "task_complete", arguments: {} },
		])).toEqual({ ok: true });
	});
});

describe("ReadGuard", () => {
	test("blocks an edit of a file that was not read first", () => {
		const guard = new ReadGuard();
		guard.recordRead("read", { path: "src/other.ts" });

		const result = guard.needsReadForEdit("edit", { path: "src/target.ts" });
		expect(result).toBeTruthy();
	});

	test("allows an edit after the file was read", () => {
		const guard = new ReadGuard();
		guard.recordRead("read", { path: "src/target.ts" });

		expect(guard.needsReadForEdit("edit", { path: "src/target.ts" })).toBeNull();
	});

	test("normalises relative and absolute paths", () => {
		const guard = new ReadGuard();
		guard.recordRead("read", { path: "src/a.ts" });

		expect(guard.needsReadForEdit("edit", { path: resolve("src/a.ts") })).toBeNull();
	});

	test("does not guard when a path is missing", () => {
		const guard = new ReadGuard();
		guard.recordRead("read", { path: "src/a.ts" });
		expect(guard.needsReadForEdit("edit", {})).toBeNull();
	});

	test("only read tools record files", () => {
		const guard = new ReadGuard();
		guard.recordRead("bash", { command: "ls src/" });
		expect(guard.readFilesCount()).toBe(0);
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

// ---------------------------------------------------------------------------
// Preflight regression: task ledger scope must not depend on managed-model
// policy. An explicit task_contract defines intent even outside a managed
// model, so ledger evidence tracking must bind tool_call/tool_result for any
// active contract. Only harness policy (gate/loop/telemetry/prompt) stays
// managed-model scoped.
// ---------------------------------------------------------------------------

type PiStub = {
	on: (event: string, handler: (...args: unknown[]) => unknown) => void;
	registerTool: (tool: {
		name: string;
		label: string;
		description?: string;
		parameters?: unknown;
		execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;
	}) => void;
	registerCommand: (name: string, command: { description?: string; handler: (...args: unknown[]) => unknown }) => void;
	appendEntry: (name: string, data: unknown) => void;
	sendMessage: (message: unknown) => void;
	sendUserMessage: (text: string, options: unknown) => void;
};

function createPiStub(): { pi: ExtensionAPI; handlers: Map<string, (arg0: unknown, arg1: unknown) => unknown>; tools: Map<string, (params: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; details: unknown } | undefined>> } {
	const handlers = new Map<string, (arg0: unknown, arg1: unknown) => unknown>();
	const tools = new Map<string, (params: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; details: unknown } | undefined>>();
	const pi = {
		on(event: unknown, handler: (arg0: unknown, arg1: unknown) => unknown) {
			handlers.set(event as string, handler);
		},
		registerTool(tool: { name: string; execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; details: unknown }> }) {
			tools.set(tool.name, (params) => tool.execute("test-call", params));
		},
		registerCommand() {},
		appendEntry() {},
		sendMessage() {},
		sendUserMessage() {},
	} as PiStub;
	return { pi: pi as unknown as ExtensionAPI, handlers, tools };
}

function nonManagedContext(): ExtensionContext {
	return {
		ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {} },
		mode: "json",
		hasUI: false,
		cwd: process.cwd(),
		sessionManager: undefined as unknown as ExtensionContext["sessionManager"],
		modelRegistry: undefined as unknown as ExtensionContext["modelRegistry"],
		model: { provider: "openai", id: "not-managed-model" } as ExtensionContext["model"],
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => true,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
}

const harnessConfigForLedgerScopeTest = JSON.stringify({
	provider: "lmstudio",
	models: ["managed-model"],
});

describe("preflight: task ledger evidence across model scopes", () => {
	test("non-managed model with an explicit contract still records verification evidence", async () => {
		const configPath = await writeTempConfig(harnessConfigForLedgerScopeTest);
		const previousConfigPath = process.env.LOCAL_MODEL_HARNESS_CONFIG;
		process.env.LOCAL_MODEL_HARNESS_CONFIG = configPath;
		try {
			const { pi, handlers, tools } = createPiStub();
			localModelHarness(pi);

			await tools.get("task_contract")!({
				intent: "remove an app",
				scope: ["app package"],
				doneWhen: ["app absent"],
				verificationPlan: ["inspect app"],
				unresolved: [],
			});

			const context = nonManagedContext();
			handlers.get("tool_call")!({ toolName: "edit", toolCallId: "e1", input: { filePath: "src/app.ts" } }, context);
			handlers.get("tool_result")!({ toolName: "edit", toolCallId: "e1", input: {}, content: [], isError: false }, context);
			handlers.get("tool_call")!({ toolName: "grep", toolCallId: "g1", input: { path: "src", pattern: "app" } }, context);
			handlers.get("tool_result")!({ toolName: "grep", toolCallId: "g1", input: {}, content: [], isError: false }, context);

			await expect(tools.get("task_verify")!({ condition: "app absent" })).resolves.toBeDefined();
		} finally {
			if (previousConfigPath === undefined) {
				delete process.env.LOCAL_MODEL_HARNESS_CONFIG;
			} else {
				process.env.LOCAL_MODEL_HARNESS_CONFIG = previousConfigPath;
			}
		}
	});
});
