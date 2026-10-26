/** Closed, literal-only Git request grammar. This is not a shell command filter. */
export type GitRequest =
  | { action: 'status'; repo: string }
  | { action: 'diff'; repo: string; target: 'working' | 'staged'; paths?: string[] }
  | { action: 'log'; repo: string; count: number }
  | { action: 'stage'; repo: string; paths: string[]; expectedSnapshot: string }
  | { action: 'commit'; repo: string; message: string; expectedSnapshot: string }

export function deny(message: string): never { throw new Error(`LOCAL_GIT: ${message}`) }
export function text(value: unknown, name: string, max = 1024): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x1f\x7f]/.test(value)) deny(`invalid ${name}`)
  return value
}
export function literalPath(value: unknown): string {
  const path = text(value, 'literal file path')
  if (path.includes('\\') || /[:*?\[\]]/.test(path) || path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) deny('non-literal or outside path')
  return path
}
export function parseGitRequest(value: unknown): GitRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) deny('request must be a plain record')
  const v = value as Record<string, unknown>
  const action = text(v.action, 'action')
  const keys: Record<string, string[]> = {
    status: ['action', 'repo'], diff: ['action', 'repo', 'target', 'paths'], log: ['action', 'repo', 'count'],
    stage: ['action', 'repo', 'paths', 'expectedSnapshot'], commit: ['action', 'repo', 'message', 'expectedSnapshot'],
  }
  if (!Object.hasOwn(keys, action) || Reflect.ownKeys(v).some(k => typeof k !== 'string' || !keys[action]!.includes(k))) deny('unknown action or key')
  const repo = v.repo === '.' ? '.' : literalPath(v.repo)
  const paths = (): string[] => {
    if (!Array.isArray(v.paths) || !v.paths.length || v.paths.length > 100) deny('paths must contain 1–100 files')
    const result = v.paths.map(literalPath)
    if (new Set(result).size !== result.length) deny('duplicate paths')
    return result
  }
  if (action === 'status') return { action, repo }
  if (action === 'diff') {
    if (v.target !== 'working' && v.target !== 'staged') deny('invalid diff target')
    return { action, repo, target: v.target, ...(v.paths === undefined ? {} : { paths: paths() }) }
  }
  if (action === 'log') {
    if (!Number.isInteger(v.count) || (v.count as number) < 1 || (v.count as number) > 50) deny('log count must be 1–50')
    return { action, repo, count: v.count as number }
  }
  const expectedSnapshot = text(v.expectedSnapshot, 'expectedSnapshot', 128)
  if (action === 'stage') return { action, repo, paths: paths(), expectedSnapshot }
  return { action: 'commit', repo, message: text(v.message, 'commit message', 4096), expectedSnapshot }
}

/** Deliberately small config language. Unknown/escaped/continued constructs fail closed.
 * It is parsed BEFORE Git reads local config; this parser never follows includes.
 * Remote URLs/refspecs are inert data: no action here invokes a remote.
 */
export function validateLocalConfig(source: string): void {
  let section = ''
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || /^[#;]/.test(line)) continue
    const header = /^\[([a-zA-Z][a-zA-Z0-9-]*)(?: "([^"\\\x00-\x1f]*)")?\]$/.exec(line)
    if (header) {
      section = header[1]!.toLowerCase()
      if (!['core', 'user', 'remote', 'branch', 'init', 'lfs'].includes(section)) deny(`unsupported config section ${section}`)
      if (['remote', 'branch'].includes(section) !== (header[2] !== undefined)) deny('invalid config subsection')
      continue
    }
    const entry = /^([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*([^\\\x00-\x1f]*)$/.exec(line)
    if (!entry) deny('unsupported config syntax')
    const key = entry[1]!.toLowerCase(), val = entry[2]!.trim()
    const allowed: Record<string, string[]> = {
      core: ['repositoryformatversion', 'bare', 'filemode', 'logallrefupdates', 'ignorecase', 'precomposeunicode', 'symlinks', 'autocrlf', 'safecrlf', 'quotepath'],
      user: ['name', 'email'], remote: ['url', 'pushurl', 'fetch', 'tagopt'], branch: ['remote', 'merge', 'rebase'], init: ['defaultbranch'],
      // Pure repository-format metadata only. No LFS filters/drivers or execution.
      lfs: ['repositoryformatversion'],
    }
    if (!allowed[section]?.includes(key)) deny(`unsupported config ${section}.${key}`)
    if (section === 'lfs' && val !== '0') deny('unsupported lfs repository format')
    if (section === 'core') {
      if (key === 'repositoryformatversion' ? val !== '0' : key === 'bare' ? val !== 'false' : !['true', 'false', 'input'].includes(val)) deny(`unsupported core value ${key}`)
    }
  }
}

export function validateAttributes(source: string): void {
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    if (parts.length < 2 || parts[0]!.startsWith('[attr]') || !parts.slice(1).every(a => ['text', '-text', '!text', 'binary', 'eol=lf', 'eol=crlf', 'diff', '-diff'].includes(a))) deny('unsupported attributes (filters/macros/drivers forbidden)')
  }
}
