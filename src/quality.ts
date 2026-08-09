export type QualityBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; name: string; arguments: Record<string, unknown> };

export type QualityVerdict =
	| { ok: true }
	| { ok: false; reason: "empty_response" }
	| { ok: false; reason: "empty_tool_call"; tool: string };

export type QualitySnapshot = {
	emptyResponses: number;
	emptyToolCalls: number;
};

/** Tools whose parameter schema is legitimately empty (e.g. `task_complete`).
 *  An empty `arguments` object is the correct, complete call for these, so the
 *  empty-argument check must skip them. */
const ZERO_ARG_TOOLS: ReadonlySet<string> = new Set(["task_complete"]);

export function assessResponseQuality(blocks: readonly QualityBlock[]): QualityVerdict {
	const text = blocks.filter((block) => block.type === "text").map((block) => (block as { text: string }).text.trim()).join(" ");
	const thinking = blocks.some((block) => block.type === "thinking");
	const toolCalls = blocks.filter((block) => block.type === "toolCall") as Array<{ name: string; arguments: Record<string, unknown> }>;

	if (!text && !thinking && toolCalls.length === 0) return { ok: false, reason: "empty_response" };

	for (const call of toolCalls) {
		if (ZERO_ARG_TOOLS.has(call.name)) continue;
		if (!call.arguments || Object.keys(call.arguments).length === 0) {
			return { ok: false, reason: "empty_tool_call", tool: call.name };
		}
	}

	return { ok: true };
}

export class QualityMonitor {
	private emptyResponses = 0;
	private emptyToolCalls = 0;

	reset(): void {
		this.emptyResponses = 0;
		this.emptyToolCalls = 0;
	}

	record(blocks: readonly QualityBlock[]): QualityVerdict {
		const verdict = assessResponseQuality(blocks);
		if (!verdict.ok) {
			if (verdict.reason === "empty_response") this.emptyResponses++;
			else if (verdict.reason === "empty_tool_call") this.emptyToolCalls++;
		}
		return verdict;
	}

	snapshot(): QualitySnapshot {
		return { emptyResponses: this.emptyResponses, emptyToolCalls: this.emptyToolCalls };
	}
}