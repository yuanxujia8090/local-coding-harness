# local-model-harness

A thin coding harness for [pi](https://pi.dev) + local models (LM Studio, llama.cpp, MLX, Ollama — anything behind a local OpenAI-compatible endpoint).

Local models can write code. What they struggle with is **finishing work reliably**: they skip verification, announce completion after one successful command, loop on failing calls, and lose task state when context compacts. This harness adds a thin layer of discipline and evidence on top of pi — without replacing pi's agent loop, tools, sessions, or Skills.

```
pi native agent loop
  |
  +-- Local Coding Protocol        read before edit, verify after change, inspect diff
  +-- Provider Lock                serialize managed-model requests across pi processes
  +-- Session Telemetry            requests, lock waits, tools, verification, context, compactions
  +-- Task Completion Ledger       contract -> evidence -> doneWhen; blocks unevidenced "done"
  +-- Context Watchdog             early compaction before the window fills up
  +-- Loop Guard                   steers the model out of identical repeated calls
```

## Why a harness for local models

Frontier-model harnesses assume the model rarely breaks tool-call format, follows structured output, and summarizes well during compaction. Local models break those assumptions. This harness is deliberately small and only intervenes where local models measurably fail:

- **"I ran the command, so the task is done."** A successful tool call is a local fact, not proof the user's goal was reached. The task ledger requires the model to declare completion conditions up front (`task_contract`) and attach real read-only evidence to each one (`task_verify`) before `task_complete` is accepted.
- **Skipping verification.** Edits mark the session "unverified"; only a recognized verification command (`npm test`, `pytest`, `cargo test`, `tsc`, ...) clears it. Settling with unverified changes produces a visible warning.
- **Repeat-until-stuck loops.** The loop guard detects the same call N times in a row and steers the model to change approach.
- **Context pressure.** Local servers re-read long histories slowly and small-model recall degrades near a full window. The watchdog compacts early (default 80%) with a loop guard, and protocol/task state is re-injected after compaction.
- **Multi-process GPU contention.** Several pi sessions talking to one local server fight over memory. A file-lease lock serializes managed-model requests across pi processes that load this extension.

## What this is not

- Not another agent framework. pi's loop, tools, sessions, AGENTS.md, and Skills are untouched.
- Not a machine-wide resource manager. The lock only coordinates pi processes that load this extension; other clients of your local server are unaffected. Model loading/unloading stays your server's job.
- No auto-fallback, no model routing, no multi-agent orchestration. Those hide failures instead of explaining them. If the telemetry shows you need them, you'll know.

## Requirements

- [pi](https://pi.dev) >= 0.83
- A local OpenAI-compatible server (LM Studio, llama.cpp, MLX/omlx, Ollama, ...) registered in pi as a provider
- Models that support tool calling (run `/local-doctor` to verify)

## Install

Add the package to `packages` in `~/.pi/agent/settings.json`:

```jsonc
{
  "packages": [
    "git:github.com/<owner>/local-model-harness"
  ]
}
```

Then restart pi. (Replace `<owner>` with the repository owner.)

## Configure

Create `~/.pi/agent/local-model-harness.json` listing the models the harness should manage:

```jsonc
{
  "provider": "lmstudio",              // pi provider name (default: "lmstudio")
  "models": ["your-model-id"],         // required, non-empty whitelist
  "lockPath": "~/.pi/agent/local-model-harness.lock",  // optional
  "contextWatchdog": {                 // optional
    "enabled": true,                   // default true
    "thresholdPercent": 80             // default 80 (clamped 10-95)
  },
  "loopGuard": {                       // optional
    "enabled": true,                   // default true
    "window": 3                        // default 3 (min 2)
  }
}
```

Without a valid config the harness stays completely inactive (no gating, no injection) and `/local-doctor` prints setup instructions. Set `LOCAL_MODEL_HARNESS_CONFIG=/path/to/config.json` to use another location. Changes require a pi restart.

## Verify your setup

Select a managed model, then run:

```
/local-doctor
```

It checks, in order: the model is on your whitelist → the provider endpoint answers `GET /models` and exposes the model → a side-effect-free probe request actually returns the requested tool call. "The model is listed" and "the model completes a tool call" are two different things; doctor separates them.

## Commands

| Command | What it does |
|---------|--------------|
| `/local-doctor` | Checks the selected managed model end-to-end (whitelist, endpoint, tool-call probe) |
| `/local-report` | Prints session telemetry + task completion state and saves it as a session entry |

## Tools (used by the model)

| Tool | Purpose |
|------|---------|
| `task_contract` | Declare `intent`, `scope`, `doneWhen`, `verificationPlan`, `unresolved` before state-changing work |
| `task_verify` | Bind the most recent successful read-only result to one `doneWhen` condition |
| `task_complete` | Accepted only when every `doneWhen` condition has verification evidence |

Read-only exploration (`read`, `grep`, `find`, `ls`, and known read-only bash like `git status`, `ls`, `cat`) never needs a contract. `edit`, `write`, and any bash command that cannot be proven read-only are blocked until a contract exists. The model never has to recite internal tool-call IDs — it states conditions in words; the ledger matches evidence.

## Design notes

- **KV-cache-friendly injection.** Protocol, verification state, and task state are injected as a trailing custom message (not a system-prompt rewrite), so the cached prefix on your local server stays valid. The block is deduplicated and re-injected after compaction.
- **Watchdog pause.** If compaction doesn't bring usage below the threshold, the watchdog pauses instead of firing doomed compactions, and resumes once usage drops clearly. pi's own near-overflow compaction still applies as a backstop.
- **Loop guard steers, never blocks.** Repetition can be legitimate (polling); the guard injects a corrective nudge once per repeated signature and records the intervention in telemetry.
- **Conservative bash classification.** Unknown bash commands are treated as state-changing. A growing whitelist guesses fewer side effects than a growing blacklist.

## Limitations

- The provider lock only coordinates pi processes with this extension loaded.
- The read-only bash whitelist is intentionally small; everything else requires a contract.
- Telemetry is per-session and in-memory (persisted as session entries at settle/report time), not a cross-session database.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
```

Core logic lives in `src/core.ts` (pure, no pi imports) so every mechanism is unit-testable; `index.ts` is the pi wiring.

## License

MIT
