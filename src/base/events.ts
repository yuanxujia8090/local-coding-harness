import type { ModelReference } from "./config";
import type { QualityBlock } from "../mechanisms/quality";

/** Harness 语义事件，统一现有 Pi hook 行为。事件名不复制 Pi hook 名；
 *  Pi API 变化时只改 adapter。语义见架构文档 4.1。
 *
 *  `turn.end` 承载质量/漂移/上下文的观察载荷：content 是回合产出的
 *  blocks（quality 与 research drift 使用），stopReason 过滤被中止的回合，
 *  contextPercent 是上下文占用率（watchdog 使用）。 */
export type HarnessEvent =
	| { type: "session.started"; model?: ModelReference }
	| { type: "model.selected"; model?: ModelReference }
	| { type: "turn.started" }
	| { type: "turn.end"; content?: readonly QualityBlock[]; stopReason?: string; contextPercent?: number }
	| { type: "agent.starting"; prompt: string }
	| { type: "tool.requested"; callId: string; tool: string; input: unknown }
	| { type: "tool.completed"; callId: string; tool: string; input: unknown; result: unknown; isError: boolean }
	| { type: "agent.settled" }
	| { type: "context.observed"; usedTokens: number; contextWindow: number }
	| { type: "context.compacted"; projection: string }
	| { type: "session.ending" };

export function isHarnessEvent(value: unknown): value is HarnessEvent {
	if (typeof value !== "object" || value === null) return false;
	const event = value as { type?: unknown; projection?: unknown };
	if (typeof event.type !== "string" || !HarnessEventTypes.has(event.type)) return false;
	return event.type !== "context.compacted" || typeof event.projection === "string";
}

export const HarnessEventTypes: ReadonlySet<string> = new Set([
	"session.started",
	"model.selected",
	"turn.started",
	"turn.end",
	"agent.starting",
	"tool.requested",
	"tool.completed",
	"agent.settled",
	"context.observed",
	"context.compacted",
	"session.ending",
]);