import { DEFAULT_LOOP_WINDOW } from "./config";

export function toolCallSignature(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "bash" && typeof input.command === "string") return `bash:${input.command.trim()}`;
	if (typeof input.path === "string") return `${toolName}:${input.path}`;
	let serialized: string;
	try {
		serialized = JSON.stringify(input) ?? "{}";
	} catch {
		serialized = "{}";
	}
	return `${toolName}:${serialized.slice(0, 200)}`;
}

export class LoopGuard {
	private recent: string[] = [];
	private readonly notified = new Set<string>();

	constructor(private readonly window: number = DEFAULT_LOOP_WINDOW) {}

	reset(): void {
		this.recent = [];
		this.notified.clear();
	}

	record(toolName: string, input: Record<string, unknown>): string | null {
		const signature = toolCallSignature(toolName, input);
		this.recent.push(signature);
		if (this.recent.length > this.window) this.recent.shift();

		if (
			this.recent.length === this.window
			&& this.recent.every((entry) => entry === signature)
			&& !this.notified.has(signature)
		) {
			this.notified.add(signature);
			return signature;
		}
		return null;
	}
}