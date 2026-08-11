import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	buildCodingProtocol,
	ContractGate,
	DEFAULT_LOCAL_BASE_URL,
	FileLeaseLock,
	SessionTelemetry,
	TaskCompletionLedger,
	ReadGuard,
	TurnCap,
	assessResponseQuality,
	formatDuration,
	formatTaskCompletionReport,
	formatTelemetryReport,
	isManagedLocalModel,
	isVerificationCommand,
	parseToolProbe,
	type HarnessConfig,
} from "./core.ts";
import { HarnessController } from "./controller";
import { createCompletionPolicy } from "./policies/completion";
import { createMutationPolicy } from "./policies/mutation";
import { createLoopPolicy } from "./policies/loop";
import { createQualityPolicy } from "./policies/quality";
import { createContextPolicy } from "./policies/context";
import type { Directive } from "./policy";
import type { HarnessEvent } from "./events";
import type { QualityBlock } from "./quality";

const PROBE_TOOL = "pi_local_probe";
const INJECTION_CUSTOM_TYPE = "local-harness-context";

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

/** 把 index 组装好的 harness 注册为 Pi 的 hooks/tools/commands：事件转
 *  HarnessEvent 驱动 controller，directives 转为 Pi 干预，同时维护
 *  telemetry/ledger 持久化与 provider lock。机制判定在 policies/controller，
 *  阈值与计数器不在本层。 */
