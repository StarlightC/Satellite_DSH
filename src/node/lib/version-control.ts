/**
 * Local Git kernel, exposed only through the reserved runtime identity bridge. No remote operation.
 * Services/identity are trusted constructor seams, NEVER model request fields.
 * Host-shared POSIX only. Full native file confinement is required for every spawn.
 * This does not isolate a malicious host Git binary or eliminate external last-instant races.
 */
import { lstat, realpath } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { dirname, join } from 'node:path'
import { runBounded, type BoundedRunResult } from '../../lib/bounded-process.ts'
import type { SandboxLike, SubprocessLike } from '../../lib/process-contracts.ts'
import { deny, literalPath, parseGitRequest, type GitRequest } from './version-control-input.ts'
import { digest, inside, noSymlinkAncestors, observeRepository, observeTargets, repositoryLayout, repositoryReadState, repositoryMetadataStamp, type RepositoryState } from './version-control-repository.ts'

export interface LocalGitDependencies {
  readonly workspaceRoot: string
  readonly agent: { readonly id: string; readonly session?: unknown }
  readonly sessionId: string
  readonly sandbox: SandboxLike
  readonly subprocess: SubprocessLike
  /** Must resolve the calling scope's effective parent policy, not a registration root. */
  readonly policy: () => { mode: string; workspaceRoot: string; sessionId?: string } | undefined
  readonly approval?: { request(input: { agent: unknown; toolName: string; callId?: string; reason: string; signal: AbortSignal }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'> }
  /** Read-only kernel (delegated child): stage/commit are refused here and only handed off. */
  readonly readOnly?: boolean
  /**
   * Parent-owned write handoff: consume the child's private one-shot snapshot.
   * The snapshot must match THIS kernel's own (parent-scope) observation.
   */
  readonly handoff?: { take(token: string): FrozenSnapshot | undefined; owner: string }
  /**
   * Trusted seam: prove the same host-shared fs mapping for repository layout
   * directories (gitdir/commondir). Required when any of them is outside the workspace.
   */
  readonly verifyHostPaths?: (paths: readonly string[], signal: AbortSignal) => Promise<void>
}
export interface FrozenSnapshot { readonly state: RepositoryState; readonly head: string | null; readonly policy: string; readonly workspaceRoot: string; readonly expiresAt: number; readonly deadline: number; readonly owner: string }
export interface LocalGitResult {
  status: 'succeeded' | 'blocked' | 'failed' | 'effect-unknown'
  action?: GitRequest['action']
  message?: string
  stdout?: string
  stderr?: string
  stagedGitlinks?: string
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
  exitCode?: number | null
  expectedSnapshot?: string
  beforeHead?: string | null
  afterHead?: string | null
  indexDigest?: string | null
  actualScope?: string[]
  snapshot?: { head: string | null; indexDigest: string | null; digest: string; expiresAt: number }
}
const queues = new Map<string, Promise<void>>()
async function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const tail = previous.then(() => gate)
  queues.set(key, tail)
  await previous
  try { return await operation() }
  finally { release(); if (queues.get(key) === tail) queues.delete(key) }
}
const GIT = '/usr/bin/git', ENV = '/usr/bin/env'
const CLEAN_ENV = [
  'PATH=/usr/bin:/bin', 'LC_ALL=C', 'HOME=/nonexistent', 'XDG_CONFIG_HOME=/nonexistent',
  'GIT_CONFIG_NOSYSTEM=1', 'GIT_CONFIG_SYSTEM=/dev/null', 'GIT_CONFIG_GLOBAL=/dev/null',
  'GIT_ATTR_NOSYSTEM=1', 'GIT_ALLOW_PROTOCOL=', 'GIT_NO_LAZY_FETCH=1', 'GIT_TERMINAL_PROMPT=0',
  'GIT_OPTIONAL_LOCKS=0', 'GIT_NO_REPLACE_OBJECTS=1', 'GIT_LITERAL_PATHSPECS=1', 'GIT_PAGER=cat',
]
const FIXED = [
  '--no-pager', '--no-replace-objects', '--literal-pathspecs',
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
  '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'core.pager=cat',
  '-c', 'diff.external=', '-c', 'diff.trustExitCode=false', '-c', 'submodule.recurse=false',
  '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false', '-c', 'core.attributesFile=/dev/null',
]
// Model-visible output stays small. Internal index/approval reads need complete
// content, not the display budget; exceeding this memory budget blocks explicitly.
const DISPLAY_BYTES = 128 * 1024, INTERNAL_BYTES = 16 * 1024 * 1024
const TTL = 5 * 60_000
type Snapshot = FrozenSnapshot
const expired = (snapshot: Snapshot): boolean => snapshot.expiresAt <= Date.now() || snapshot.deadline <= performance.now()
interface IndexEntry { mode: string; oid: string; path: string }
const ownerKey = (deps: LocalGitDependencies): string => JSON.stringify([deps.agent.id, deps.sessionId])
const fullArgv = (args: readonly string[]): string[] => [ENV, '-i', ...CLEAN_ENV, GIT, ...FIXED, ...args]
async function executableIdentity(): Promise<string> {
  const records = []
  for (const path of [ENV, GIT]) {
    const st = await lstat(path)
    if (!st.isFile() || st.isSymbolicLink() || await realpath(path) !== path) deny('trusted POSIX executable unavailable')
    records.push([path, st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs])
  }
  return JSON.stringify(records)
}

/** Private in-memory tokens expire and are single-use. No persistence or model-supplied facts. */
export function createLocalVersionControl(deps: LocalGitDependencies): {
  execute(input: unknown, signal: AbortSignal, callId?: string): Promise<LocalGitResult>
  /** Consume (single-use) an unexpired snapshot of this kernel; returns undefined otherwise. */
  take(token: string): FrozenSnapshot | undefined
  readonly owner: string
} {
  const snapshots = new Map<string, Snapshot>()
  const owner = ownerKey(deps), boundAgent = deps.agent, boundSession = deps.agent.session
  function policy(write: boolean): string {
    const p = deps.policy()
    if (!p || !['read-only', 'workspace-write', 'danger-full-access'].includes(p.mode) || p.workspaceRoot !== deps.workspaceRoot || (p.sessionId !== undefined && p.sessionId !== deps.sessionId)) deny('effective parent policy unavailable or mismatched')
    if (!deps.agent.id || !deps.sessionId || owner !== ownerKey(deps) || deps.agent !== boundAgent || deps.agent.session !== boundSession) deny('calling identity changed')
    if (write && p.mode === 'read-only') deny('parent sandbox denies writes')
    return JSON.stringify([p.mode, p.workspaceRoot, p.sessionId ?? null])
  }
  return {
    owner,
    take(token) {
      const snap = snapshots.get(token)
      snapshots.delete(token)
      return snap && !expired(snap) && snap.owner === owner ? snap : undefined
    },
    async execute(input, signal, callId) {
      let request: GitRequest | undefined
      try {
        request = parseGitRequest(input)
        const r = request
        if (deps.readOnly && (r.action === 'stage' || r.action === 'commit')) deny('writes are only executed by the parent-owned handoff')
        policy(r.action === 'stage' || r.action === 'commit')
        // Derive the queue key with read-only observation, not a caller path spelling.
        const queuedState = await repositoryLayout(deps.workspaceRoot, r.repo)
        return await serial(queuedState.lockKey, async (): Promise<LocalGitResult> => {
          signal.throwIfAborted()
          const initialPolicy = policy(false), executable = await executableIdentity()
          const state = await observeRepository(deps.workspaceRoot, r.repo)
          if (state.identity !== queuedState.identity) deny('repository identity changed while queued')
          // Layout directories outside the workspace need a proven host-shared mapping.
          const layoutPaths = [state.layout.gitDir, state.layout.commonDir]
          const hostPaths = async (): Promise<void> => {
            if (layoutPaths.every(path => inside(deps.workspaceRoot, path))) return
            if (!deps.verifyHostPaths) deny('host-shared mapping for external git directory unavailable')
            await deps.verifyHostPaths(layoutPaths, signal)
          }
          await hostPaths()
          // Exactly the validated common directory, only when it is outside the workspace.
          const writableRoots = inside(deps.workspaceRoot, state.layout.commonDir) ? undefined : [state.layout.commonDir] as const
          const initialReadState = await repositoryReadState(state.layout)
          let readStamp = state.metadataStamp
          let targets: Awaited<ReturnType<typeof observeTargets>> | undefined
          const targetPaths = r.action === 'stage' ? r.paths : []
          const sameTargets = (a: typeof targets, b: typeof targets): boolean => !!a && !!b && a.attributesDigest === b.attributesDigest && JSON.stringify([...a.files]) === JSON.stringify([...b.files]) && JSON.stringify([...a.fileKinds]) === JSON.stringify([...b.fileKinds])
          const check = async (write = false): Promise<void> => {
            signal.throwIfAborted()
            if (await executableIdentity() !== executable) deny('executable changed')
            if (write) {
              // Full write recheck AFTER final confinement, immediately before spawn.
              await hostPaths()
              const current = await observeRepository(deps.workspaceRoot, r.repo)
              if (current.identity !== state.identity || current.digest !== state.digest) deny('repository changed; observe again')
              if (current.locks.length) deny('Git locks present')
              if (r.action === 'stage' && !sameTargets(targets, await observeTargets(state.root, targetPaths))) deny('stage targets or attributes changed')
              if (await repositoryMetadataStamp(deps.workspaceRoot, r.repo) !== current.metadataStamp) deny('metadata changed at final write boundary')
            } else if (await repositoryReadState(state.layout) !== initialReadState) deny('HEAD/index changed; observe again')
            if (policy(write) !== initialPolicy) deny('policy changed')
            signal.throwIfAborted()
          }
          const run = async (args: string[], write = false, outputMaxBytes = DISPLAY_BYTES): Promise<BoundedRunResult> => {
            const argv = fullArgv(args)
            let launched = false
            // Once a write enters the provider boundary, a lost launch/result cannot
            // be presented as a safely retryable failure (spawn may throw after launch).
            const uncertain = (detail: string): BoundedRunResult => ({
              exitCode: null, signal: null, timedOut: false, aborted: signal.aborted,
              stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false },
              enforcement: 'full', cleanup: 'failed', failureDetail: detail,
            })
            try {
              const subprocess = { ...deps.subprocess, spawn: (spec: Parameters<typeof deps.subprocess.spawn>[0]) => { launched = true; return deps.subprocess.spawn(spec) } }
              const result = await runBounded({ sandbox: deps.sandbox, subprocess }, {
                executable: argv[0]!, args: argv.slice(1), cwd: state.root,
                mode: write ? 'workspace-write' : 'read-only', workspaceRoot: deps.workspaceRoot,
                sessionId: deps.sessionId, ...(write && writableRoots ? { additionalWritableRoots: writableRoots } : {}), timeoutMs: 30_000, outputMaxBytes,
                // Final freeze AFTER the last confinement await; spawn follows synchronously.
                beforeSpawn: write ? () => check(true) : async () => {
                  if (await repositoryMetadataStamp(deps.workspaceRoot, r.repo) !== readStamp) deny('metadata changed before Git read')
                  signal.throwIfAborted(); if (policy(false) !== initialPolicy) deny('policy changed')
                },
              }, signal)
              if (!result.ok) {
                if (write && launched) return uncertain(JSON.stringify(result.failure))
                deny(`process unavailable: ${JSON.stringify(result.failure)}`)
              }
              return result.result
            } catch (error) {
              // Refusal before spawn is a known no-effect denial, never effect-unknown.
              if (write && launched) return uncertain(error instanceof Error ? error.message : String(error))
              throw error
            }
          }
          const read = async (args: string[], allowed = [0], outputMaxBytes = DISPLAY_BYTES, preview = false): Promise<BoundedRunResult> => {
            const result = await run(args, false, outputMaxBytes)
            if (!preview && (result.stdout.truncated || result.stderr.truncated)) deny(`complete Git output exceeds ${outputMaxBytes}-byte ${outputMaxBytes === DISPLAY_BYTES ? 'display' : 'internal index/approval'} budget; no snapshot/approval from truncated content`)
            if (result.aborted || result.timedOut || result.cleanup !== 'completed' || result.failureDetail || !allowed.includes(result.exitCode ?? -1)) deny(`read failed: ${JSON.stringify(result)}`)
            return result
          }
          // No Git command runs until the bounded local config/attributes/metadata scan passed.
          const headResult = await read(['rev-parse', '--verify', '--quiet', 'HEAD'], [0, 1])
          const head = headResult.exitCode === 1 ? null : headResult.stdout.text.trim()
          if (head !== null && !/^[a-f0-9]{40}$/.test(head)) deny('unsupported HEAD/object format')
          const manifest = (await read(['ls-files', '--stage', '-z'], [0], INTERNAL_BYTES)).stdout.text
          const index: IndexEntry[] = manifest.split('\0').filter(Boolean).map(line => {
            const match = /^(100644|100755|120000|160000) ([a-f0-9]{40}) 0\t(.+)$/.exec(line)
            if (!match) deny('conflicted or unsupported index entry')
            return { mode: match[1]!, oid: match[2]!, path: literalPath(match[3]!) }
          })
          const validatePaths = async (paths: readonly string[], staging = true): Promise<void> => {
            for (const path of paths) {
              if (index.some(e => e.mode === '160000' && (e.path === path || path.startsWith(`${e.path}/`)))) {
                if (staging) deny(`staging submodule HEAD/content is unsupported without observing its separate metadata: ${path}`)
                continue
              }
              // Ordinary symlinks are leaves, never path traversal aliases.
              try { await noSymlinkAncestors(dirname(join(state.root, path))) }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
              if (!state.fileKinds.has(path)) {
                if (staging && !index.some(e => e.path === path)) deny(`not a regular file or explicit tracked deletion: ${path}`)
                try { await lstat(join(state.root, path)); deny('deleted path resolves to existing alias/directory') }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
              }
              if ([...state.files.keys(), ...index.map(e => e.path)].some(p => p.startsWith(`${path}/`))) deny('directory path denied')
            }
          }
          if (r.action === 'stage' || (r.action === 'diff' && r.paths)) {
            targets = await observeTargets(state.root, r.action === 'stage' ? r.paths : r.paths!.filter(path => !index.some(e => e.mode === '160000' && e.path === path)))
            state.files = targets.files; state.fileKinds = targets.fileKinds
          }
          if (r.action === 'status') {
            const result = await read(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'])
            // status's ignore=all avoids reading a submodule's external gitdir but
            // hides staged gitlinks too. Cached raw diff reads only our own index/tree.
            const stagedGitlinks = head !== null || index.some(e => e.mode === '160000')
              ? (await read(['diff', '--cached', '--raw', '--no-abbrev', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--'], [0], INTERNAL_BYTES)).stdout.text.split('\n').filter(line => /^:(?:160000 |[0-9]{6} 160000 )/.test(line)).join('\n') : ''
            await check()
            // Only changed leaves reported by status, never every tracked/ignored file.
            const fields = result.stdout.text.split('\0'), paths: string[] = []
            for (let i = 0; i < fields.length; i++) {
              const field = fields[i]!
              if (!field) continue
              const path = literalPath(field.slice(3))
              if (!index.some(e => e.mode === '160000' && (e.path === path || path.startsWith(`${e.path}/`)))) paths.push(path)
              if (/^[RC]|^.[RC]/.test(field.slice(0, 2))) i++
            }
            const changed = await observeTargets(state.root, paths, true)
            state.files = changed.files; state.fileKinds = changed.fileKinds
            await check()
            for (const [key, snap] of snapshots) if (expired(snap)) snapshots.delete(key)
            if (snapshots.size >= 32) snapshots.delete(snapshots.keys().next().value!)
            const token = randomBytes(32).toString('hex'), expiresAt = Date.now() + TTL
            snapshots.set(token, { state, head, policy: initialPolicy, workspaceRoot: deps.workspaceRoot, expiresAt, deadline: performance.now() + TTL, owner })
            return { status: 'succeeded', action: r.action, stdout: result.stdout.text, ...(stagedGitlinks ? { stagedGitlinks } : {}), expectedSnapshot: token, snapshot: { head, indexDigest: state.indexDigest, digest: state.digest, expiresAt } }
          }
          if (r.action === 'log') {
            const stdout = head === null ? '' : (await read(['log', `-${r.count}`, '--format=medium', '--no-decorate', '--no-show-signature', 'HEAD', '--'])).stdout.text
            await check()
            return { status: 'succeeded', action: r.action, stdout }
          }
          if (r.action === 'diff') {
            if (r.paths) await validatePaths(r.paths, false)
            const result = await read(['diff', ...(r.target === 'staged' ? ['--cached'] : []), '--no-ext-diff', '--no-textconv', '--no-renames', r.target === 'staged' ? '--ignore-submodules=none' : '--ignore-submodules=all', '--submodule=short', '--', ...(r.paths ?? [])], [0], DISPLAY_BYTES, true)
            await check()
            return { status: 'succeeded', action: r.action, stdout: result.stdout.text, stderr: result.stderr.text, stdoutTruncated: result.stdout.truncated, stderrTruncated: result.stderr.truncated, ...(result.stdout.truncated || result.stderr.truncated ? { message: 'Truncated preview only; not complete summary or approval material.' } : {}) }
          }
          // single-use even on denial/change/cancellation
          const snap = deps.handoff ? deps.handoff.take(r.expectedSnapshot) : snapshots.get(r.expectedSnapshot)
          snapshots.delete(r.expectedSnapshot)
          // Handoff: the child's snapshot must equal this parent-scope observation; the
          // policy differs by session, so only the shared workspace root is compared.
          const policyMatches = deps.handoff ? snap?.workspaceRoot === deps.workspaceRoot : snap?.policy === initialPolicy
          if (!snap || expired(snap) || snap.owner !== (deps.handoff?.owner ?? owner) || snap.state.identity !== state.identity || snap.state.digest !== state.digest || snap.head !== head || !policyMatches) deny('expectedSnapshot missing, expired, foreign or changed')
          if (r.action === 'stage') for (const path of r.paths) {
            if (!snap.state.files.has(path)) deny(`stage target not observed by status; fresh status required: ${path}`)
            if (snap.state.files.get(path) !== state.files.get(path) || JSON.stringify(snap.state.fileKinds.get(path)) !== JSON.stringify(state.fileKinds.get(path))) deny('stage target changed since status')
          }
          if (state.locks.length) deny(`Git locks present (not removed): ${state.locks.join(', ')}`)
          let args: string[], indexPatch: string | undefined
          if (r.action === 'stage') {
            await validatePaths(r.paths)
            args = ['add', '--', ...r.paths]
          } else {
            if (!index.length) deny('empty index')
            const changed = await read(['diff', '--cached', '--quiet', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--'], [0, 1])
            if (changed.exitCode === 0) deny('no staged change')
            indexPatch = (await read(['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none', '--submodule=short', '--'], [0], INTERNAL_BYTES)).stdout.text
            args = ['commit', '--no-gpg-sign', '--no-verify', '-m', r.message]
          }
          const argv = fullArgv(args)
          const plan = {
            action: r.action, repository: state.root, layout: state.layout, ...(writableRoots ? { additionalWritableRoots: writableRoots } : {}), identity: state.identity, head, indexDigest: state.indexDigest,
            treeDigest: state.digest, configDigest: state.configDigest, attributesDigest: r.action === 'stage' ? digest(JSON.stringify([state.attributesDigest, targets!.attributesDigest])) : state.attributesDigest,
            argv, owner, policy: initialPolicy,
            ...(r.action === 'stage' ? { targets: r.paths.map(path => ({ path, digest: state.files.get(path) === 'missing' ? null : state.files.get(path) ?? null, ...(state.fileKinds.get(path) ?? {}) })) } : { entireIndex: index, indexPatch }),
          }
          const reason = `Local Git exact one-shot write; no remote operation. Commit covers the ENTIRE actual index.${writableRoots ? ` Also grants this one call write access to the linked worktree's shared Git directory ${writableRoots[0]} (outside the workspace).` : ''}\n${JSON.stringify(plan)}`
          await check()
          // Capability probe is side-effect free; never ask approval for an unenforceable write.
          // Same policy shape as the real write run (incl. the exact external commondir grant).
          const confinement = await deps.sandbox.confine(argv, { mode: 'workspace-write', workspaceRoot: deps.workspaceRoot, sessionId: deps.sessionId, ...(writableRoots ? { additionalWritableRoots: [...writableRoots] } : {}) }, signal)
          if (confinement.enforcement !== 'full' || !confinement.argv.length) deny('full write confinement unavailable')
          if (!deps.approval || typeof deps.approval.request !== 'function') deny('approval service unavailable')
          // Fresh at approval admission; user reading time does not expire the plan.
          if (expired(snap)) deny('expectedSnapshot expired before approval')
          let granted: string
          try { granted = await deps.approval.request({ agent: deps.agent, toolName: 'satellite_version_control', ...(callId ? { callId } : {}), reason, signal }) }
          catch { deny('approval service exception; denied') }
          if (granted !== 'allowed-once') deny(`approval ${granted}; denied`)
          const result = await run(args, true)
          const unknown = result.aborted || result.timedOut || result.cleanup !== 'completed' || !!result.failureDetail || result.exitCode !== 0
          if (unknown) return { status: 'effect-unknown', action: r.action, exitCode: result.exitCode, stdout: result.stdout.text, stderr: result.stderr.text, stdoutTruncated: result.stdout.truncated, stderrTruncated: result.stderr.truncated, message: 'Write may have taken effect. Observe status before any new decision; never automatically retry.' }
          // Return only post-write facts, without a status/log round trip.
          try {
            const after = await observeRepository(deps.workspaceRoot, r.repo)
            if (after.identity !== state.identity || after.configDigest !== state.configDigest || policy(true) !== initialPolicy) deny('post-write context changed')
            readStamp = after.metadataStamp
            const afterResult = await run(['rev-parse', '--verify', '--quiet', 'HEAD'])
            const afterHead = afterResult.exitCode === 1 ? null : afterResult.stdout.text.trim()
            if (![0, 1].includes(afterResult.exitCode ?? -1) || afterResult.stdout.truncated || afterResult.stderr.truncated || afterResult.aborted || afterResult.timedOut || afterResult.cleanup !== 'completed' || afterResult.failureDetail || (afterHead !== null && !/^[a-f0-9]{40}$/.test(afterHead))) deny('post-write HEAD unavailable')
            return { status: 'succeeded', action: r.action, exitCode: result.exitCode, stdout: result.stdout.text, stderr: result.stderr.text, stdoutTruncated: result.stdout.truncated, stderrTruncated: result.stderr.truncated, beforeHead: head, afterHead, indexDigest: after.indexDigest, actualScope: r.action === 'stage' ? r.paths : index.map(e => e.path) }
          } catch (error) {
            return { status: 'effect-unknown', action: r.action, message: `Write completed but post-write facts unavailable: ${error instanceof Error ? error.message : String(error)}. Observe before any new decision; never automatically retry.` }
          }
        })
      } catch (error) {
        return { status: 'blocked', ...(request ? { action: request.action } : {}), message: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
