---
name: reviewing-local-model-harness
description: Use when modifying, reviewing, or preparing a release of this local-model-harness Pi extension, especially changes to hooks, policies, task contracts, shell classification, provider locks, telemetry, configuration, or package behavior.
---

# Review Local Model Harness

Review this as a reliability boundary, not ordinary utility code. A passing pure-policy test does not prove Pi hook order, provider serialization, or task completion work in a live session.

## Scope First

1. Read `AGENTS.md`, current architecture, relevant plan/review records, source seam, callers, and focused tests. Preserve unrelated worktree changes.
2. State behavior contract, non-goals, failure policy, verification, and benchmark requirement before editing. Reuse existing Pi runtime and policy/controller boundaries; do not add runtime/framework abstractions without evidence.
3. Trace end to end: Pi hook -> adapter -> `HarnessEvent` -> controller/reducer -> policy/directive -> Pi side effect. For tool changes, trace both `tool_call` and registered tool `execute`; a pre-execution block must not make the only completion path unreachable.

## Release-Critical Checks

| Area | Review rule | Required regression |
| --- | --- | --- |
| Contract and ledger | A new contract or mutation cannot inherit stale evidence. Never pre-block `task_complete` on state only its registered `execute` can create. State whether one result may prove multiple `doneWhen` conditions; test that exact rule. | Contract replacement, mutation after verification, `task_verify`, then `tool_call` plus real `task_complete` execution. |
| Bash gate | Unknown or opaque execution is state-changing unless safely proven otherwise. Inspect quoted and nested `$()`, interpreters, `sh -c`, remote mutation, redirects, background jobs, and mixed chains. | Classifier plus adapter test: mutation is blocked without contract and recorded after allowance. |
| Provider lock | Define failure mode explicitly. Never remove a lock based only on stale prior observation; account for malformed/fresh/stale files, PID reuse, cancellation, and every release hook. | Contention, stale recovery, malformed lock grace, cancellation, and test-only temp lock path. |
| Adapter lifecycle | Async hook failures must preserve chosen fail-open/fail-closed semantics and release resources. Check model switching, compaction, settle, shutdown, dedupe, telemetry, and user-visible status. | Integration fixture uses real adapter with a temp config/lock; no production `~/.pi` state. |
| Policy boundary | Policies remain Pi-free/read-only; controller owns state; adapter owns side effects. Directive priority and dedupe remain deterministic. | Event-trajectory test plus adapter integration test. |
| Package and docs | Public behavior, defaults, config, and limits match README/README.zh-CN. Package contains intended runtime files only. | `npm pack --dry-run`, `npm test`, `npm run typecheck`. |

## Validation

- Write failing regression first for every behavior/bug fix; watch it fail before implementation.
- Run focused test, then `npm test` and `npm run typecheck`. If full suite depends on live user state, treat it as a test-isolation defect, not a passing result.
- For policy, threshold, prompt, gate, or default behavior changes: run affected benchmark task before/after three times and full task set once. Record comparable environment and median; do not claim improvement from one run.
- Update architecture/ADR/review and bilingual README when project rules classify the change as a documented capability or contract change.

## Report Format

List findings first, highest severity first. Each finding has `severity`, `file:line`, trigger, consequence, smallest safe fix, and missing test. Separate verified facts, assumptions, and residual runtime risks. Do not report release-ready without fresh test, typecheck, package, and required benchmark evidence.
