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
  if (path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) deny('outside path or reserved Git metadata')
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
    if (!Array.isArray(v.paths) || !v.paths.length) deny('paths must contain at least one file')
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
    if (!Number.isSafeInteger(v.count) || (v.count as number) < 1) deny('log count must be a positive safe integer')
    return { action, repo, count: v.count as number }
  }
  const expectedSnapshot = text(v.expectedSnapshot, 'expectedSnapshot', 128)
  if (action === 'stage') return { action, repo, paths: paths(), expectedSnapshot }
  return { action: 'commit', repo, message: text(v.message, 'commit message', 4096), expectedSnapshot }
}

/** Git's integer parser is strtoimax(value, &end, 0) plus an optional k/m/g
 * unit, so 0, 00, +0, -0, 0x0 and 0k are the same zero. Any other value is
 * either non-zero or rejected by Git itself. */
function isGitIntegerZero(value: string): boolean {
  const parsed = /^[ \t]*[+-]?(?:0[xX]([0-9a-fA-F]+)|([0-9]+))[kKmMgG]?$/.exec(value)
  return parsed !== null && /^0+$/.test(parsed[1] ?? parsed[2]!)
}

/** Parse locally, before Git startup can read includes or redirected metadata.
 * Git-config(1) syntax: comments, quoted fragments, escapes, continuations,
 * implicit booleans, deprecated dotted subsections and repeated keys.
 * Unknown keys are NOT an execution protocol. Restrictions below name reachable
 * execution/path entries not already neutralised by the kernel's fixed argv/env.
 */
export function validateLocalConfig(source: string): void {
  if (source.includes('\0')) deny('NUL in local config')
  let section = '', subsection: string | undefined
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.trimStart()
    if (!line || /^[#;]/.test(line)) continue
    if (line.startsWith('[')) {
      const header = /^\[([A-Za-z0-9.-]+)(?:[ \t]+"((?:[^"\\]|\\.)*)")?\]/.exec(line)
      if (!header) deny('invalid config section syntax')
      const dot = header[1]!.indexOf('.')
      section = (dot < 0 ? header[1]! : header[1]!.slice(0, dot)).toLowerCase()
      subsection = header[2] !== undefined ? header[2].replace(/\\(.)/g, '$1') : dot < 0 ? undefined : header[1]!.slice(dot + 1).toLowerCase()
      line = line.slice(header[0].length).trimStart()
      if (!line || /^[#;]/.test(line)) continue
    }
    const entry = /^([A-Za-z][A-Za-z0-9-]*)([ \t]*(?:=([\s\S]*)|[#;].*)?)$/.exec(line)
    if (!section || !entry) deny('invalid config entry syntax')
    const key = entry[1]!.toLowerCase()
    let value = '', pending = '', quoted = false
    line = entry[3] ?? ''
    for (let j = 0; j < line.length; j++) {
      const c = line[j]!
      if (c === '\\') {
        if (j === line.length - 1 && i + 1 < lines.length) { line += '\n' + lines[++i]!; j++; continue }
        const escape = line[++j], decoded: Record<string, string> = { n: '\n', t: '\t', b: '\b', '"': '"', '\\': '\\' }
        if (escape === undefined || !Object.hasOwn(decoded, escape)) deny('invalid config escape')
        value += pending + decoded[escape]; pending = ''
      } else if (c === '"') { value += pending; pending = ''; quoted = !quoted }
      else if (!quoted && (c === '#' || c === ';')) break
      else if (!quoted && /[ \t]/.test(c)) { if (value) pending += c }
      else { value += pending + c; pending = '' }
    }
    if (quoted) deny('unterminated config quote')
    const name = `${section}.${key}`, implicit = entry[3] === undefined
    const falseValue = !implicit && (/^(?:false|no|off|\+?0+[kmg]?)$/i.test(value) || value === '')
    // add/status/diff may run clean/process filters, including via indexed attrs
    // or macros. Deny executable definitions, not inert attributes/driver names.
    if (section === 'filter' && subsection !== undefined && ['clean', 'process'].includes(key) && value) deny(`executable filter config ${name}`)
    if (((section === 'include' && subsection === undefined) || (section === 'includeif' && subsection !== undefined)) && key === 'path') deny('config includes are outside the observed config boundary')
    if (section === 'core' && subsection === undefined && key === 'worktree') deny('core.worktree redirects the observed worktree')
    if (section === 'core' && subsection === undefined && key === 'bare' && !falseValue) deny('bare repository unsupported')
    if (section === 'core' && subsection === undefined && key === 'repositoryformatversion' && !isGitIntegerZero(value)) deny('unsupported repository format')
    if (section === 'extensions' && subsection === undefined && ['worktreeconfig', 'objectformat', 'refstorage', 'partialclone'].includes(key)) deny(`unsupported repository layout ${name}`)
    if (section === 'remote' && subsection !== undefined && key === 'promisor' && !falseValue) deny('partial-clone lazy object source unsupported')
    // core.hooksPath/fsmonitor/attributesFile, pager, signing and diff drivers
    // are accepted: fixed -c/command options disable their execution entrances.
  }
}
