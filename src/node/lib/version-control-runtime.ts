/** Trusted execution identity bridge. No model/fact field can mint membership. */
import type { defineTool, ToolGuard } from '@deepseek-ai/dsh-tools'
import { isAbsolute, relative, resolve } from 'node:path'
import { createLocalVersionControl, type LocalGitDependencies } from './version-control.ts'
import { deny, parseGitRequest } from './version-control-input.ts'
import { inside } from './version-control-repository.ts'
import { VERSION_CONTROL_TOOLS } from './config.ts'

type Tool = ReturnType<typeof defineTool>
interface Tools {
  guard(guard: ToolGuard): () => void
  get(name: string, scope?: object): unknown
  register(tool: Tool): () => void
}
export interface VersionAgent {
  readonly id: string
  readonly session: { readonly header: { readonly id: string; readonly cwd?: string } }
  readonly ctx: { get(name: string): unknown; effect(fn: () => () => void): unknown }
}
interface ScopeContext { get(name: string): unknown; readonly tools: Partial<Tools> }
interface Policy { mode: string; workspaceRoot: string; sessionId?: string }
interface FsMapping {
  processPathFromHostPath(path: string): string | undefined
  resolve(path: string, options: { signal: AbortSignal }): Promise<unknown>
  processPath(target: unknown): string
}
interface Member {
  agent: VersionAgent
  /** Exact delegating parent, bound by the trusted node runtime closure (never model args). */
  parent: VersionAgent
  parentCallId?: string
  active: boolean
  remove: () => void
  kernel?: ReturnType<typeof createLocalVersionControl>
  binding?: string
}
const NAME = 'satellite_version_control'
const EFFECT_UNKNOWN = 'Write may have taken effect (the call was cancelled after the write entered the process boundary). Observe status before any new decision; never automatically retry.'
const SERVICES = ['sandbox', 'subprocess', 'approval', 'sandboxPolicy', 'workingDirectory', 'fs'] as const
type Services = {
  sandbox: LocalGitDependencies['sandbox']; subprocess: LocalGitDependencies['subprocess']
  approval: NonNullable<LocalGitDependencies['approval']>
  sandboxPolicy: { resolve(input: { session: unknown }): Policy | undefined }
  workingDirectory: { ensure(agent: object, signal: AbortSignal): Promise<string | undefined> }
  fs: FsMapping
}
/** Resolve every execution service from ONE agent's own scope; no root fallback. */
function scopeServices(agent: VersionAgent, label: string): Services {
  const scope = agent.ctx
  if (!scope || typeof scope.get !== 'function') deny(`${label} scope unavailable`)
  const out: Record<string, unknown> = {}
  for (const name of SERVICES) {
    const value = scope.get(name)
    if (!value) deny(`${label} scope service unavailable: ${name}`)
    out[name] = value
  }
  const v = out as unknown as Services
  if (typeof v.sandbox.confine !== 'function' || typeof v.subprocess.spawn !== 'function'
    || typeof v.subprocess.terminalEnvironment !== 'function' || typeof v.approval.request !== 'function'
    || typeof v.sandboxPolicy.resolve !== 'function' || typeof v.workingDirectory.ensure !== 'function'
    || typeof v.fs.processPathFromHostPath !== 'function' || typeof v.fs.resolve !== 'function' || typeof v.fs.processPath !== 'function') deny(`incomplete ${label} scope services`)
  return v
}
const allowed = new Set(VERSION_CONTROL_TOOLS)

