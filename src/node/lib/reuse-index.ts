import { createHash } from 'node:crypto'

/** Structural subset of the inspected DSH fs API; no project access through Node fs. */
export interface ReuseFsTarget { readonly targetKey: string; readonly displayPath: string }
export interface ReuseFsInfo { readonly version: string; readonly type: 'file' | 'directory' | 'other'; readonly size?: number }
export interface ReuseSandboxPolicy {
  readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly workspaceRoot: string
  readonly sessionId?: string
}
export interface ReuseFs {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<ReuseFsTarget>
  processPath(target: ReuseFsTarget): string
  contains(parent: ReuseFsTarget, child: ReuseFsTarget): boolean
  stat(target: ReuseFsTarget, signal?: AbortSignal): Promise<ReuseFsInfo | undefined>
  readBytes(target: ReuseFsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
  writeText(target: ReuseFsTarget, content: string,
    expected: { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: string },
    signal: AbortSignal | undefined, policy: ReuseSandboxPolicy): Promise<unknown>
}
export interface ReuseEntryDraft {
  readonly kind: string
  readonly symbol: string
  readonly line: number
  readonly aliases?: readonly string[]
}
export interface ReuseEntry extends ReuseEntryDraft {
  readonly id: string
  readonly location: string
  readonly aliases: readonly string[]
}
export interface ReuseOverride {
  readonly aliases?: readonly string[]
  readonly useWhen?: readonly string[]
  readonly doNotUseWhen?: readonly string[]
  readonly owner?: string
  readonly status?: 'preferred' | 'compatible' | 'deprecated' | 'excluded'
  readonly notes?: readonly string[]
}
interface FileRecord { path: string; digest: string; entries: ReuseEntry[] }
interface ReuseIndex {
  schemaVersion: 1
  project: { backendId: string; rootKey: string }
  sourceRevision: string
  coverage: 'explicit-files'
  generatedAt: string
  files: FileRecord[]
  agentOverrides: Record<string, ReuseOverride>
}
export interface ReuseApprovalPlan {
  readonly action: 'initialize' | 'rebuild' | 'update'
  readonly project: Readonly<{ backendId: string; rootKey: string }>
  readonly root: string
  readonly destination: string
  readonly paths: readonly string[]
  readonly adjustments: readonly ReuseAdjustment[]
  readonly coverage: 'explicit-files'
  readonly replacingInvalidBaseline?: Readonly<{ reason: string; version: string; digest: string }>
}
export interface ReuseAdjustment { readonly entryId: string; readonly value?: ReuseOverride; readonly remove?: boolean }
export interface ReuseIndexDependencies {
  readonly fs: ReuseFs
  /** Host-owned proven execution-world identity, never a guessed provider id or tool argument.
   * The initial host adapter supports only verified host-shared mappings; remote backends
   * without a stable identity must remain unavailable. FsTarget keys alone are not global.
   */
  readonly backendId: string
  /** Host/session-bound project root, not the current model-selected cwd. */
  readonly projectRoot: string
  /** Optional for generic queries; absent revision is reported separately as unverified. */
  readonly sourceRevision?: string
  readonly extract?: (path: string, text: string) => readonly ReuseEntryDraft[]
  /** Adapter to the real host approval boundary; only allowed-once grants execution. */
  readonly approve?: (plan: ReuseApprovalPlan, signal: AbortSignal) => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
  /** Resolve from the calling session at execution time; do not fabricate a narrower root. */
  readonly policy?: () => ReuseSandboxPolicy
}
// Root-level files need no mkdir capability. User overrides are only read, never rewritten.
export const REUSE_INDEX_PATH = '.satellite-reuse-index.json'
export const REUSE_OVERRIDES_PATH = '.satellite-reuse-overrides.json'
export const REUSE_LIMITS = Object.freeze({ paths: 100, files: 1000, entries: 4000,
  fileBytes: 1024 * 1024, totalBytes: 16 * 1024 * 1024, indexBytes: 4 * 1024 * 1024,
  overrideBytes: 256 * 1024, outputBytes: 16 * 1024, terms: 20, results: 8 })
export type ReuseStatus = 'missing' | 'invalid' | 'stale' | 'available'
export interface ReuseQueryResult {
  status: ReuseStatus
  reason?: string
  coverage: 'explicit-files'
  recognitionStatus: 'current' | 'changed' | 'unverified'
  sourceRevision?: string
  checkedFiles: number
  indexedFiles: number
  candidateCount: number
  truncated: boolean
  matches: Array<ReuseEntry & ReuseOverride & { freshness: 'current' | 'stale' | 'missing'; score: number }>
}
export class ReuseIndexError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.code = code; this.name = 'ReuseIndexError' }
}
function fail(code: string): never { throw new ReuseIndexError(code) }
const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !v.includes('\0')
const words = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 32 && v.every(text)
const normalize = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_./-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
function relativePath(value: unknown): string {
  if (!text(value) || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)
    || value.split('/').some(p => !p || p === '.' || p === '..')
    || value === REUSE_INDEX_PATH || value === REUSE_OVERRIDES_PATH) return fail('REUSE_PATH_DENIED')
  return value
}
function validOverride(value: unknown): value is ReuseOverride {
  return object(value) && Object.entries(value).every(([key, v]) => {
    if (['aliases', 'useWhen', 'doNotUseWhen', 'notes'].includes(key)) return words(v)
    if (key === 'owner') return text(v)
    return key === 'status' && typeof v === 'string' && ['preferred', 'compatible', 'deprecated', 'excluded'].includes(v)
  })
}
function entryId(path: string, kind: string, symbol: string): string {
  return digest(`${path}\0${kind}\0${symbol}`).slice(0, 32)
}
function validDraft(v: unknown): v is ReuseEntryDraft {
  return object(v) && text(v.kind) && text(v.symbol) && Number.isSafeInteger(v.line) && Number(v.line) > 0
    && (v.aliases === undefined || words(v.aliases))
}
function parseIndex(raw: string): ReuseIndex {
  const v: unknown = JSON.parse(raw)
  if (!object(v) || v.schemaVersion !== 1 || !object(v.project) || !text(v.project.backendId)
    || !text(v.project.rootKey) || !text(v.sourceRevision) || !text(v.generatedAt)
    || v.coverage !== 'explicit-files' || !Array.isArray(v.files) || v.files.length > REUSE_LIMITS.files
    || !object(v.agentOverrides)) return fail('REUSE_INVALID_INDEX')
  let count = 0
  const paths = new Set<string>(), ids = new Set<string>()
  for (const file of v.files) {
    if (!object(file) || typeof file.path !== 'string' || relativePath(file.path) !== file.path
      || typeof file.digest !== 'string' || !/^[a-f0-9]{64}$/.test(file.digest)
      || !Array.isArray(file.entries) || paths.has(file.path)) return fail('REUSE_INVALID_INDEX')
    paths.add(file.path)
    for (const entry of file.entries) {
      if (!validDraft(entry) || !object(entry) || entry.location !== file.path || !words(entry.aliases)
        || entry.id !== entryId(file.path, entry.kind, entry.symbol) || ids.has(String(entry.id))) return fail('REUSE_INVALID_INDEX')
      ids.add(String(entry.id)); count++
    }
  }
  if (count > REUSE_LIMITS.entries || Object.entries(v.agentOverrides).some(([id, o]) => !ids.has(id) || !validOverride(o))) return fail('REUSE_INVALID_INDEX')
  return v as unknown as ReuseIndex
}
function checkSignal(signal: AbortSignal): void { signal.throwIfAborted() }

