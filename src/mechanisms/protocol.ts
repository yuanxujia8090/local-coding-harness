import type { ProtocolLanguage } from "../base/config";

const PROTOCOL_EN = `
## Local Coding Protocol
- Read project instructions and relevant code before editing.
- For non-trivial work, state a short plan before changing files.
- Make the smallest change that satisfies the request; preserve existing user changes.
- Run the smallest relevant verification after changes.
- After a state change, run a successful read-only check (ls/test/grep/git status...) before task_verify; task_verify requires it.
- Inspect the diff before reporting completion.
- Diagnose failed verification before changing code again.
- State clearly when verification was not run.
- Reply to the user in the language the user is using.
`.trim();

const PROTOCOL_ZH = `
## 本地编码协议
- 编辑前先阅读项目说明和相关代码。
- 非平凡任务，修改文件前先给出简短计划。
- 做满足需求的最小改动；保留用户已有的修改。
- 修改后运行最小相关验证。
- 状态变更后、task_verify 之前，先运行一次成功的只读检查（ls/test/grep/git status 等）；task_verify 会强制要求这一条。
- 报告完成前检查 diff。
- 验证失败先诊断原因，再改代码。
- 没有运行验证时必须明确说明。
- 用用户使用的语言回复。
`.trim();

export function buildCodingProtocol(language: ProtocolLanguage = "en"): string {
	return language === "zh" ? PROTOCOL_ZH : PROTOCOL_EN;
}