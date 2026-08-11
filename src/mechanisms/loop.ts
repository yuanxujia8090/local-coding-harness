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

export class TurnCap {
	private count = 0;

	constructor(
		private readonly maxTurns: number,
		private readonly enabled: boolean,
	) {}

	reset(): void {
		this.count = 0;
	}

	record(): boolean {
		this.count++;
		return this.enabled && this.maxTurns > 0 && this.count > this.maxTurns;
	}
}