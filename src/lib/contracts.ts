/**
 * Satellite DSH 自有契约（不是 DSH 原生类型）。
 *
 * 这里只放纯数据校验与目录定义，不依赖 Cordis 或任何 DSH 包，
 * 以便单元测试可以直接导入构建产物。
 */

export type NodePhase = 'before' | 'after'

/** 稳定插槽声明。 */
export interface SlotDefinition {
  /** 稳定插槽名，例如 `validate.before` */
  readonly name: string
  /** 基础节点标识，例如 `validate` */
  readonly node: string
  readonly phase: NodePhase
  /** 插槽契约版本；扩展必须声明相同版本 */
  readonly version: number
}

/** match 三态结果。`unknown` 必须说明缺少哪些事实，不能与 `no` 混用。 */
export type Match =
  | { readonly kind: 'yes' }
  | { readonly kind: 'no' }
  | { readonly kind: 'unknown'; readonly missing: readonly string[] }

/**
 * ready 只判断“当前作用域能不能执行”，不代表已获授权。
 * `ready: false` 必须给出 reason，`missing` 用于指出缺少的能力。
 */
export type Readiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: string; readonly missing?: readonly string[] }

/**
 * 只读事实视图。事实只有在被核对后才写入 `values`；`provides` 声明本身不产生事实。
 */
export interface SlotFacts {
  readonly values: Readonly<Record<string, unknown>>
}

/** 角色目录说明；只投影已注册挂载，不参与 match/ready 或权限判定。 */
export interface SlotRoleMetadata {
  readonly name: string
  readonly skill: string
  readonly objective: string
  readonly condition: string
}

/**
 * 扩展定义。`run` 的实现可以是同步或异步（调用方一律 await），
 * 其 execution 参数由调用方（节点工具）在调用时注入，因此这里是 `unknown`。
 */
export interface SlotExtension {
  /** 命名空间内唯一，例如 `android.validation-context` */
  readonly id: string
  /** 公共插槽名（不是组件名） */
  readonly slot: string
  readonly slotVersion: number
  /** 可选的角色职责与触发说明，应与真实执行共用声明来源。 */
  readonly role?: SlotRoleMetadata
  /** 需要已核对的既有事实 */
  readonly requires?: readonly string[]
  /** 声明输出；不因声明就成为事实 */
  readonly provides?: readonly string[]
  /** 同一职责只能选一项时声明 */
  readonly exclusiveGroup?: string
  match(facts: SlotFacts): Match
  ready(view: unknown): Readiness
  /** 可选：产出事实加入前的核对；返回 true 才接受。 */
  verify?(name: string, value: unknown, facts: SlotFacts): boolean
  run(execution: unknown): unknown
}

/**
 * 扩展执行时可见的只读执行证据快照（本项目自有契约，不是 DSH 原生类型）。
 *
 * 只描述本次节点调用已经真实发生的事：`before` 阶段没有 `base`（基础节点尚未运行），
 * `after` 阶段才有本次调用已完成的基础结果。它是原始证据，不是
 * `provides` 事实、不是程序验收结论；正文一律按不可信任务数据处理。
 */
export interface ExtensionEvidence {
  readonly node: string
  readonly unit?: string
  readonly stage: NodePhase
  /** 本次调用已完成的基础结果（含失败）；`before` 阶段必须缺省。 */
  readonly base?: { readonly status: string; readonly result: unknown }
  /** 本次调用已经开始过的扩展，按实际顺序保留原始状态与正文。 */
  readonly previousExtensions: readonly ExtensionEvidenceEntry[]
}

/** 执行证据里的一条扩展记录；与节点执行器的实际记录同形。 */
export interface ExtensionEvidenceEntry {
  readonly id: string
  readonly slot: string
  readonly status: 'completed' | 'failed' | 'blocked' | 'needs_decision'
  readonly note?: string
  readonly error?: string
}

export const MATCH_YES: Match = Object.freeze({ kind: 'yes' })
export const MATCH_NO: Match = Object.freeze({ kind: 'no' })

export function unknownMatch(missing: readonly string[]): Match {
  if (!Array.isArray(missing) || missing.length === 0) {
    throw new TypeError('unknown match must name at least one missing fact')
  }
  return Object.freeze({ kind: 'unknown', missing: Object.freeze([...missing]) })
}

export const READY: Readiness = Object.freeze({ ready: true })

export function blocked(reason: string, missing?: readonly string[]): Readiness {
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new TypeError('blocked readiness requires a reason')
  }
  return Object.freeze({
    ready: false,
    reason,
    ...(missing ? { missing: Object.freeze([...missing]) } : {}),
  })
}

