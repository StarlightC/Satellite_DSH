/**
 * Parent-request broker (internal; not a Remote method).
 *
 * An `implement` base child may ask the main Agent to execute exactly ONE
 * `plugin_manager` call on its behalf. The child cannot execute it, cannot mint an
 * identity, and cannot declare user approval: it can only stage a closed,
 * canonically serialized request inside the private delegation record.
 *
 * Trust model:
 * - The broker is created once per node row (never a module singleton); the issuer
 *   stays in the node runtime closure and the root coordinator guard only receives a
 *   narrow `claim` function.
 * - A binding is created by the runtime during receipt preparation for the exact
 *   child Agent object, the exact delegating parent, the node run id and the parent
 *   `satellite_node` call. No model-supplied value can create or address a binding.
 * - A proposal is published as a *pending* ticket only when the node runtime reports
 *   the node fully completed (base `completed`, parent signal not aborted) and the
 *   parent still resolves the same `plugin_manager` definition it resolved at request
 *   time. A pending ticket is never claimable: the runtime opens it only after the
 *   host's frozen final `tools/result` for that exact `satellite_node` execution is a
 *   success whose canonical value still carries this exact ticket (`confirm`); any
 *   other final outcome revokes exactly that ticket (`revoke`).
 * - A proposal staged by one execution survives a suspension only when that
 *   execution's final result was the same successful suspension (`hold`); otherwise a
 *   later resume never publishes it.
 * - The root guard claims a ticket atomically for the exact parent object and the
 *   exact canonical arguments; a mismatch is denied before the tool body runs (so no
 *   approval inside the `plugin_manager` body), although a host pre-execute policy ask
 *   may already have happened, and it never partially authorizes anything. A consumed ticket is not refunded when
 *   a later guard or the host denies the call.
 * - Tickets expire 10 minutes after the request and are revoked by parent dispose,
 *   row unload or a newer publish for the same parent. A published ticket keeps the
 *   staging and publishing call signals: if either aborts later (the host may still
 *   cancel the publishing call during post-execute), the ticket is void for good.
 *   A model token is never a
 *   bearer credential; the audit value is plain data.
 *
 * This module grants no sandbox or approval breadth: `plugin_manager` still runs in
 * the parent's own scope and still asks the host for its own approval.
 */
import type { defineTool } from '@deepseek-ai/dsh-tools'

export const PARENT_REQUEST_TOOL = 'satellite_parent_request'
export const PARENT_TARGET_TOOL = 'plugin_manager'
/** Fixed from request time; a resume never refreshes it. */
export const PARENT_REQUEST_TTL_MS = 10 * 60 * 1000

const MAX_REASON_CHARS = 4_000
const MAX_IDENTIFIER_CHARS = 1_024
const MAX_OFFSET = 1_000_000

/** Actions this feature may hand back. Version-exemption actions stay unavailable. */
const SUPPORTED_ACTIONS = Object.freeze([
  'list_plugins', 'list_bundles', 'set_plugin', 'set_bundle', 'install_bundle', 'remove_bundle',
] as const)
const SUPPORTED_ACTION_SET: ReadonlySet<string> = new Set(SUPPORTED_ACTIONS)
const REQUEST_KEYS = new Set(['reason', 'arguments'])
const ARGUMENT_KEYS = new Set(['action', 'target', 'enabled', 'registry', 'offset', 'limit'])

type ToolsScope = {
  register?(tool: unknown): () => void
  guard?(guard: (exec: {
    readonly name: string
    readonly agent?: unknown
    readonly parent?: unknown
    readonly arguments?: unknown
    readonly callId?: string
  }) => string | undefined): () => void
  get?(name: string, scope?: unknown): unknown
}
interface ScopeLike { get(name: string): unknown; effect?(fn: () => void | (() => void)): unknown }
export interface ParentScopeAgent {
  readonly id: string
  readonly session: unknown
  readonly ctx: ScopeLike
}
export interface ParentGuardExecution {
  readonly name: string
  readonly agent?: object
  readonly arguments: unknown
  readonly callId?: string
}

