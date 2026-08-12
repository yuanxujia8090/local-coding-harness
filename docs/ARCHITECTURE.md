# Architecture — local-model-harness

> Thin coding harness for [pi](https://pi.dev) + local models. Adds discipline and evidence on top of pi's agent loop without replacing it.

## Table of Contents

1. [Overview](#overview)
2. [Layer Architecture](#layer-architecture)
3. [Event System](#event-system)
4. [Controller](#controller)
5. [Policy Framework](#policy-framework)
6. [State Management](#state-management)
7. [Mechanisms](#mechanisms)
8. [Policies](#policies)
9. [Configuration](#configuration)
10. [Adapter — Pi Integration](#adapter--pi-integration)
11. [Design Principles](#design-principles)

---

## Overview

The harness sits between pi's agent loop and local models (LM Studio, llama.cpp, MLX, Ollama, or any OpenAI-compatible endpoint). Local models can write code but struggle to **finish work reliably**: they skip verification, announce completion after one successful command, loop on failing calls, and lose task state when context compacts.

The harness adds eight mechanisms as a thin layer on top of pi:

| Mechanism | What it does |
|-----------|-------------|
| Local Coding Protocol | Persistent context injection: read before edit, verify after change, inspect diff |
| Provider Lock | File-lease lock serializing managed-model requests across pi processes |
| Session Telemetry | Per-session counters: requests, lock waits, tools, verification, context, compactions |
| Task Completion Ledger | Contract → evidence → `doneWhen`; blocks unevidenced `task_complete` |
| Context Watchdog | Early compaction at configurable threshold with pause/resume logic |
| Loop Guard | Detects identical tool calls in a sliding window; steers the model |
| Quality Monitor | Flags empty responses / empty-arg tool calls; steer then back off |
| Read Guard | (Opt-in) Blocks `edit`/`write` on a path with no prior `read` |

These mechanisms live in `src/mechanisms/`. They are **pure logic** with zero pi imports — each is unit-testable in isolation.

---

## Layer Architecture

```
src/
├── pi/adapter.ts        ← Pi wiring: hooks, tools, commands, provider lock, injection
├── base/                ← Shared contracts
│   ├── config.ts        ← HarnessConfig schema + loader
│   ├── events.ts        ← HarnessEvent union type
│   ├── state.ts         ← HarnessState + reducer (applyEvent, applyPolicyRecord)
│   └── policy.ts        ← Directive union + Policy interface + mergeDirectives
├── mechanisms/          ← Pure logic, no pi imports
│   ├── protocol.ts      ← Coding protocol text (en/zh)
│   ├── session.ts       ← SessionTelemetry + verification command detection
│   ├── shell.ts         ← Structural bash read-only analysis
│   ├── gate.ts          ← ContractGate escalation logic
│   ├── ledger.ts        ← TaskCompletionLedger + report formatters
│   ├── lock.ts          ← FileLeaseLock + tool-call probe parser
│   ├── loop.ts          ← Tool call signature + TurnCap
│   ├── quality.ts       ← Response quality assessment
│   ├── readguard.ts     ← Read-before-edit guard
│   └── watchdog.ts      ← Context compaction decision helper
├── policies/            ← Policy implementations (stateless evaluators)
│   ├── completion.ts    ← Unfinished task follow-up steer at agent.settled
│   ├── mutation.ts      ← Contract gate + read guard enforcement
│   ├── context.ts       ← Watchdog evaluation + post-compact injection
│   ├── loop.ts          ← Loop detection + research drift
│   └── quality.ts       ← Empty response / empty-arg steer + backoff
├── controller.ts        ← HarnessController: event → policy dispatch, state write-back
└── core.ts              ← Barrel re-export
```

**Key boundary rules:**

- **`src/mechanisms/` has zero pi imports.** Mechanisms are pure functions/classes that take inputs and return outputs. Tests feed them event traces directly.
- **`src/policies/` are stateless evaluators.** Each policy's `evaluate()` reads `HarnessState` (immutable via `Readonly<>`) and returns `Directive[]`. State mutation happens only through `applyPolicyRecord()` in the controller.
- **`src/pi/adapter.ts` is the sole pi integration point.** It converts Pi hooks → HarnessEvents, and directives → Pi interventions. Everything else is framework-agnostic.

---

## Event System

Events are the universal language between Pi hooks and policies. They are **not** named after Pi hooks — when Pi's API changes, only the adapter needs updating.

```typescript
type HarnessEvent =
  | { type: "session.started"; model?: ModelReference }
  | { type: "model.selected"; model?: ModelReference }
  | { type: "turn.started" }
  | { type: "turn.end"; content?: QualityBlock[]; stopReason?: string; contextPercent?: number }
  | { type: "agent.starting"; prompt: string }
  | { type: "tool.requested"; callId: string; tool: string; input: unknown }
  | { type: "tool.completed"; callId: string; tool: string; input: unknown; result: unknown; isError: boolean }
  | { type: "agent.settled" }
  | { type: "context.observed"; usedTokens: number; contextWindow: number }
  | { type: "context.compacted"; projection: string }
  | { type: "session.ending" };
```

**Event flow:**

```
Pi hook (e.g. "tool_call")
  → adapter converts to HarnessEvent ("tool.requested")
  → controller.handle(event)
    → each policy.evaluate(event, state, config) returns Directive[]
    → mergeDirectives() resolves conflicts
    → controller applies "record" directives to state
    → returns retained directives to adapter
  → adapter translates directives to Pi interventions (block/steer/inject/compact/notify)
```

**Key design choice:** `turn.end` carries the observation payload (content blocks, stopReason, contextPercent). Quality, research drift, and watchdog all read from this single event — no duplicate data paths.

---

## Controller

`HarnessController` is the **single orchestration entry point**. It does not call Pi APIs — events and state are pure logic, enabling unit tests to feed event traces directly.

```typescript
class HarnessController {
  handle(event: HarnessEvent): readonly Directive[]
  snapshot(): Readonly<HarnessState>
}
```

**Per-event lifecycle:**

1. Sync the latest task ledger snapshot into `state.task` (the contract/evidence truth source).
2. Apply the event to state via `applyEvent()` (session counters, compaction epoch, etc.).
3. Clear steer/inject dedupe sets on `session.started`.
4. Run every policy's `evaluate()` in fixed priority order.
5. Merge policy outputs via `mergeDirectives()` (conflict resolution).
6. Apply `record` directives to state (the only way policies mutate cross-event state).
7. Deduplicate `steer`/`inject` by key within the session; count `block`/`compact` in interventions.
8. Return retained directives.

**State ownership:** The controller owns `HarnessState` exclusively. Policies are read-only consumers. This prevents race conditions and makes state transitions replayable.

---

## Policy Framework

### Directives

Policies return directives — the actions they want the adapter to take:

```typescript
type Directive =
  | { kind: "allow" }                          // nothing to do
  | { kind: "block"; policy: string; reason: string }
  | { kind: "steer"; policy: string; message: string; dedupeKey: string }
  | { kind: "inject"; policy: string; message: string; dedupeKey: string }
  | { kind: "compact"; policy: string; reason: string }
  | { kind: "notify"; policy: string; level: "info" | "warning" | "error"; message: string }
  | { kind: "record"; policy: string; event: string; data?: Record<string, unknown> };
```

### Policy Interface

```typescript
interface Policy {
  readonly id: string;
  evaluate(event: HarnessEvent, state: Readonly<HarnessState>, config: HarnessConfig): readonly Directive[];
}
```

### Conflict Resolution (`mergeDirectives`)

When multiple policies produce directives for the same event, this rule set applies:

| Priority | Rule |
|----------|------|
| 1 | `record` always retained |
| 2 | `block` overrides `allow` |
| 3 | Only one `steer` kept (earliest by policy order) |
| 4 | `inject` deduplicated by `dedupeKey` (caller handles cross-event cooling) |
| 5 | Only one `compact` kept |

### Policy Priority Order

```typescript
DEFAULT_POLICY_ORDER = ["completion", "mutation", "context", "loop", "quality"];
```

Correctness policies (completion, mutation) run before efficiency/quality policies (context, loop, quality).

---

## State Management

### HarnessState Structure

```typescript
interface HarnessState {
  session: SessionState;        // active, model, turns
  task: TaskCompletionSnapshot; // ledger truth source (synced from TaskCompletionLedger)
  context: ContextState;        // paused, pendingCompact, compactionEpoch
  quality: QualityState;        // emptyResponses, emptyToolCalls, consecutiveSteers
  loop: LoopState;              // recentSignatures, notifiedSignatures, driftTurns, driftNotified
  interventions: InterventionState; // blocks, steers, injects, compactions (counters)
}
```

### State Mutation Rules

- **Events** mutate session-level counters (`session.turns`, `context.compactionEpoch`).
- **Policies** mutate observation/loop state via `record` directives → `applyPolicyRecord()`.
- **Controller** is the sole writer. Policies read `state` as `Readonly<>`.

### Compaction Epoch

Each `context.compacted` event increments `compactionEpoch`. This serves two purposes:
1. Each compaction gets its own injection dedupe key (`post-compact-${epoch}`), so consecutive manual compactions each restore dynamic state once.
2. The epoch is part of the injection block identity — `lastInjectedBlock` in the adapter caches by content, so the protocol-only block from `before_agent_start` won't be re-injected after a compaction that already injected protocol + task state.

---

## Mechanisms

### Protocol (`protocol.ts`)

Bilingual coding protocol text (en/zh). Injected as a trailing custom message on `before_agent_start` and after every compaction. KV-cache-friendly: the cached prefix on the local server stays valid because we append, not rewrite.

### Session Telemetry (`session.ts`)

Per-session counters persisted as pi session entries at settle/report time. Key behaviors:
- **Verification pending**: set on `edit`/`write`, cleared on recognized verification commands (`npm test`, `pytest`, `cargo test`, `tsc`, etc.) or successful edit/write.
- **Docs-only exemption**: if all changed files are `.md`/`.mdx`, `verificationPending` stays false (no runnable verification command exists for pure docs).
- **Tool error attribution**: per-tool error counts in snapshot.

### Shell Analysis (`shell.ts`)

Structural bash read-only analysis — not a flat regex. Handles:
- Quote-aware scanning (single/double quotes, backslash escapes)
- Heredoc body stripping (payload is data, not syntax)
- Command chain splitting at top-level `&&`/`||`/`;`/`|`/newlines
- `$()` substitution re-parsing (recursive)
- Compound block flattening (`for`/`while`/`if` → keyword boundaries)

**Conservative by default:** a command not proven read-only is treated as state-changing. Write-detection is structural (redirects, known destructive commands) rather than name-based.

### Contract Gate (`gate.ts`)

Escalation logic for the contract gate:
- Block counter increments on each blocked call.
- At 3 blocks: inject a steer message telling the model to call `task_contract`.
- At 6 blocks: emit a user-facing warning.
- `reset()` called after a successful contract is set.

### Task Completion Ledger (`ledger.ts`)

The truth source for task completion. Tracks:
- Active contract (intent, scope, doneWhen, verificationPlan, unresolved)
- Tool calls with state-changing classification and ordering
- Verified conditions (each `doneWhen` condition maps to one successful read-only tool call after the last mutation)
- Completion: all `doneWhen` conditions must have evidence

**Key invariant:** `task_complete` can only succeed when every `doneWhen` condition has a verified read-only tool call that occurred after the last state-changing call.

### File Lease Lock (`lock.ts`)

Cross-process serialization for managed model requests:
- `tryAcquire()`: opens file with `wx` flag; on `EEXIST`, checks if owner process is alive via `process.kill(pid, 0)`. Dead processes are cleaned up automatically.
- `release()`: closes handle and unlinks file.
- `peekOwner()`: static helper for displaying lock holder info in UI.

### Loop Detection (`loop.ts`)

- **Tool call signature:** `bash:<command>` for bash, `<tool>:<path>` for file tools, `<tool>:<json>` for others (truncated to 200 chars).
- **TurnCap:** simple counter with `reset()` on session start and model switch.

### Quality Assessment (`quality.ts`)

Evaluates response blocks:
- Empty response: no text, no thinking, no tool calls.
- Empty tool call: tool call with empty `arguments` (excluding `task_complete` which legitimately has zero args).

### Read Guard (`readguard.ts`)

Tracks paths seen by read tools (`read`, `grep`, `find`, `ls`, `rg`, `cat`, `head`, `tail`). When `edit`/`write` targets an untracked path, it blocks and steers the model to read first. Opt-in via `readGuard.enabled: true`.

### Watchdog Decision (`watchdog.ts`)

Pure function: `evolveWatchdog(current, threshold, percent)` → `{ decision, next }`. States:
- **none**: nothing happening.
- **compact**: percent ≥ threshold, trigger compaction.
- **pause**: compaction just ran but percent still ≥ threshold → pause until usage drops below `threshold - 10%`.
- **resume**: paused and percent dropped below resume margin.

---

## Policies

### Completion Policy (`completion.ts`)

Triggers on `agent.settled`. If the task has mutation tool calls but isn't completed, emits a steer telling the model to finish the pending evidence. Uses `dedupeKey: "task-follow-up"` to avoid repeated follow-ups.

### Mutation Policy (`mutation.ts`)

Handles `tool.requested` events:
1. **Contract gate:** if the tool is state-changing and no contract exists, block with the contract reason. Escalation (steer at 3, notify at 6) is handled via gate's `recordBlock()`.
2. **Read guard:** if enabled, block `edit`/`write` on paths not previously read.

### Context Policy (`context.ts`)

Handles `turn.end` and `context.compacted`:
- On `turn.end`: runs `evolveWatchdog()`, emits `record` for state update, plus `compact` or `notify` based on the decision.
- On `context.compacted`: emits `inject` with the full projection (protocol + verification state + task state). Dedupe key uses `compactionEpoch` so each compaction restores state independently.

### Loop Policy (`loop.ts`)

Two concerns in one policy:
1. **Dead loop detection** on `tool.requested`: maintains a sliding window of tool call signatures. When the window fills with identical signatures and the signature hasn't been notified before, emits a steer. State-changing calls reset the window (a changed environment means progress).
2. **Research drift** on `turn.end`: counts consecutive read-only turns with no text findings, no completion signals, and no state changes. At threshold, emits a steer telling the model to converge. Aborted/error turns don't count.

### Quality Policy (`quality.ts`)

On `turn.end`: assesses response quality. Up to 2 consecutive steers, then degrades to a single `notify` warning. The steer dedupe key uses `turn` number so each anomalous turn gets exactly one correction. Aborted/error turns are skipped.

---

## Configuration

Config loaded from `~/.pi/agent/local-model-harness.json` (or `LOCAL_MODEL_HARNESS_CONFIG` env var). All fields are optional with sensible defaults:

| Field | Default | Description |
|-------|---------|-------------|
| `provider` | `"lmstudio"` | Pi provider name |
| `models` | *(required)* | Non-empty whitelist of model IDs |
| `lockPath` | `~/.pi/agent/local-model-harness.lock` | Lock file path |
| `contextWatchdog.enabled` | `true` | Enable watchdog |
| `contextWatchdog.thresholdPercent` | `80` (clamped 10-95) | Compact threshold |
| `loopGuard.enabled` | `true` | Enable loop guard |
| `loopGuard.window` | `3` (min 2) | Sliding window size |
| `researchDrift.enabled` | `true` | Enable drift detection |
| `researchDrift.threshold` | `8` (min 3) | Consecutive read-only turns before steer |
| `turnCap.enabled` | `false` | Hard turn cap |
| `turnCap.maxTurns` | `40` (min 4) | Max turns before abort |
| `protocolLanguage` | `"en"` | `"en"` or `"zh"` |
| `gate.enabled` | `true` | Enable contract gate |
| `gate.readOnlyTools` | `[]` | Extra read-only tool names |
| `readGuard.enabled` | `false` | Enable read-before-edit guard |

Without a valid config, the harness stays completely inactive.

---

## Adapter — Pi Integration

`src/pi/adapter.ts` (`registerActiveAdapter`) is the sole bridge to pi. It:

1. **Registers tools:** `task_contract`, `task_verify`, `task_complete`.
2. **Registers commands:** `/local-doctor`, `/local-report`.
3. **Subscribes to hooks:** `session_start`, `model_select`, `before_agent_start`, `before_provider_request`, `turn_start`, `tool_execution_start`, `tool_call`, `tool_result`, `turn_end`, `session_compact`, `agent_end`, `agent_settled`, `session_shutdown`.
4. **Manages the provider lock:** acquires before provider requests, releases on tool execution start and session end.
5. **Builds injection blocks:** protocol + verification state + task state, deduplicated by content via `lastInjectedBlock`.
6. **Applies directives:** translates controller output to Pi interventions (block returns error, steer sends user message, inject sends custom-type message, compact calls `ctx.compact()`, notify calls `ctx.ui.notify()`).

**Error handling:** Every hook runs through `safeRun()` / `safeRunAsync()`. Failures are logged via `pi.appendEntry("local-error", ...)` and never propagate to pi. The fail-closed fallback (`gate.enabled: true` → block) ensures safety on internal errors.

**Lock lifecycle:**
```
before_provider_request → acquireLock()
tool_execution_start    → releaseLock()
turn_end                → releaseLock() (finally)
agent_end               → releaseLock()
session_shutdown        → releaseLock()
```

---

## Design Principles

1. **Evidence before assertions.** Every mechanism was validated against benchmark transcripts before shipping. Verification pacing (v0.2.1) fixed a real deadlock (t2 errors 27→0); quality monitor and read guard defend against rare but real failure modes.

2. **Controller owns state.** Policies read `Readonly<HarnessState>`. State mutation flows through exactly one path: `record` directive → `applyPolicyRecord()` in the controller. This makes state transitions replayable and eliminates race conditions.

3. **Mechanisms are framework-agnostic.** `src/mechanisms/` has zero pi imports. Each mechanism is a pure function or class that takes inputs and returns outputs. Tests feed event traces directly without mocking pi.

4. **Conservative defaults.** Bash classification: only proven state-changing commands are gated. Read guard: off by default. Turn cap: off by default. The harness explains failures rather than hiding them.

5. **KV-cache-friendly injection.** Protocol, verification state, and task state are injected as a trailing custom message (not a system-prompt rewrite), so the cached prefix on the local server stays valid. The block is deduplicated and re-injected after compaction via `compactionEpoch`.

6. **Steer backoff.** Quality corrections and drift nudges stop after 2 consecutive unanswered ones and degrade to a single UI warning. A stuck model can't farm a nudging loop.

7. **Cancelled turns are not quality failures.** Turns ending with `stopReason: "aborted"` or `"error"` skip quality checks — empty content is expected, not a model defect.

8. **Fail-closed on internal errors.** If any hook throws, the adapter logs the error and applies a fail-closed gate (block) rather than letting the model proceed unchecked.
