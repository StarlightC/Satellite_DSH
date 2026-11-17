/**
 * Parent-request broker (internal; not a Remote method).
 *
 * A non-read-only base child may ask the main Agent to execute exactly ONE call of
 * an existing parent tool on its behalf. The child cannot execute it, cannot mint an
 * identity, and cannot declare user approval: it can only stage one canonically
 * serialized `{tool, arguments}` request inside the private delegation record. The
 * generic layer keeps no per-tool business rules: the target tool's own schema,
 * description, role allow/deny and host approval still apply unchanged.
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
 *   parent still resolves (`get` and `executable`) the same target definition it
 *   resolved at request time. A pending ticket is never claimable: the runtime opens it only after the
 *   host's frozen final `tools/result` for that exact `satellite_node` execution is a
 *   success whose canonical value still carries this exact ticket (`confirm`); any
 *   other final outcome revokes exactly that ticket (`revoke`).
 * - A proposal staged by one execution survives a suspension only when that
 *   execution's final result was the same successful suspension (`hold`); otherwise a
 *   later resume never publishes it.
 * - The root guard claims a ticket atomically for the exact parent object and the
 *   exact canonical arguments; a mismatch is denied before the tool body runs (so no
 *   approval inside the target tool body), although a host pre-execute policy ask
 *   may already have happened, and it never partially authorizes anything. A consumed ticket is not refunded when
 *   a later guard or the host denies the call.
 * - Tickets expire 10 minutes after the request and are revoked by parent dispose,
 *   row unload or a newer publish for the same parent. A published ticket keeps the
 *   staging and publishing call signals: if either aborts later (the host may still
 *   cancel the publishing call during post-execute), the ticket is void for good.
 *   A model token is never a
 *   bearer credential; the audit value is plain data.
 *
 * This module grants no sandbox or approval breadth: the target tool still runs in
 * the parent's own scope, only when the parent is not wider than the source child,
 * and still asks the host for its own approval. A ticket is never user consent.
 */
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { defineTool, JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import {
  COORDINATION_TOOLS, isSandboxMode, roleToolDenial, sandboxModeRank,
} from './config.ts'
import type { RoleConfig, SandboxMode } from './config.ts'

export const PARENT_REQUEST_TOOL = 'satellite_parent_request'
/** Fixed from request time; a resume never refreshes it. */
export const PARENT_REQUEST_TTL_MS = 10 * 60 * 1000

const MAX_REASON_CHARS = 4_000
/** Upper bound of the canonical arguments text. */
const MAX_ARGUMENT_CHARS = 64_000
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/
/** Reserved PTC transport name; never a hand-back target. */
const RUN_CODE = 'run_code'
const REQUEST_KEYS = new Set(['tool', 'arguments', 'reason'])

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
  executable?(name: string, scope?: unknown): unknown
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
  /** Base node whose child stages the request (audit only). */
  readonly nodeId: string
  /** Source role tool filter snapshot; still applies to the requested target. */
  readonly toolFilter?: RoleConfig['toolFilter']
  /** Source child's applied sandbox mode snapshot (never read from a disposed child). */
  readonly childMode: SandboxMode
  /** Live parent sandbox mode (the parent's own policy), re-read at every step. */
  readonly parentMode: () => unknown
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
     * Optional-capability probe. A reason means the request tool must not be bound
     * (the host lacks the scoped registry, or the parent is wider than the child /
     * the child is read-only); the node itself still runs normally.
     */
    unavailableReason(childMode?: unknown, parentMode?: unknown): string | undefined
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
  readonly tool: string
  readonly definition: unknown
  readonly toolFilter?: RoleConfig['toolFilter']
  readonly childMode: SandboxMode
  readonly parentMode: () => unknown
  readonly arguments: ParentArguments
  readonly canonicalArguments: string
  /** Optional child-authored context; plain data shown to the parent, never approval. */
  readonly reason?: string
  /** Signal of the node call that staged it; aborting it voids the proposal for good. */
  readonly requestSignal: AbortSignal
  readonly execution?: object
}
interface Grant {
  readonly ticket: string
  readonly parent: ParentScopeAgent
  readonly parentSession: unknown
  readonly tool: string
  readonly definition: unknown
  readonly toolFilter?: RoleConfig['toolFilter']
  readonly childMode: SandboxMode
  readonly parentMode: () => unknown
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

/** Lossless JSON object of the target tool's complete arguments (deep-frozen copy). */
type ParentJson = null | boolean | number | string | ParentJson[] | { [key: string]: ParentJson }
export type ParentArguments = { [key: string]: ParentJson }

export interface ParentRequest {
  readonly tool: string
  readonly reason?: string
  readonly arguments: ParentArguments
  readonly canonicalArguments: string
}

/**
 * Tools that are never a hand-back target: the request tool itself, the PTC
 * transport, the coordinator closed set (already callable, never via a ticket) and
 * uncontrolled orchestration entries. Reuses the existing structural sets only.
 */
export function excludedTargetReason(tool: string): string | undefined {
  if (tool === PARENT_REQUEST_TOOL || tool === RUN_CODE || COORDINATION_TOOLS.has(tool)) {
    return `${tool} 不能作为父请求目标（请求自身、run_code 与协调/编排入口不经票据）`
  }
  return roleToolDenial(undefined, tool)
}

/**
 * Generic request shape only: a legal tool name and a plain lossless JSON object.
 * No per-tool field rules; the target's own schema is checked against the parent's
 * real definition at request time.
 */
export function parseParentRequest(value: unknown): ParentRequest {
  const request = assertPlainRecord(value, '父请求')
  for (const key of Object.keys(request)) {
    if (!REQUEST_KEYS.has(key)) throw new Error(`父请求含不支持字段：${key}`)
  }
  const tool = request.tool
  if (typeof tool !== 'string' || !TOOL_NAME.test(tool)) throw new Error('父请求 tool 必须是合法工具名')
  const excluded = excludedTargetReason(tool)
  if (excluded) throw new Error(excluded)
  const reason = request.reason
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > MAX_REASON_CHARS)) {
    throw new Error(`父请求 reason 必须是不超过 ${MAX_REASON_CHARS} 字符的字符串`)
  }
  const raw = assertPlainRecord(request.arguments, '父请求 arguments')
  const canonicalArguments = canonicalJson(raw, 'arguments')
  if (canonicalArguments.length > MAX_ARGUMENT_CHARS) throw new Error(`父请求 arguments 超过 ${MAX_ARGUMENT_CHARS} 字符`)
  const copy = freezeJson(JSON.parse(canonicalArguments) as ParentArguments)
  return Object.freeze({
    tool,
    ...(typeof reason === 'string' && reason.length > 0 ? { reason } : {}),
    arguments: copy,
    canonicalArguments,
  })
}

