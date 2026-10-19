/**
 * 插槽解析：注册、条件三态、就绪、同槽依赖与冲突。
 *
 * 纯函数式实现，不引入 Cordis；`src/slots/index.ts` 只把它包装成服务。
 * 排序是插槽内的局部依赖处理，不是任务图调度。
 */

import { validateExtension } from './contracts.js'
import type { NodeCatalog, Readiness, SlotExtension, SlotFacts } from './contracts.js'

export interface PlannedStep {
  readonly id: string
  readonly extension: SlotExtension
}

export interface BlockedExtension {
  readonly id: string
  readonly reason: string
  readonly missing?: readonly string[]
}

export interface Conflict {
  readonly kind: 'output-ownership' | 'exclusive-group' | 'dependency-cycle'
  readonly ids: readonly string[]
  readonly detail: string
}

/**
 * 一次插槽解析的结果，`considered` 是本次看到的候选扩展 id（稳定排序）。
 * 除 `empty` / `run` 外的分支都表示"当前不能继续执行"，必须由调用方交给业务决定或补齐事实。
 */
export type Resolution =
  | { readonly kind: 'empty'; readonly considered: readonly string[] }
  | { readonly kind: 'run'; readonly steps: readonly PlannedStep[]; readonly considered: readonly string[] }
  | {
      readonly kind: 'waiting'
      readonly steps: readonly PlannedStep[]
      readonly missing: readonly string[]
      readonly unprovided: readonly string[]
      readonly considered: readonly string[]
    }
  | { readonly kind: 'gap'; readonly missing: readonly string[]; readonly considered: readonly string[] }
  | {
      readonly kind: 'blocked'
      readonly blocked: readonly BlockedExtension[]
      readonly considered: readonly string[]
    }
  | {
      readonly kind: 'conflict'
      readonly conflicts: readonly Conflict[]
      readonly considered: readonly string[]
    }

export interface SlotRegistry {
  /** 注册扩展定义；返回撤销函数。非法定义抛错。 */
  register(extension: SlotExtension): () => void
  /** 解析某个插槽当前适用的扩展、顺序与冲突。 */
  resolve(
    slot: string,
    facts: SlotFacts,
    view: unknown,
    definitions?: readonly SlotExtension[],
  ): Resolution
  /** 定义快照（稳定按 id 排序）。 */
  snapshot(): readonly SlotExtension[]
  list(): readonly SlotExtension[]
}

const byId = (a: SlotExtension, b: SlotExtension): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const byRecordId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * 就绪判定只在“当前作用域可执行”范围内回答；是否获准由 DSH 工具管线决定。
 * view 由调用方提供，registry 不解释它的内部结构。
 */
