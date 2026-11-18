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
async function resolveLayout(root: string): Promise<{ layout: RepositoryLayout; dot: import('node:fs').Stats; gitStat: import('node:fs').Stats; commonStat: import('node:fs').Stats; gitfile?: string }> {
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
export async function observeRepository(workspaceRoot: string, repo: string): Promise<RepositoryState> {
  await noSymlinkAncestors(workspaceRoot)
  if (await realpath(workspaceRoot) !== workspaceRoot) deny('workspace must be canonical')
  const root = resolve(workspaceRoot, repo)
  if (!inside(workspaceRoot, root)) deny('repository outside workspace')
  await noSymlinkAncestors(root)
  if (await realpath(root) !== root) deny('repository path must be canonical')
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory()) deny('repository root must be a directory')
  const { layout, gitStat, commonStat, gitfile } = await resolveLayout(root)
  // Private metadata is addressed as `.git/...` in both layouts: for a linked worktree
  // its gitdir is `.git/worktrees/<name>` inside the scanned common directory.
  const privatePrefix = layout.kind === 'main' ? '.git' : `.git/worktrees/${basename(layout.gitDir)}`
  const records: unknown[] = [['layout', layout.kind, layout.worktreeRoot, layout.gitDir, layout.commonDir, gitfile ?? null]], attributes: unknown[] = [], files = new Map<string, string>(), fileKinds: RepositoryState['fileKinds'] = new Map(), locks: string[] = []
  let config: string | undefined, indexDigest: string | null = null
  const walk = async (directory: string, prefix: string, metadata: boolean): Promise<void> => {
    const before = await lstat(directory)
    if (!before.isDirectory() || before.isSymbolicLink()) deny('special directory')
    const names = (await readdir(directory)).sort()
    for (const name of names) {
      const path = join(directory, name), rel = prefix ? `${prefix}/${name}` : name
      if (!metadata && rel === '.git') {
        if (layout.kind === 'main') { await walk(path, '.git', true); continue }
        // Linked: the gitfile was validated by resolveLayout; bind its exact bytes/identity.
        const st = await lstat(path)
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) deny('gitfile changed while observing')
        records.push(['.git#gitfile', st.dev, st.ino, st.mode, st.size, st.mtimeMs, st.ctimeMs, digest(await regularBytes(path, 4096))])
        continue
      }
      const lower = rel.toLowerCase(), lowerName = name.toLowerCase()
      const worktreeEntry = /^\.git\/worktrees\/[^/]+\/(.+)$/.exec(lower)?.[1]
      if (metadata && ['.git/config', `${privatePrefix}/index`.toLowerCase()].includes(lower) && rel !== lower && rel !== `${privatePrefix}/index`) deny('noncanonical reserved metadata alias')
      // Nested repository metadata is another domain: do not recurse or follow gitfiles.
      if (!metadata && lowerName === '.git') {
        const st = await lstat(path)
        records.push([rel, 'nested-metadata-not-followed', st.dev, st.ino, st.mode, st.size, st.mtimeMs, st.ctimeMs])
        continue
      }
      if (metadata && (['.git/commondir', '.git/gitdir', '.git/objects/info/alternates', '.git/objects/info/http-alternates', '.git/info/grafts', '.git/config.worktree'].includes(lower) || worktreeEntry === 'config.worktree' || lowerName.endsWith('.promisor') || lowerName.startsWith('sharedindex.'))) deny(`unsupported repository metadata ${rel}`)
      const st = await lstat(path)
      if (metadata && (lower === '.git/modules' || worktreeEntry === 'modules')) {
        if (!st.isDirectory() || st.isSymbolicLink()) deny('submodule metadata must be an ordinary directory')
        records.push([rel, 'submodule-metadata-not-recursed', st.dev, st.ino, st.mode])
        continue
      }
      if (!metadata && st.isSymbolicLink()) {
        // Never open the referent, even for directory links or .gitattributes.
        // Git-gitattributes(5) likewise never follows worktree attribute symlinks.
        const link = await readlink(path, { encoding: 'buffer' }), after = await lstat(path)
        if (st.dev !== after.dev || st.ino !== after.ino || st.mode !== after.mode || st.size !== after.size || st.mtimeMs !== after.mtimeMs || st.ctimeMs !== after.ctimeMs) deny('symlink changed while observing')
        const hash = digest(link)
        literalPath(rel); files.set(rel, hash); fileKinds.set(rel, { mode: st.mode, linkTextBase64: link.toString('base64') })
        records.push([rel, 'symlink', st.dev, st.ino, st.mode, st.size, st.mtimeMs, st.ctimeMs, hash])
        continue
      }
      if (st.isDirectory() && !st.isSymbolicLink()) {
        records.push([rel, 'directory', st.dev, st.ino, st.mode])
        await walk(path, rel, metadata)
      } else {
        if (!st.isFile() || st.isSymbolicLink() || (metadata && st.nlink !== 1)) deny(`special path or hardlinked metadata ${rel}`)
        // Only config needs parsing. Attributes/macros are data: executable filter
        // definitions are controlled in config, for worktree/info/index sources alike.
        const content = lower === '.git/config' ? await regularBytes(path, Number.MAX_SAFE_INTEGER) : undefined
        const hash = content ? digest(content) : await regularDigest(path, metadata)
        records.push([rel, st.dev, st.ino, st.mode, st.size, st.mtimeMs, st.ctimeMs, hash])
        if (!metadata) {
          literalPath(rel)
          files.set(rel, hash); fileKinds.set(rel, { mode: st.mode })
        }
        if (lower === '.git/config') { config = content!.toString('utf8'); validateLocalConfig(config) }
        if (rel === `${privatePrefix}/index`) indexDigest = hash
        if ((!metadata && lowerName === '.gitattributes') || lower === '.git/info/attributes') {
          attributes.push([rel, hash])
        }
        if (metadata && lowerName.endsWith('.lock')) locks.push(rel)
      }
    }
    const after = await lstat(directory)
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) deny('directory changed while observing')
  }
  // Worktree domain, then (linked only) the common directory, which contains the private gitdir.
  // Both domains are scanned in full; nothing is skipped.
  await walk(root, '', false)
  if (layout.kind === 'linked') {
    await walk(layout.commonDir, '.git', true)
    // Layout must still hold after the bounded scan (pointer/backlink swaps are rejected).
    const again = await resolveLayout(root)
    if (JSON.stringify(again.layout) !== JSON.stringify(layout) || again.gitStat.ino !== gitStat.ino || again.commonStat.ino !== commonStat.ino) deny('worktree layout changed while observing')
  }
  if (config === undefined) deny('local config required')
  const ids = [rootStat.dev, rootStat.ino, gitStat.dev, gitStat.ino, commonStat.dev, commonStat.ino]
  return { root, layout, identity: JSON.stringify([layout.kind, root, layout.gitDir, layout.commonDir, ...ids]), lockKey: JSON.stringify([commonStat.dev, commonStat.ino]), digest: digest(JSON.stringify(records)), configDigest: digest(config), attributesDigest: digest(JSON.stringify(attributes)), indexDigest, files, fileKinds, locks }
}