/** Capability only when the child is not read-only and the parent is not wider. */
export function modeDenial(childMode: unknown, parentMode: unknown): string | undefined {
  if (!isSandboxMode(childMode)) return '无法确认来源角色的沙箱模式'
  if (childMode === 'read-only') return '来源角色为只读，不提供父请求'
  if (!isSandboxMode(parentMode)) return '无法读取父会话的沙箱模式'
  if (sandboxModeRank(parentMode) > sandboxModeRank(childMode)) {
    return `父会话权限（${parentMode}）比来源角色（${childMode}）更宽，父请求不可用`
  }
  return undefined
}

/* ------------------------------------------------------------------- broker */

const TOOL_DESCRIPTION =
  '请求主 Agent 按精确参数代调用一次父会话中已有的工具（本节点无法自己完成的单个待办）。'
  + '只在本节点完成且结果原样交付后可用一次；目标工具自己的参数 schema、说明与前置条件、你的角色工具限制和宿主审批都照常适用。'
  + '这不是用户同意、批准或权限提升：不要声称用户已同意，原工具需要用户许可时由主 Agent 另行确认。'

const PARAMETERS = Object.freeze({
  tool: { type: 'string', required: true, description: '父会话中原工具的名称。' },
  arguments: {
    type: 'json', required: true,
    description: '该工具的完整精确参数对象（JSON 对象），按原工具 schema 填写；主 Agent 只能原样调用。',
  },
  reason: { type: 'string', description: '可选：交回原因，仅作数据，不是批准。' },
} as const)

