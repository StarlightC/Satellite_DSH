/** Bounded host-shared repository observation. No filesystem writes. */
import { constants } from 'node:fs'
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { deny, literalPath, validateLocalConfig } from './version-control-input.ts'

export const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
export const inside = (root: string, path: string): boolean => path === root || (!relative(root, path).startsWith(`..${sep}`) && relative(root, path) !== '..' && !isAbsolute(relative(root, path)))
export async function noSymlinkAncestors(path: string): Promise<void> {
  const absolute = resolve(path)
  let cursor: string = sep
  for (const part of absolute.split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    if ((await lstat(cursor)).isSymbolicLink()) deny('symlink ancestor')
  }
}
export async function regularBytes(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) deny('special, hardlinked metadata or oversized file')
    // Fixed-size read: concurrent growth cannot turn this into an unbounded allocation.
    const bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    const after = await handle.stat()
    if (offset !== before.size || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) deny('file changed while reading')
    return bytes.subarray(0, offset)
  } finally { await handle.close() }
}
/** Streamed full-content sha256; ordinary hardlinks are data, metadata aliases are refused. */
export async function regularDigest(path: string, metadata = true): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || (metadata && before.nlink !== 1)) deny('special or hardlinked metadata')
    const hash = createHash('sha256'), chunk = Buffer.alloc(Math.min(1024 * 1024, before.size + 1))
    // Read at most size+1 bytes: growth is detected without unbounded reading.
    let offset = 0
    while (offset <= before.size) {
      const read = await handle.read(chunk, 0, Math.min(chunk.length, before.size + 1 - offset), offset)
      if (!read.bytesRead) break
      hash.update(chunk.subarray(0, read.bytesRead))
      offset += read.bytesRead
    }
    const after = await handle.stat()
    if (offset !== before.size || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) deny('file changed while reading')
    return hash.digest('hex')
  } finally { await handle.close() }
}
export interface RepositoryLayout {
  /** 'main': ordinary .git directory (may hold registered linked worktrees); 'linked': root/.git gitfile. */
  kind: 'main' | 'linked'
  worktreeRoot: string
  /** Private per-worktree metadata (HEAD/index). Equals commonDir for 'main'. */
  gitDir: string
  /** Shared metadata (config/objects/refs). */
  commonDir: string
}
export interface RepositoryState {
  root: string
  layout: RepositoryLayout
  identity: string
  lockKey: string
  digest: string
  configDigest: string
  attributesDigest: string
  indexDigest: string | null
  files: Map<string, string>
  fileKinds: Map<string, { mode: number; linkTextBase64?: string }>
  locks: string[]
  metadataStamp: string
}
async function canonicalDirectory(path: string, label: string): Promise<import('node:fs').Stats> {
  if (!isAbsolute(path)) deny(`${label} must be absolute`)
  await noSymlinkAncestors(path)
  if (await realpath(path) !== path) deny(`${label} must be canonical`)
  const st = await lstat(path)
  if (!st.isDirectory() || st.isSymbolicLink()) deny(`${label} must be a directory`)
  return st
}
/** One-line pointer file (gitfile/commondir/gitdir backlink); no other content. */
async function pointer(path: string, prefix: string): Promise<string> {
  // Lossless decode: Buffer#toString would map invalid bytes to U+FFFD while Git uses raw bytes.
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await regularBytes(path, 4096)) } catch (error) {
    if (error instanceof TypeError) deny('worktree pointer file is not valid UTF-8')
    throw error
  }
  const match = new RegExp(`^${prefix}([^\\x00-\\x1f]+)\\n?$`).exec(text)
  if (!match) deny('malformed worktree pointer file')
  return match[1]!
}
/** Validate the exact worktree layout before any Git runs. No filesystem writes. */
export async function resolveLayout(root: string): Promise<{ layout: RepositoryLayout; dot: import('node:fs').Stats; gitStat: import('node:fs').Stats; commonStat: import('node:fs').Stats; gitfile?: string }> {
  const dotPath = join(root, '.git'), dot = await lstat(dotPath)
  if (dot.isDirectory() && !dot.isSymbolicLink()) return { layout: { kind: 'main', worktreeRoot: root, gitDir: dotPath, commonDir: dotPath }, dot, gitStat: dot, commonStat: dot }
  if (!dot.isFile() || dot.isSymbolicLink() || dot.nlink !== 1) deny('ordinary .git directory or linked-worktree gitfile required; no submodules/bare repos')
  // Absolute gitfile only (Git's default for `git worktree add`); relative gitfiles are out of scope.
  const gitDir = await pointer(dotPath, 'gitdir: ')
  if (!isAbsolute(gitDir) || resolve(gitDir) !== gitDir) deny('linked worktree gitfile must name a canonical absolute gitdir')
  const gitStat = await canonicalDirectory(gitDir, 'linked gitdir')
  // Never lexically collapse an unchecked spelling: Git resolves `..` physically after
  // symlinks. Only Git's default `../..` (gitDir is canonical with no symlink ancestors,
  // so its physical grandparent is its lexical one) or a canonical absolute path.
  const rawCommon = await pointer(join(gitDir, 'commondir'), '')
  if (rawCommon !== '../..' && (!isAbsolute(rawCommon) || resolve(rawCommon) !== rawCommon)) deny('commondir must be Git default ../.. or a canonical absolute path')
  const commonDir = rawCommon === '../..' ? dirname(dirname(gitDir)) : rawCommon
  const commonStat = await canonicalDirectory(commonDir, 'common git directory')
  if (dirname(gitDir) !== join(commonDir, 'worktrees')) deny('linked gitdir is not registered under commondir/worktrees')
  if (await pointer(join(gitDir, 'gitdir'), '') !== dotPath) deny('linked worktree backlink does not name this worktree')
  if (inside(root, commonDir) || inside(commonDir, root)) deny('nested worktree/common directory layout unsupported')
  if (basename(commonDir) !== '.git') deny('common directory must be a non-bare .git directory')
  return { layout: { kind: 'linked', worktreeRoot: root, gitDir, commonDir }, dot, gitStat, commonStat, gitfile: gitDir }
}
/** Layout-only queue identity: never scan the worktree or object store. */
export async function repositoryLayout(workspaceRoot: string, repo: string) {
  await noSymlinkAncestors(workspaceRoot)
  if (await realpath(workspaceRoot) !== workspaceRoot) deny('workspace must be canonical')
  const root = resolve(workspaceRoot, repo)
  if (!inside(workspaceRoot, root)) deny('repository outside workspace')
  await noSymlinkAncestors(root)
  if (await realpath(root) !== root) deny('repository path must be canonical')
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory()) deny('repository root must be a directory')
  const resolved = await resolveLayout(root)
  const { layout, gitStat, commonStat } = resolved
  const ids = [rootStat.dev, rootStat.ino, gitStat.dev, gitStat.ino, commonStat.dev, commonStat.ino]
  return { root, ...resolved, identity: JSON.stringify([layout.kind, root, layout.gitDir, layout.commonDir, ...ids]), lockKey: JSON.stringify([commonStat.dev, commonStat.ino]) }
}
async function optionalStat(path: string) {
  try { return await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined }
}
/** Read only HEAD's actual ref chain and index; never enumerate refs or objects. */
async function headRecords(layout: RepositoryLayout): Promise<unknown[]> {
  const records: unknown[] = []
  let path = join(layout.gitDir, 'HEAD')
  const seen = new Set<string>()
  while (true) {
    if (seen.has(path)) deny('cyclic HEAD reference')
    seen.add(path)
    await noSymlinkAncestors(dirname(path))
    const st = await optionalStat(path)
    const bytes = st ? await regularBytes(path, Number.MAX_SAFE_INTEGER) : null
    records.push([path, bytes ? digest(bytes) : null])
    const text = bytes ? new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim() : undefined
    if (!text?.startsWith('ref: ')) break
    const ref = text.slice(5)
    if (!ref.startsWith('refs/') || /[\x00-\x1f\x7f]/.test(ref) || ref.split('/').some(p => !p || p === '.' || p === '..')) deny('unsafe HEAD reference')
    path = join(layout.commonDir, ref)
  }
  return records
}
export async function repositoryReadState(layout: RepositoryLayout): Promise<string> {
  const records = await headRecords(layout)
  // Packed refs can resolve HEAD when its loose ref does not exist.
  const packed = join(layout.commonDir, 'packed-refs')
  records.push(['packed-refs', await optionalStat(packed) ? digest(await regularBytes(packed, Number.MAX_SAFE_INTEGER)) : null])
  const index = join(layout.gitDir, 'index')
  records.push(['index', await optionalStat(index) ? await regularDigest(index) : null])
  return digest(JSON.stringify(records))
}
/** Lightweight startup/final-tail guard, not a content observation or cache. */
export async function repositoryMetadataStamp(workspaceRoot: string, repo: string): Promise<string> {
  const { root, layout, identity } = await repositoryLayout(workspaceRoot, repo)
  const paths = [layout.gitDir, layout.commonDir, join(layout.commonDir, 'info'), join(layout.commonDir, 'objects/info'), join(layout.commonDir, 'objects/pack'), join(layout.commonDir, 'config'), join(layout.gitDir, 'index'), join(layout.gitDir, 'HEAD'), join(layout.commonDir, 'packed-refs'), join(layout.commonDir, 'info/attributes'), join(root, '.gitattributes')]
  if (layout.kind === 'linked') paths.push(join(root, '.git'), join(layout.gitDir, 'commondir'), join(layout.gitDir, 'gitdir'))
  const records: unknown[] = [identity, await headRecords(layout)]
  for (const path of paths) {
    const st = await optionalStat(path)
    records.push([path, st ? [st.dev, st.ino, st.mode, st.nlink, st.size, st.mtimeMs, st.ctimeMs] : null])
  }
  return JSON.stringify(records)
}
/** Exact worktree leaves, including raw symlink bytes; status may tag directory boundaries, never recurse. */
export async function observeTargets(root: string, paths: readonly string[], statusBoundaries = false): Promise<Pick<RepositoryState, 'files' | 'fileKinds' | 'attributesDigest'>> {
  const files = new Map<string, string>(), fileKinds: RepositoryState['fileKinds'] = new Map(), attrs: unknown[] = []
  const directories = new Set<string>([root])
  for (const rel of paths) {
    literalPath(rel)
    const path = join(root, rel)
    try { await noSymlinkAncestors(dirname(path)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const st = await optionalStat(path)
    if (st?.isSymbolicLink()) {
      const link = await readlink(path, { encoding: 'buffer' }), after = await lstat(path)
      if (st.dev !== after.dev || st.ino !== after.ino || st.mtimeMs !== after.mtimeMs || st.ctimeMs !== after.ctimeMs) deny('symlink changed while observing')
      files.set(rel, digest(link)); fileKinds.set(rel, { mode: st.mode, linkTextBase64: link.toString('base64') })
    } else if (st?.isFile()) {
      files.set(rel, await regularDigest(path, false)); fileKinds.set(rel, { mode: st.mode })
    } else if (st?.isDirectory() && statusBoundaries) files.set(rel, 'directory-boundary')
    else if (st) deny('target must be an exact regular file, symlink or tracked deletion')
    else files.set(rel, 'missing')
    let dir = dirname(path)
    while (inside(root, dir)) { directories.add(dir); if (dir === root) break; dir = dirname(dir) }
  }
  for (const dir of [...directories].sort()) {
    const path = join(dir, '.gitattributes'), st = await optionalStat(path)
    if (st?.isSymbolicLink()) attrs.push([path, 'symlink-not-followed'])
    else attrs.push([path, st ? await regularDigest(path, false) : null])
  }
  return { files, fileKinds, attributesDigest: digest(JSON.stringify(attrs)) }
}
export async function observeRepository(workspaceRoot: string, repo: string): Promise<RepositoryState> {
  const queued = await repositoryLayout(workspaceRoot, repo)
  const { root, layout, identity, lockKey } = queued
  const initialStamp = await repositoryMetadataStamp(workspaceRoot, repo)
  const records: unknown[] = [['layout', identity]], locks: string[] = []
  let config = '', indexDigest: string | null = null
  const metadata = async (path: string): Promise<Buffer | undefined> => {
    await noSymlinkAncestors(dirname(path))
    const st = await optionalStat(path)
    if (!st) { records.push([path, null]); return undefined }
    const bytes = await regularBytes(path, Number.MAX_SAFE_INTEGER)
    records.push([path, st.dev, st.ino, st.mode, st.size, st.mtimeMs, st.ctimeMs, digest(bytes)])
    return bytes
  }
  // Only names in directories containing execution/layout controls are enumerated.
  // Object contents, hooks, logs, ignored files and unrelated worktree leaves are never read.
  for (const dir of new Set([layout.gitDir, layout.commonDir, join(layout.commonDir, 'objects/info'), join(layout.commonDir, 'objects/pack'), join(layout.commonDir, 'info')])) {
    const st = await optionalStat(dir)
    if (!st) continue
    if (!st.isDirectory() || st.isSymbolicLink()) deny('special metadata directory')
    await noSymlinkAncestors(dir)
    for (const name of await readdir(dir)) {
      const lower = name.toLowerCase()
      if ((dir === layout.gitDir || dir === layout.commonDir) && (lower === 'config.worktree' || lower.startsWith('sharedindex.') || (layout.kind === 'main' && ['commondir', 'gitdir'].includes(lower)))) deny(`unsupported repository metadata ${name}`)
      if ((dir === join(layout.commonDir, 'objects/info') && ['alternates', 'http-alternates'].includes(lower)) || (dir === join(layout.commonDir, 'objects/pack') && lower.endsWith('.promisor')) || (dir === join(layout.commonDir, 'info') && lower === 'grafts')) deny(`unsupported repository metadata ${name}`)
      if ((dir === layout.gitDir || dir === layout.commonDir) && lower.endsWith('.lock')) locks.push(join(dir, name))
      if ((dir === layout.gitDir || dir === layout.commonDir) && ['config', 'index', 'head'].includes(lower) && name !== (lower === 'head' ? 'HEAD' : lower)) deny('noncanonical reserved metadata alias')
    }
  }
  config = (await metadata(join(layout.commonDir, 'config')))?.toString('utf8') ?? ''
  if (!config) deny('local config required')
  validateLocalConfig(config)
  indexDigest = (await optionalStat(join(layout.gitDir, 'index'))) ? await regularDigest(join(layout.gitDir, 'index')) : null
  const readState = await repositoryReadState(layout)
  records.push(['readState', readState])
  if (layout.kind === 'linked') for (const path of [join(root, '.git'), join(layout.gitDir, 'commondir'), join(layout.gitDir, 'gitdir')]) await metadata(path)
  // Git's info attributes override indexed/worktree sources; global/system sources are disabled.
  const attributes = await metadata(join(layout.commonDir, 'info/attributes'))
  const rootAttributes = join(root, '.gitattributes'), attrStat = await optionalStat(rootAttributes)
  if (attrStat?.isSymbolicLink()) records.push(['root-attributes', 'symlink-not-followed'])
  else records.push(['root-attributes', attrStat ? await regularDigest(rootAttributes, false) : null])
  // HEAD's ref lock (including nested branch names) is the write-relevant ref lock.
  const headText = (await regularBytes(join(layout.gitDir, 'HEAD'), Number.MAX_SAFE_INTEGER)).toString('utf8').trim()
  if (headText.startsWith('ref: ')) {
    const lock = join(layout.commonDir, `${headText.slice(5)}.lock`)
    if (await optionalStat(lock)) locks.push(lock)
  }
  records.push(['locks', locks.sort()])
  const again = await repositoryLayout(workspaceRoot, repo)
  if (again.identity !== identity || JSON.stringify(again.layout) !== JSON.stringify(layout)) deny('worktree layout changed while observing')
  const metadataStamp = await repositoryMetadataStamp(workspaceRoot, repo)
  if (metadataStamp !== initialStamp) deny('metadata changed while observing')
  return { root, layout, identity, lockKey, digest: digest(JSON.stringify(records)), configDigest: digest(config), attributesDigest: digest(attributes ?? ''), indexDigest, files: new Map(), fileKinds: new Map(), locks, metadataStamp }
}