/** Called by the node runtime, bound to its private creation reservation. */
export function createVersionControlBoundary(ctx: ScopeContext, defineToolFn: typeof defineTool) {
  const members = new Map<object, Member>()
  // Executions whose write reached the process boundary; read only by finalizeContent.
  const writes = new WeakSet<object>()
  let disposed = false
  const capable = typeof ctx.tools.guard === 'function' && typeof ctx.tools.get === 'function'
  const tool = defineToolFn({
    name: NAME,
    description: 'Explicit optional version-control node only. Five local actions; no remote/flags/history rewrite. Writes require a fresh snapshot and real one-shot host approval.',
    parameters: {
      request: { required: true, oneOf: [
        { type: 'object', additionalProperties: false, properties: {
          action: { type: 'string', const: 'status', required: true }, repo: { type: 'string', required: true },
        } },
        { type: 'object', additionalProperties: false, properties: {
          action: { type: 'string', const: 'diff', required: true }, repo: { type: 'string', required: true },
          target: { type: 'string', enum: ['working', 'staged'], required: true }, paths: { type: 'array', items: { type: 'string' } },
        } },
        { type: 'object', additionalProperties: false, properties: {
          action: { type: 'string', const: 'log', required: true }, repo: { type: 'string', required: true }, count: { type: 'integer', required: true },
        } },
        { type: 'object', additionalProperties: false, properties: {
          action: { type: 'string', const: 'stage', required: true }, repo: { type: 'string', required: true },
          paths: { type: 'array', items: { type: 'string' }, required: true }, expectedSnapshot: { type: 'string', required: true },
        } },
        { type: 'object', additionalProperties: false, properties: {
          action: { type: 'string', const: 'commit', required: true }, repo: { type: 'string', required: true },
          message: { type: 'string', required: true }, expectedSnapshot: { type: 'string', required: true },
        } },
      ] },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    // The runtime replaces a post-dispatch cancelled result with ABORTED; keep that
    // cancellation semantics but never let it hide that a write may have happened.
    finalizeContent(exec, result) {
      if (!result.isError || !writes.has(exec)) return undefined
      return [...result.content, { type: 'text', text: `effect-unknown: ${EFFECT_UNKNOWN}` }]
    },
    async execute(args, exec) {
      try {
        const member = exec.agent && members.get(exec.agent)
        if (!member || !member.active || disposed) deny('active version-control execution identity required')
        if (Reflect.ownKeys(args).some(key => key !== 'request')) deny('unknown tool field')
        const request = parseGitRequest(args.request) // independent of host schema validation
        const agent = member.agent
        // Absolutely no root-context service fallback (including cwd and tools).
        const child = scopeServices(agent, 'child')
        const boundSession = agent.session
        const live = (): void => {
          if (disposed || !member.active || members.get(agent) !== member || agent.session !== boundSession) deny('execution identity ended or changed')
        }
        // Resolve, per call, a scope-pinned policy reader + adapters for ONE agent.
        const prepare = async (who: VersionAgent, s: Services, label: string) => {
          const session = who.session
          const policy = (): Policy => {
            live()
            if (who.session !== session) deny(`${label} session changed`)
            for (const name of SERVICES) if (who.ctx.get(name) !== s[name]) deny(`${label} scope service changed: ${name}`)
            const p = s.sandboxPolicy.resolve({ session: who.session })
            if (!p || !['read-only', 'workspace-write'].includes(p.mode) || p.sessionId !== who.id
              || !isAbsolute(p.workspaceRoot) || who.session.header.id !== who.id) deny(`${label} session policy unavailable or mismatched`)
            return p
          }
          const p = policy()
          const cwd = await s.workingDirectory.ensure(who, exec.signal)
          if (!cwd || !isAbsolute(cwd) || !inside(p.workspaceRoot, cwd)) deny(`${label} cwd outside policy workspace`)
          if ((await s.subprocess.terminalEnvironment(exec.signal)).platform !== 'posix') deny('host-shared POSIX required')
          // Native fs contract: mapping promises SAME host file in subprocess execution world.
          // Identity mapping is required because the kernel observes via node:fs and spawns
          // fixed POSIX host paths. Containers/remapped/non-shared providers fail closed.
          for (const path of [p.workspaceRoot, cwd, '/usr/bin/env', '/usr/bin/git']) {
            if (s.fs.processPathFromHostPath(path) !== path
              || s.fs.processPath(await s.fs.resolve(path, { signal: exec.signal })) !== path) deny(`host-shared identity mapping unavailable: ${path}`)
          }
          const adapters = {
            policy,
            sandbox: { async confine(argv: readonly string[], requested: Parameters<Services['sandbox']['confine']>[1], signal?: AbortSignal) {
              policy()
              const confined = await s.sandbox.confine(argv, requested, signal)
              policy() // cancellation/unload/service changes while confinement awaited
              return confined
            } },
            subprocess: {
              resolveExecutable: (...args: Parameters<Services['subprocess']['resolveExecutable']>) => s.subprocess.resolveExecutable(...args),
              terminalEnvironment: (...args: Parameters<Services['subprocess']['terminalEnvironment']>) => s.subprocess.terminalEnvironment(...args),
              spawn(spec: Parameters<Services['subprocess']['spawn']>[0]) { policy(); return s.subprocess.spawn(spec) },
            },
            approval: { request: (input: Parameters<Services['approval']['request']>[0]) => { policy(); return s.approval.request(input) } },
          }
          return { p, cwd, adapters }
        }
        const { p, cwd, adapters } = await prepare(agent, child, 'child')
        const binding = JSON.stringify([cwd, p.workspaceRoot, p.sessionId])
        if (member.binding !== undefined && member.binding !== binding) deny('child cwd/workspace changed; new execution required')
        member.binding = binding
        if (!member.kernel) {
          // The child kernel is read-only: its native approval is pinned to never.
          member.kernel = createLocalVersionControl({
            workspaceRoot: p.workspaceRoot, sessionId: agent.id, agent, readOnly: true,
            policy: adapters.policy, sandbox: adapters.sandbox, subprocess: adapters.subprocess,
          })
        }
        const repository = resolve(cwd, request.repo)
        if (!inside(p.workspaceRoot, repository)) deny('repository outside child workspace')
        const repo = relative(p.workspaceRoot, repository) || '.'
        if (request.action !== 'stage' && request.action !== 'commit') {
          return { ...await member.kernel.execute({ ...request, repo }, exec.signal, exec.callId) }
        }
        // Parent-owned write handoff. The parent identity is the trusted creation-bound
        // caller of this explicit satellite_node invocation; every service (approval,
        // sandbox, subprocess, cwd, policy, fs) comes from the PARENT's own scope.
        const parent = member.parent, childKernel = member.kernel
        const agents = ctx.get('agents') as { get(id: string): unknown; isOwnedBy(id: string, owner: object): boolean } | undefined
        if (!agents || typeof agents.isOwnedBy !== 'function' || agents.get(agent.id) !== agent || !agents.isOwnedBy(agent.id, parent)) deny('parent/child ownership unavailable or mismatched')
        const parentPrepared = await prepare(parent, scopeServices(parent, 'parent'), 'parent')
        if (parentPrepared.p.workspaceRoot !== p.workspaceRoot || parentPrepared.cwd !== cwd) deny('parent and child workspace differ')
        const parentKernel = createLocalVersionControl({
          workspaceRoot: p.workspaceRoot, sessionId: parent.id, agent: parent,
          policy: parentPrepared.adapters.policy, sandbox: parentPrepared.adapters.sandbox,
          subprocess: parentPrepared.adapters.subprocess, approval: parentPrepared.adapters.approval,
          handoff: { owner: childKernel.owner, take: token => childKernel.take(token) },
        })
        const result = await parentKernel.execute({ ...request, repo }, exec.signal, member.parentCallId)
        if (result.status === 'succeeded' || result.status === 'effect-unknown') writes.add(exec)
        return { ...result }
      } catch (error) {
        return { status: 'blocked', message: error instanceof Error ? error.message : String(error) }
      }
    },
  })
  // Monotonic gate also covers a same-name scoped replacement and ordinary children.
  const removeGlobal = capable ? ctx.tools.guard!(exec => {
    if (exec.name !== NAME) return undefined
    if (!exec.agent || !members.get(exec.agent)?.active || disposed) return 'Satellite: active version-control execution identity required'
    if (ctx.tools.get!(NAME, exec.agent) !== tool) return 'Satellite: version-control tool shadowed'
    return undefined
  }) : () => {}
  const removeTool = ctx.tools.register!(tool)
  return {
    capable,
    bind(agent: VersionAgent, parent: VersionAgent, parentCallId?: string): () => void {
      if (!capable || disposed || !agent.ctx || typeof agent.ctx.get !== 'function' || typeof agent.ctx.effect !== 'function') deny('child scope guard service unavailable')
      const childTools = agent.ctx.get('tools') as Tools | undefined
      if (!childTools || typeof childTools.guard !== 'function' || typeof childTools.get !== 'function') deny('child scope guard service unavailable')
      const agents = ctx.get('agents') as { get(id: string): unknown; isOwnedBy(id: string, owner: object): boolean } | undefined
      if (!agents || typeof agents.get !== 'function' || typeof agents.isOwnedBy !== 'function'
        || agents.get(agent.id) !== agent || !agents.isOwnedBy(agent.id, parent)) deny('runtime child ownership unavailable or mismatched')
      // Freeze canonical allowed definitions at creation; a scoped replacement cannot
      // turn a read/skill/question name into an alternate execution entry afterwards.
      const definitions = new Map(VERSION_CONTROL_TOOLS.map(name => [name, ctx.tools.get!(name, agent)]))
      if (definitions.get(NAME) !== tool) deny('version-control tool shadowed at creation')
      const member: Member = { agent, parent, ...(parentCallId !== undefined ? { parentCallId } : {}), active: true, remove: () => {} }
      members.set(agent, member)
      try {
        member.remove = childTools.guard(exec => {
          if (!member.active || disposed || exec.agent !== agent) return 'Satellite: version-control descendant/derived or ended scope denied'
          if (exec.parent || !allowed.has(exec.name)) return 'Satellite: version-control permits only its fixed direct method tools'
          if (ctx.tools.get!(exec.name, agent) !== definitions.get(exec.name)) return 'Satellite: version-control method tool shadowed'
          return undefined
        })
      } catch (error) { members.delete(agent); throw error }
      const release = () => { member.active = false; members.delete(agent); member.kernel = undefined; member.remove() }
      try { agent.ctx.effect(() => release) }
      catch (error) { release(); throw error }
      return release
    },
    dispose() {
      disposed = true
      for (const member of members.values()) { member.active = false; member.kernel = undefined; member.remove() }
      members.clear(); removeGlobal(); removeTool()
    },
  }
}
