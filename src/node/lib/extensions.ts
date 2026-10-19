/**
 * 核心自带的最小 after 扩展：`acceptance.required` 为真且尚未提交决定时，
 * 在节点的 after 阶段暂停并索取一个业务决定。
 *
 * 这是 **core 自己的扩展**（不是领域扩展）：它只读已核对的既有事实，不声明
 * `provides`，也不调用角色，因此不需要技能表或子 Agent 服务。
 *
 * 为什么不写 `requires: ['base.completed']`：`base.completed` / `base.failed`
 * 由节点工具在进入 after 时合成，没有任何扩展 `provides` 它们；写进 `requires`
 * 会被解析器判成"必需事实无人提供"的缺口（gap），节点反而无法暂停。
 * 本扩展只依据**入参事实**判断是否适用，缺事实一律按不适用处理（`MATCH_NO`），
 * 这样"要不要在 after 要一个决定"永远不会把节点卡成缺口。
 */

import type { Match, Readiness, SlotExtension, SlotFacts } from '../../lib/contracts.js'
import { MATCH_NO, MATCH_YES, READY } from '../../lib/contracts.js'

/** 事实：本次节点调用是否要求一个处理决定。只有字面 `true` 才算要求。 */
export const ACCEPTANCE_REQUIRED_FACT = 'acceptance.required'

/** 事实：已提交的处理决定。存在（任意值）即视为已决定。 */
export const DECISION_FACT = 'decision'

/** 扩展 id 前缀；完整 id 形如 `core.acceptance-decision.validate`。 */
export const ACCEPTANCE_DECISION_ID_PREFIX = 'core.acceptance-decision'

/** 暂停原因文案：告诉模型为什么停、下一步交什么。 */
export const ACCEPTANCE_DECISION_NOTE = '基础节点已完成，等待提交处理决定'

export function acceptanceDecisionId(nodeId: string): string {
  return `${ACCEPTANCE_DECISION_ID_PREFIX}.${nodeId}`
}

/**
 * 为某一个已声明节点造一个 after 扩展。
 * `slotVersion` 必须与目录声明的版本一致，由调用方（wiring）在声明节点时给出。
 */
export function createAcceptanceDecisionExtension(nodeId: string, slotVersion = 1): SlotExtension {
  return {
    id: acceptanceDecisionId(nodeId),
    slot: `${nodeId}.after`,
    slotVersion,
    match(facts: SlotFacts): Match {
      if (facts.values[ACCEPTANCE_REQUIRED_FACT] !== true) return MATCH_NO
      if (facts.values[DECISION_FACT] !== undefined) return MATCH_NO
      return MATCH_YES
    },
    ready(): Readiness {
      // 不依赖任何能力：事实齐备就能执行，是否获准由 DSH 工具管线决定。
      return READY
    },
    run(): unknown {
      return { status: 'needs_decision', note: ACCEPTANCE_DECISION_NOTE }
    },
  }
}

/** 为每个已声明节点各造一个 after 扩展（顺序与入参一致）。 */
export function createBuiltinAfterExtensions(
  nodeIds: readonly string[],
  slotVersion = 1,
): readonly SlotExtension[] {
  return Object.freeze(nodeIds.map((nodeId) => createAcceptanceDecisionExtension(nodeId, slotVersion)))
}
