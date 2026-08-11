import { open, readFile, unlink } from "node:fs/promises";
import type { ToolProbeResult } from "../base/config";

export function parseToolProbe(response: unknown, toolName: string): ToolProbeResult {
	const choices = (response as { choices?: unknown })?.choices;
	if (!Array.isArray(choices)) {
		return { ok: false, reason: "Response has no choices array." };
	}

	for (const choice of choices) {
		const toolCalls = (choice as { message?: { tool_calls?: unknown } })?.message?.tool_calls;
		if (!Array.isArray(toolCalls)) continue;
		if (toolCalls.some((call) => (call as { function?: { name?: unknown } })?.function?.name === toolName)) {
			return { ok: true };
		}
	}

	return { ok: false, reason: `No ${toolName} tool call in response.` };
}

function processExists(pid: unknown): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export type LockOwner = {
	pid: number;
	acquiredAt: string;
};

export class FileLeaseLock {
	private handle: Awaited<ReturnType<typeof open>> | undefined;

	constructor(private readonly path: string) {}

	static async peekOwner(path: string): Promise<LockOwner | null> {
		try {
			const owner = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown; acquiredAt?: unknown };
			if (typeof owner.pid !== "number") return null;
			return { pid: owner.pid, acquiredAt: typeof owner.acquiredAt === "string" ? owner.acquiredAt : "" };
		} catch {
			return null;
		}
	}

	async tryAcquire(): Promise<boolean> {
		if (this.handle) return true;

		try {
			this.handle = await open(this.path, "wx");
			await this.handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}

		try {
			const owner = JSON.parse(await readFile(this.path, "utf8")) as { pid?: unknown };
			if (processExists(owner.pid)) return false;
			await unlink(this.path);
			return this.tryAcquire();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.tryAcquire();
			return false;
		}
	}

	async release(): Promise<void> {
		if (!this.handle) return;
		await this.handle.close();
		this.handle = undefined;
		try {
			await unlink(this.path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}