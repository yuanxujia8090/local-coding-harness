import type { ModelReference } from "./config";
import type { TaskCompletionSnapshot } from "./ledger";
import type { HarnessEvent } from "./events";
import type { Directive } from "./policy";

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
	/** 连续异常回合数（空回复/漂移共用），超过上限停止投递纠正。 */
	consecutiveSteers: number;
};

/** 死循环与漂移状态：共享真相源见架构 4.2。 */
export type LoopState = {
	/** 最近一次工具签名的滑动窗口，达到窗口宽度且全部相同才判定复用。 */
	recentSignatures: string[];
	/** 已通知过的签名，防止 session 内重复 steer。 */
	notifiedSignatures: string[];
	/** 连续只读无产出回合数（research drift）。 */
	driftTurns: number;
	/** research drift 是否已通知过一次。 */
	driftNotified: boolean;
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
	loop: LoopState;
	interventions: InterventionState;
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
		quality: { emptyResponses: 0, emptyToolCalls: 0, consecutiveSteers: 0 },
		loop: { recentSignatures: [], notifiedSignatures: [], driftTurns: 0, driftNotified: false },
		interventions: { blocks: 0, steers: 0, injects: 0, compactions: 0 },
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
		case "turn.end":
		case "agent.starting":
		case "tool.requested":
		case "tool.completed":
		case "agent.settled":
		case "context.observed":
			return;
		case "context.compacted":
			// 压缩完成不清 pendingCompact：它由下一个 turn.end 的 evolveWatchdog
			// 消费（仍高 -> pause，回落后复位），提前清除会破坏该判定（审查 F1）。
			return;
		case "session.ending":
			state.session.active = false;
			return;
	}
}

/** 应用 loop 政策通过 record 指令回写的窗口与漂移中间状态。
 *  policy 只读 state，跨事件的运行时推进靠 controller 集中改（架构 4.2）。 */
export function applyPolicyRecord(state: HarnessState, record: Directive & { kind: "record" }): void {
	switch (record.policy) {
		case "loop": {
			const data = (record.data ?? {}) as Record<string, unknown>;
			if (data.recent) state.loop.recentSignatures = data.recent as string[];
			if (data.notified) state.loop.notifiedSignatures = data.notified as string[];
			if (typeof data.drift === "number") state.loop.driftTurns = data.drift;
			if (typeof data.driftNotified === "boolean") state.loop.driftNotified = data.driftNotified;
			return;
		}
		case "quality": {
			const data = (record.data ?? {}) as Record<string, unknown>;
			if (typeof data.consecutiveSteers === "number") state.quality.consecutiveSteers = data.consecutiveSteers;
			if (typeof data.emptyResponses === "number") state.quality.emptyResponses = data.emptyResponses;
			if (typeof data.emptyToolCalls === "number") state.quality.emptyToolCalls = data.emptyToolCalls;
			return;
		}
		case "context": {
			const data = (record.data ?? {}) as Record<string, unknown>;
			if (typeof data.paused === "boolean") state.context.paused = data.paused;
			if (typeof data.pendingCompact === "boolean") state.context.pendingCompact = data.pendingCompact;
			return;
		}
		default:
			return;
	}
}