export function registerActiveAdapter(pi: ExtensionAPI, config: HarnessConfig): void {
	function recordError(hook: string, error: unknown): void {
		try {
			pi.appendEntry("local-error", {
				at: new Date().toISOString(),
				hook,
				error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
			});
		} catch {
			// appendEntry 自身失败时不再抛：兜底必须静默。
		}
	}

	function safeRun<T>(hook: string, fn: () => T, fallback?: () => T): T | undefined {
		try {
			return fn();
		} catch (error) {
			recordError(hook, error);
			return fallback?.();
		}
	}

	async function safeRunAsync<T>(hook: string, fn: () => Promise<T>, fallback?: () => Promise<T>): Promise<T | undefined> {
		try {
			return await fn();
		} catch (error) {
			recordError(hook, error);
			return fallback?.();
		}
	}

	const lock = new FileLeaseLock(config.lockPath);
	let lockHeld = false;
	let telemetry = new SessionTelemetry();
	let taskLedger = new TaskCompletionLedger(new Set(config.gateExtraReadOnlyTools));
	let turnCap = new TurnCap(config.turnCapMaxTurns, config.turnCapEnabled);
	let contractGate = new ContractGate();
	let readGuard = new ReadGuard();
	let unverifiedWarningShown = false;
	let lastInjectedBlock: string | undefined;

	function createController(): HarnessController {
		const completion = createCompletionPolicy({ ledger: taskLedger });
		const mutation = createMutationPolicy({ ledger: taskLedger, contractGate, readGuard });
		return new HarnessController(config, [completion, mutation, createLoopPolicy(), createQualityPolicy(), createContextPolicy()], undefined, () => taskLedger.snapshot());
	}
	let controller = createController();

	function emit(event: HarnessEvent): readonly Directive[] {
		return controller.handle(event);
	}

	/** 把 controller 的 directives 转成 Pi 的实际干预，并同步 telemetry 计数。
	 *  block/steer 由 caller 决定是否应用；notify 直接提示；compact 执行上下文
	 *  压缩；inject 通过 user message 投递（快速回路受控消息不进对话）。
	 *  loop 干预的下发次数即 telemetry 的 loopInterventions（与原直调一致）。 */
	function applyDirectives(directives: readonly Directive[], ctx: ExtensionContext): { blocked: boolean; blockReason?: string; compacted?: boolean; injected?: string } {
		let blocked = false;
		let blockReason: string | undefined;
		let notified = false;
		let compacted = false;
		let injected: string | undefined;
		for (const directive of directives) {
			try {
				switch (directive.kind) {
					case "block":
						blocked = true;
						blockReason = directive.reason;
						break;
					case "steer":
						if (directive.policy === "loop") telemetry.recordLoopIntervention();
						pi.sendUserMessage(directive.message, { deliverAs: "steer" });
						break;
					case "notify":
						if (!notified) {
							ctx.ui.notify(directive.message, directive.level);
							notified = true;
						}
						break;
					case "inject":
						if (!injected) {
							pi.sendUserMessage(directive.message, { deliverAs: "steer" });
							injected = directive.message;
						}
						break;
					case "compact":
						if (!compacted) {
							compacted = true;
							telemetry.recordWatchdogCompaction();
							ctx.ui.setStatus("local-model-watchdog", "Context watchdog: compacting");
							ctx.compact();
						}
						break;
					case "record":
						// policy 中间状态已由 controller 回写，无须 adapter 动作。
						break;
					case "allow":
						break;
				}
			} catch (error) {
				recordError(`applyDirectives:${directive.kind}`, error);
			}
		}
		return { blocked, blockReason, compacted, injected };
	}

	/** 把一次事件交给 controller，并把 policy 产生的空回复/空工具计数增量
	 *  同步进 telemetry（controller snapshot 是唯一真相源）。 */
	function emitAndSync(event: HarnessEvent, ctx: ExtensionContext): { blocked: boolean; blockReason?: string; compacted?: boolean; injected?: string } {
		const before = controller.snapshot().quality;
		const directives = emit(event);
		const after = controller.snapshot().quality;
		const emptyResponsesDelta = after.emptyResponses - before.emptyResponses;
		const emptyToolCallsDelta = after.emptyToolCalls - before.emptyToolCalls;
		for (let i = 0; i < emptyResponsesDelta; i++) telemetry.recordQuality({ ok: false, reason: "empty_response" });
		for (let i = 0; i < emptyToolCallsDelta; i++) telemetry.recordQuality({ ok: false, reason: "empty_tool_call", tool: "unknown" });
		return applyDirectives(directives, ctx);
	}

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
		while (true) {
			try {
				if (await lock.tryAcquire()) break;
			} catch (error) {
				recordError("acquireLock:tryAcquire", error);
				ctx.ui.setStatus("local-model-lock", undefined);
				ctx.ui.setWorkingMessage();
				return;
			}
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
		try {
			await lock.release();
			ctx.ui.setStatus("local-model-lock", undefined);
		} catch (error) {
			recordError("releaseLock", error);
		} finally {
			lockHeld = false;
		}
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

	/** 完整注入投影：protocol + verification state + task state。
	 *  它是 legacy before_agent_start 与 ContextPolicy post-compact 注入的
	 *  **同一来源**（审查第四轮：共享完整 verification projection），因此两
	 *  条路径内容逐字节一致，可被 lastInjectedBlock 单一 cache 去重。 */
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
			safeRun("runDoctor:report", () => {
				report(`Local model check failed for ${modelLabel(ctx)}: ${error instanceof Error ? error.message : String(error)}`);
			});
		} finally {
			await releaseLock(ctx);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		telemetry = new SessionTelemetry(modelLabel(ctx));
		taskLedger = new TaskCompletionLedger(new Set(config.gateExtraReadOnlyTools));
		turnCap = new TurnCap(config.turnCapMaxTurns, config.turnCapEnabled);
		contractGate = new ContractGate();
		readGuard = new ReadGuard();
		controller = createController();
		unverifiedWarningShown = false;
		lastInjectedBlock = undefined;
	});

	pi.on("model_select", (event, ctx) => {
		safeRun("model_select", () => {
			telemetry.setModel(modelId(event.model as { id?: unknown }));
			// 切换模型是 turnCap 分段边界：run 中切走再切回不继承此前轮数
			// （review 问题 2），taskLedger/telemetry 继续跨模型共享。
			turnCap.reset();
			const managed = isManagedLocalModel(
				event.model as { provider?: unknown; id?: unknown } | undefined,
				config,
			);
			ctx?.ui?.setStatus("local-model-harness", managed ? "active" : undefined);
		});
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!isManagedSession(ctx)) return;
		return safeRun("before_agent_start", () => {
			turnCap.reset();
			if (taskLedger.snapshot().completed) {
				taskLedger = new TaskCompletionLedger();
				controller = createController();
			}
			telemetry.setModel(modelLabel(ctx));
			const block = buildInjectionBlock();
			if (block === lastInjectedBlock) return;
			lastInjectedBlock = block;
			return { message: { customType: INJECTION_CUSTOM_TYPE, content: block, display: false } };
		});
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		if (!isManagedSession(ctx)) return;
		const startedAt = performance.now();
		await safeRunAsync("before_provider_request", () => acquireLock(ctx));
		telemetry.recordProviderRequest(performance.now() - startedAt);
	});

	pi.on("turn_start", (_event, ctx) => {
		if (!isManagedSession(ctx)) return;
		safeRun("turn_start", () => {
			// turn.started 先入 controller：session.turns 是 quality 等跨回合
			// 去重的窗口依据（审查 F0/P0），随后再处理 turn cap。
			applyDirectives(emit({ type: "turn.started" }), ctx);
			if (turnCap.record()) {
				telemetry.recordLoopIntervention();
				ctx.ui.notify(
					`local-model-harness: the model exceeded the turn cap (${config.turnCapMaxTurns}) for this run — stopping the loop.`,
					"warning",
				);
				ctx.abort();
			}
		});
	});

	pi.on("tool_call", (event, ctx) => {
		const result = safeRun(
			"tool_call",
			() => {
				if (isManagedSession(ctx)) {
					// 契约门禁、read guard、死循环检测均走 policy（Task 3/4 迁移）：
					// 该事件触发 completion/mutation/loop 三个 policy 的判定。
					const { blocked, blockReason } = applyDirectives(
						emit({ type: "tool.requested", callId: event.toolCallId, tool: event.toolName, input: event.input }),
						ctx,
					);
					if (blocked) {
						return { block: true, reason: blockReason ?? "Blocked by local-model-harness." };
					}
				}
				return;
			},
			() => (config.gateEnabled ? { block: true, reason: "local-model-harness internal error (fail-closed)." } : undefined),
		);
		if (result) return result;

		taskLedger.recordToolCall(event.toolCallId, event.toolName, event.input);
	});

	pi.on("tool_result", (event, ctx) => {
		safeRun("tool_result", () => {
			taskLedger.recordToolResult(event.toolCallId, event.toolName, event.input, event.isError);
			if (!isManagedSession(ctx)) return;
			telemetry.recordToolResult(event.toolName, event.input, event.isError);
			if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
				unverifiedWarningShown = false;
			}
			if (event.toolName === "bash" && !event.isError && typeof event.input.command === "string" && isVerificationCommand(event.input.command)) {
				unverifiedWarningShown = false;
			}
		});
	});

	pi.on("turn_end", async (_event, ctx) => {
		try {
			if (isManagedSession(ctx)) {
				recordContextUsage(ctx);
				const message = _event.message as { content?: unknown; stopReason?: unknown } | undefined;
				const stopReason = typeof message?.stopReason === "string" ? message.stopReason : undefined;
				const content = Array.isArray(message?.content)
					? (message.content as Parameters<typeof assessResponseQuality>[0])
					: undefined;
				// quality / research drift / watchdog 判定全部走 policy（Task 3）：
				// 一次 turn.end 事件触发这三个政策的评估，Policies 的指令由
				// applyDirectives 化为 steer/notify/compact 等实际干预。
				const contextPercent = ctx.getContextUsage()?.percent ?? undefined;
				const { compacted } = emitAndSync(
					{ type: "turn.end", content, stopReason, contextPercent },
					ctx,
				);
				// watchdog pause/resume 的 status 语义由 controller 快照回写。
				const snapshotContext = controller.snapshot().context;
				if (compacted) {
					ctx.ui.setStatus("local-model-watchdog", "Context watchdog: compacting");
				} else if (snapshotContext.paused) {
					ctx.ui.setStatus("local-model-watchdog", "Context watchdog: paused");
				} else {
					ctx.ui.setStatus("local-model-watchdog", undefined);
				}
			}
		} catch (error) {
			recordError("turn_end", error);
		} finally {
			await releaseLock(ctx);
		}
	});

	pi.on("session_compact", (_event, ctx) => {
		if (!isManagedSession(ctx)) return;
		safeRun("session_compact", () => {
			// watchdog 或手动压缩后统一走 ContextPolicy：注入协议与任务状态，
			// 并在 controller 内推进 context 状态（审查 F1/P1）。pendingCompact 由
			// 下一个 turn.end 的 evolveWatchdog 消费，这里不清除，避免破坏
			// 「压缩后仍高 -> pause」的判定。
			const { injected } = applyDirectives(emit({ type: "context.compacted", projection: buildInjectionBlock() }), ctx);
			telemetry.recordCompaction();
			// 把 compact 实际投递的 payload 写回 lastInjectedBlock：cache 的语义是
			// 「模型上下文里最近一次注入的完整内容」，谁最后投递就归谁。下一
			// 次 before_agent_start 只在内容真正变化时重投（审查第三轮 P1）。若
			// 不更新，契约建立后 compact 注入的 protocol + Task State 会被旧的
			// protocol-only 缓存误判为「不同」而重复投递。
			if (injected !== undefined) {
				lastInjectedBlock = injected;
			}
		});
	});

	pi.on("agent_settled", async (_event, ctx) => {
		try {
			if (isManagedSession(ctx)) {
				recordContextUsage(ctx);
				const snapshot = persistTelemetry();
				const task = taskLedger.snapshot();
				// 任务未完成续跑 steer 走 completionPolicy（dedupeKey 防止重复 followUp）。
				applyDirectives(emit({ type: "agent.settled" }), ctx);
				if (snapshot.verificationPending && !unverifiedWarningShown) {
					pi.sendMessage({
						customType: "local-verification",
						content: `Unverified local changes: ${snapshot.changedFiles.join(", ")}.`,
						display: true,
					});
					unverifiedWarningShown = true;
				}
			}
		} catch (error) {
			recordError("agent_settled", error);
		} finally {
			await releaseLock(ctx);
		}
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