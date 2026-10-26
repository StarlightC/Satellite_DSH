/** Bounded host-shared repository observation. No filesystem writes. */
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { deny, literalPath, validateAttributes, validateLocalConfig } from './version-control-input.ts'

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
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) deny('special, hardlinked or oversized file')
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
export interface RepositoryState {
  root: string
  identity: string
  lockKey: string
  digest: string
  configDigest: string
  attributesDigest: string
  indexDigest: string | null
  files: Map<string, string>
  locks: string[]
}
export async function observeRepository(workspaceRoot: string, repo: string): Promise<RepositoryState> {
  await noSymlinkAncestors(workspaceRoot)
  if (await realpath(workspaceRoot) !== workspaceRoot) deny('workspace must be canonical')
  const root = resolve(workspaceRoot, repo)
  if (!inside(workspaceRoot, root)) deny('repository outside workspace')
  await noSymlinkAncestors(root)
  if (await realpath(root) !== root) deny('repository path must be canonical')
  const gitdir = join(root, '.git')
  const rootStat = await lstat(root), gitStat = await lstat(gitdir)
  if (!rootStat.isDirectory() || !gitStat.isDirectory() || gitStat.isSymbolicLink()) deny('ordinary .git directory required; no worktrees/submodules/bare repos')
  let entries = 0, bytes = 0
  const records: unknown[] = [], attributes: unknown[] = [], files = new Map<string, string>(), locks: string[] = []
  let config: string | undefined, indexDigest: string | null = null
  const walk = async (directory: string, prefix: string, metadata: boolean): Promise<void> => {
    const before = await lstat(directory)
    if (!before.isDirectory() || before.isSymbolicLink()) deny('special directory')
    const names = (await readdir(directory)).sort()
    for (const name of names) {
      if (++entries > 20_000) deny('repository entry budget exceeded')
      const path = join(directory, name), rel = prefix ? `${prefix}/${name}` : name
      if (!metadata && rel === '.git') { await walk(path, '.git', true); continue }
      const lower = rel.toLowerCase(), lowerName = name.toLowerCase()
      if (metadata && ['.git/config', '.git/index'].includes(lower) && rel !== lower) deny('noncanonical reserved metadata alias')
      if (!metadata && (lowerName === '.git' || lowerName === '.gitmodules')) deny('nested repository/submodule unsupported')
      if (metadata && (['.git/commondir', '.git/gitdir', '.git/shallow', '.git/objects/info/alternates', '.git/objects/info/http-alternates', '.git/info/grafts', '.git/config.worktree', '.git/modules', '.git/worktrees'].includes(lower) || lowerName.endsWith('.promisor') || lowerName.startsWith('sharedindex.'))) deny(`unsupported repository metadata ${rel}`)
      const st = await lstat(path)
      if (st.isDirectory() && !st.isSymbolicLink()) {
        records.push([rel, 'directory', st.dev, st.ino, st.mode])
        await walk(path, rel, metadata)
      } else {
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) deny(`special path ${rel}`)
        bytes += st.size
        if (bytes > 64 * 1024 * 1024) deny('repository byte budget exceeded')
        const content = await regularBytes(path, Math.min(8 * 1024 * 1024, 64 * 1024 * 1024 - bytes + st.size))
        const hash = digest(content)
        records.push([rel, st.dev, st.ino, st.mode, st.size, st.mtimeMs, st.ctimeMs, hash])
        if (!metadata) {
          literalPath(rel)
          files.set(rel, hash)
        }
        if (lower === '.git/config') { config = content.toString('utf8'); validateLocalConfig(config) }
        if (lower === '.git/index') indexDigest = hash
        if ((!metadata && lowerName === '.gitattributes') || lower === '.git/info/attributes') {
          validateAttributes(content.toString('utf8')); attributes.push([rel, hash])
        }
        if (metadata && lowerName.endsWith('.lock')) locks.push(rel)
      }
    }
    const after = await lstat(directory)
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) deny('directory changed while observing')
  }
  await walk(root, '', false)
  if (config === undefined) deny('local config required')
  return { root, identity: JSON.stringify([root, rootStat.dev, rootStat.ino, gitStat.dev, gitStat.ino]), lockKey: JSON.stringify([rootStat.dev, rootStat.ino, gitStat.dev, gitStat.ino]), digest: digest(JSON.stringify(records)), configDigest: digest(config), attributesDigest: digest(JSON.stringify(attributes)), indexDigest, files, locks }
}
