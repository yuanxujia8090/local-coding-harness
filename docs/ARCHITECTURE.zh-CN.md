# 架构文档 — local-model-harness

> 为 [pi](https://pi.dev) + 本地模型打造的薄层编码 harness。在 pi 的 agent loop 之上补充纪律和证据机制，不替换 pi 本身。

## 目录

1. [概述](#概述)
2. [分层架构](#分层架构)
3. [事件系统](#事件系统)
4. [控制器](#控制器)
5. [策略框架](#策略框架)
6. [状态管理](#状态管理)
7. [机制](#机制)
8. [策略](#策略)
9. [配置](#配置)
10. [适配器 — Pi 集成](#适配器--pi-集成)
11. [设计原则](#设计原则)

---

## 概述

Harness 运行在 pi agent loop 和本地模型（LM Studio、llama.cpp、MLX、Ollama，或任何 OpenAI 兼容端点）之间。本地模型会写代码，但很难**可靠地把活干完**：跳过验证、一条命令成功就宣布完成、失败调用反复重试、上下文压缩后丢失任务状态。

Harness 在 pi 之上叠加了八个机制：

| 机制 | 作用 |
|------|------|
| 本地编码协议 | 持续上下文注入：编辑前阅读、修改后验证、检查 diff |
| Provider 锁 | 文件租约锁，在 pi 进程间串行化受管模型请求 |
| 会话遥测 | 按会话统计：请求数、锁等待、工具、验证、上下文、压缩次数 |
| 任务完成台账 | 契约 → 证据 → doneWhen；拦截无证据的 task_complete |
| 上下文看门狗 | 在可配置阈值提前压缩，带暂停/恢复逻辑 |
| 循环守卫 | 检测滑动窗口内完全相同的工具调用，引导模型换思路 |
| 质量监控 | 检测空响应/空参数工具调用，先引导后降级 |
| 阅读守卫 | （可选）拦截未先阅读的 edit/write |

这些机制位于 `src/mechanisms/`。它们是**纯逻辑**，零 pi 依赖——每个都可以独立单元测试。

---

## 分层架构

```
src/
├── pi/adapter.ts        ← Pi 接线：hooks、tools、commands、provider 锁、注入
├── base/                ← 共享契约
│   ├── config.ts        ← HarnessConfig 模式 + 加载器
│   ├── events.ts        ← HarnessEvent 联合类型
│   ├── state.ts         ← HarnessState + 归约器（applyEvent, applyPolicyRecord）
│   └── policy.ts        ← Directive 联合 + Policy 接口 + mergeDirectives
├── mechanisms/          ← 纯逻辑，零 pi 依赖
│   ├── protocol.ts      ← 编码协议文本（en/zh）
│   ├── session.ts       ← SessionTelemetry + 验证命令识别
│   ├── shell.ts         ← bash 结构化只读分析
│   ├── gate.ts          ← ContractGate 升级逻辑
│   ├── ledger.ts        ← TaskCompletionLedger + 报表格式化
│   ├── lock.ts          ← FileLeaseLock + 工具调用探针解析
│   ├── loop.ts          ← 工具调用签名 + TurnCap
│   ├── quality.ts       ← 回复质量评估
│   ├── readguard.ts     ← 先读后改守卫
│   └── watchdog.ts      ← 上下文压缩决策辅助
├── policies/            ← 策略实现（无状态评估器）
│   ├── completion.ts    ← agent.settled 时未完成任务的续跑引导
│   ├── mutation.ts      ← 契约门禁 + 阅读守卫执行
│   ├── context.ts       ← 看门狗评估 + 压缩后注入
│   ├── loop.ts          ← 循环检测 + 调研漂移
│   └── quality.ts       ← 空响应/空参数引导 + 退避
├── controller.ts        ← HarnessController：事件 → 策略分发、状态回写
└── core.ts              ← 桶文件 re-export
```

**关键边界规则：**

- **`src/mechanisms/` 零 pi 依赖。** 机制是纯函数/类，接收输入返回输出。测试直接注入事件轨迹。
- **`src/policies/` 是无状态评估器。** 每个策略的 `evaluate()` 读取 `HarnessState`（通过 `Readonly<>` 保证不可变），返回 `Directive[]`。状态变异仅通过 controller 中的 `applyPolicyRecord()` 发生。
- **`src/pi/adapter.ts` 是唯一的 pi 集成点。** 它把 Pi hooks 转为 HarnessEvents，把 directives 转为 Pi 干预。其余部分与框架无关。

---

## 事件系统

事件是 Pi hooks 和策略之间的通用语言。事件名不复制 Pi hook 名——Pi API 变化时只需改 adapter。

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

**事件流转：**

```
Pi hook（如 "tool_call"）
  → adapter 转为 HarnessEvent（"tool.requested"）
  → controller.handle(event)
    → 每个策略 evaluate(event, state, config) 返回 Directive[]
    → mergeDirectives() 解决冲突
    → controller 对 state 应用 "record" 指令
    → 返回保留的 directives 给 adapter
  → adapter 将 directives 转为 Pi 干预（block/steer/inject/compact/notify）
```

**关键设计选择：** `turn.end` 承载观察载荷（content blocks、stopReason、contextPercent）。质量、调研漂移、看门狗都从这一个事件读取——没有重复数据路径。

---

## 控制器

`HarnessController` 是**唯一的编排入口**。它不调用 Pi API——事件和状态都是纯逻辑，使单元测试可以直接注入事件轨迹。

```typescript
class HarnessController {
  handle(event: HarnessEvent): readonly Directive[]
  snapshot(): Readonly<HarnessState>
}
```

**逐事件生命周期：**

1. 将最新台账快照同步到 `state.task`（契约/证据真相源）。
2. 通过 `applyEvent()` 将事件应用到 state（会话计数器、压缩 epoch 等）。
3. 在 `session.started` 时清空 steer/inject 去重集合。
4. 按固定优先级顺序运行每个策略的 `evaluate()`。
5. 通过 `mergeDirectives()` 合并策略输出（冲突解决）。
6. 对 state 应用 `record` 指令（策略跨事件修改状态的唯一途径）。
7. 按 key 去重 `steer`/`inject`；在 interventions 中计数 `block`/`compact`。
8. 返回保留的 directives。

**状态所有权：** Controller 独占 `HarnessState`。策略是只读消费者。这防止了竞态条件并使状态转换可重放。

---

## 策略框架

### 指令（Directives）

策略返回 directives——它们希望 adapter 执行的动作：

```typescript
type Directive =
  | { kind: "allow" }                          // 无需操作
  | { kind: "block"; policy: string; reason: string }
  | { kind: "steer"; policy: string; message: string; dedupeKey: string }
  | { kind: "inject"; policy: string; message: string; dedupeKey: string }
  | { kind: "compact"; policy: string; reason: string }
  | { kind: "notify"; policy: string; level: "info" | "warning" | "error"; message: string }
  | { kind: "record"; policy: string; event: string; data?: Record<string, unknown> };
```

### 策略接口

```typescript
interface Policy {
  readonly id: string;
  evaluate(event: HarnessEvent, state: Readonly<HarnessState>, config: HarnessConfig): readonly Directive[];
}
```

### 冲突解决（`mergeDirectives`）

当多个策略对同一事件产生 directives 时，应用以下规则：

| 优先级 | 规则 |
|--------|------|
| 1 | `record` 始终保留 |
| 2 | `block` 覆盖 `allow` |
| 3 | 只保留一个 `steer`（按策略传入顺序，最早者优先） |
| 4 | `inject` 按 `dedupeKey` 去重（调用方负责跨事件冷却期） |
| 5 | 只保留一个 `compact` |

### 策略优先级顺序

```typescript
DEFAULT_POLICY_ORDER = ["completion", "mutation", "context", "loop", "quality"];
```

正确性策略（completion、mutation）先于效率/质量策略（context、loop、quality）运行。

---

## 状态管理

### HarnessState 结构

```typescript
interface HarnessState {
  session: SessionState;        // active, model, turns
  task: TaskCompletionSnapshot; // 台账真相源（从 TaskCompletionLedger 同步）
  context: ContextState;        // paused, pendingCompact, compactionEpoch
  quality: QualityState;        // emptyResponses, emptyToolCalls, consecutiveSteers
  loop: LoopState;              // recentSignatures, notifiedSignatures, driftTurns, driftNotified
  interventions: InterventionState; // blocks, steers, injects, compactions（计数器）
}
```

### 状态变异规则

- **事件** 修改会话级计数器（`session.turns`、`context.compactionEpoch`）。
- **策略** 通过 `record` 指令修改观察/循环状态 → `applyPolicyRecord()`。
- **Controller** 是唯一的写入者。策略以 `Readonly<>` 读取 `state`。

### 压缩 Epoch

每次 `context.compacted` 事件递增 `compactionEpoch`。这有两个用途：
1. 每次压缩获得独立的注入去重 key（`post-compact-${epoch}`），因此连续手动压缩各自恢复一次动态状态。
2. Epoch 是注入块身份的一部分——adapter 中的 `lastInjectedBlock` 按内容缓存，所以 `before_agent_start` 中仅协议块不会在已注入协议 + 任务状态的压缩后被重复注入。

---

## 机制

### 协议（`protocol.ts`）

双语编码协议文本（en/zh）。在 `before_agent_start` 和每次压缩后作为尾部自定义消息注入。KV 缓存友好：本地服务器上的缓存前缀保持有效，因为我们追加而非重写。

### 会话遥测（`session.ts`）

按会话统计，在结算/报告时持久化为 pi 会话条目。关键行为：
- **验证待定**：在 `edit`/`write` 时设置，在识别的验证命令（`npm test`、`pytest`、`cargo test`、`tsc` 等）或成功的 edit/write 后清除。
- **纯文档豁免**：如果所有更改文件都是 `.md`/`.mdx`，`verificationPending` 保持 false（纯文档没有可运行的验证命令）。
- **工具错误归因**：snapshot 中按工具统计错误数。

### Shell 分析（`shell.ts`）

结构化 bash 只读分析——不是平面正则。处理：
- 引号感知扫描（单/双引号、反斜杠转义）
- Here 文档主体剥离（主体是数据，不是语法）
- 在顶层 `&&`/`||`/`;`/`|`/换行处分割命令链
- `$()` 替换重解析（递归）
- 复合块展平（`for`/`while`/`if` → 关键字边界）

**默认保守：** 未被证明是只读的命令被视为状态变更。写入检测是结构性的（重定向、已知破坏性命令）而非基于名称。

### 契约门禁（`gate.ts`）

契约门禁的升级逻辑：
- 每次拦截递增 block 计数器。
- 3 次拦截：注入 steer 消息，告知模型调用 `task_contract`。
- 6 次拦截：发出用户可见警告。
- 成功设置契约后调用 `reset()`。

### 任务完成台账（`ledger.ts`）

任务完成的真相源。跟踪：
- 活跃契约（intent、scope、doneWhen、verificationPlan、unresolved）
- 工具调用及其状态变更分类和顺序
- 已验证条件（每个 `doneWhen` 条件映射到最后一次状态变更后的一个成功只读工具调用）
- 完成：所有 `doneWhen` 条件都必须有证据

**关键不变量：** `task_complete` 只能在每个 `doneWhen` 条件都有证据时成功，且证据工具调用必须发生在最后一次状态变更调用之后。

### 文件租约锁（`lock.ts`）

跨进程受管模型请求串行化：
- `tryAcquire()`：用 `wx` 标志打开文件；遇到 `EEXIST` 时通过 `process.kill(pid, 0)` 检查所有者进程是否存活。死进程自动清理。
- `release()`：关闭句柄并删除文件。
- `peekOwner()`：静态辅助函数，用于在 UI 中显示锁持有者信息。

### 循环检测（`loop.ts`）

- **工具调用签名：** bash 为 `bash:<command>`，文件工具为 `<tool>:<path>`，其他为 `<tool>:<json>`（截断至 200 字符）。
- **TurnCap：** 简单计数器，在会话开始和模型切换时 `reset()`。

### 质量评估（`quality.ts`）

评估响应 blocks：
- 空响应：无文本、无 thinking、无工具调用。
- 空工具调用：工具调用带空 `arguments`（`task_complete` 除外，它 legitimately 有零参数）。

### 阅读守卫（`readguard.ts`）

跟踪被阅读工具（`read`、`grep`、`find`、`ls`、`rg`、`cat`、`head`、`tail`）访问过的路径。当 `edit`/`write`  targeting 未跟踪路径时，拦截并引导模型先阅读。通过 `readGuard.enabled: true` 开启。

### 看门狗决策（`watchdog.ts`）

纯函数：`evolveWatchdog(current, threshold, percent)` → `{ decision, next }`。状态：
- **none**：无操作。
- **compact**：percent ≥ 阈值，触发压缩。
- **pause**：刚压缩但 percent 仍 ≥ 阈值 → 暂停直到使用率降至 `阈值 - 10%` 以下。
- **resume**：已暂停且 percent 降至恢复边际以下。

---

## 策略

### 完成策略（`completion.ts`）

在 `agent.settled` 时触发。如果任务有状态变更工具调用但未完成，发出 steer 告知模型完成待处理的证据。使用 `dedupeKey: "task-follow-up"` 避免重复续跑引导。

### 变更策略（`mutation.ts`）

处理 `tool.requested` 事件：
1. **契约门禁：** 如果工具是状态变更且无契约，用契约原因拦截。升级（3 次 steer、6 次 notify）通过 gate 的 `recordBlock()` 处理。
2. **阅读守卫：** 如果启用，拦截未先阅读的 `edit`/`write`。

### 上下文策略（`context.ts`）

处理 `turn.end` 和 `context.compacted`：
- 在 `turn.end`：运行 `evolveWatchdog()`，发出 `record` 更新状态，并根据决策发出 `compact` 或 `notify`。
- 在 `context.compacted`：发出 `inject` 带完整投影（协议 + 验证状态 + 任务状态）。Dedupe key 使用 `compactionEpoch`，使每次压缩独立恢复状态。

### 循环策略（`loop.ts`）

一个策略处理两个关注点：
1. **死循环检测** 在 `tool.requested`：维护工具调用签名的滑动窗口。当窗口填满相同签名且该签名尚未通知过时，发出 steer。状态变更调用重置窗口（环境变了意味着进展）。
2. **调研漂移** 在 `turn.end`：统计连续只读轮次且无文本结论、无完成信号、无状态变更。达到阈值时发出 steer 告知模型收敛。中止/错误轮次不计入。

### 质量策略（`quality.ts`）

在 `turn.end`：评估回复质量。最多 2 次连续 steer，之后降级为单次 `notify` 警告。Steer dedupe key 使用轮次号，使每个异常轮次恰好获得一次纠正。中止/错误轮次被跳过。

---

## 配置

从 `~/.pi/agent/local-model-harness.json` 加载配置（或 `LOCAL_MODEL_HARNESS_CONFIG` 环境变量）。所有字段都有合理的默认值：

| 字段 | 默认值 | 描述 |
|------|--------|------|
| `provider` | `"lmstudio"` | Pi provider 名称 |
| `models` | *必填* | 非空模型 ID 白名单 |
| `lockPath` | `~/.pi/agent/local-model-harness.lock` | 锁文件路径 |
| `contextWatchdog.enabled` | `true` | 启用水 watchdog |
| `contextWatchdog.thresholdPercent` | `80`（限制 10-95） | 压缩阈值 |
| `loopGuard.enabled` | `true` | 启用循环守卫 |
| `loopGuard.window` | `3`（最小 2） | 滑动窗口大小 |
| `researchDrift.enabled` | `true` | 启用漂移检测 |
| `researchDrift.threshold` | `8`（最小 3） | 引导前连续只读轮次 |
| `turnCap.enabled` | `false` | 硬轮数上限 |
| `turnCap.maxTurns` | `40`（最小 4） | abort 前最大轮数 |
| `protocolLanguage` | `"en"` | `"en"` 或 `"zh"` |
| `gate.enabled` | `true` | 启用契约门禁 |
| `gate.readOnlyTools` | `[]` | 额外只读工具名 |
| `readGuard.enabled` | `false` | 启用先读后改守卫 |

没有有效配置时，harness 完全静默不生效。

---

## 适配器 — Pi 集成

`src/pi/adapter.ts`（`registerActiveAdapter`）是与 pi 的唯一桥梁。它：

1. **注册工具：** `task_contract`、`task_verify`、`task_complete`。
2. **注册命令：** `/local-doctor`、`/local-report`。
3. **订阅 hooks：** `session_start`、`model_select`、`before_agent_start`、`before_provider_request`、`turn_start`、`tool_execution_start`、`tool_call`、`tool_result`、`turn_end`、`session_compact`、`agent_end`、`agent_settled`、`session_shutdown`。
4. **管理 provider 锁：** 在 provider 请求前获取，在工具执行开始和会话结束时释放。
5. **构建注入块：** 协议 + 验证状态 + 任务状态，通过 `lastInjectedBlock` 按内容去重。
6. **应用 directives：** 将控制器输出转为 Pi 干预（block 返回错误，steer 发送用户消息，inject 发送自定义类型消息，compact 调用 `ctx.compact()`，notify 调用 `ctx.ui.notify()`）。

**错误处理：** 每个 hook 都通过 `safeRun()` / `safeRunAsync()` 运行。失败通过 `pi.appendEntry("local-error", ...)` 记录，从不传播到 pi。fail-closed 回退（`gate.enabled: true` → block）确保内部错误时的安全性。

**锁生命周期：**
```
before_provider_request → acquireLock()
tool_execution_start    → releaseLock()
turn_end                → releaseLock()（finally）
agent_end               → releaseLock()
session_shutdown        → releaseLock()
```

---

## 设计原则

1. **证据先于断言。** 每个机制在上线前都用 benchmark 转录验证过。验证节奏（v0.2.1）修复了一个真实死锁（t2 errors 27→0）；质量监控和阅读守卫防御罕见但真实的失败模式。

2. **Controller 拥有状态。** 策略读取 `Readonly<HarnessState>`。状态变异只通过一条路径流动：`record` 指令 → controller 中的 `applyPolicyRecord()`。这使状态转换可重放并消除竞态条件。

3. **机制与框架无关。** `src/mechanisms/` 零 pi 依赖。每个机制是接收输入返回输出的纯函数或类。测试直接注入事件轨迹，无需模拟 pi。

4. **默认保守。** Bash 分类：只有被证明是状态变更的命令才被拦截。阅读守卫：默认关闭。Turn cap：默认关闭。Harness 解释失败而非隐藏它们。

5. **KV 缓存友好注入。** 协议、验证状态和任务状态作为尾部自定义消息注入（而非 system prompt 重写），使本地服务器上的缓存前缀保持有效。该块在压缩后通过 `compactionEpoch` 去重并重新注入。

6. **引导退避。** 质量纠正和漂移提醒在连续 2 次无响应后停止，降级为单条 UI 警告。卡死的模型不能通过 nudge 循环 farming。

7. **取消轮次不是质量失败。** `stopReason: "aborted"` 或 `"error"` 结束的轮次跳过质量检查——空内容是预期行为，不是模型缺陷。

8. **内部错误时 fail-closed。** 如果任何 hook 抛出异常，adapter 记录错误并应用 fail-closed 门禁（block），而不是让模型 unchecked 继续。
