# local-model-harness

[English](./README.md) | 中文

为 [pi](https://pi.dev) + 本地模型（LM Studio、llama.cpp、MLX、Ollama——任何本地 OpenAI 兼容端点）打造的薄层 Coding Harness。

本地模型会写代码，但很难**可靠地把活干完**：跳过验证、一条命令成功就宣布任务完成、失败调用反复重试、上下文压缩后丢失任务状态。这个 harness 在 pi 之上补了一层纪律和证据机制——不替换 pi 的 agent loop、工具、会话和 Skills。

```
pi 原生 agent loop
  |
  +-- Local Coding Protocol        编辑前阅读、修改后验证、报告前查 diff
  +-- Provider Lock                多个 pi 进程间串行化受管模型请求
  +-- Session Telemetry            请求数、锁等待、工具、验证、上下文、压缩次数
  +-- Task Completion Ledger       契约 -> 证据 -> doneWhen；拦截无证据的"完成"
  +-- Context Watchdog             窗口打满前提前压缩
  +-- Loop Guard                   把模型从完全相同的重复调用中拉出来
  +-- Quality Monitor              检测空响应 / 空参数工具调用并纠正（v0.2.2）
  +-- Read Guard                   编辑前未读先拦（v0.2.3，默认关）
```

## 为什么要给本地模型做 harness

面向 frontier 模型的 harness 隐含假设：模型几乎不会写错工具调用格式、能遵守结构化输出、压缩时摘要质量高。本地模型会打破这些假设。本 harness 刻意保持小巧，只在本地模型有实测短板的地方介入：

- **"命令跑成功了，所以任务完成了。"** 工具调用成功只是局部事实，不能证明用户目标已达成。任务账本要求模型先声明完成条件（`task_contract`），并为每个条件附上真实的只读证据（`task_verify`），之后 `task_complete` 才会被接受。
- **跳过验证。** 编辑会把会话标记为"未验证"；只有成功执行被识别的验证命令（`npm test`、`pytest`、`cargo test`、`tsc`……）才会清除。带着未验证变更结算会产生可见提醒。
- **反复重试直到卡死。** Loop guard 检测同一调用连续出现 N 次，并引导模型换思路。
- **空响应 / 空参数工具调用。** 较小或劣化的模型偶尔会输出空内容，或带空参的工具调用。quality monitor 会同时记账并纠正该回合。
- **编辑从未读过的文件。** 罕见但真实：模型把内容幻想到未知文件里。read guard（可选，默认关）会拦住无先验 `read` 的 `edit`/`write`，并引导模型先读。
- **上下文压力。** 本地服务器重放长历史很慢，小模型在接近满窗时召回能力衰减。Watchdog 提前压缩（默认 80%）并带防压缩循环保护；协议/任务状态在压缩后自动重新注入。
- **多进程 GPU 争抢。** 多个 pi 会话同时请求同一个本地服务会争抢显存/内存。文件租约锁在加载本扩展的 pi 进程之间串行化受管模型请求。等待中的会话会在 working 指示器上显示 `waiting for model slot (held by pid N, Xm Ys)`，等待超过 5 秒弹出通知；进程死亡留下的遗留锁会自动清理。

## 这不是什么

- 不是另一个 Agent 框架。pi 的循环、工具、会话、AGENTS.md、Skills 全部不动。
- 不是机器级资源管理器。锁只协调加载了本扩展的 pi 进程；你本地服务的其他客户端不受影响。模型加载/卸载仍由你的推理服务负责。
- 没有自动 fallback、没有模型路由、没有多代理编排。这些机制会掩盖失败而不是解释失败。如果 telemetry 数据证明你需要它们，你会看到的。

## 环境要求

- [pi](https://pi.dev) >= 0.83
- 本地 OpenAI 兼容服务（LM Studio、llama.cpp、MLX/omlx、Ollama 等），并已在 pi 中注册为 provider
- 支持工具调用的模型（用 `/local-doctor` 验证）

## 安装

在 `~/.pi/agent/settings.json` 的 `packages` 中添加：

```jsonc
{
  "packages": [
    "git:github.com/<owner>/local-model-harness"
  ]
}
```

然后重启 pi。（`<owner>` 替换为仓库所有者；也支持 `pi install /本地/路径` 直接从本地目录安装。）

## 配置

创建 `~/.pi/agent/local-model-harness.json`，列出 harness 要管理的模型：

```jsonc
{
  "provider": "lmstudio",              // pi provider 名称（默认 "lmstudio"）
  "models": ["your-model-id"],         // 必填，非空白名单
  "lockPath": "~/.pi/agent/local-model-harness.lock",  // 可选
  "contextWatchdog": {                 // 可选
    "enabled": true,                   // 默认 true
    "thresholdPercent": 80             // 默认 80（限制在 10-95）
  },
  "loopGuard": {                       // 可选
    "enabled": true,                   // 默认 true
    "window": 3                        // 默认 3（最小 2）
  },
  "researchDrift": {                   // 可选；引导过长的只读调研收敛
    "enabled": true,                   // 默认 true
    "threshold": 8                     // 默认 8（最小 3）连续只读轮次无产出
  },
  "turnCap": {                         // 可选；每轮运行硬轮数上限——默认关
    "enabled": false,                  // 默认 false；开启后硬停不终止的运行
    "maxTurns": 40                     // 默认 40（最小 4）；超过即 abort
  },
  "protocolLanguage": "en",            // 可选："en"（默认）或 "zh"
  "gate": {                            // 可选
    "enabled": true,                   // 默认 true；false 完全关闭契约门禁
    "readOnlyTools": ["shepherd_rules"] // 第三方只读工具名（仅读，不需契约）
  },
  "readGuard": {                       // 可选；默认关
    "enabled": false                   // edit/write 该路径前必须先 read
  }
}
```

`protocolLanguage: "zh"` 会以中文注入编码协议。对本地模型而言，让协议语言与工作语言一致可以减少语言漂移——注入的协议是持续的上下文来源，移除英文来源比"要求模型别说英文"更有效。未知值回退为 `"en"`。

没有有效配置时，harness 完全静默不生效（不拦截、不注入），`/local-doctor` 会打印配置指引。设置 `LOCAL_MODEL_HARNESS_CONFIG=/path/to/config.json` 可指定其他配置路径。修改配置需重启 pi。

## 验证环境

选中一个受管模型，然后运行：

```
/local-doctor
```

它按顺序检查：模型在白名单内 → provider 端点响应 `GET /models` 且暴露了该模型 → 一次无副作用的探针请求确实返回了指定的工具调用。"模型列表里有这个模型"和"这个模型能正确完成工具调用"是两件事，doctor 把它们分开检查。

## 命令

| 命令 | 作用 |
|------|------|
| `/local-doctor` | 端到端检查当前选中的受管模型（白名单、端点、tool call 探针） |
| `/local-report` | 打印会话 telemetry + 任务完成状态，并保存为会话条目 |

Telemetry 的设计目标是诊断本地模型会话，不是好看。`/local-report` 包含：

```
Lock wait: 137230ms (12 waits >500ms, max 45000ms)   <- 锁争抢严重程度
Tool calls: 35 (6 errors: bash 4, edit 2)            <- 分工具错误归因
Verification: passed (9 commands)                    <- 模型是否真的跑了验证
Compactions: 0 (0 watchdog-triggered)                <- 上下文压力历史
Loop interventions: 0                                <- 模型被转向提醒的次数
```

## 工具（模型使用）

| 工具 | 用途 |
|------|------|
| `task_contract` | 在状态变更工作前声明 `intent`、`scope`、`doneWhen`、`verificationPlan`、`unresolved` |
| `task_verify` | 把最近一次成功的只读工具结果绑定到一个 `doneWhen` 条件 |
| `task_complete` | 仅当每个 `doneWhen` 条件都有验证证据时才被接受 |

只读探索（`read`、`grep`、`find`、`ls`，以及已知只读的 bash 命令如 `git status`、`ls`、`cat`，包括只读管道如 `git status | head -30`）永远不需要契约。`edit`、`write` 和任何无法证明只读的 bash 命令，在契约建立前会被拦截——拦截消息署名 `[local-model-harness]` 并附带填好的 `task_contract` 示例。若模型持续撞门禁（3 次），harness 会注入明确的转向指令；6 次后在 UI 提醒用户。`gate.enabled: false` 是逃生门，无需卸载即可整体关闭门禁。模型不需要复述内部 tool call ID——它用自然语言表达条件，账本负责匹配证据。

## 设计说明

- **KV cache 友好注入。** 协议、验证状态、任务状态以尾部自定义消息注入（而非改写 system prompt），让你本地服务器上的缓存前缀保持有效。注入块带去重，压缩后自动重新注入。
- **Watchdog 暂停机制。** 如果压缩后使用率仍高于阈值，watchdog 会暂停而不是反复触发注定失败的压缩；使用率明显回落后自动恢复。pi 自身的接近溢出压缩仍是最后兜底。
- **Loop guard 只引导、不拦截。** 重复调用可能是合理的（如轮询）；guard 对每个重复签名只注入一次纠偏消息，并把干预次数记入 telemetry。新的状态变更调用会重置重复窗口（环境变了之后重复调用是进展），但重复相同变更仍视为循环。
- **调研漂移守卫。** 除了完全相同重复，harness 还检测"调研漂移"：连续 N 轮只做只读查询（没有文本结论、没有 `task_verify`/`task_complete`、没有状态变更）时，引导模型收敛——总结已有发现，或明确请用户确认范围，而不是继续翻文件。取消产生的空轮次不计数。通过 `researchDrift` 配置。
- **轮数上限是兜底。** 调研漂移、完全相同重复、以及一切超长运行共享同一道最终保险：可选的硬轮数上限（`turnCap`），轮数超过 `maxTurns` 即 abort 终止运行，移植自 little-coder 的 `max_turns` early-break。默认关；当模型容易跑长时开启。
- **Steer 退避。** 质量纠正与漂移提醒在连续 2 次未响应后停止，降级为单条 UI 警告，避免卡死的模型被连环 nudge 喂出新的循环。
- **取消轮次不算质量失败。** `stopReason: "aborted"`（用户 ESC 或 harness abort）或 `"error"`（传输/提供方失败）结束的轮次跳过质量检查——内容为空是预期行为，不是模型缺陷。
- **保守的 bash 分类。** 只有当命令结构性地写入时才按状态变更处理——重定向（`>`、`>>`）、已知破坏性命令（`rm`、`mv`、`git commit`、包安装）、或执行任意脚本。其余默认只读，因此探索链、循环、内联脚本不会被无端拦截。
- **证据优先。** 每个机制都在上基准实测后再上线。验证节奏（v0.2.1）修掉一个真实死锁（t2 errors 27→0）；quality monitor 与 read guard 针对罕见但真实的失败模式，默认关闭或最小化。

## 限制

- Provider 锁只协调加载了本扩展的 pi 进程。
- 只读 bash 白名单刻意保持很小；其余命令一律要求契约。
- Telemetry 按会话内存记录（结算/报告时持久化为会话条目），不是跨会话数据库。

## 版本历史

- **v0.2.3** Read Guard：`edit`/`write` 一个从未 `read` 过的路径会被拦截并引导（默认关，`readGuard.enabled: true` 开启）。防御型机制（bench 仅 1 轮 2 次无先读的 edit）。
- **v0.2.2** Quality Monitor：检测空响应（empty responses）与空参数工具调用（empty tool calls），计入 telemetry 并引导该回合。
- **v0.2.1** 验证节奏死锁修复：`&&`/`||`/`!`/`;` 链、测试命令（`node test.js`、`npm test`…）识别为只读；一次只读结果可支撑多个完成条件。t2 errors 27→0。
- **v0.2.0** 契约门禁、Context Watchdog、Loop Guard、中文协议。

## 开发

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
```

核心逻辑是纯 TypeScript，零 pi 依赖，按职责拆分在 `src/` 下各文件，每个机制保持可单元测试；`src/core.ts` 是桶文件（barrel），只负责 re-export 公共接口；`index.ts` 是 pi 接线层：

```
src/
├── adapter.ts      pi 接线：hooks、tools、commands、provider 锁、注入
├── config.ts       配置加载、默认值、受管模型识别
├── protocol.ts     本地编码协议文本（en/zh）
├── session.ts      会话 telemetry + 验证命令识别
├── shell.ts        bash 结构化只读分析
├── gate.ts         契约门禁（拦截 + 升级引导）
├── ledger.ts       任务契约/证据台账 + 报表格式化
├── lock.ts         文件租约锁 + 模型 tool-call 探针
├── loop.ts         工具调用签名 + 回合上限辅助
├── quality.ts      回复质量判定辅助
├── readguard.ts    先读后改守卫
├── watchdog.ts     上下文压缩决策辅助
├── controller.ts   事件 → policy 分发、状态回写
├── events.ts       harness 事件类型
├── state.ts        按 policy 归属的 harness 状态
├── policy.ts       policy/directive 契约
├── policies/       loop / quality / context / mutation / completion 各 policy
└── core.ts         re-export 公共表面
```

## 许可证

MIT
