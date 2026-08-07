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
```

## 为什么要给本地模型做 harness

面向 frontier 模型的 harness 隐含假设：模型几乎不会写错工具调用格式、能遵守结构化输出、压缩时摘要质量高。本地模型会打破这些假设。本 harness 刻意保持小巧，只在本地模型有实测短板的地方介入：

- **"命令跑成功了，所以任务完成了。"** 工具调用成功只是局部事实，不能证明用户目标已达成。任务账本要求模型先声明完成条件（`task_contract`），并为每个条件附上真实的只读证据（`task_verify`），之后 `task_complete` 才会被接受。
- **跳过验证。** 编辑会把会话标记为"未验证"；只有成功执行被识别的验证命令（`npm test`、`pytest`、`cargo test`、`tsc`……）才会清除。带着未验证变更结算会产生可见提醒。
- **反复重试直到卡死。** Loop guard 检测同一调用连续出现 N 次，并引导模型换思路。
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
  "protocolLanguage": "en",            // 可选："en"（默认）或 "zh"
  "gate": {                            // 可选
    "enabled": true                    // 默认 true；false 完全关闭契约门禁
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
- **Loop guard 只引导、不拦截。** 重复调用可能是合理的（如轮询）；guard 对每个重复签名只注入一次纠偏消息，并把干预次数记入 telemetry。
- **保守的 bash 分类。** 未知 bash 命令按状态变更处理。不断增长的白名单比不断增长的黑名单更少误判副作用。

## 限制

- Provider 锁只协调加载了本扩展的 pi 进程。
- 只读 bash 白名单刻意保持很小；其余命令一律要求契约。
- Telemetry 按会话内存记录（结算/报告时持久化为会话条目），不是跨会话数据库。

## 开发

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
```

核心逻辑在 `src/core.ts`（纯逻辑，零 pi 依赖），每个机制都可单元测试；`index.ts` 是 pi 接线层。

## 许可证

MIT
