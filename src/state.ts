import type { ModelReference } from "./config";
import type { TaskCompletionSnapshot } from "./ledger";
import type { TelemetrySnapshot } from "./session";
import type { HarnessEvent } from "./events";

/** 会话级状态：由 controller/reducer 独占修改，policy 只读。 */
export type SessionState = {
	active: boolean;
	model: ModelReference | null;
	turns: number;
};

/** 上下文压力状态：源自循环 `context.observed`。 */
export type ContextState = {
	paused: boolean;
	pendingCompact: boolean;
};

/** 质量观察状态：计数语义与 quality 模块对齐，共享真相源见架构 4.2。 */
export type QualityState = {
	emptyResponses: number;
	emptyToolCalls: number;
};

/** 干预状态：block/steer/inject/compact 累计。 */
export type InterventionState = {
	blocks: number;
	steers: number;
	injects: number;
	compactions: number;
};

export interface HarnessState {
	session: SessionState;
	task: TaskCompletionSnapshot;
	context: ContextState;
	quality: QualityState;
	interventions: InterventionState;
	telemetry: TelemetrySnapshot;
}

export function initialHarnessState(model: ModelReference | null = null): HarnessState {
	return {
		session: { active: false, model, turns: 0 },
		task: {
			intent: null,
			scope: [],
			doneWhen: [],
			mutationToolCalls: [],
			completed: false,
			missingConditions: [],
		},
		context: { pendingCompact: false, paused: false },
		quality: { emptyResponses: 0, emptyToolCalls: 0 },
		interventions: { blocks: 0, steers: 0, injects: 0, compactions: 0 },
		telemetry: zeroTelemetry(),
	};
}

function zeroTelemetry(): TelemetrySnapshot {
	return {
		model: "unknown model",
		durationMs: 0,
		providerRequests: 0,
		lockWaitMs: 0,
		lockWaits: 0,
		lockWaitMaxMs: 0,
		toolCalls: 0,
		toolErrors: 0,
		toolErrorsByTool: {},
		changedFiles: [],
		verificationPending: false,
		verificationCommands: [],
		contextPeakPercent: null,
		compactions: 0,
		loopInterventions: 0,
		watchdogCompactions: 0,
		emptyResponses: 0,
		emptyToolCalls: 0,
	};
}

/** Controller 的 reducer：事件先于此收敛到状态，policy 再读状态。原地震改，所有权归 controller。 */
export function applyEvent(state: HarnessState, event: HarnessEvent): void {
	switch (event.type) {
		case "session.started":
			state.session.active = true;
			if (event.model) state.session.model = event.model;
			return;
		case "model.selected":
			if (event.model) state.session.model = event.model;
			return;
		case "turn.started":
			state.session.turns += 1;
			return;
		case "agent.starting":
		case "tool.requested":
		case "tool.completed":
		case "agent.settled":
		case "context.observed":
			return;
		case "context.compacted":
			state.context.pendingCompact = false;
			return;
		case "session.ending":
			state.session.active = false;
			return;
	}
}