function evaluateReadiness(extension: SlotExtension, view: unknown): Readiness {
  let result: unknown
  try {
    result = extension.ready(view)
  } catch (error) {
    return { ready: false, reason: `ready() threw: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!result || typeof result !== 'object' || typeof (result as { ready?: unknown }).ready !== 'boolean') {
    return { ready: false, reason: 'ready() must return { ready: boolean }' }
  }
  const readiness = result as Readiness
  if (readiness.ready === false && (typeof readiness.reason !== 'string' || readiness.reason.length === 0)) {
    return { ready: false, reason: 'ready() denied without a reason' }
  }
  return readiness
}

function evaluateMatch(extension: SlotExtension, facts: SlotFacts): ReturnType<SlotExtension['match']> {
  let result: unknown
  try {
    result = extension.match(facts)
  } catch (error) {
    return { kind: 'unknown', missing: [`match() threw: ${error instanceof Error ? error.message : String(error)}`] }
  }
  if (!result || typeof result !== 'object') return { kind: 'unknown', missing: ['match() returned no result'] }
  const match = result as { kind?: unknown; missing?: unknown }
  if (match.kind === 'yes' || match.kind === 'no') return { kind: match.kind }
  if (match.kind === 'unknown') {
    const missing = Array.isArray(match.missing) ? (match.missing as string[]) : []
    return { kind: 'unknown', missing }
  }
  return { kind: 'unknown', missing: [`match() returned unknown kind: ${String(match.kind)}`] }
}

function factKnown(facts: SlotFacts | undefined, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(facts?.values ?? {}, name)
}

export function createSlotRegistry(catalog: NodeCatalog): SlotRegistry {
  const definitions = new Map<string, SlotExtension>()

  function register(extension: SlotExtension): () => void {
    const frozen = validateExtension(extension, catalog)
    if (definitions.has(frozen.id)) throw new Error(`duplicate extension id: ${frozen.id}`)
    definitions.set(frozen.id, frozen)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (definitions.get(frozen.id) === frozen) definitions.delete(frozen.id)
    }
  }

  function snapshot(): readonly SlotExtension[] {
    return Object.freeze([...definitions.values()].sort(byId))
  }

  function resolve(
    slot: string,
    facts: SlotFacts,
    view: unknown,
    override?: readonly SlotExtension[],
  ): Resolution {
    const declared = catalog.get(slot)
    if (!declared) throw new Error(`unknown slot: ${slot}`)
    const candidates = (override ?? snapshot()).filter((entry) => entry.slot === slot).sort(byId)
    const considered = Object.freeze(candidates.map((entry) => entry.id))
    if (candidates.length === 0) return { kind: 'empty', considered }

    const applicable: SlotExtension[] = []
    const blockedList: BlockedExtension[] = []
    const unknownMissing: string[] = []

    for (const extension of candidates) {
      const matched = evaluateMatch(extension, facts)
      if (matched.kind === 'no') continue
      if (matched.kind === 'unknown') {
        for (const fact of matched.missing) if (!unknownMissing.includes(fact)) unknownMissing.push(fact)
        continue
      }
      const readiness = evaluateReadiness(extension, view)
      if (readiness.ready !== true) {
        blockedList.push({
          id: extension.id,
          reason: readiness.reason,
          ...(readiness.missing ? { missing: Object.freeze([...readiness.missing]) } : {}),
        })
        continue
      }
      applicable.push(extension)
    }

    // 适用但不可执行不能当作未注册而静默跳过。
    if (blockedList.length > 0) return { kind: 'blocked', blocked: Object.freeze(blockedList), considered }

    // 有候选的 missing 事实由本次可执行候选提供时，先执行提供者再重算，避免一律预检阻塞。
    const provable = new Set(applicable.flatMap((entry) => [...(entry.provides ?? [])]))
    const suppliedByRun = unknownMissing.filter((fact) => provable.has(fact))
    const unprovided = unknownMissing.filter((fact) => !provable.has(fact))
    if (unknownMissing.length > 0 && suppliedByRun.length === 0) {
      return { kind: 'gap', missing: Object.freeze([...unknownMissing]), considered }
    }
    if (applicable.length === 0) return { kind: 'empty', considered }

    const conflicts: Conflict[] = []
    const claimed = new Map<string, string>()
    for (const extension of applicable) {
      for (const fact of extension.provides ?? []) {
        const owner = claimed.get(fact)
        if (owner && owner !== extension.id) {
          conflicts.push({
            kind: 'output-ownership',
            ids: Object.freeze([owner, extension.id].sort()),
            detail: `both extensions claim to provide ${fact}`,
          })
        } else {
          claimed.set(fact, extension.id)
        }
      }
    }
    const groups = new Map<string, string[]>()
    for (const extension of applicable) {
      if (!extension.exclusiveGroup) continue
      const members = groups.get(extension.exclusiveGroup) ?? []
      members.push(extension.id)
      groups.set(extension.exclusiveGroup, members)
    }
    for (const [group, members] of groups) {
      if (members.length > 1) {
        conflicts.push({
          kind: 'exclusive-group',
          ids: Object.freeze([...members].sort()),
          detail: `exclusive group ${group} has more than one applicable extension`,
        })
      }
    }
    if (conflicts.length > 0) return { kind: 'conflict', conflicts: Object.freeze(conflicts), considered }

    // 依赖边：需要的事实无人提供时是缺口，不执行部分猜测流程。
    const missingProviders = new Set<string>()
    const edges = new Map<string, Set<string>>(applicable.map((entry) => [entry.id, new Set<string>()]))
    for (const extension of applicable) {
      for (const fact of extension.requires ?? []) {
        if (factKnown(facts, fact)) continue
        const providers = applicable.filter(
          (entry) => entry.id !== extension.id && (entry.provides ?? []).includes(fact),
        )
        if (providers.length === 0) {
          missingProviders.add(fact)
          continue
        }
        for (const provider of providers) edges.get(provider.id)?.add(extension.id)
      }
    }
    if (missingProviders.size > 0) {
      return { kind: 'gap', missing: Object.freeze([...missingProviders].sort()), considered }
    }

    const ordered = topological(applicable, edges)
    if (!ordered) {
      return {
        kind: 'conflict',
        conflicts: Object.freeze([
          {
            kind: 'dependency-cycle',
            ids: Object.freeze(applicable.map((entry) => entry.id)),
            detail: 'requires/provides 存在依赖环',
          } satisfies Conflict,
        ]),
        considered,
      }
    }

    const steps = Object.freeze(ordered.map((extension) => Object.freeze({ id: extension.id, extension })))
    if (unknownMissing.length > 0) {
      return {
        kind: 'waiting',
        steps,
        missing: Object.freeze([...unknownMissing]),
        unprovided: Object.freeze([...unprovided]),
        considered,
      }
    }
    return { kind: 'run', steps, considered }
  }

  return Object.freeze({ register, resolve, snapshot, list: snapshot })
}

/**
 * Kahn 拓扑排序；同层按 id 稳定排序以便复现。返回 undefined 表示有环。
 * edges 是 provider -> consumers。
 */
function topological(
  nodes: readonly SlotExtension[],
  edges: Map<string, Set<string>>,
): SlotExtension[] | undefined {
  const indegree = new Map<string, number>(nodes.map((entry) => [entry.id, 0]))
  for (const consumers of edges.values()) {
    for (const consumer of consumers) indegree.set(consumer, (indegree.get(consumer) ?? 0) + 1)
  }
  const remaining = new Map<string, SlotExtension>(nodes.map((entry) => [entry.id, entry]))
  const ordered: SlotExtension[] = []
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((entry) => (indegree.get(entry.id) ?? 0) === 0).sort(byRecordId)
    if (ready.length === 0) return undefined
    for (const entry of ready) {
      ordered.push(entry)
      remaining.delete(entry.id)
      for (const consumer of edges.get(entry.id) ?? []) {
        indegree.set(consumer, (indegree.get(consumer) ?? 0) - 1)
      }
    }
  }
  return ordered
}
