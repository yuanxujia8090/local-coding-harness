import { resolve } from "node:path";

const READ_TOOLS = new Set(["read", "grep", "find", "ls", "rg", "cat", "head", "tail"]);
const EDIT_TOOLS = new Set(["edit", "write"]);

function toolPath(toolName: string, input: Record<string, unknown>): string | null {
	const path = typeof input.path === "string" ? input.path
		: typeof input.filePath === "string" ? input.filePath
			: null;
	if (!path) return null;
	try {
		return resolve(path);
	} catch {
		return null;
	}
}

export class ReadGuard {
	private readonly readFiles = new Set<string>();

	reset(): void {
		this.readFiles.clear();
	}

	recordRead(toolName: string, input: Record<string, unknown>): void {
		if (!READ_TOOLS.has(toolName)) return;
		const path = toolPath(toolName, input);
		if (path) this.readFiles.add(path);
	}

	needsReadForEdit(toolName: string, input: Record<string, unknown>): string | null {
		if (!EDIT_TOOLS.has(toolName)) return null;
		const path = toolPath(toolName, input);
		if (!path) return null;
		return this.readFiles.has(path) ? null : path;
	}

	readFilesCount(): number {
		return this.readFiles.size;
	}
}