export interface ParentRequestSpec {
  readonly child: ParentScopeAgent
  readonly parent: ParentScopeAgent
  readonly parentSession: unknown
  /** Only the `implement` base node may bind this capability. */
  readonly nodeId: string
  readonly unit?: string
  /** Native subagent run id of the base child. */
  readonly runId: string
  /** Stable node-call token, shared by the initial call and its resumes. */
  readonly callToken: string
  /** The parent's open `satellite_node` call that created the child. */
  readonly parentCallId: string
  /** The parent node-call signal (completion/cancellation/unload). */
  readonly signal: AbortSignal
  /** Opaque runtime identity of the staging `satellite_node` execution. */
  readonly execution?: object
  /** Private delegation-record liveness (exact child and parent live, active). */
  readonly live: () => boolean
}

/** Published audit value; plain data, never a credential. */
export interface ParentActionSource {
  readonly node: string
  readonly unit?: string
  readonly runId: string
}
export interface ParentActionAudit {
  /** `ready`: pending until this call's final result is delivered unchanged. */
  readonly status: 'ready' | 'expired' | 'dropped'
  readonly tool: string
  readonly arguments: ParentArguments
  readonly ticket?: string
  readonly source: ParentActionSource
  readonly expiresAt: string
  readonly note?: string
}
export type ParentClaim =
  | { readonly kind: 'allow' }
  | { readonly kind: 'none' }
  | { readonly kind: 'deny'; readonly reason: string }

/** The narrow surface the coordinator guard receives. It cannot bind or mint. */
export interface ParentGrantsGuard {
  claim(exec: ParentGuardExecution): ParentClaim
}

export interface ParentGrantBroker {
  readonly available: boolean
  readonly issuer: {
    /**
     * Optional-capability probe for the exact parent. A reason means the request tool
     * must not be bound (the parent's `plugin_manager` is absent or filtered, or the
     * host lacks the scoped registry); the node itself still runs normally.
     */
    unavailableReason(parent: ParentScopeAgent): string | undefined
    bind(spec: ParentRequestSpec): () => void
  }
  readonly guard: ParentGrantsGuard
  /**
   * Called only by the node runtime after a fully completed node. The ticket stays
   * pending (never claimable) until `confirm`.
   */
  publish(callToken: string, parentSignal: AbortSignal, publishCallId?: string, execution?: object): ParentActionAudit | undefined
  /** Open exactly this pending ticket for the execution that published it. */
  confirm(ticket: string, execution?: object): boolean
  /** Revoke exactly this ticket (pending or open); never touches another one. */
  revoke(ticket: string): void
  /** Keep a proposal across a suspension whose final result was confirmed. */
  hold(callToken: string, execution?: object): boolean
  /** Called by the node runtime for failed, cancelled, blocked or error outcomes. */
  discard(callToken: string): void
  /** Row unload: every binding, proposal and ticket dies. */
  release(): void
}

export interface ParentGrantOptions {
  readonly defineTool: typeof defineTool
  readonly root: ScopeLike
  readonly now?: () => number
}

interface Member {
  readonly spec: ParentRequestSpec
  readonly definition: unknown
  active: boolean
  readonly releases: Array<() => void>
}
interface Proposal {
  readonly callToken: string
  readonly parent: ParentScopeAgent
  readonly parentSession: unknown
  readonly childId: string
  readonly runId: string
  readonly nodeId: string
  readonly unit?: string
  readonly parentCallId: string
  readonly requestedAt: number
  readonly expiresAt: number
  readonly definition: unknown
  readonly arguments: ParentArguments
  readonly canonicalArguments: string
  /** Child-authored task context; plain data shown to the parent, never approval. */
  readonly reason: string
  /** Signal of the node call that staged it; aborting it voids the proposal for good. */
  readonly requestSignal: AbortSignal
  readonly execution?: object
}
interface Grant {
  readonly ticket: string
  readonly parent: ParentScopeAgent
  readonly parentSession: unknown
  readonly definition: unknown
  readonly arguments: ParentArguments
  readonly canonicalArguments: string
  readonly source: ParentActionSource
  readonly parentCallId: string
  readonly expiresAt: number
  /** Publishing execution; only its confirmed final result opens the ticket. */
  readonly execution?: object
  state: 'pending' | 'open' | 'consumed' | 'revoked'
  consumedCallId?: string
  consumedAt?: number
  /** Audit only: the resume call that completed the node, if it was a resume. */
  publishCallId?: string
  /**
   * Source call signals (staging call, and the publishing call when it differs). The
   * host may still cancel the publishing call after this tool body returned (e.g.
   * while post-execute runs); any abort voids the ticket for good.
   */
  readonly sources: readonly AbortSignal[]
  /** Removes abort listeners and the TTL timer; idempotent. */
  detach: () => void
}