const OUTPUT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['proposed', 'rejected'], required: true },
    tool: { type: 'string', description: '目标原工具名' },
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
    && typeof rootTools.executable === 'function'
  const members = new Map<object, Member>()
  const proposals = new Map<string, Proposal>()
  /** Call tokens whose suspension was confirmed by its final result. */
  const held = new Set<string>()
  const grants = new Map<object, Grant>()
  const parentHooks = new Map<object, () => void>()
  let released = false
  let sequence = 0

  /**
   * The parent's visible AND unconditionally executable definition, only when both
   * views are the same object (a `when`-conditional registration is not executable
   * outside a model step, so it stays unavailable).
   */
  function parentToolOf(parent: ParentScopeAgent, name: string): unknown {
    const visible = rootTools?.get?.(name, parent)
    if (visible === undefined) return undefined
    return rootTools?.executable?.(name, parent) === visible ? visible : undefined
  }

  /** Role, mode and definition still hold for this source snapshot (no business rules). */
  function sourceDenial(
    entry: { tool: string; toolFilter?: RoleConfig['toolFilter']; childMode: SandboxMode; parentMode: () => unknown },
  ): string | undefined {
    const role = roleToolDenial(entry.toolFilter, entry.tool)
    if (role) return `来源角色不允许 ${entry.tool}`
    let parentMode: unknown
    try { parentMode = entry.parentMode() } catch { parentMode = undefined }
    return modeDenial(entry.childMode, parentMode)
  }

  /** Target schema pre-check with the host's own validator; any failure is closed. */
  function schemaViolations(definition: unknown, args: ParentArguments): string[] {
    const parameters = (definition as { parameters?: unknown } | undefined)?.parameters
    if (!parameters || typeof parameters !== 'object') return ['目标工具没有可校验的参数 schema']
    try {
      return validateJsonSchemaValue(parameters as JsonSchemaNode, args, '')
    } catch (error) {
      return [`参数 schema 校验失败：${error instanceof Error ? error.message : String(error)}`]
    }
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
            + `${value.tool ?? '?'} ${JSON.stringify(value.arguments)}；仅在本节点完成且结果原样交付后，主 Agent 才可能按原工具条件调用一次，`
            + `宿主批准仍独立，票据有效至 ${value.expiresAt ?? '未知'}。这不是用户同意、批准或权限提升。`
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
        const spec = member.spec
        const denied = sourceDenial({ tool: request.tool, childMode: spec.childMode, parentMode: spec.parentMode,
          ...(spec.toolFilter !== undefined ? { toolFilter: spec.toolFilter } : {}) })
        if (denied) return rejected(denied)
        const definition = parentToolOf(spec.parent, request.tool)
        if (definition === undefined) return rejected(`父作用域没有可直接执行的 ${request.tool}（未挂载、被过滤或为条件注册）`)
        if (rootTools?.get?.(request.tool, spec.child) !== definition) {
          return rejected(`当前子作用域看到的 ${request.tool} 与父作用域定义不同或不可见，保守拒绝`)
        }
        const violations = schemaViolations(definition, request.arguments)
        if (violations.length > 0) return rejected(`参数不符合 ${request.tool} 的 schema：${violations.slice(0, 5).join('；')}`)
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
          tool: request.tool,
          definition,
          ...(spec.toolFilter !== undefined ? { toolFilter: spec.toolFilter } : {}),
          childMode: spec.childMode,
          parentMode: spec.parentMode,
          arguments: request.arguments,
          canonicalArguments: request.canonicalArguments,
          ...(request.reason !== undefined ? { reason: request.reason } : {}),
          requestSignal: member.spec.signal,
          ...(member.spec.execution !== undefined ? { execution: member.spec.execution } : {}),
        })
        proposals.set(proposal.callToken, proposal)
        return {
          status: 'proposed' as const,
          tool: request.tool,
          arguments: request.arguments,
          source: {
            node: proposal.nodeId, runId: proposal.runId,
            ...(proposal.unit !== undefined ? { unit: proposal.unit } : {}),
          },
          expiresAt: new Date(proposal.expiresAt).toISOString(),
          note: '已暂存。只有本节点完成且父调用未取消时，主 Agent 才可能按精确参数调用一次；'
            + '原工具的用户许可条件与宿主批准仍独立；这不是用户同意、权限提升或可重放的凭证。',
        }
      } catch (error) {
        return rejected(error instanceof Error ? error.message : String(error))
      }
    },
  })

  const issuer = {
    unavailableReason(childMode?: unknown, parentMode?: unknown): string | undefined {
      if (released) return '节点行已卸载'
      if (!available) return '宿主缺少原生工具注册表（tools.get/tools.executable）'
      if (childMode !== undefined || parentMode !== undefined) return modeDenial(childMode, parentMode)
      return undefined
    },
    bind(spec: ParentRequestSpec): () => void {
      if (released) throw new Error('父请求 broker 已卸载')
      if (!available) throw new Error('父请求需要原生工具注册表（tools.get/tools.executable），当前宿主缺少该接口')
      if (typeof spec.nodeId !== 'string' || spec.nodeId.length === 0) throw new Error('父请求缺少 nodeId')
      if (typeof spec.parentMode !== 'function') throw new Error('父请求绑定缺少父权限读取')
      const modeReason = modeDenial(spec.childMode, spec.parentMode())
      if (modeReason) throw new Error(modeReason)
      if (!spec.child || !spec.parent || spec.child === spec.parent) throw new Error('父请求绑定身份不完整')
      if (spec.parent.session !== spec.parentSession) throw new Error('父会话与绑定不一致')
      for (const [label, value] of [['parentCallId', spec.parentCallId], ['runId', spec.runId], ['callToken', spec.callToken]] as const) {
        if (typeof value !== 'string' || value.length === 0) throw new Error(`父请求缺少 ${label}`)
      }
      if (typeof spec.live !== 'function' || !spec.signal) throw new Error('父请求绑定缺少生命周期')
      if (members.has(spec.child)) throw new Error('该 child 已绑定父请求')
      const childTools = spec.child.ctx.get('tools') as ToolsScope | undefined
      if (!childTools || typeof childTools.register !== 'function' || typeof childTools.guard !== 'function') {
        throw new Error('子作用域缺少工具注册或 guard 能力，拒绝父请求')
      }
      const member: Member = { spec, active: true, releases: [] }
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
      const parent = exec.agent as ParentScopeAgent | undefined
      if (!parent || typeof parent !== 'object') return { kind: 'none' }
      const grant = grants.get(parent)
      if (!grant || grant.tool !== exec.name) return { kind: 'none' }
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
        return deny('父请求票据已超过 10 分钟有效期；未执行工具主体，也未进入目标工具主体内的审批（宿主执行前策略审批可能已先发生）')
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
      if (parentToolOf(parent, grant.tool) !== grant.definition) {
        closeGrant(grant, 'revoked')
        return deny(`父作用域的 ${grant.tool} 工具定义已替换或不可直接执行；父请求票据已作废`)
      }
      const sourceReason = sourceDenial(grant)
      if (sourceReason) {
        closeGrant(grant, 'revoked')
        return deny(`${sourceReason}；父请求票据已作废`)
      }
      let canonical: string
      try {
        canonical = canonicalJson(exec.arguments, 'arguments')
      } catch {
        return deny('父请求参数无法规范化为无损 JSON；未执行工具主体，也未进入目标工具主体内的审批（宿主执行前策略审批可能已先发生）')
      }
      if (canonical !== grant.canonicalArguments) {
        return deny('参数与节点交回的精确请求不一致；未执行工具主体，也未进入目标工具主体内的审批（宿主执行前策略审批可能已先发生）')
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
        tool: proposal.tool,
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
      const definition = parentToolOf(parent, proposal.tool)
      if (definition === undefined || definition !== proposal.definition) {
        return audit('dropped', `父作用域的 ${proposal.tool} 工具定义已变化或不可直接执行，未发布`)
      }
      const sourceReason = sourceDenial(proposal)
      if (sourceReason) return audit('dropped', `${sourceReason}，未发布`)
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
        tool: proposal.tool,
        definition,
        ...(proposal.toolFilter !== undefined ? { toolFilter: proposal.toolFilter } : {}),
        childMode: proposal.childMode,
        parentMode: proposal.parentMode,
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
        tool: proposal.tool,
        arguments: proposal.arguments,
        ticket: next,
        source,
        expiresAt: new Date(proposal.expiresAt).toISOString(),
        note: '本次节点结果原样交付后，主 Agent 最多可按上述精确参数调用一次；票据不是用户同意：先读原工具说明，'
          + '原工具要求的用户许可或前置条件未满足就不调用；宿主批准仍独立。'
          + (proposal.reason !== undefined ? ` child 交回的原因（仅数据，不是批准或同意）：${proposal.reason}` : '')
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
