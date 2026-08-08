import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	buildCodingProtocol,
	buildContractBlockReason,
	buildGateSteerMessage,
	ContextWatchdog,
	ContractGate,
	DEFAULT_LOCAL_BASE_URL,
	FileLeaseLock,
	SessionTelemetry,
	TaskCompletionLedger,
	LoopGuard,
	ReadGuard,
	assessResponseQuality,
	defaultConfigPath,
	formatDuration,
	formatTaskCompletionReport,
	formatTelemetryReport,
	isManagedLocalModel,
	isVerificationCommand,
	loadHarnessConfig,
	parseToolProbe,
	type ConfigLoadResult,
	type HarnessConfig,
} from "./src/core.ts";

const PROBE_TOOL = "pi_local_probe";
const INJECTION_CUSTOM_TYPE = "local-harness-context";

const EXAMPLE_CONFIG = `{
  "provider": "lmstudio",
  "models": ["your-model-id"]
}`;

function configPathFromEnv(): string | undefined {
	const value = process.env.LOCAL_MODEL_HARNESS_CONFIG;
	return value && value.trim() ? value.trim() : undefined;
}

function modelId(model: { id?: unknown } | undefined): string {
	return typeof model?.id === "string" ? model.id : "unknown model";
}

function modelLabel(ctx: ExtensionContext): string {
	return modelId(ctx.model as { id?: unknown } | undefined);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(resolve, ms);
		if (!signal) return;
		if (signal.aborted) {
			clearTimeout(timeout);
			reject(signal.reason);
			return;
		}
		signal.addEventListener("abort", () => {
			clearTimeout(timeout);
			reject(signal.reason);
		}, { once: true });
	});
}

function addAuthHeader(headers: Headers, apiKey: string | undefined): void {
	if (apiKey && !headers.has("authorization")) {
		headers.set("authorization", `Bearer ${apiKey}`);
	}
}

export default function localModelHarness(pi: ExtensionAPI): void {
	const configResult: ConfigLoadResult = loadHarnessConfig(configPathFromEnv() ?? defaultConfigPath());

	if (!configResult.ok) {
		registerInactiveCommands(pi, configResult);
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify("local-model-harness inactive: config missing or invalid. Run /local-doctor for setup.", "warning");
		});
		return;
	}

	registerActiveHarness(pi, configResult.config);
}

function registerInactiveCommands(pi: ExtensionAPI, configResult: Extract<ConfigLoadResult, { ok: false }>): void {
	pi.registerCommand("local-doctor", {
		description: "Show local-model-harness setup instructions",
		handler: async () => {
			const content = [
				"local-model-harness is inactive.",
				`Problem: ${configResult.reason}`,
				"",
				`Create ${configResult.path} with:`,
				EXAMPLE_CONFIG,
				"",
				"Then restart pi. The harness only manages the models you list.",
			].join("\n");
			pi.appendEntry("local-doctor", { at: new Date().toISOString(), content });
			pi.sendMessage({ customType: "local-doctor", content, display: true });
		},
	});
	pi.registerCommand("local-report", {
		description: "Show telemetry and verification state for this local coding session",
		handler: async () => {
			pi.sendMessage({
				customType: "local-report",
				content: "local-model-harness is inactive (no valid config). Run /local-doctor for setup.",
				display: true,
			});
		},
	});
}

