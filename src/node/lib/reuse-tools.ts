import { defineTool } from '@deepseek-ai/dsh-tools'
import { createReuseIndex, REUSE_INDEX_PATH, REUSE_OVERRIDES_PATH, REUSE_LIMITS } from './reuse-index.js'
import type { ReuseApprovalPlan, ReuseEntryDraft, ReuseFs, ReuseSandboxPolicy } from './reuse-index.js'

/** Host adapter only. Service names/signatures follow the inspected DSH contracts. */
interface HostFs extends ReuseFs {
  processPathFromHostPath(hostPath: string): string | undefined
  fileUrl(target: Parameters<ReuseFs['stat']>[0]): string
}
interface HostSession { readonly header: { readonly cwd?: string } }
interface HostAgent { readonly session: HostSession; readonly ctx?: ServiceContext }
interface HostExecution { readonly agent?: HostAgent; readonly callId?: string; readonly signal: AbortSignal }
interface Approval {
  request(request: { agent: HostAgent; toolName: string; callId?: string; reason: string; signal: AbortSignal }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}
interface SandboxPolicy { resolve(request: { session: HostSession }): ReuseSandboxPolicy }
interface ServiceContext { get(name: string): unknown }
export interface ReuseToolContext extends ServiceContext {
  readonly tools: { register(tool: ReturnType<typeof defineTool>): () => void }
  effect(callback: () => (() => void)): unknown
}
export interface ReuseSource {
  readonly revision: string
  readonly extract: (path: string, text: string) => readonly ReuseEntryDraft[]
}
const unavailable = (reason: string) => ({ status: 'unavailable', reason, fallback: 'Use bounded ordinary search; do not initialize or rebuild implicitly.' })
const json = (value: unknown) => JSON.parse(JSON.stringify(value))
const output = {
  schema: { type: 'object', additionalProperties: true, properties: {
    status: { type: 'string', required: true }, reason: { type: 'string' },
  } },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

function serviceContext(ctx: ServiceContext, exec: HostExecution): ServiceContext {
  // Do not silently fall back to a different execution world's services when an Agent
  // scope exists but does not have a capability.
  return exec.agent?.ctx ?? ctx
}
function hasFs(value: unknown): value is HostFs {
  if (!value || typeof value !== 'object') return false
  const fs = value as unknown as Record<string, unknown>
  return ['resolve', 'processPath', 'processPathFromHostPath', 'fileUrl', 'contains', 'stat', 'readBytes', 'writeText']
    .every(name => typeof fs[name] === 'function')
}

/** No model-selected root/backend id and no assumption that host files exist remotely. */
async function binding(ctx: ServiceContext, exec: HostExecution) {
  exec.signal.throwIfAborted()
  const rootPath = exec.agent?.session?.header?.cwd
  if (typeof rootPath !== 'string' || rootPath.length === 0) return unavailable('REUSE_SESSION_ROOT_UNAVAILABLE')
  const services = serviceContext(ctx, exec), fs = services.get('fs')
  if (!hasFs(fs)) return unavailable('REUSE_FILESYSTEM_UNAVAILABLE')
  const mapped = fs.processPathFromHostPath(rootPath)
  if (!mapped) return unavailable('REUSE_HOST_SHARED_MAPPING_UNAVAILABLE')
  const root = await fs.resolve(mapped, { signal: exec.signal })
  if ((await fs.stat(root, exec.signal))?.type !== 'directory') return unavailable('REUSE_SESSION_ROOT_UNAVAILABLE')
  const canonical = fs.processPath(root)
  const again = fs.processPathFromHostPath(canonical)
  if (!again) return unavailable('REUSE_HOST_SHARED_MAPPING_UNVERIFIED')
  const mappedAgain = await fs.resolve(again, { signal: exec.signal })
  if (mappedAgain.targetKey !== root.targetKey || fs.fileUrl(mappedAgain) !== fs.fileUrl(root)
    || !fs.fileUrl(root).startsWith('file:')) return unavailable('REUSE_HOST_SHARED_MAPPING_UNVERIFIED')
  exec.signal.throwIfAborted()
  return { fs, services, projectRoot: canonical, backendId: 'host-shared-v1' }
}
function isUnavailable(value: unknown): value is ReturnType<typeof unavailable> {
  return !!value && typeof value === 'object' && 'status' in value
}
function rejectExtra(args: object, names: readonly string[]): void {
  if (Object.keys(args).some(key => !names.includes(key))) throw new Error('REUSE_UNKNOWN_ARGUMENT')
}
function asExecution(exec: unknown): HostExecution { return exec as HostExecution }

export function registerReuseQuery(ctx: ReuseToolContext): void {
  const tool = defineTool({
    name: 'satellite_reuse_query',
    description: 'Read a bounded set of reuse candidates for this session project. Never scans or writes an index. Missing, invalid or stale evidence requires bounded source search; explicit-file coverage is not a whole-project inventory.',
    parameters: {
      terms: { type: 'array', items: { type: 'string' }, description: 'Up to 20 task-specific terms, each at most 1024 characters. Omit to inspect status without matches.' },
      limit: { type: 'integer', description: 'Maximum candidates, 1–8; defaults to 8.' },
    },
    output,
    isConcurrencySafe: () => true,
    async execute(args, nativeExec) {
      rejectExtra(args, ['terms', 'limit'])
      const exec = asExecution(nativeExec), bound = await binding(ctx, exec)
      if (isUnavailable(bound)) return json(bound)
      const result = await createReuseIndex(bound).query(args, exec.signal)
      return json(result.status === 'missing' ? { ...result, fallback: 'Use bounded ordinary search; initialization requires an explicit maintenance request and host approval.' } : result)
    },
  })
  ctx.effect(() => ctx.tools.register(tool))
}

/** Android supplies the sole real recognizer. No recognizer registry or core→Android import. */
export function registerReuseMaintenance(ctx: ReuseToolContext, source: ReuseSource): void {
  const toolName = 'satellite_reuse_maintain'
  const tool = defineTool({
    name: toolName,
    description: `Maintain this session project's reuse index after exact host approval. Writes ${REUSE_INDEX_PATH}; reads but never rewrites user overrides ${REUSE_OVERRIDES_PATH}. Only explicit files are covered, not a repository scan.`,
    parameters: {
      action: { type: 'string', enum: ['initialize', 'rebuild', 'update'], required: true,
        description: 'initialize creates a missing baseline; rebuild replaces the explicit-file baseline; update requires an existing baseline and changes only supplied files.' },
      paths: { type: 'array', items: { type: 'string' }, required: true,
        description: '1–100 exact project-relative source files (not directories); each at most 1024 characters. Deleted files may be supplied to update. Coverage remains partial.' },
      adjustments: { type: 'array', description: 'Up to 100 semantic adjustments, only for entries belonging to the supplied files. User overrides always win.',
        items: { type: 'object', additionalProperties: false, properties: {
          entryId: { type: 'string', required: true }, remove: { type: 'boolean', description: 'Remove the agent override; do not supply value with true.' },
          value: { type: 'object', additionalProperties: false, properties: {
            aliases: { type: 'array', items: { type: 'string' } }, useWhen: { type: 'array', items: { type: 'string' } },
            doNotUseWhen: { type: 'array', items: { type: 'string' } }, notes: { type: 'array', items: { type: 'string' } },
            owner: { type: 'string' }, status: { type: 'string', enum: ['preferred', 'compatible', 'deprecated', 'excluded'] },
          } },
        } } },
    },
    output,
    isConcurrencySafe: () => false,
    async execute(args, nativeExec) {
      rejectExtra(args, ['action', 'paths', 'adjustments'])
      const exec = asExecution(nativeExec), bound = await binding(ctx, exec)
      if (isUnavailable(bound)) return json(bound)
      const approval = bound.services.get('approval') as Approval | undefined
      const sandboxPolicy = bound.services.get('sandboxPolicy') as SandboxPolicy | undefined
      if (!approval || typeof approval.request !== 'function') return json(unavailable('REUSE_APPROVAL_UNAVAILABLE'))
      if (!sandboxPolicy || typeof sandboxPolicy.resolve !== 'function') return json(unavailable('REUSE_SANDBOX_POLICY_UNAVAILABLE'))
      const agent = exec.agent!
      const policy = () => sandboxPolicy.resolve({ session: agent.session })
      const initialPolicy = policy()
      if (!initialPolicy || !['workspace-write', 'danger-full-access'].includes(initialPolicy.mode)) throw new Error('REUSE_WRITE_DENIED')
      // Fail before approval for a mismatched sandbox root, including bare fs providers.
      const writeRoot = await bound.fs.resolve(initialPolicy.workspaceRoot, { signal: exec.signal })
      const projectRoot = await bound.fs.resolve(bound.projectRoot, { signal: exec.signal })
      if (!bound.fs.contains(writeRoot, projectRoot)) throw new Error('REUSE_WRITE_ROOT_DENIED')
      const api = createReuseIndex({ ...bound, sourceRevision: source.revision, extract: source.extract, policy,
        approve: async (plan: ReuseApprovalPlan, signal: AbortSignal) => {
          const reason = `Reuse index maintenance (explicit files only):\n${JSON.stringify(plan)}`
          // Never truncate an approval plan: if it cannot be shown exactly, split the request.
          if (Buffer.byteLength(reason) > 64 * 1024) throw new Error('REUSE_APPROVAL_PLAN_TOO_LARGE')
          signal.throwIfAborted()
          return approval.request({ agent, toolName, ...(exec.callId ? { callId: exec.callId } : {}), reason, signal })
        },
      })
      const result = await api.maintain(args, exec.signal)
      if (Buffer.byteLength(JSON.stringify(result)) > REUSE_LIMITS.outputBytes) throw new Error('REUSE_OUTPUT_BUDGET')
      return json(result)
    },
  })
  ctx.effect(() => ctx.tools.register(tool))
}
