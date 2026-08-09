import type { HarnessConfig } from "./config";
import { isHarnessEvent, type HarnessEvent } from "./events";
import { mergeDirectives, type Directive, type Policy } from "./policy";
import { applyEvent, initialHarnessState, type HarnessState } from "./state";
import type { TaskCompletionSnapshot } from "./ledger";

/** 唯一编排入口（架构 4.5）。不调用 Pi API，事件与状态都是纯逻辑，
 *  便于单元测试直接输入事件轨迹。 */
export class HarnessController {
	private readonly state: HarnessState;
	private readonly seenSteerKeys = new Set<string>();
	private readonly seenInjectKeys = new Set<string>();

	constructor(
		private readonly config: HarnessConfig,
		private readonly policies: readonly Policy[],
		initial: HarnessState = initialHarnessState(),
		private readonly taskSnapshot?: () => TaskCompletionSnapshot,
	) {
		this.state = initial;
	}

	handle(event: HarnessEvent): readonly Directive[] {
		if (!isHarnessEvent(event)) {
			throw new Error(`Unknown harness event: ${JSON.stringify(event)}`);
		}
		// ledger 是任务契约与证据真相源（arch 4.2）：handle 前把最新快照同步进 state。
		if (this.taskSnapshot) {
			this.state.task = this.taskSnapshot();
		}
		applyEvent(this.state, event);

		if (event.type === "session.started") {
			this.seenSteerKeys.clear();
			this.seenInjectKeys.clear();
		}

		const outputs: Directive[] = [];
		for (const policy of this.policies) {
			outputs.push(...policy.evaluate(event, this.state, this.config));
		}
		const merged = mergeDirectives(outputs);

		// 跨事件冷却期去重：同一 dedupeKey 的 steer/inject 只返回一次，
		// 防止相同消息反复注入。drop 的项不再计入 interventions。
		const retained: Directive[] = [];
		for (const directive of merged) {
			if (directive.kind === "steer") {
				if (this.seenSteerKeys.has(directive.dedupeKey)) continue;
				this.seenSteerKeys.add(directive.dedupeKey);
				this.state.interventions.steers += 1;
			} else if (directive.kind === "inject") {
				if (this.seenInjectKeys.has(directive.dedupeKey)) continue;
				this.seenInjectKeys.add(directive.dedupeKey);
				this.state.interventions.injects += 1;
			} else if (directive.kind === "block") {
				this.state.interventions.blocks += 1;
			} else if (directive.kind === "compact") {
				this.state.interventions.compactions += 1;
			}
			retained.push(directive);
		}
		return retained;
	}

	snapshot(): Readonly<HarnessState> {
		// 冻结合并在 controller 内做（见构造）；此处深拷贝防御外部写穿。
		return JSON.parse(JSON.stringify(this.state)) as HarnessState;
	}
}