/** Explicit-file lifecycle, not a scanner registry. Instantiate per host-bound project/call. */
export function createReuseIndex(deps: ReuseIndexDependencies) {
  if (!text(deps.backendId) || !text(deps.projectRoot) || (deps.sourceRevision !== undefined && !text(deps.sourceRevision))) fail('REUSE_BINDING_REQUIRED')
  const fs = deps.fs
  async function bind(signal: AbortSignal) {
    checkSignal(signal)
    const root = await fs.resolve(deps.projectRoot, { signal })
    if ((await fs.stat(root, signal))?.type !== 'directory') fail('REUSE_ROOT_REQUIRED')
    return { root, cwd: fs.processPath(root), project: { backendId: deps.backendId, rootKey: root.targetKey } }
  }
  async function target(root: ReuseFsTarget, cwd: string, path: string, signal: AbortSignal) {
    checkSignal(signal)
    const result = await fs.resolve(path, { cwd, signal })
    if (result.targetKey === root.targetKey || !fs.contains(root, result)) fail('REUSE_PATH_DENIED')
    return result
  }
  async function readSnapshot(target: ReuseFsTarget, max: number, signal: AbortSignal) {
    checkSignal(signal)
    const before = await fs.stat(target, signal)
    if (!before) return undefined
    if (before.type !== 'file') fail('REUSE_NOT_FILE')
    const bytes = await fs.readBytes(target, signal, max)
    const after = await fs.stat(target, signal)
    if (!after || before.version !== after.version) fail('REUSE_SOURCE_CHANGED')
    checkSignal(signal)
    return { data: bytes, bytes: bytes.length, version: after.version }
  }
  async function read(target: ReuseFsTarget, max: number, signal: AbortSignal) {
    const content = await readSnapshot(target, max, signal)
    return content ? { ...content, raw: new TextDecoder('utf-8', { fatal: true }).decode(content.data) } : undefined
  }
  async function load(binding: Awaited<ReturnType<typeof bind>>, signal: AbortSignal, recoverInvalid = false) {
    const destination = await target(binding.root, binding.cwd, REUSE_INDEX_PATH, signal)
    // Snapshot bounded bytes/version first. Invalid UTF-8 is recoverable only through
    // explicit rebuild; I/O, size, file-kind and version failures stay outside recovery.
    const content = await readSnapshot(destination, REUSE_LIMITS.indexBytes, signal)
    if (!content) return { destination, content, index: undefined }
    let index: ReuseIndex
    try { index = parseIndex(new TextDecoder('utf-8', { fatal: true }).decode(content.data)) }
    catch (error) {
      if (!recoverInvalid) throw error
      return { destination, content, index: undefined, replacingInvalidBaseline: {
        reason: error instanceof Error ? error.message.slice(0, 256) : 'REUSE_INVALID_INDEX',
        version: content.version, digest: digest(content.data),
      } }
    }
    if (index.project.backendId !== binding.project.backendId || index.project.rootKey !== binding.project.rootKey) fail('REUSE_PROJECT_MISMATCH')
    return { destination, content, index }
  }
  async function userOverrides(binding: Awaited<ReturnType<typeof bind>>, signal: AbortSignal): Promise<Record<string, ReuseOverride>> {
    const source = await target(binding.root, binding.cwd, REUSE_OVERRIDES_PATH, signal)
    const content = await read(source, REUSE_LIMITS.overrideBytes, signal)
    if (!content) return Object.create(null) as Record<string, ReuseOverride>
    const v: unknown = JSON.parse(content.raw)
    if (!object(v) || v.schemaVersion !== 1 || !object(v.entries)
      || Object.keys(v.entries).length > REUSE_LIMITS.entries
      || Object.entries(v.entries).some(([id, o]) => !/^[a-f0-9]{32}$/.test(id) || !validOverride(o))) fail('REUSE_INVALID_OVERRIDES')
    return (v as { entries: Record<string, ReuseOverride> }).entries
  }
  async function query(request: { terms?: readonly string[]; limit?: number }, signal: AbortSignal): Promise<ReuseQueryResult> {
    const terms = request.terms ?? [], limit = request.limit ?? REUSE_LIMITS.results
    if (!Array.isArray(terms) || terms.length > REUSE_LIMITS.terms || !terms.every(text)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > REUSE_LIMITS.results) fail('REUSE_QUERY_INVALID')
    const result: ReuseQueryResult = { status: 'missing', coverage: 'explicit-files', recognitionStatus: 'unverified', checkedFiles: 0, indexedFiles: 0,
      candidateCount: 0, truncated: false, matches: [] }
    const binding = await bind(signal)
    let loaded: Awaited<ReturnType<typeof load>>, overrides: Record<string, ReuseOverride>
    try { loaded = await load(binding, signal); overrides = await userOverrides(binding, signal) }
    catch (error) { checkSignal(signal); return { ...result, status: 'invalid', reason: error instanceof Error ? error.message.slice(0, 256) : 'REUSE_INVALID_INDEX' } }
    if (!loaded.index) return result
    const index = loaded.index
    result.sourceRevision = index.sourceRevision
    result.recognitionStatus = deps.sourceRevision === undefined ? 'unverified' : index.sourceRevision === deps.sourceRevision ? 'current' : 'changed'
    result.status = result.recognitionStatus === 'changed' ? 'stale' : 'available'
    if (result.recognitionStatus === 'changed') result.reason = 'REUSE_RECOGNITION_VERSION_CHANGED'
    result.indexedFiles = index.files.length
    const normalized = [...new Set(terms.map(normalize).filter(Boolean))]
    let bytes = 0
    const matches: ReuseQueryResult['matches'] = []
    for (const file of index.files) {
      checkSignal(signal)
      let freshness: 'current' | 'stale' | 'missing' = 'stale'
      try {
        if (bytes >= REUSE_LIMITS.totalBytes) fail('REUSE_READ_BUDGET')
        const source = await target(binding.root, binding.cwd, file.path, signal)
        const metadata = await fs.stat(source, signal)
        let allowance = Math.min(REUSE_LIMITS.fileBytes, REUSE_LIMITS.totalBytes - bytes)
        if (metadata?.size !== undefined && Number.isSafeInteger(metadata.size) && metadata.size >= 0) allowance = Math.min(allowance, metadata.size)
        // Reserve before attempting I/O: rejected reads and failed decoding/version checks
        // still consume their possible byte budget. Never refund a failed read.
        bytes += allowance
        const content = await read(source, allowance, signal)
        freshness = !content ? 'missing' : digest(content.raw) === file.digest ? 'current' : 'stale'
        result.checkedFiles++
      } catch (error) { checkSignal(signal); result.reason = error instanceof Error ? error.message.slice(0, 256) : 'REUSE_SOURCE_UNVERIFIED' }
      if (freshness !== 'current') result.status = 'stale'
      for (const entry of file.entries) {
        const item = { ...entry, ...index.agentOverrides[entry.id], ...overrides[entry.id] }
        if (item.status === 'excluded') continue
        result.candidateCount++
        const primary = [item.symbol, ...item.aliases].map(normalize)
        const secondary = [item.location, item.kind, item.owner ?? '', ...(item.useWhen ?? []), ...(item.notes ?? [])].map(normalize)
        const score = normalized.reduce((sum, term) => sum + (primary.includes(term) ? 20 : primary.some(p => p.includes(term)) ? 10 : secondary.some(p => p.includes(term)) ? 4 : 0), 0)
        if (score > 0) matches.push({ ...item, freshness, score })
      }
    }
    matches.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    for (const match of matches.slice(0, limit)) {
      if (Buffer.byteLength(JSON.stringify({ ...result, matches: [...result.matches, match] })) > REUSE_LIMITS.outputBytes) break
      result.matches.push(match)
    }
    result.truncated = result.matches.length < matches.length
    return result
  }
  async function maintain(request: { action: 'initialize' | 'rebuild' | 'update'; paths: readonly string[]; adjustments?: readonly ReuseAdjustment[] }, signal: AbortSignal) {
    if (!['initialize', 'rebuild', 'update'].includes(request.action) || !Array.isArray(request.paths)
      || !request.paths.length || request.paths.length > REUSE_LIMITS.paths) fail('REUSE_MAINTENANCE_INVALID')
    const extract = deps.extract, sourceRevision = deps.sourceRevision
    if (!extract || !sourceRevision) fail('REUSE_EXTRACTOR_UNAVAILABLE')
    const action = request.action
    const paths = [...new Set(request.paths.map(relativePath))].sort()
    const adjustments = structuredClone(request.adjustments ?? [])
    if (!Array.isArray(adjustments) || adjustments.length > REUSE_LIMITS.paths
      || adjustments.some(a => !object(a) || !text(a.entryId) || (a.remove !== undefined && typeof a.remove !== 'boolean')
        || (a.remove === true ? a.value !== undefined : !validOverride(a.value)))) fail('REUSE_ADJUSTMENT_INVALID')
    const initialPolicy = deps.policy?.()
    if (!initialPolicy || !['workspace-write', 'danger-full-access'].includes(initialPolicy.mode)) fail('REUSE_WRITE_DENIED')
    const binding = await bind(signal), loaded = await load(binding, signal, action === 'rebuild')
    if (action === 'initialize' && loaded.index) fail('REUSE_BASELINE_EXISTS')
    if (action === 'update' && !loaded.index) fail('REUSE_BASELINE_REQUIRED')
    if (action === 'update' && loaded.index?.sourceRevision !== deps.sourceRevision) fail('REUSE_REBUILD_REQUIRED')
    for (const path of paths) await target(binding.root, binding.cwd, path, signal)
    const plan: ReuseApprovalPlan = Object.freeze({ action, project: Object.freeze({ ...binding.project }),
      root: binding.cwd, destination: fs.processPath(loaded.destination), paths: Object.freeze([...paths]),
      adjustments: Object.freeze(structuredClone(adjustments)), coverage: 'explicit-files',
      ...(loaded.replacingInvalidBaseline ? { replacingInvalidBaseline: Object.freeze({ ...loaded.replacingInvalidBaseline }) } : {}) })
    if (await deps.approve?.(plan, signal) !== 'allowed-once') fail('REUSE_APPROVAL_DENIED')
    checkSignal(signal)
    const rebound = await bind(signal)
    if (rebound.root.targetKey !== binding.root.targetKey) fail('REUSE_PROJECT_CHANGED')
    const current = await target(binding.root, binding.cwd, REUSE_INDEX_PATH, signal)
    if (current.targetKey !== loaded.destination.targetKey) fail('REUSE_DESTINATION_CHANGED')
    const previous = loaded.index
    const files = action === 'update' ? [...previous!.files] : []
    const permittedIds = new Set(previous?.files.filter(f => paths.includes(f.path)).flatMap(f => f.entries.map(e => e.id)) ?? [])
    const observed: Array<{ path: string; targetKey: string; version?: string }> = []
    let bytes = 0
    for (const path of paths) {
      checkSignal(signal)
      const source = await target(binding.root, binding.cwd, path, signal)
      const content = await read(source, Math.min(REUSE_LIMITS.fileBytes, REUSE_LIMITS.totalBytes - bytes), signal)
      const at = files.findIndex(f => f.path === path)
      if (at >= 0) files.splice(at, 1)
      observed.push({ path, targetKey: source.targetKey, version: content?.version })
      if (!content) continue
      bytes += content.bytes
      if (bytes > REUSE_LIMITS.totalBytes) fail('REUSE_READ_BUDGET')
      const drafts = extract!(path, content.raw)
      if (!Array.isArray(drafts) || drafts.length > REUSE_LIMITS.entries || !drafts.every(validDraft)) fail('REUSE_EXTRACTOR_INVALID')
      const entries = drafts.map(d => ({ kind: d.kind, symbol: d.symbol, line: d.line,
        aliases: [...(d.aliases ?? [])], id: entryId(path, d.kind, d.symbol), location: path }))
      for (const entry of entries) permittedIds.add(entry.id)
      files.push({ path, digest: digest(content.raw), entries })
    }
    if (files.length > REUSE_LIMITS.files || files.reduce((n, f) => n + f.entries.length, 0) > REUSE_LIMITS.entries) fail('REUSE_INDEX_BUDGET')
    const ids = new Set(files.flatMap(f => f.entries.map(e => e.id)))
    const agentOverrides: Record<string, ReuseOverride> = Object.fromEntries(Object.entries(previous?.agentOverrides ?? {}).filter(([id]) => ids.has(id)))
    for (const adjustment of adjustments) {
      if (!permittedIds.has(adjustment.entryId)) fail('REUSE_ADJUSTMENT_OUTSIDE_CHANGE')
      if (adjustment.remove) delete agentOverrides[adjustment.entryId]
      else if (ids.has(adjustment.entryId)) agentOverrides[adjustment.entryId] = adjustment.value!
      else fail('REUSE_ADJUSTMENT_ENTRY_MISSING')
    }
    const index: ReuseIndex = { schemaVersion: 1, project: binding.project, sourceRevision: sourceRevision!,
      coverage: 'explicit-files', generatedAt: new Date().toISOString(), files: files.sort((a, b) => a.path.localeCompare(b.path)), agentOverrides }
    const serialized = JSON.stringify(index)
    if (Buffer.byteLength(serialized) > REUSE_LIMITS.indexBytes) fail('REUSE_INDEX_BUDGET')
    parseIndex(serialized)
    // Recheck observed identities/versions before the sole atomic publication.
    for (const item of observed) {
      const source = await target(binding.root, binding.cwd, item.path, signal)
      if (source.targetKey !== item.targetKey || (await fs.stat(source, signal))?.version !== item.version) fail('REUSE_SOURCE_CHANGED')
    }
    const destination = await target(binding.root, binding.cwd, REUSE_INDEX_PATH, signal)
    if (destination.targetKey !== loaded.destination.targetKey) fail('REUSE_DESTINATION_CHANGED')
    const resolvedPolicy = deps.policy?.()
    const policy = resolvedPolicy ? { ...resolvedPolicy } : undefined
    if (!policy || !['workspace-write', 'danger-full-access'].includes(policy.mode) || !text(policy.workspaceRoot)) fail('REUSE_WRITE_DENIED')
    // Defense in depth: a bare fs provider may ignore sandboxPolicy. This module still
    // fences its write to the real session root, even when the caller has broader mode.
    const writeRoot = await fs.resolve(policy.workspaceRoot, { signal })
    if ((await fs.stat(writeRoot, signal))?.type !== 'directory' || !fs.contains(writeRoot, binding.root)
      || !fs.contains(writeRoot, destination)) fail('REUSE_WRITE_ROOT_DENIED')
    checkSignal(signal)
    // No async work may sit between this final live-policy observation and write dispatch.
    const latest = deps.policy?.()
    if (!latest || latest.mode !== policy.mode || latest.workspaceRoot !== policy.workspaceRoot || latest.sessionId !== policy.sessionId) fail('REUSE_POLICY_CHANGED')
    await fs.writeText(destination, serialized, loaded.content ? { kind: 'replaceIfVersion', version: loaded.content.version } : { kind: 'createIfAbsent' }, signal, latest)
    return { status: 'updated' as const, coverage: 'explicit-files' as const, changedFiles: paths.length,
      indexedFiles: files.length, candidateCount: ids.size, destination: fs.processPath(destination) }
  }
  return { query, maintain }
}
