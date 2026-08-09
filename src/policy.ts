import type { HarnessConfig } from "./config";
import type { HarnessEvent } from "./events";
import type { HarnessState } from "./state";

/** 策略指令。语义与冲突规则见架构文档 4.4。 */
export type Directive =
	| { kind: "allow" }
	| { kind: "block"; policy: string; reason: string }
	| { kind: "steer"; policy: string; message: string; dedupeKey: string }
	| { kind: "inject"; policy: string; message: string; dedupeKey: string }
	| { kind: "compact"; policy: string; reason: string }
	| { kind: "notify"; policy: string; level: "info" | "warning" | "error"; message: string }
	| { kind: "record"; policy: string; event: string; data?: Record<string, unknown> };

export interface Policy {
	readonly id: string;
	evaluate(event: HarnessEvent, state: Readonly<HarnessState>, config: HarnessConfig): readonly Directive[];
}

/** Policy 固定优先级默认顺序（架构 4.4）：先正确性，再效率与质量。 */
export const DEFAULT_POLICY_ORDER: readonly string[] = [
	"completion",
	"mutation",
	"context",
	"loop",
	"quality",
];

/** 合并一条事件的多个 policy 输出，执行架构 4.4 的冲突规则。
 *  - record 总是保留
 *  - block 覆盖 allow
 *  - 只保留一个 steer（按 policy 传入顺序，最早者优先）
 *  - inject 按 dedupeKey 去重（调用方负责跨事件冷却期）
 *  - compact 只保留一个 */
export function mergeDirectives(policyOutputs: readonly Directive[]): readonly Directive[] {
	const result: Directive[] = [];
	let hasBlock = false;
	let hasAllow = false;
	let steerPicked = false;
	let compactPicked = false;
	const injectedKeys = new Set<string>();

	for (const directive of policyOutputs) {
		switch (directive.kind) {
			case "allow":
				hasAllow = true;
				break;
			case "block":
				hasBlock = true;
				result.push(directive);
				break;
			case "steer":
				if (!steerPicked) {
					steerPicked = true;
					result.push(directive);
				}
				break;
			case "inject":
				if (!injectedKeys.has(directive.dedupeKey)) {
					injectedKeys.add(directive.dedupeKey);
					result.push(directive);
				}
				break;
			case "compact":
				if (!compactPicked) {
					compactPicked = true;
					result.push(directive);
				}
				break;
			case "notify":
			case "record":
				result.push(directive);
				break;
		}
	}

	if (hasBlock) {
		return result.filter((directive) => directive.kind !== "allow");
	}
	if (hasAllow) {
		return [...result.filter((directive) => directive.kind !== "allow"), { kind: "allow" as const }];
	}
	return result;
}