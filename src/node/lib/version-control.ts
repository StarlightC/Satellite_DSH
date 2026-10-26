/**
 * Local Git kernel, exposed only through the reserved runtime identity bridge. No remote operation.
 * Services/identity are trusted constructor seams, NEVER model request fields.
 * Host-shared POSIX only. Full native file confinement is required for every spawn.
 * This does not isolate a malicious host Git binary or eliminate external last-instant races.
 */
import { lstat, realpath } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { runBounded, type BoundedRunResult } from '../../lib/bounded-process.ts'
import type { SandboxLike, SubprocessLike } from '../../lib/process-contracts.ts'
import { deny, literalPath, parseGitRequest, validateAttributes, type GitRequest } from './version-control-input.ts'
import { observeRepository, type RepositoryState } from './version-control-repository.ts'

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
}
export interface FrozenSnapshot { readonly state: RepositoryState; readonly head: string | null; readonly policy: string; readonly workspaceRoot: string; readonly expiresAt: number; readonly deadline: number; readonly owner: string }
export interface LocalGitResult {
  status: 'succeeded' | 'blocked' | 'failed' | 'effect-unknown'
  action?: GitRequest['action']
  message?: string
  stdout?: string
  stderr?: string
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
  exitCode?: number | null
  expectedSnapshot?: string
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
        const queuedState = await observeRepository(deps.workspaceRoot, r.repo)
        return await serial(queuedState.lockKey, async (): Promise<LocalGitResult> => {
          signal.throwIfAborted()
          const initialPolicy = policy(false), executable = await executableIdentity()
          const state = await observeRepository(deps.workspaceRoot, r.repo)
          if (state.identity !== queuedState.identity) deny('repository identity changed while queued')
          let writeSnapshot: Snapshot | undefined
          const check = async (write = false): Promise<void> => {
            signal.throwIfAborted()
            if (await executableIdentity() !== executable) deny('executable changed')
            const current = await observeRepository(deps.workspaceRoot, r.repo)
            // Synchronous tail AFTER the last await: policy/expiry/cancellation are
            // re-read with no further async gap before the caller's next step.
            if (current.identity !== state.identity || current.digest !== state.digest) deny('repository changed; observe again')
            if (policy(write) !== initialPolicy) deny('policy changed')
            if (write && (!writeSnapshot || expired(writeSnapshot))) deny('write snapshot expired')
            signal.throwIfAborted()
          }
          const run = async (args: string[], write = false): Promise<BoundedRunResult> => {
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
                sessionId: deps.sessionId, timeoutMs: 30_000, outputMaxBytes: 128 * 1024,
                // Final freeze AFTER the last confinement await; spawn follows synchronously.
                beforeSpawn: () => check(write),
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
          const read = async (args: string[], allowed = [0]): Promise<BoundedRunResult> => {
            const result = await run(args)
            if (result.aborted || result.timedOut || result.cleanup !== 'completed' || result.failureDetail || result.stdout.truncated || result.stderr.truncated || !allowed.includes(result.exitCode ?? -1)) deny(`read failed: ${JSON.stringify(result)}`)
            return result
          }
          // No Git command runs until the bounded local config/attributes/metadata scan passed.
          const headResult = await read(['rev-parse', '--verify', '--quiet', 'HEAD'], [0, 1])
          const head = headResult.exitCode === 1 ? null : headResult.stdout.text.trim()
          if (head !== null && !/^[a-f0-9]{40}$/.test(head)) deny('unsupported HEAD/object format')
          const manifest = (await read(['ls-files', '--stage', '-z'])).stdout.text
          const index: IndexEntry[] = manifest.split('\0').filter(Boolean).map(line => {
            const match = /^(100644|100755) ([a-f0-9]{40}) 0\t(.+)$/.exec(line)
            if (!match) deny('conflicted/special index entry (including gitlink/symlink)')
            return { mode: match[1]!, oid: match[2]!, path: literalPath(match[3]!) }
          })
          for (const entry of index.filter(e => e.path.split('/').at(-1)!.toLowerCase() === '.gitattributes')) {
            validateAttributes((await read(['show', `:${entry.path}`])).stdout.text)
          }
          const validatePaths = async (paths: readonly string[], staging = true): Promise<void> => {
            for (const path of paths) {
              // Full-tree scan rejects symlink ancestors and special files, even unrelated ones.
              if (!state.files.has(path)) {
                if (staging && !index.some(e => e.path === path)) deny(`not a regular file or explicit tracked deletion: ${path}`)
                try { await lstat(join(state.root, path)); deny('deleted path resolves to existing alias/directory') }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
              }
              if ([...state.files.keys(), ...index.map(e => e.path)].some(p => p.startsWith(`${path}/`))) deny('directory path denied')
            }
          }
          if (r.action === 'status') {
            const result = await read(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'])
            await check()
            for (const [key, snap] of snapshots) if (expired(snap)) snapshots.delete(key)
            if (snapshots.size >= 32) snapshots.delete(snapshots.keys().next().value!)
            const token = randomBytes(32).toString('hex'), expiresAt = Date.now() + TTL
            snapshots.set(token, { state, head, policy: initialPolicy, workspaceRoot: deps.workspaceRoot, expiresAt, deadline: performance.now() + TTL, owner })
            return { status: 'succeeded', action: r.action, stdout: result.stdout.text, expectedSnapshot: token, snapshot: { head, indexDigest: state.indexDigest, digest: state.digest, expiresAt } }
          }
          if (r.action === 'log') {
            const stdout = head === null ? '' : (await read(['log', `-${r.count}`, '--format=medium', '--no-decorate', '--no-show-signature', 'HEAD', '--'])).stdout.text
            return { status: 'succeeded', action: r.action, stdout }
          }
          if (r.action === 'diff') {
            if (r.paths) await validatePaths(r.paths, false)
            const result = await read(['diff', ...(r.target === 'staged' ? ['--cached'] : []), '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', '--', ...(r.paths ?? [])])
            return { status: 'succeeded', action: r.action, stdout: result.stdout.text }
          }
          // single-use even on denial/change/cancellation
          const snap = deps.handoff ? deps.handoff.take(r.expectedSnapshot) : snapshots.get(r.expectedSnapshot)
          snapshots.delete(r.expectedSnapshot)
          // Handoff: the child's snapshot must equal this parent-scope observation; the
          // policy differs by session, so only the shared workspace root is compared.
          const policyMatches = deps.handoff ? snap?.workspaceRoot === deps.workspaceRoot : snap?.policy === initialPolicy
          if (!snap || expired(snap) || snap.owner !== (deps.handoff?.owner ?? owner) || snap.state.identity !== state.identity || snap.state.digest !== state.digest || snap.head !== head || !policyMatches) deny('expectedSnapshot missing, expired, foreign or changed')
          writeSnapshot = snap
          if (state.locks.length) deny(`Git locks present (not removed): ${state.locks.join(', ')}`)
          let args: string[], indexPatch: string | undefined
          if (r.action === 'stage') {
            await validatePaths(r.paths)
            args = ['add', '--', ...r.paths]
          } else {
            if (!index.length) deny('empty index')
            const changed = await read(['diff', '--cached', '--quiet', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--'], [0, 1])
            if (changed.exitCode === 0) deny('no staged change')
            indexPatch = (await read(['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', '--'])).stdout.text
            args = ['commit', '--no-gpg-sign', '--no-verify', '-m', r.message]
          }
          const argv = fullArgv(args)
          const plan = {
            action: r.action, repository: state.root, identity: state.identity, head, indexDigest: state.indexDigest,
            treeDigest: state.digest, configDigest: state.configDigest, attributesDigest: state.attributesDigest,
            argv, owner, policy: initialPolicy,
            ...(r.action === 'stage' ? { targets: r.paths.map(path => ({ path, digest: state.files.get(path) ?? null })) } : { entireIndex: index, indexPatch }),
          }
          const reason = `Local Git exact one-shot write; no remote operation. Commit covers the ENTIRE actual index.\n${JSON.stringify(plan)}`
          if (Buffer.byteLength(reason) > 64 * 1024) deny('approval plan too large; do not truncate')
          await check(true)
          // Capability probe is side-effect free; never ask approval for an unenforceable write.
          const confinement = await deps.sandbox.confine(argv, { mode: 'workspace-write', workspaceRoot: deps.workspaceRoot, sessionId: deps.sessionId }, signal)
          if (confinement.enforcement !== 'full' || !confinement.argv.length) deny('full write confinement unavailable')
          if (!deps.approval || typeof deps.approval.request !== 'function') deny('approval service unavailable')
          let granted: string
          try { granted = await deps.approval.request({ agent: deps.agent, toolName: 'satellite_version_control', ...(callId ? { callId } : {}), reason, signal }) }
          catch { deny('approval service exception; denied') }
          if (granted !== 'allowed-once') deny(`approval ${granted}; denied`)
          if (expired(snap)) deny('expectedSnapshot expired while awaiting approval')
          await check(true) // freeze binds actual repo+HEAD+index+all target contents+config/attributes+argv
          const result = await run(args, true)
          const unknown = result.aborted || result.timedOut || result.cleanup !== 'completed' || !!result.failureDetail || result.exitCode !== 0
          return { status: unknown ? 'effect-unknown' : 'succeeded', action: r.action, exitCode: result.exitCode, stdout: result.stdout.text, stderr: result.stderr.text, stdoutTruncated: result.stdout.truncated, stderrTruncated: result.stderr.truncated, ...(unknown ? { message: 'Write may have taken effect. Observe status before any new decision; never automatically retry.' } : {}) }
        })
      } catch (error) {
        return { status: 'blocked', ...(request ? { action: request.action } : {}), message: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