/** 节点与插槽目录。core 在这里声明稳定标识和版本，扩展只能引用已声明插槽。 */
export interface NodeCatalog {
  /**
   * 声明一个节点的稳定插槽；返回撤销函数。
   * 卸载节点插件时撤销其声明的插槽，避免留下无实现的稳定标识。
   */
  defineNode(node: string, options?: { version?: number; phases?: readonly NodePhase[] }): () => void
  get(name: string): SlotDefinition | undefined
  has(name: string): boolean
  list(): readonly SlotDefinition[]
}

export function createNodeCatalog(): NodeCatalog {
  const slots = new Map<string, SlotDefinition>()

  return Object.freeze({
    defineNode(node: string, options: { version?: number; phases?: readonly NodePhase[] } = {}) {
      const version = options.version ?? 1
      const phases = options.phases ?? (['before', 'after'] as const)
      if (!/^[a-z][a-z0-9-]*$/.test(node)) throw new TypeError(`invalid node id: ${node}`)
      if (!Number.isInteger(version) || version < 1) throw new TypeError('version must be a positive integer')
      const added: string[] = []
      for (const phase of phases) {
        if (phase !== 'before' && phase !== 'after') throw new TypeError(`invalid phase: ${phase}`)
        const name = `${node}.${phase}`
        if (slots.has(name)) throw new Error(`slot already declared: ${name}`)
        slots.set(name, Object.freeze({ name, node, phase, version }))
        added.push(name)
      }
      // 卸载节点插件时撤销其声明的插槽，避免留下无实现的稳定标识。
      return () => {
        for (const name of added) slots.delete(name)
      }
    },
    get(name: string) {
      return slots.get(name)
    },
    has(name: string) {
      return slots.has(name)
    },
    list() {
      return Object.freeze([...slots.values()])
    },
  })
}

/**
 * 校验并冻结一个扩展定义。非法定义必须抛错，不接受“先加载者覆盖”。
 * 参数按运行时不可信输入处理：调用方可能来自未类型化的 JS 插件。
 */
export function validateExtension(extension: SlotExtension, catalog: NodeCatalog): Readonly<SlotExtension> {
  if (!extension || typeof extension !== 'object') throw new TypeError('extension must be an object')
  const { id, slot, slotVersion } = extension
  if (typeof id !== 'string' || id.length === 0) throw new TypeError('extension.id is required')
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(id)) throw new TypeError(`invalid extension id: ${id}`)
  if (typeof slot !== 'string' || slot.length === 0) throw new TypeError(`extension ${id}: slot is required`)
  if (!Number.isInteger(slotVersion) || slotVersion < 1) {
    throw new TypeError(`extension ${id}: slotVersion must be a positive integer`)
  }

  const declared = catalog.get(slot)
  if (!declared) throw new Error(`extension ${id}: unknown slot ${slot}`)
  if (declared.version !== slotVersion) {
    throw new Error(
      `extension ${id}: slot ${slot} expects version ${declared.version}, got ${slotVersion}`,
    )
  }

  for (const method of ['match', 'ready', 'run'] as const) {
    if (typeof extension[method] !== 'function') {
      throw new TypeError(`extension ${id}: ${method} must be a function`)
    }
  }
  for (const list of ['requires', 'provides'] as const) {
    const value = extension[list]
    if (value === undefined) continue
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
      throw new TypeError(`extension ${id}: ${list} must be an array of non-empty strings`)
    }
  }
  if (extension.exclusiveGroup !== undefined && typeof extension.exclusiveGroup !== 'string') {
    throw new TypeError(`extension ${id}: exclusiveGroup must be a string`)
  }

  if (extension.role !== undefined) {
    if (!extension.role || typeof extension.role !== 'object' || Array.isArray(extension.role)) {
      throw new TypeError(`extension ${id}: role must be an object`)
    }
    for (const field of ['name', 'skill', 'objective', 'condition'] as const) {
      if (typeof extension.role[field] !== 'string' || extension.role[field].trim().length === 0) {
        throw new TypeError(`extension ${id}: role.${field} must be a non-empty string`)
      }
    }
  }

  return Object.freeze({
    ...extension,
    ...(extension.role ? { role: Object.freeze({ ...extension.role }) } : {}),
    requires: Object.freeze([...(extension.requires ?? [])]),
    provides: Object.freeze([...(extension.provides ?? [])]),
  })
}
