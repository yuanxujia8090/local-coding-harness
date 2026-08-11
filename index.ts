import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	defaultConfigPath,
	loadHarnessConfig,
	type ConfigLoadResult,
} from "./src/core.ts";
import { registerActiveAdapter } from "./src/adapter";

const EXAMPLE_CONFIG = `{
  "provider": "lmstudio",
  "models": ["your-model-id"]
}`;

function configPathFromEnv(): string | undefined {
	const value = process.env.LOCAL_MODEL_HARNESS_CONFIG;
	return value && value.trim() ? value.trim() : undefined;
}

export default function localModelHarness(pi: ExtensionAPI): void {
	const configResult: ConfigLoadResult = loadHarnessConfig(configPathFromEnv() ?? defaultConfigPath());

	if (!configResult.ok) {
		registerInactiveCommands(pi, configResult);
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify("local-model-harness inactive: config missing or invalid. Run /local-doctor for setup.", "warning");
		});
		return;
	}

	registerActiveAdapter(pi, configResult.config);
}

function registerInactiveCommands(pi: ExtensionAPI, configResult: Extract<ConfigLoadResult, { ok: false }>): void {
	pi.registerCommand("local-doctor", {
		description: "Show local-model-harness setup instructions",
		handler: async () => {
			const content = [
				"local-model-harness is inactive.",
				`Problem: ${configResult.reason}`,
				"",
				`Create ${configResult.path} with:`,
				EXAMPLE_CONFIG,
				"",
				"Then restart pi. The harness only manages the models you list.",
			].join("\n");
			pi.appendEntry("local-doctor", { at: new Date().toISOString(), content });
			pi.sendMessage({ customType: "local-doctor", content, display: true });
		},
	});
	pi.registerCommand("local-report", {
		description: "Show telemetry and verification state for this local coding session",
		handler: async () => {
			pi.sendMessage({
				customType: "local-report",
				content: "local-model-harness is inactive (no valid config). Run /local-doctor for setup.",
				display: true,
			});
		},
	});
}