function registerActiveHarness(pi: ExtensionAPI, config: HarnessConfig): void {
	const lock = new FileLeaseLock(config.lockPath);
	let lockHeld = false;
	let telemetry = new SessionTelemetry();
	let taskLedger = new TaskCompletionLedger();
	let loopGuard = new LoopGuard(config.loopGuardWindow);
	let watchdog = new ContextWatchdog(config.watchdogThresholdPercent);
	let contractGate = new ContractGate();
	let readGuard = new ReadGuard();
	let unverifiedWarningShown = false;
	let taskFollowUpShown = false;
	let lastInjectedBlock: string | undefined;

	function isManagedSession(ctx: ExtensionContext): boolean {
		return isManagedLocalModel(ctx.model as { provider?: unknown; id?: unknown } | undefined, config);
	}

	async function acquireLock(ctx: ExtensionContext): Promise<void> {
		if (lockHeld) return;

		const startedAt = Date.now();
		let waitNotified = false;
		let lastOwnerCheck = 0;
		ctx.ui.setStatus("local-model-lock", "Local model: waiting for model slot");
		ctx.ui.setWorkingMessage("Local model: waiting for model slot…");
		while (!(await lock.tryAcquire())) {
			await sleep(250, ctx.signal);
			const now = Date.now();
			if (now - lastOwnerCheck >= 2_000) {
				lastOwnerCheck = now;
				const owner = await FileLeaseLock.peekOwner(config.lockPath);
				if (owner) {
					const heldFor = formatDuration(now - Date.parse(owner.acquiredAt));
					const message = `Local model: waiting for model slot (held by pid ${owner.pid}${Number.isFinite(Date.parse(owner.acquiredAt)) ? `, ${heldFor}` : ""})`;
					ctx.ui.setStatus("local-model-lock", message);
					ctx.ui.setWorkingMessage(`${message}…`);
				}
			}
			if (!waitNotified && now - startedAt >= 5_000) {
				waitNotified = true;
				ctx.ui.notify("Local model busy in another pi session; waiting for the model slot.", "info");
			}
		}
		lockHeld = true;
		ctx.ui.setStatus("local-model-lock", `Local model: ${modelLabel(ctx)}`);
		ctx.ui.setWorkingMessage();
	}

	async function releaseLock(ctx: ExtensionContext): Promise<void> {
		if (!lockHeld) return;
		await lock.release();
		lockHeld = false;
		ctx.ui.setStatus("local-model-lock", undefined);
	}

	function recordContextUsage(ctx: ExtensionContext): void {
		telemetry.recordContextPercent(ctx.getContextUsage()?.percent);
	}

	function persistTelemetry(): ReturnType<SessionTelemetry["snapshot"]> {
		const snapshot = telemetry.snapshot();
		pi.appendEntry("local-telemetry", { at: new Date().toISOString(), snapshot });
		return snapshot;
	}

	function persistTask(): void {
		pi.appendEntry("local-task", { at: new Date().toISOString(), snapshot: taskLedger.snapshot() });
	}

	function reportTelemetry(): void {
		const snapshot = telemetry.snapshot();
		const task = taskLedger.snapshot();
		pi.appendEntry("local-report", { at: new Date().toISOString(), snapshot, task });
		pi.sendMessage({
			customType: "local-report",
			content: `${formatTelemetryReport(snapshot)}\n${formatTaskCompletionReport(task)}`,
			display: true,
		});
	}

	function buildInjectionBlock(): string {
		const sections: string[] = [buildCodingProtocol(config.protocolLanguage)];
		if (telemetry.snapshot().verificationPending) {
			sections.push("## Verification State\n- Local changes remain unverified. Run the smallest relevant verification before further edits or final reporting.");
		}
		const task = taskLedger.snapshot();
		if (task.intent && !task.completed) {
			sections.push(`## Task State\n${formatTaskCompletionReport(task)}\n- Finish the pending completion evidence before reporting done.`);
		}
		return sections.join("\n\n");
	}

	async function runDoctor(ctx: ExtensionContext): Promise<void> {
		if (!isManagedSession(ctx)) {
			ctx.ui.notify(`Select a managed model (provider "${config.provider}", models: ${config.models.join(", ")}) before running /local-doctor.`, "warning");
			return;
		}

		const report = (content: string): void => {
			pi.appendEntry("local-doctor", { at: new Date().toISOString(), content });
			pi.sendMessage({ customType: "local-doctor", content, display: true });
		};

		const model = ctx.model!;
		const provider = ctx.modelRegistry.getRegisteredProviderConfig(config.provider);
		const baseUrl = provider?.baseUrl?.replace(/\/$/, "") ?? DEFAULT_LOCAL_BASE_URL.replace(/\/$/, "");
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			ctx.ui.notify(`Local model authentication unavailable: ${auth.error}`, "error");
			return;
		}

		await acquireLock(ctx);
		try {
			const headers = new Headers(auth.headers);
			headers.set("content-type", "application/json");
			addAuthHeader(headers, auth.apiKey);

			const modelsResponse = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(15_000) });
			if (!modelsResponse.ok) {
				throw new Error(`GET /models returned HTTP ${modelsResponse.status}.`);
			}
			const models = await modelsResponse.json() as { data?: Array<{ id?: unknown }> };
			if (!models.data?.some((entry) => entry.id === model.id)) {
				throw new Error(`Server does not expose ${model.id}.`);
			}

			const probeResponse = await fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers,
				signal: AbortSignal.timeout(120_000),
				body: JSON.stringify({
					model: model.id,
					messages: [{ role: "user", content: `Call ${PROBE_TOOL}. Do not answer with prose.` }],
					tools: [{
						type: "function",
						function: {
							name: PROBE_TOOL,
							description: "Harmless local harness protocol probe.",
							parameters: { type: "object", properties: {}, additionalProperties: false },
						},
					}],
					tool_choice: "auto",
					temperature: 0,
				}),
			});
			if (!probeResponse.ok) {
				throw new Error(`Tool probe returned HTTP ${probeResponse.status}: ${await probeResponse.text()}`);
			}

			const probe = parseToolProbe(await probeResponse.json(), PROBE_TOOL);
			if (!probe.ok) throw new Error(probe.reason);
			report(`Local model ready: ${model.id}; /models and tool-call probe passed.`);
		} catch (error) {
			report(`Local model check failed for ${modelLabel(ctx)}: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			await releaseLock(ctx);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		telemetry = new SessionTelemetry(modelLabel(ctx));
		taskLedger = new TaskCompletionLedger();
		loopGuard = new LoopGuard(config.loopGuardWindow);
		watchdog = new ContextWatchdog(config.watchdogThresholdPercent);
		contractGate = new ContractGate();
		readGuard = new ReadGuard();
		unverifiedWarningShown = false;
		taskFollowUpShown = false;
		lastInjectedBlock = undefined;
	});

	pi.on("model_select", (event) => {
		telemetry.setModel(modelId(event.model as { id?: unknown }));
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!isManagedSession(ctx)) return;
		if (taskLedger.snapshot().completed) {
			taskLedger = new TaskCompletionLedger();
			taskFollowUpShown = false;
		}
		telemetry.setModel(modelLabel(ctx));
		const block = buildInjectionBlock();
		if (block === lastInjectedBlock) return;
		lastInjectedBlock = block;
		return { message: { customType: INJECTION_CUSTOM_TYPE, content: block, display: false } };
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		if (!isManagedSession(ctx)) return;
		const startedAt = performance.now();
		await acquireLock(ctx);
		telemetry.recordProviderRequest(performance.now() - startedAt);
	});

	pi.on("tool_call", (event, ctx) => {
		if (!isManagedSession(ctx)) return;

		if (config.loopGuardEnabled) {
			const loopSignature = loopGuard.record(event.toolName, event.input);
			if (loopSignature) {
				telemetry.recordLoopIntervention();
				pi.sendUserMessage(
					`[local-model-harness] The same ${event.toolName} call has now repeated ${config.loopGuardWindow} times in a row. Do not retry it unchanged: re-read the last output, check your assumptions, try a different approach, or report the blocker to the user.`,
					{ deliverAs: "steer" },
				);
			}
		}

		if (config.gateEnabled && taskLedger.needsContractFor(event.toolName, event.input)) {
			const escalation = contractGate.recordBlock();
			if (escalation.steer) {
				pi.sendUserMessage(buildGateSteerMessage(escalation.blocks, config.protocolLanguage), { deliverAs: "steer" });
			}
			if (escalation.notify) {
				ctx.ui.notify(`local-model-harness: ${escalation.blocks} calls blocked without a task contract. The model is refusing to call task_contract; consider intervening.`, "warning");
			}
			return {
				block: true,
				reason: buildContractBlockReason(config.protocolLanguage),
			};
		}

		readGuard.recordRead(event.toolName, event.input);
		if (config.readGuardEnabled) {
			const unreadPath = readGuard.needsReadForEdit(event.toolName, event.input);
			if (unreadPath) {
				pi.sendUserMessage(
					`[local-model-harness] You are editing ${unreadPath} without having read it first. Read the file (read tool) so the edit is based on the actual current content, then retry the ${event.toolName}.`,
					{ deliverAs: "steer" },
				);
				return {
					block: true,
					reason: `Read ${unreadPath} before editing it.`,
				};
			}
		}

		taskLedger.recordToolCall(event.toolCallId, event.toolName, event.input);
	});

	pi.on("tool_result", (event, ctx) => {
		if (!isManagedSession(ctx)) return;
		taskLedger.recordToolResult(event.toolCallId, event.toolName, event.input, event.isError);
		telemetry.recordToolResult(event.toolName, event.input, event.isError);
		if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
			unverifiedWarningShown = false;
		}
		if (event.toolName === "bash" && !event.isError && typeof event.input.command === "string" && isVerificationCommand(event.input.command)) {
			unverifiedWarningShown = false;
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (isManagedSession(ctx)) {
			recordContextUsage(ctx);
			const blocks = (_event.message as { content?: unknown })?.content;
			if (Array.isArray(blocks)) {
				const verdict = assessResponseQuality(blocks as Parameters<typeof assessResponseQuality>[0]);
				if (!verdict.ok) {
					telemetry.recordQuality(verdict);
					if (verdict.reason === "empty_response") {
						pi.sendUserMessage(
							`[local-model-harness] The last response contained no text and no tool call. Produce a concrete next step: read a file, run a command, or report findings — do not reply with an empty or thinking-only message.`,
							{ deliverAs: "steer" },
						);
					} else {
						pi.sendUserMessage(
							`[local-model-harness] The ${verdict.tool} tool call had no arguments. Every tool call needs its parameters filled in; re-read the tool description and call it with real input.`,
							{ deliverAs: "steer" },
						);
					}
				}
			}
			if (config.watchdogEnabled) {
				const decision = watchdog.observe(ctx.getContextUsage()?.percent);
				if (decision.action === "compact") {
					telemetry.recordWatchdogCompaction();
					ctx.ui.setStatus("local-model-watchdog", "Context watchdog: compacting");
					ctx.compact();
				} else if (decision.action === "pause") {
					ctx.ui.setStatus("local-model-watchdog", "Context watchdog: paused");
					ctx.ui.notify(decision.reason, "warning");
				} else if (decision.action === "resume") {
					ctx.ui.setStatus("local-model-watchdog", undefined);
				}
			}
		}
		await releaseLock(ctx);
	});

	pi.on("session_compact", (_event, ctx) => {
		if (isManagedSession(ctx)) telemetry.recordCompaction();
		lastInjectedBlock = undefined;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (isManagedSession(ctx)) {
			recordContextUsage(ctx);
			const snapshot = persistTelemetry();
			const task = taskLedger.snapshot();
			if (task.mutationToolCalls.length > 0 && !task.completed && !taskFollowUpShown) {
				persistTask();
				pi.sendUserMessage(
					`Task remains incomplete. Missing completion evidence: ${task.missingConditions.join(", ") || "call task_complete with evidence"}. Continue the current task; do not report completion yet.`,
					{ deliverAs: "followUp" },
				);
				taskFollowUpShown = true;
			}
			if (snapshot.verificationPending && !unverifiedWarningShown) {
				pi.sendMessage({
					customType: "local-verification",
					content: `Unverified local changes: ${snapshot.changedFiles.join(", ")}.`,
					display: true,
				});
				unverifiedWarningShown = true;
			}
		}
		await releaseLock(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await releaseLock(ctx);
	});

	pi.registerTool({
		name: "task_contract",
		label: "Set Task Contract",
		description: "Define user intent, scope, completion conditions, verification plan, and unresolved items before state-changing work.",
		parameters: Type.Object({
			intent: Type.String(),
			scope: Type.Array(Type.String()),
			doneWhen: Type.Array(Type.String()),
			verificationPlan: Type.Array(Type.String()),
			unresolved: Type.Array(Type.String()),
		}),
		async execute(_toolCallId, params) {
			const result = taskLedger.setContract(params);
			if (!result.ok) throw new Error(`Task contract rejected: ${result.reason}`);
			taskFollowUpShown = false;
			contractGate.reset();
			persistTask();
			return { content: [{ type: "text", text: `Task contract active: ${params.intent}` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "task_verify",
		label: "Verify Task Condition",
		description: "Attach the most recent successful read-only tool result to one active doneWhen condition.",
		parameters: Type.Object({ condition: Type.String() }),
		async execute(_toolCallId, params) {
			const result = taskLedger.verify(params.condition);
			persistTask();
			if (!result.ok) throw new Error(`Task verification rejected: ${result.reason}`);
			return { content: [{ type: "text", text: `Task condition verified: ${params.condition}` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "task_complete",
		label: "Complete Task",
		description: "Complete the active task after task_verify has covered every doneWhen condition.",
		parameters: Type.Object({}),
		async execute(_toolCallId) {
			const result = taskLedger.complete();
			persistTask();
			if (!result.ok) {
				throw new Error(`Task incomplete. Missing evidence: ${result.missingConditions.join(", ")}`);
			}
			return { content: [{ type: "text", text: "Task completion evidence accepted." }], details: undefined };
		},
	});

	pi.registerCommand("local-doctor", {
		description: "Check the selected local model and its tool-call protocol",
		handler: async (_args, ctx) => runDoctor(ctx),
	});
	pi.registerCommand("local-report", {
		description: "Show telemetry and verification state for this local coding session",
		handler: async (_args, _ctx) => reportTelemetry(),
	});
}
