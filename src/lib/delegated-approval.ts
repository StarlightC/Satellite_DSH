/**
 * Delegated-approval broker (internal; not a model tool, not a Remote method).
 *
 * Satellite role children run with approval pinned to `never`, so a tool that asks
 * the child's own approval service is always rejected without a prompt. This broker
 * lets a consumer tool route exactly ONE approval per child tool call to the exact
 * live delegating parent, tagged with the parent's open `satellite_node` callId.
 *
 * - `createDelegatedApprovalBroker()` returns a private issuer and a consumer
 *   factory. The node runtime creates one broker per node row (no module-level or
 *   cross-bundle singleton), keeps the issuer in its own closure and binds a
 *   delegation only during its receipt preparation, keyed by the exact child Agent
 *   object. There is no registration by parent id or any model-supplied value.
 * - A consumer presents its own canonical tool definition; the broker compares it
 *   with what the exact child resolves for that tool name.
 * - Only `allowed-once` yields a permit; the permit is bound to that one call,
 *   re-validated (delegation, sessions, parent approval service AND its current
 *   policy) before every side effect, released when the call ends, and never
 *   cached, replayed or returned as a token.
 * - The child keeps its own `never` policy and its own fs/sandbox/subprocess/shell
 *   services; the parent only answers the question. A delegated call is bound to
 *   the original child services and the child's sandbox policy snapshot; no
 *   requested mode may be wider than that snapshot.
 *
 * Trust domain: same-process Host plugins are trusted code. This module keeps the
 * issuer private to the node runtime and gives models/clients no entry point; it is
 * not an isolation boundary against a malicious in-process plugin.
 */
import { symbols } from '@deepseek-ai/cordis'

/** Name of the node row's internal, non-Remote consumer service. */
export const DELEGATED_APPROVAL_SERVICE = 'satelliteDelegatedApproval'

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
type Denied = Exclude<ApprovalOutcome, 'allowed-once'>

interface ScopeLike { get(name: string): unknown }
export interface BrokerAgent { readonly id: string; readonly session?: unknown; readonly ctx?: ScopeLike }
export interface BrokerExecution { readonly agent?: BrokerAgent; readonly callId?: string; readonly signal: AbortSignal }
export interface ApprovalRequestLike {
  readonly agent: unknown; readonly toolName: string; readonly callId?: string; readonly reason: string; readonly signal: AbortSignal
}
interface ApprovalLike { request(request: ApprovalRequestLike): Promise<ApprovalOutcome> }
/** Public ApprovalService surface (dsh-user-approval): override + configured default. */
interface ApprovalApi extends ApprovalLike {
  overrideOf?(session: unknown): string | undefined
  readonly config?: { readonly policy?: unknown }
}

/** Facts the trusted node runtime supplies at receipt preparation. */
export interface DelegationSpec {
  readonly child: BrokerAgent
  readonly childSession: unknown
  readonly parent: BrokerAgent
  readonly parentSession: unknown
  readonly runId: string
  /** The parent's open satellite_node tool call. */
  readonly parentCallId: string
  /** The parent's satellite_node call signal (node completion/abort). */
  readonly signal: AbortSignal
  /** Private delegation record liveness (exact child/parent live, record active). */
  readonly live: () => boolean
  /** Tool definition the exact child currently resolves for a name. */
  readonly toolOf: (name: string) => unknown
}

export interface Permit {
  /** Throws when this call's approval no longer holds. */
  check(): void
  release(): void
}
export type BrokerDecision =
  | { readonly kind: 'direct' }
  | { readonly kind: 'granted'; readonly permit: Permit }
  | { readonly kind: 'denied'; readonly outcome: Denied; readonly reason: string }

