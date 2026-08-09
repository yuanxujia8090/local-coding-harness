import type { ModelReference } from "./config";

/** Harness 语义事件，统一现有 Pi hook 行为。事件名不复制 Pi hook 名；
 *  Pi API 变化时只改 adapter。语义见架构文档 4.1。 */
export type HarnessEvent =
	| { type: "session.started"; model?: ModelReference }
	| { type: "model.selected"; model?: ModelReference }
	| { type: "turn.started" }
	| { type: "agent.starting"; prompt: string }
	| { type: "tool.requested"; callId: string; tool: string; input: unknown }
	| { type: "tool.completed"; callId: string; tool: string; input: unknown; result: unknown; isError: boolean }
	| { type: "agent.settled" }
	| { type: "context.observed"; usedTokens: number; contextWindow: number }
	| { type: "context.compacted" }
	| { type: "session.ending" };

export function isHarnessEvent(value: unknown): value is HarnessEvent {
	if (typeof value !== "object" || value === null) return false;
	const event = value as { type?: unknown };
	return typeof event.type === "string" && HarnessEventTypes.has(event.type);
}

export const HarnessEventTypes: ReadonlySet<string> = new Set([
	"session.started",
	"model.selected",
	"turn.started",
	"agent.starting",
	"tool.requested",
	"tool.completed",
	"agent.settled",
	"context.observed",
	"context.compacted",
	"session.ending",
]);