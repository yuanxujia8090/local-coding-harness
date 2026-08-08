import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const DEFAULT_PROVIDER = "lmstudio";
export const DEFAULT_LOCK_FILENAME = "local-model-harness.lock";
export const DEFAULT_WATCHDOG_THRESHOLD_PERCENT = 80;
export const WATCHDOG_RESUME_MARGIN_PERCENT = 10;
export const DEFAULT_LOOP_WINDOW = 3;
export const DEFAULT_LOCAL_BASE_URL = "http://localhost:1234/v1";

export type ProtocolLanguage = "en" | "zh";

export type HarnessConfig = {
	provider: string;
	models: string[];
	lockPath: string;
	watchdogEnabled: boolean;
	watchdogThresholdPercent: number;
	loopGuardEnabled: boolean;
	loopGuardWindow: number;
	protocolLanguage: ProtocolLanguage;
	gateEnabled: boolean;
	readGuardEnabled: boolean;
};

export type ConfigLoadResult =
	| { ok: true; config: HarnessConfig; path: string }
	| { ok: false; reason: string; path: string };

export function defaultConfigPath(): string {
	return join(homedir(), ".pi", "agent", "local-model-harness.json");
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return isAbsolute(path) ? path : resolve(path);
}

function readSection(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function loadHarnessConfig(path: string = defaultConfigPath()): ConfigLoadResult {
	if (!existsSync(path)) {
		return {
			ok: false,
			path,
			reason: `Config file not found at ${path}. Create it with a "models" array of managed model IDs (see local-model-harness.example.json).`,
		};
	}

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return { ok: false, path, reason: `Config is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, path, reason: "Config root must be a JSON object." };
	}

	const root = raw as Record<string, unknown>;

	const provider = root.provider ?? DEFAULT_PROVIDER;
	if (typeof provider !== "string" || !provider.trim()) {
		return { ok: false, path, reason: '"provider" must be a non-empty string.' };
	}

	const models = root.models;
	if (!Array.isArray(models) || models.length === 0 || !models.every((model) => typeof model === "string" && model.trim().length > 0)) {
		return { ok: false, path, reason: '"models" must be a non-empty array of model ID strings.' };
	}

	const lockPath = typeof root.lockPath === "string" && root.lockPath.trim().length > 0
		? expandHome(root.lockPath.trim())
		: join(homedir(), ".pi", "agent", DEFAULT_LOCK_FILENAME);

	const watchdog = readSection(root.contextWatchdog);
	const watchdogEnabled = typeof watchdog.enabled === "boolean" ? watchdog.enabled : true;
	const watchdogThresholdPercent = typeof watchdog.thresholdPercent === "number" && Number.isFinite(watchdog.thresholdPercent)
		? Math.min(95, Math.max(10, watchdog.thresholdPercent))
		: DEFAULT_WATCHDOG_THRESHOLD_PERCENT;

	const loopGuard = readSection(root.loopGuard);
	const loopGuardEnabled = typeof loopGuard.enabled === "boolean" ? loopGuard.enabled : true;
	const loopGuardWindow = typeof loopGuard.window === "number" && Number.isInteger(loopGuard.window) && loopGuard.window >= 2
		? loopGuard.window
		: DEFAULT_LOOP_WINDOW;

	const protocolLanguage: ProtocolLanguage = root.protocolLanguage === "zh" ? "zh" : "en";

	const gate = readSection(root.gate);
	const gateEnabled = typeof gate.enabled === "boolean" ? gate.enabled : true;

	const readGuardConfig = readSection(root.readGuard);
	const readGuardEnabled = typeof readGuardConfig.enabled === "boolean" ? readGuardConfig.enabled : false;

	return {
		ok: true,
		path,
		config: {
			provider: provider.trim(),
			models: [...new Set(models.map((model) => (model as string).trim()))],
			lockPath,
			watchdogEnabled,
			watchdogThresholdPercent,
			loopGuardEnabled,
			loopGuardWindow,
			protocolLanguage,
			gateEnabled,
			readGuardEnabled,
		},
	};
}

export type ModelReference = {
	provider?: unknown;
	id?: unknown;
};

export type ToolProbeResult =
	| { ok: true }
	| { ok: false; reason: string };

export function isManagedLocalModel(model: ModelReference | undefined, config: HarnessConfig): boolean {
	return model?.provider === config.provider
		&& typeof model.id === "string"
		&& config.models.includes(model.id);
}