/** Held only by the node runtime that created the broker. */
export interface BrokerIssuer {
  bind(spec: DelegationSpec): () => void
  /** Unload: every binding dies and no further binding is accepted. */
  release(): void
}
/** The narrow surface tool rows receive. It cannot bind or mint identities. */
export interface BrokerConsumer {
  /** Whether this exact caller is a currently bound delegated child. */
  delegated(exec: BrokerExecution): boolean
  request(exec: BrokerExecution, tool: unknown, toolName: string, reason: string): Promise<BrokerDecision>
  dispose(): void
}
export interface DelegatedApprovalBroker {
  readonly issuer: BrokerIssuer
  consumer(): BrokerConsumer
}

interface Member {
  readonly spec: DelegationSpec
  readonly parentApproval: unknown
  readonly calls: Set<string>
  active: boolean
  queue: Promise<void>
}

/** Cordis `ctx.get` returns a fresh traceable proxy; identity is the proxied target. */
export const original = (value: unknown): unknown =>
  value && (typeof value === 'object' || typeof value === 'function')
    ? (value as Record<symbol, unknown>)[symbols.original] ?? value
    : value

const MAX_REASON = 32 * 1024

/** The parent's effective approval policy right now; undefined when unreadable. */
function parentPolicy(approval: ApprovalApi | undefined, session: unknown): string | undefined {
  if (!approval || typeof approval.overrideOf !== 'function') return undefined
  try {
    const value = approval.overrideOf(session) ?? approval.config?.policy
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

export function createDelegatedApprovalBroker(): DelegatedApprovalBroker {
  let issuerReleased = false
  const members = new Map<object, Member>()

  const issuer: BrokerIssuer = {
    bind(spec) {
      if (issuerReleased) throw new Error('delegated approval issuer released')
      if (!spec.child || !spec.parent || spec.child === spec.parent || typeof spec.parentCallId !== 'string'
        || spec.parentCallId.length === 0 || typeof spec.runId !== 'string' || typeof spec.live !== 'function'
        || typeof spec.toolOf !== 'function' || !spec.signal) throw new Error('incomplete delegated approval binding')
      if (members.has(spec.child)) throw new Error('delegated approval already bound for this child')
      // Missing here is not an error at start: every request then fails closed with a reason.
      const parentApproval = original(spec.parent.ctx?.get('approval'))
      const member: Member = { spec, parentApproval, calls: new Set(), active: true, queue: Promise.resolve() }
      members.set(spec.child, member)
      return () => {
        member.active = false
        if (members.get(spec.child) === member) members.delete(spec.child)
      }
    },
    release() {
      issuerReleased = true
      for (const member of members.values()) member.active = false
      members.clear()
    },
  }

  function consumer(): BrokerConsumer {
    let disposed = false
    return {
      dispose() { disposed = true },
      delegated(exec) {
        const member = exec.agent ? members.get(exec.agent) : undefined
        return member !== undefined && member.active
      },
      async request(exec, tool, toolName, reason) {
        const agent = exec.agent
        const member = agent ? members.get(agent) : undefined
        if (!agent || !member) return { kind: 'direct' }
        const { spec } = member
        const deny = (outcome: Denied, why: string): BrokerDecision => ({ kind: 'denied', outcome, reason: why })
        const problem = (): string | undefined => {
          if (disposed) return 'consumer plugin unloaded'
          if (!member.active || issuerReleased) return 'delegation ended'
          if (!spec.live()) return 'delegation no longer live'
          if (agent.session !== spec.childSession) return 'child session replaced'
          if (spec.parent.session !== spec.parentSession) return 'parent session replaced'
          if (exec.signal.aborted || spec.signal.aborted) return 'call cancelled'
          if (tool === undefined || spec.toolOf(toolName) !== tool) return 'tool definition is not the canonical consumer definition'
          const approval = spec.parent.ctx?.get('approval') as ApprovalApi | undefined
          if (approval === undefined || original(approval) !== member.parentApproval) return 'parent approval service unavailable or changed'
          // Re-read the parent's CURRENT policy every time: the same service object may switch to never.
          const policy = parentPolicy(approval, spec.parentSession)
          if (policy === 'never') return 'parent session approval policy is "never": no prompt can be shown; nothing ran'
          if (policy !== 'ask') return 'parent session approval policy unavailable; nothing ran'
          return undefined
        }
        const callId = exec.callId
        if (typeof callId !== 'string' || callId.length === 0) return deny('unavailable', 'child call id missing')
        // One parent question per child call: replay or a second plan for the same call is denied.
        if (member.calls.has(callId)) return deny('unavailable', 'this child call already used its one parent approval; retry as a new call')
        member.calls.add(callId)
        const before = problem()
        if (before) return deny('unavailable', before)
        // Serialize parent questions per delegation: all carry the same parent callId.
        const run = member.queue.then(async (): Promise<BrokerDecision> => {
          const waiting = problem()
          if (waiting) return deny('unavailable', waiting)
          const approval = spec.parent.ctx?.get('approval') as ApprovalApi
          const text = [
            `Delegated child approval: Satellite role agent ${agent.id} (run ${spec.runId}) requests ${toolName} in its own sandbox, child call ${callId}.`,
            'Approving allows only this one child call; the next call asks again.',
            '',
            reason,
          ].join('\n')
          if (Buffer.byteLength(text) > MAX_REASON) return deny('unavailable', 'approval plan too large to show exactly; split the request')
          let outcome: ApprovalOutcome
          try {
            outcome = await approval.request({
              agent: spec.parent, toolName, callId: spec.parentCallId, reason: text,
              signal: AbortSignal.any([exec.signal, spec.signal]),
            })
          } catch (error) {
            return deny('unavailable', `parent approval failed: ${error instanceof Error ? error.message : String(error)}`)
          }
          if (outcome !== 'allowed-once') {
            const why = outcome === 'rejected' ? 'parent user rejected the request'
              : outcome === 'cancelled' ? 'parent approval cancelled'
                : 'no parent approval answerer available'
            return deny(outcome === 'rejected' || outcome === 'cancelled' ? outcome : 'unavailable', why)
          }
          const after = problem()
          if (after) return deny('unavailable', `${after} after approval; nothing ran`)
          let released = false
          return {
            kind: 'granted',
            permit: {
              check() {
                if (released) throw new Error('delegated approval permit already released')
                const now = problem()
                if (now) throw new Error(`delegated approval no longer holds: ${now}`)
              },
              release() { released = true },
            },
          }
        })
        member.queue = run.then(() => undefined, () => undefined)
        return run
      },
    }
  }

  return { issuer, consumer }
}

/* ------------------------------------------------------------ consumer helper */

const MODE_RANK: Readonly<Record<string, number>> = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }

interface PolicySnapshot { readonly mode: string; readonly workspaceRoot: string; readonly roots: readonly string[]; readonly key: string }

function readPolicy(scope: ScopeLike | undefined, session: unknown): PolicySnapshot | undefined {
  const service = scope?.get('sandboxPolicy') as { resolve?(request: { session: unknown }): unknown } | undefined
  if (!service || typeof service.resolve !== 'function') return undefined
  let value: { mode?: unknown; workspaceRoot?: unknown; additionalWritableRoots?: unknown } | undefined
  try { value = service.resolve({ session }) as typeof value } catch { return undefined }
  if (!value || typeof value.mode !== 'string' || MODE_RANK[value.mode] === undefined
    || typeof value.workspaceRoot !== 'string' || value.workspaceRoot.length === 0) return undefined
  const roots = Array.isArray(value.additionalWritableRoots) ? value.additionalWritableRoots.map(String) : []
  return { mode: value.mode, workspaceRoot: value.workspaceRoot, roots, key: JSON.stringify([value.mode, value.workspaceRoot, [...roots].sort()]) }
}

export interface CallGateOptions {
  readonly consumer: BrokerConsumer | undefined
  readonly exec: BrokerExecution
  /** The canonical definition this consumer registered. */
  readonly tool: () => unknown
  readonly toolName: string
  /** The caller's own approval service: the only path for non-delegated callers (never the root). */
  readonly childApproval: () => ApprovalLike | undefined
  /**
   * Adapter list: the execution services this tool actually uses. A delegated call
   * binds their original identities; absent unrelated services are not required.
   */
  readonly services: readonly string[]
}

export interface CallGate {
  /** The caller was a bound delegated child when this call started. */
  readonly delegated: boolean
  /** Approval adapter: direct for non-delegated callers, parent-routed for Satellite children. */
  readonly approval: ApprovalLike
  /** Delegated: throws unless a granted permit, the bound services and the policy snapshot all still hold. */
  check(): void
  /** Delegated: side-effect methods re-check the gate and cap the requested mode; otherwise identity. */
  wrap<T extends object>(services: T): T
  readonly denial: string | undefined
  release(): void
}

const FS_READS = new Set(['resolve', 'processPath', 'processPathFromHostPath', 'fileUrl', 'contains', 'stat', 'lstat',
  'readText', 'streamText', 'readBytes', 'readByteRange', 'listDir', 'watch'])

/**
 * One gate per tool call. Non-delegated callers keep their own approval service and
 * their services unchanged. A delegated call is bound at creation to the exact
 * child's original services and sandbox policy snapshot.
 */
export function createCallGate(options: CallGateOptions): CallGate {
  const { consumer, exec, toolName } = options
  const delegated = consumer !== undefined && consumer.delegated(exec)
  let permit: Permit | undefined
  let denial: string | undefined
  let released = false
  const scope = exec.agent?.ctx
  const bound = new Map<string, unknown>()
  let snapshot: PolicySnapshot | undefined
  if (delegated) {
    for (const name of options.services) bound.set(name, original(scope?.get(name)))
    snapshot = readPolicy(scope, exec.agent?.session)
  }
  const confined = new WeakSet<object>()

  const bindingProblem = (): string | undefined => {
    if (!scope) return 'child service scope unavailable'
    for (const [name, value] of bound) {
      if (value === undefined) return `child ${name} service unavailable`
      if (original(scope.get(name)) !== value) return `child ${name} service replaced`
    }
    if (!snapshot) return 'child sandbox policy unavailable'
    const now = readPolicy(scope, exec.agent?.session)
    if (!now || now.key !== snapshot.key) return 'child sandbox policy changed'
    return undefined
  }
  const check = (): void => {
    if (!delegated) return
    if (released) throw new Error('delegated approval permit already released')
    if (!permit) throw new Error('delegated call has no parent approval for this side effect')
    permit.check()
    const problem = bindingProblem()
    if (problem) throw new Error(`delegated approval no longer holds: ${problem}`)
  }
  /** A requested sandbox policy may never be wider than the child's snapshot. */
  const cap = (policy: unknown): void => {
    if (!delegated) return
    const limit = snapshot!
    const value = policy as { mode?: unknown; workspaceRoot?: unknown; additionalWritableRoots?: unknown } | undefined
    if (!value || typeof value !== 'object' || typeof value.mode !== 'string' || MODE_RANK[value.mode] === undefined) {
      throw new Error('delegated side effect without an explicit sandbox policy')
    }
    if (MODE_RANK[value.mode]! > MODE_RANK[limit.mode]!) {
      throw new Error(`requested sandbox mode ${value.mode} is wider than the child's current ${limit.mode}`)
    }
    if (value.workspaceRoot !== limit.workspaceRoot) throw new Error('requested sandbox root differs from the child policy')
    const roots = Array.isArray(value.additionalWritableRoots) ? value.additionalWritableRoots.map(String) : []
    if (roots.some((root) => !limit.roots.includes(root))) throw new Error('requested writable roots exceed the child policy')
  }
  const policyArg = (args: readonly unknown[]): unknown =>
    [...args].reverse().find((arg) => !!arg && typeof arg === 'object' && typeof (arg as { mode?: unknown }).mode === 'string')

  const proxy = <T extends object>(target: T, method: (name: string, fn: (...args: unknown[]) => unknown) => ((...args: unknown[]) => unknown) | undefined): T =>
    new Proxy(target, {
      get(object, key) {
        const value = Reflect.get(object, key) as unknown
        if (typeof value !== 'function') return value
        const fn = (value as (...args: unknown[]) => unknown).bind(object)
        return (typeof key === 'string' ? method(key, fn) : undefined) ?? fn
      },
    })

  const wrapService = (name: string, service: object): object => {
    switch (name) {
      case 'fs':
        return proxy(service, (key, fn) => FS_READS.has(key) ? undefined : (...args) => {
          check()
          if (key === 'writeText' || key === 'editText' || key === 'patchText' || key === 'deleteFile' || key === 'moveFile') cap(policyArg(args))
          return fn(...args)
        })
      case 'sandbox':
        return proxy(service, (key, fn) => key !== 'confine' ? undefined : async (...args) => {
          check()
          cap(args[1])
          const result = await fn(...args) as { argv?: unknown } | undefined
          // After the final confine await: the permit, services and policy must still hold.
          check()
          if (result && typeof result.argv === 'object' && result.argv !== null) confined.add(result.argv)
          return result
        })
      case 'subprocess':
        return proxy(service, (key, fn) => key !== 'spawn' && key !== 'spawnTerminal' ? undefined : (...args) => {
          check()
          const argv = (args[0] as { argv?: unknown } | undefined)?.argv
          // An unconfined argv (e.g. an automatic danger-full-access run) is wider than a confined child.
          if (snapshot!.mode !== 'danger-full-access' && !(typeof argv === 'object' && argv !== null && confined.has(argv))) {
            throw new Error(`unconfined process is wider than the child's current ${snapshot!.mode} sandbox`)
          }
          return fn(...args)
        })
      case 'shell':
        return proxy(service, (key, fn) => key !== 'execute' ? undefined : (...args) => {
          check()
          cap((args[0] as { sandboxPolicy?: unknown } | undefined)?.sandboxPolicy)
          return fn(...args)
        })
      default:
        return service
    }
  }

  const direct = (request: ApprovalRequestLike): Promise<ApprovalOutcome> => {
    const own = options.childApproval()
    if (!own || typeof own.request !== 'function') return Promise.resolve('unavailable')
    return own.request(request)
  }
  return {
    delegated,
    approval: {
      async request(request) {
        if (released) return 'unavailable'
        if (!delegated) return direct(request)
        const before = bindingProblem()
        if (before) { denial = `${before}; nothing ran`; return 'unavailable' }
        const decision = await consumer!.request(exec, options.tool(), toolName, request.reason)
        // A delegated call never falls back to the child's (or anyone else's) own approval.
        if (decision.kind === 'direct') { denial = 'delegation ended before approval; nothing ran'; return 'unavailable' }
        if (decision.kind === 'denied') { denial = decision.reason; return decision.outcome }
        const after = released ? 'call ended' : bindingProblem()
        if (after) { decision.permit.release(); denial = `${after} after approval; nothing ran`; return 'unavailable' }
        permit?.release()
        permit = decision.permit
        return 'allowed-once'
      },
    },
    check,
    wrap<T extends object>(services: T): T {
      if (!delegated) return services
      const out: Record<string, unknown> = { ...(services as Record<string, unknown>) }
      for (const [name, value] of Object.entries(out)) {
        if (value && typeof value === 'object') out[name] = wrapService(name, value)
      }
      return out as T
    },
    get denial() { return denial },
    release() { released = true; permit?.release() },
  }
}

const gates = new WeakMap<object, CallGate>()
export function attachGate(exec: object, gate: CallGate): void { gates.set(exec, gate) }
export function detachGate(exec: object): void { gates.get(exec)?.release(); gates.delete(exec) }
export function gateOf(exec: object): CallGate | undefined { return gates.get(exec) }
/** Approval failure text including the delegated reason when one exists. */
export function approvalMessage(exec: object, outcome: string): string {
  const reason = gates.get(exec)?.denial
  return reason ? `approval ${outcome}: ${reason}` : `approval ${outcome}`
}