/** Close a grant once and drop its listeners; never touches another grant. */
function closeGrant(grant: Grant, state: 'consumed' | 'revoked'): void {
  if (grant.state === 'open' || grant.state === 'pending') grant.state = state
  grant.detach()
}

/* --------------------------------------------------------------- strict JSON */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}

/**
 * Accept only a plain, enumerable, data-property record. The shared pipeline
 * already freezes a lossless JSON snapshot; this second check keeps the broker
 * total even if a caller reaches the tool through another path.
 */
function assertPlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${label} 必须是普通对象`)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(`${label} 不能包含 symbol 键`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new Error(`${label} 不能包含访问器属性`)
    }
    if (!descriptor.enumerable) throw new Error(`${label} 不能包含不可枚举属性`)
  }
  return value
}

/** Canonical JSON with sorted object keys; rejects values JSON cannot represent. */
export function canonicalJson(value: unknown, path = 'value'): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`${path} 不是有限数字`)
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item, index) => canonicalJson(item, `${path}[${index}]`)).join(',')}]`
      }
      const record = assertPlainRecord(value, path)
      return `{${Object.keys(record).sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], `${path}.${key}`)}`)
        .join(',')}}`
    }
    default:
      throw new Error(`${path} 不是无损 JSON 值`)
  }
}

function freezeJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    for (const item of value) freezeJson(item)
    return Object.freeze(value)
  }
  for (const item of Object.values(value as Record<string, unknown>)) freezeJson(item)
  return Object.freeze(value)
}

/** Closed scalar map: exactly the supported `plugin_manager` argument values. */
export type ParentArguments = Readonly<Record<string, string | number | boolean>>

export interface ParentRequest {
  readonly reason: string
  readonly arguments: ParentArguments
  readonly canonicalArguments: string
}

/** Strict closed validation of the child request; independent of host schema lint. */
export function parseParentRequest(value: unknown): ParentRequest {
  const request = assertPlainRecord(value, '父请求')
  for (const key of Object.keys(request)) {
    if (!REQUEST_KEYS.has(key)) throw new Error(`父请求含不支持字段：${key}`)
  }
  const reason = request.reason
  if (typeof reason !== 'string' || reason.trim().length === 0) throw new Error('父请求 reason 必须是非空字符串')
  if (reason.length > MAX_REASON_CHARS) throw new Error(`父请求 reason 超过 ${MAX_REASON_CHARS} 字符`)

  const raw = assertPlainRecord(request.arguments, '父请求 arguments')
  const out: Record<string, string | number | boolean> = {}
  for (const [key, item] of Object.entries(raw)) {
    if (!ARGUMENT_KEYS.has(key)) throw new Error(`plugin_manager 参数含不支持字段：${key}`)
    switch (key) {
      case 'action':
        if (typeof item !== 'string' || !SUPPORTED_ACTION_SET.has(item)) {
          throw new Error(`plugin_manager action 只支持：${SUPPORTED_ACTIONS.join('、')}`)
        }
        out.action = item
        break
      case 'target':
        if (typeof item !== 'string' || item.length === 0 || item.length > MAX_IDENTIFIER_CHARS) {
          throw new Error('plugin_manager target 必须是 1–1024 字符的字符串')
        }
        out.target = item
        break
      case 'enabled':
        if (typeof item !== 'boolean') throw new Error('plugin_manager enabled 必须是布尔值')
        out.enabled = item
        break
      case 'registry':
        if (typeof item !== 'string' || item.length === 0 || item.length > MAX_IDENTIFIER_CHARS) {
          throw new Error('plugin_manager registry 必须是 1–1024 字符的字符串，按原值精确传递')
        }
        out.registry = item
        break
      case 'offset':
        if (!Number.isInteger(item) || (item as number) < 0 || (item as number) > MAX_OFFSET) {
          throw new Error(`plugin_manager offset 必须是 0–${MAX_OFFSET} 的整数`)
        }
        out.offset = item as number
        break
      case 'limit':
        if (!Number.isInteger(item) || (item as number) < 1 || (item as number) > 100) {
          throw new Error('plugin_manager limit 必须是 1–100 的整数')
        }
        out.limit = item as number
        break
      default:
        throw new Error(`plugin_manager 参数含不支持字段：${key}`)
    }
  }
  if (!Object.hasOwn(out, 'action')) throw new Error('plugin_manager 参数缺少 action')
  const frozen = freezeJson(out)
  return Object.freeze({ reason, arguments: frozen, canonicalArguments: canonicalJson(frozen, 'arguments') })
}

/* ------------------------------------------------------------------- broker */

const TOOL_DESCRIPTION =
  '请求主 Agent 按精确参数代执行一次 plugin_manager（仅 implement 基础节点绑定）。'
  + '请求只在本节点完成且父调用未取消后交付一次；参数必须与闭集完全一致，宿主审批仍独立，'
  + '这不是批准、不是权限提升，也不能用于其它工具、脚本或命令。'

const PARAMETERS = Object.freeze({
  reason: {
    type: 'string', required: true,
    description: '交回的真实待办与原因，供主 Agent 判断；不是批准声明，不会成为宿主批准。',
  },
  arguments: {
    type: 'object',
    additionalProperties: false,
    description: 'plugin_manager 的完整精确参数。只支持 list_plugins、list_bundles、set_plugin、set_bundle、install_bundle、remove_bundle；'
      + '版本豁免相关字段、approvedBuilds 与其它字段一律拒绝。',
    properties: {
      action: {
        type: 'string', enum: SUPPORTED_ACTIONS, required: true,
        description: '要交回的动作；list_bundles/list_plugins 是列目录，set/install/remove 是具体改动。',
      },
      target: { type: 'string', description: 'plugin_manager target 原值，按精确字符串传递。' },
      enabled: { type: 'boolean', description: 'set_plugin/set_bundle 使用。' },
      registry: { type: 'string', description: 'install_bundle 的 npm registry，按原值精确传递。' },
      offset: { type: 'number', description: 'list 分页起点，0–1000000 的整数。' },
      limit: { type: 'number', description: 'list 分页大小，1–100 的整数。' },
    },
  },
} as const)

const OUTPUT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['proposed', 'rejected'], required: true },
    tool: { type: 'string', description: '固定为 plugin_manager' },
    arguments: { type: 'json', description: '通过校验的精确参数；不是执行凭证' },
    source: {
      type: 'object', additionalProperties: false,
      properties: {
        node: { type: 'string' }, unit: { type: 'string' }, runId: { type: 'string' },
      },
    },
    expiresAt: { type: 'string' },
    note: { type: 'string' },
  },
} as const)

export function createParentGrantBroker(options: ParentGrantOptions): ParentGrantBroker {
  const clock = options.now ?? (() => Date.now())
  const rootTools = options.root.get('tools') as ToolsScope | undefined
  const available = rootTools !== undefined && typeof rootTools.get === 'function'
  const members = new Map<object, Member>()
  const proposals = new Map<string, Proposal>()
  /** Call tokens whose suspension was confirmed by its final result. */
  const held = new Set<string>()
  const grants = new Map<object, Grant>()
  const parentHooks = new Map<object, () => void>()
  let released = false
  let sequence = 0

  function parentToolOf(parent: ParentScopeAgent): unknown {
    return rootTools?.get?.(PARENT_TARGET_TOOL, parent)
  }

  function revokeParent(parent: object): void {
    const grant = grants.get(parent)
    if (grant) closeGrant(grant, 'revoked')
    for (const [token, proposal] of proposals) {
      if (proposal.parent === parent) { proposals.delete(token); held.delete(token) }
    }
  }

  /** Install at most one parent-scope dispose hook per exact parent object. */
  function ensureParentHook(parent: ParentScopeAgent): void {
    if (parentHooks.has(parent) || !parent.ctx || typeof parent.ctx.effect !== 'function') return
    try {
      const remove = parent.ctx.effect(() => () => {
        revokeParent(parent)
        parentHooks.delete(parent)
      })
      if (typeof remove === 'function') parentHooks.set(parent, remove as () => void)
    } catch {
      // The dispose hook is defense in depth; the guard re-checks exact liveness.
    }
  }

  function releaseMember(member: Member): void {
    if (!member.active) return
    member.active = false
    if (members.get(member.spec.child) === member) members.delete(member.spec.child)
    for (const remove of member.releases.splice(0).reverse()) {
      try { remove() } catch { /* release continues */ }
    }
  }

  const tool = options.defineTool({
    name: PARENT_REQUEST_TOOL,
    description: TOOL_DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT,
      render: (_args, value) => [{
        type: 'text' as const,
        text: value.status === 'proposed'
          ? `父请求已暂存（node=${value.source?.node ?? '?'}, run=${value.source?.runId ?? '?'}）：`
            + `plugin_manager ${JSON.stringify(value.arguments)}；仅在本节点完成且父调用未取消后由主 Agent 执行一次，`
            + `宿主批准仍独立，票据有效至 ${value.expiresAt ?? '未知'}。这不是批准或权限提升。`
          : `父请求被拒绝：${value.note ?? '未说明原因'}。未暂存任何请求，也不会交给主 Agent。`,
      }],
    },
    async execute(args, exec) {
      const rejected = (note: string) => ({ status: 'rejected' as const, note })
      try {
        if (released) return rejected('节点行已卸载，父请求不可用')
        const agent = exec.agent as object | undefined
        const member = agent ? members.get(agent) : undefined
        if (!agent || !member || !member.active) return rejected('当前作用域没有有效的父请求绑定')
        if (agent !== member.spec.child) return rejected('父请求只属于绑定的 base child')
        if (exec.parent !== undefined) return rejected('父请求只允许直接调用，不接受嵌套/派生作用域')
        if (!member.spec.live()) return rejected('委派已结束或失效')
        if (exec.signal.aborted || member.spec.signal.aborted) return rejected('调用已取消')
        const callId = exec.callId
        if (typeof callId !== 'string' || callId.length === 0) return rejected('缺少子调用标识')
        if (proposals.has(member.spec.callToken)) return rejected('本次节点调用已使用过唯一一次父请求')
        const request = parseParentRequest(args)
        const definition = parentToolOf(member.spec.parent)
        if (definition === undefined || definition !== member.definition) {
          return rejected('父作用域的 plugin_manager 工具定义已变化或不可见')
        }
        const now = clock()
        const proposal: Proposal = Object.freeze({
          callToken: member.spec.callToken,
          parent: member.spec.parent,
          parentSession: member.spec.parentSession,
          childId: member.spec.child.id,
          runId: member.spec.runId,
          nodeId: member.spec.nodeId,
          ...(member.spec.unit !== undefined ? { unit: member.spec.unit } : {}),
          parentCallId: member.spec.parentCallId,
          requestedAt: now,
          expiresAt: now + PARENT_REQUEST_TTL_MS,
          definition,
          arguments: request.arguments,
          canonicalArguments: request.canonicalArguments,
          reason: request.reason,
          requestSignal: member.spec.signal,
          ...(member.spec.execution !== undefined ? { execution: member.spec.execution } : {}),
        })
        proposals.set(proposal.callToken, proposal)
        return {
          status: 'proposed' as const,
          tool: PARENT_TARGET_TOOL,
          arguments: request.arguments,
          source: {
            node: proposal.nodeId, runId: proposal.runId,
            ...(proposal.unit !== undefined ? { unit: proposal.unit } : {}),
          },
          expiresAt: new Date(proposal.expiresAt).toISOString(),
          note: '已暂存。只有本节点完成且父调用未取消时才由主 Agent 按精确参数执行一次；'
            + '宿主批准仍独立；这不是批准、权限提升或可重放的凭证。',
        }
      } catch (error) {
        return rejected(error instanceof Error ? error.message : String(error))
      }
    },
  })

  const issuer = {
    unavailableReason(parent: ParentScopeAgent): string | undefined {
      if (released) return '节点行已卸载'
      if (!available) return '宿主缺少原生工具注册表（tools.get）'
      if (parentToolOf(parent) === undefined) return '父作用域看不到 plugin_manager（未挂载或被工具过滤）'
      return undefined
    },
    bind(spec: ParentRequestSpec): () => void {
      if (released) throw new Error('父请求 broker 已卸载')
      if (!available) throw new Error('父请求需要原生工具注册表（tools.get），当前宿主缺少该接口')
      if (spec.nodeId !== 'implement') throw new Error('父请求只在 implement 基础节点绑定')
      if (!spec.child || !spec.parent || spec.child === spec.parent) throw new Error('父请求绑定身份不完整')
      if (spec.parent.session !== spec.parentSession) throw new Error('父会话与绑定不一致')
      for (const [label, value] of [['parentCallId', spec.parentCallId], ['runId', spec.runId], ['callToken', spec.callToken]] as const) {
        if (typeof value !== 'string' || value.length === 0) throw new Error(`父请求缺少 ${label}`)
      }
      if (typeof spec.live !== 'function' || !spec.signal) throw new Error('父请求绑定缺少生命周期')
      if (members.has(spec.child)) throw new Error('该 child 已绑定父请求')
      const definition = parentToolOf(spec.parent)
      if (definition === undefined) throw new Error('父作用域没有 plugin_manager 工具，拒绝绑定父请求')
      const childTools = spec.child.ctx.get('tools') as ToolsScope | undefined
      if (!childTools || typeof childTools.register !== 'function' || typeof childTools.guard !== 'function') {
        throw new Error('子作用域缺少工具注册或 guard 能力，拒绝父请求')
      }
      const member: Member = { spec, definition, active: true, releases: [] }
      members.set(spec.child, member)
      try {
        const removeGuard = childTools.guard((exec) => {
          if (exec.name !== PARENT_REQUEST_TOOL) return undefined
          if (released || !member.active) return 'Satellite：父请求绑定已结束，拒绝执行'
          if (exec.agent !== spec.child) return 'Satellite：父请求只属于绑定的 base child'
          if (exec.parent !== undefined) return 'Satellite：父请求只允许直接调用'
          if (!spec.live()) return 'Satellite：委派已结束或失效，拒绝父请求'
          if (rootTools?.get?.(PARENT_REQUEST_TOOL, spec.child) !== tool) {
            return 'Satellite：父请求工具定义已替换，拒绝执行'
          }
          return undefined
        })
        member.releases.push(removeGuard)
        const removeTool = childTools.register(tool)
        member.releases.push(removeTool)
        if (rootTools?.get?.(PARENT_REQUEST_TOOL, spec.child) !== tool) {
          throw new Error('父请求工具未能在子作用域稳定注册')
        }
        ensureParentHook(spec.parent)
      } catch (error) {
        releaseMember(member)
        throw error
      }
      return () => releaseMember(member)
    },
  }

  const guard: ParentGrantsGuard = {
    claim(exec): ParentClaim {
      if (exec.name !== PARENT_TARGET_TOOL) return { kind: 'none' }
      const parent = exec.agent as ParentScopeAgent | undefined
      if (!parent || typeof parent !== 'object') return { kind: 'none' }
      const grant = grants.get(parent)
      if (!grant) return { kind: 'none' }
      const deny = (reason: string): ParentClaim => ({ kind: 'deny', reason: `Satellite：${reason}` })
      if (grant.state === 'consumed') return deny('该父请求票据已使用过；一次请求只允许一次精确调用')
      if (grant.state === 'revoked') return deny('该父请求票据已作废')
      // Not consumed and not closed: the publishing call has not been finally delivered.
      if (grant.state === 'pending') return deny('该父请求票据尚未随节点最终结果确认交付，暂不可用')
      // Fail closed even if an abort listener never ran: a cancelled source call never
      // leaves a usable ticket, and no resume or new call revives it.
      if (grant.sources.some((source) => source.aborted)) {
        closeGrant(grant, 'revoked')
        return deny('发布该票据的节点调用已取消；父请求票据已作废')
      }
      const now = clock()
      if (now > grant.expiresAt) {
        closeGrant(grant, 'revoked')
        return deny('父请求票据已超过 10 分钟有效期；未执行工具主体，也未进入 plugin_manager 主体内的审批（宿主执行前策略审批可能已先发生）')
      }
      if (parent.session !== grant.parentSession) {
        closeGrant(grant, 'revoked')
        return deny('父会话已变化；父请求票据已作废')
      }
      const agents = options.root.get('agents') as { get?(id: string): unknown } | undefined
      if (!agents || typeof agents.get !== 'function' || agents.get(parent.id) !== parent) {
        closeGrant(grant, 'revoked')
        return deny('父 Agent 已失效；父请求票据已作废')
      }
      if (parentToolOf(parent) !== grant.definition) {
        closeGrant(grant, 'revoked')
        return deny('父作用域的 plugin_manager 工具定义已替换；父请求票据已作废')
      }
      let canonical: string
      try {
        canonical = canonicalJson(exec.arguments, 'arguments')
      } catch {
        return deny('父请求参数无法规范化为无损 JSON；未执行工具主体，也未进入 plugin_manager 主体内的审批（宿主执行前策略审批可能已先发生）')
      }
      if (canonical !== grant.canonicalArguments) {
        return deny('参数与节点交回的精确请求不一致；未执行工具主体，也未进入 plugin_manager 主体内的审批（宿主执行前策略审批可能已先发生）')
      }
      // Atomic consume: a later guard or host denial does not refund the ticket.
      closeGrant(grant, 'consumed')
      grant.consumedAt = now
      if (typeof exec.callId === 'string' && exec.callId.length > 0) grant.consumedCallId = exec.callId
      return { kind: 'allow' }
    },
  }

  return {
    available,
    issuer,
    guard,
    publish(callToken, parentSignal, publishCallId, execution) {
      const proposal = proposals.get(callToken)
      if (!proposal) return undefined
      proposals.delete(callToken)
      const wasHeld = held.delete(callToken)
      const source: ParentActionSource = Object.freeze({
        node: proposal.nodeId,
        ...(proposal.unit !== undefined ? { unit: proposal.unit } : {}),
        runId: proposal.runId,
      })
      const audit = (status: ParentActionAudit['status'], note?: string, ticket?: string): ParentActionAudit => Object.freeze({
        status,
        tool: PARENT_TARGET_TOOL,
        arguments: proposal.arguments,
        ...(ticket !== undefined ? { ticket } : {}),
        source,
        expiresAt: new Date(proposal.expiresAt).toISOString(),
        ...(note !== undefined ? { note } : {}),
      })
      if (released) return audit('dropped', '节点行已卸载，未发布')
      // A resume may publish only a proposal whose staging suspension was finally delivered.
      if (proposal.execution !== undefined && proposal.execution !== execution && !wasHeld) {
        return audit('dropped', '暂存该请求的调用未确认交付，未发布')
      }
      // Both the completing call's signal and the staging call's signal must be live.
      if (parentSignal.aborted) return audit('dropped', '父调用已取消，未发布')
      // Conservative: if the call that staged the request was aborted (even after a
      // suspension), a later resume never revives it.
      if (proposal.requestSignal.aborted) return audit('dropped', '暂存该请求的父调用已取消，恢复也不发布')
      const now = clock()
      if (now > proposal.expiresAt) return audit('expired', '超过请求起的 10 分钟有效期，未发布；恢复调用不会刷新')
      const parent = proposal.parent
      if (parent.session !== proposal.parentSession) return audit('dropped', '父会话已变化，未发布')
      const agents = options.root.get('agents') as { get?(id: string): unknown } | undefined
      if (!agents || typeof agents.get !== 'function' || agents.get(parent.id) !== parent) {
        return audit('dropped', '父 Agent 已失效，未发布')
      }
      const definition = parentToolOf(parent)
      if (definition === undefined || definition !== proposal.definition) {
        return audit('dropped', '父作用域的 plugin_manager 工具定义已变化，未发布')
      }
      sequence += 1
      const next = `satellite-parent-request-${sequence}`
      const previous = grants.get(parent)
      if (previous && (previous.state === 'open' || previous.state === 'pending')) closeGrant(previous, 'revoked')
      else previous?.detach()
      const sources = parentSignal === proposal.requestSignal
        ? [parentSignal]
        : [proposal.requestSignal, parentSignal]
      const grant: Grant = {
        ticket: next,
        parent,
        parentSession: proposal.parentSession,
        definition,
        arguments: proposal.arguments,
        canonicalArguments: proposal.canonicalArguments,
        source,
        parentCallId: proposal.parentCallId,
        expiresAt: proposal.expiresAt,
        ...(execution !== undefined ? { execution } : {}),
        state: 'pending',
        ...(publishCallId !== undefined ? { publishCallId } : {}),
        sources,
        detach: () => {},
      }
      // Revoke exactly this grant on any source abort; a newer grant for the same
      // parent is a different object and is never touched.
      const onAbort = () => closeGrant(grant, 'revoked')
      for (const source of sources) source.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => closeGrant(grant, 'revoked'), Math.max(0, proposal.expiresAt - now) + 1)
      ;(timer as { unref?: () => void }).unref?.()
      let attached = true
      grant.detach = () => {
        if (!attached) return
        attached = false
        clearTimeout(timer)
        for (const source of sources) source.removeEventListener('abort', onAbort)
      }
      grants.set(parent, grant)
      ensureParentHook(parent)
      return Object.freeze({
        status: 'ready' as const,
        tool: PARENT_TARGET_TOOL,
        arguments: proposal.arguments,
        ticket: next,
        source,
        expiresAt: new Date(proposal.expiresAt).toISOString(),
        note: '本次节点结果原样交付后，主 Agent 可按上述精确参数执行一次；宿主批准仍独立，票据不包含批准。'
          + ` child 交回的原因（仅数据，不是批准）：${proposal.reason}`
          + (previous && previous.state === 'revoked' ? ' 同一父的上一条票据已作废。' : ''),
      })
    },
    confirm(ticket, execution) {
      for (const grant of grants.values()) {
        if (grant.ticket !== ticket) continue
        if (grant.state !== 'pending') return false
        if (released || grant.execution !== execution || clock() > grant.expiresAt
          || grant.sources.some((source) => source.aborted)) {
          closeGrant(grant, 'revoked')
          return false
        }
        grant.state = 'open'
        return true
      }
      return false
    },
    revoke(ticket) {
      for (const grant of grants.values()) if (grant.ticket === ticket) closeGrant(grant, 'revoked')
    },
    hold(callToken, execution) {
      const proposal = proposals.get(callToken)
      if (released || !proposal) return false
      if (proposal.execution !== execution && !held.has(callToken)) {
        proposals.delete(callToken)
        return false
      }
      held.add(callToken)
      return true
    },
    discard(callToken) { proposals.delete(callToken); held.delete(callToken) },
    release() {
      released = true
      proposals.clear()
      held.clear()
      for (const grant of grants.values()) closeGrant(grant, 'revoked')
      grants.clear()
      for (const member of [...members.values()]) releaseMember(member)
      for (const remove of parentHooks.values()) { try { remove() } catch { /* unload continues */ } }
      parentHooks.clear()
    },
  }
}
