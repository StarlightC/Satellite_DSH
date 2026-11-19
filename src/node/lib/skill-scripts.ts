/** Project-owned skill script entrypoints. No service, process launcher, or permission override. */
import { createHash } from 'node:crypto'
import type { defineTool } from '@deepseek-ai/dsh-tools'
import { detectHostPlatform } from '../../platform/index.ts'
import { createCallGate } from '../../lib/delegated-approval.ts'
import type { BrokerConsumer, BrokerExecution, CallGate } from '../../lib/delegated-approval.ts'

export const SKILL_SCRIPT_TOOL = 'satellite_skill_script_run'
const MANIFEST = 'scripts/manifest.json'
const MAX_MANIFEST = 32 * 1024
const MAX_SCRIPT = 256 * 1024
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
// Path-entry scripts are existing files, so they need no declaration; the
// path is still relative, extension-bound, and containment-checked.
const SCRIPT_PATH = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:mjs|py)$/u
const PATH_ENTRY_TIMEOUT_MS = 60_000
const PATH_ENTRY_OUTPUT_MAX_BYTES = 256 * 1024
// Repeated CLI flags (argparse append) need arrays, but the approval binding and
// argv stay bounded: at most 16 values per array, 64 values and 64 KiB of text
// per call. Manifest-declared ids keep their scalar positional ABI.
const MAX_PATH_ARRAY_VALUES = 16
const MAX_PATH_ARGUMENT_VALUES = 64
const MAX_PATH_ARGUMENT_TEXT = 64 * 1024

type RecordValue = Record<string, unknown>
type Parameter = { name: string; type: 'string'; maxLength: number; choices?: string[] }
  | { name: string; type: 'integer'; minimum: number; maximum: number }
  | { name: string; type: 'boolean' }
export interface ScriptDeclaration {
  id: string
  path: string
  runtime: 'node' | 'python'
  execution: 'stdin-v1'
  parameters: Parameter[]
  timeoutMs: number
  outputMaxBytes: number
}
/** Existing skill file run in place; no manifest and no script rewrite. */
export interface PathScriptDeclaration {
  path: string
  runtime: 'node' | 'python'
  execution: 'path-v1'
  timeoutMs: number
  outputMaxBytes: number
}
type ScriptEntry = ScriptDeclaration | PathScriptDeclaration
interface Target { targetKey: string; displayPath: string }
interface Policy { mode: 'read-only' | 'workspace-write' | 'danger-full-access'; workspaceRoot: string; sessionId?: string }
interface Skill {
  name: string; source: string; provider: string; content: string
  invocation: { modelInvocable: boolean }
  resourceBase?: { kind: string; path?: string }
}
interface Exec { agent?: { id: string; session?: unknown }; signal: AbortSignal; callId?: string }
interface Spec {
  command: string; workdir: string; timeoutMs: number; onExpiry: 'kill'; stdoutMaxBytes: number
  signal: AbortSignal; stdin: string; env: Record<string, string>; sandboxPolicy: Policy
}
interface RunResult {
  exitCode: number | null; signal: string | null; timedOut: boolean; aborted: boolean; timeoutMs: number
  stdout: { text: string; truncated: boolean }; stderr: { text: string; truncated: boolean }
  sandbox?: { mode: string; denied: boolean; enforcement?: string; runnerFailed?: boolean }
}
/** Structural slices of the inspected DSH contracts; services remain their original receivers. */
export interface SkillScriptServices {
  skills: { get(name: string, options: { scope: object; cwd: string; signal: AbortSignal }): Promise<Skill | undefined> }
  workingDirectory: { ensure(agent: object, signal: AbortSignal): Promise<string | undefined> }
  fs: {
    processPathFromHostPath(path: string): string | undefined
    resolve(path: string, options: { cwd?: string; signal: AbortSignal }): Promise<Target>
    contains(parent: Target, child: Target): boolean
    processPath(target: Target): string
    stat(target: Target, signal: AbortSignal): Promise<{ type: string } | undefined>
    readBytes(target: Target, signal: AbortSignal, maxBytes: number): Promise<Uint8Array>
  }
  sandboxPolicy: { resolve(request: { session: unknown }): Policy }
  approval: { request(request: { agent: object; toolName: string; callId?: string; reason: string; signal: AbortSignal }): Promise<string> }
  subprocess: {
    terminalEnvironment(signal: AbortSignal): Promise<{ platform: 'posix' | 'windows' }>
    resolveExecutable(command: string, env: Readonly<Record<string, string>> | undefined, signal: AbortSignal): Promise<string>
  }
  shell: {
    /** Native ShellExecutor capability: undefined means this backend does not confine. */
    readonly sandboxMode?: Policy['mode']
    resolve(request: Spec): Spec
    execute(spec: Spec): Promise<{ result(): Promise<RunResult>; kill(): boolean; done: Promise<void> }>
  }
}
export interface SkillScriptContext {
  get(name: string): unknown
  tools: { register(tool: ReturnType<typeof defineTool>): () => void }
}
function fail(message: string): never { throw new Error(`SATELLITE_SKILL_SCRIPT: ${message}`) }
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected object')
  return value as RecordValue
}
function keys(value: RecordValue, allowed: string[], required = allowed): void {
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    fail('unknown or missing field')
  }
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail('invalid bounded integer')
  return value
}
function name(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || !NAME.test(value)) fail('invalid name')
  return value
}
function safeText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail('invalid bounded text')
  return value
}
/** Strict machine declaration; prose references are deliberately not argument authorization. */
export function parseScriptManifest(value: unknown): ScriptDeclaration[] {
  const root = record(value)
  keys(root, ['schemaVersion', 'scripts'])
  if (root.schemaVersion !== 1 || !Array.isArray(root.scripts) || !root.scripts.length || root.scripts.length > 16) fail('invalid manifest version/scripts')
  const ids = new Set<string>()
  return root.scripts.map(raw => {
    const item = record(raw)
    keys(item, ['id', 'path', 'runtime', 'execution', 'parameters', 'timeoutMs', 'outputMaxBytes'])
    if (item.execution !== 'stdin-v1') fail('execution must explicitly declare stdin-v1; migrate path-entry scripts')
    const id = name(item.id)
    if (ids.has(id)) fail('duplicate script id')
    ids.add(id)
    const path = safeText(item.path, 240)
    if (!/^scripts\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:mjs|py)$/u.test(path)) fail('invalid script path')
    if (item.runtime !== 'node' && item.runtime !== 'python') fail('invalid runtime')
    if (!path.endsWith(item.runtime === 'node' ? '.mjs' : '.py')) fail('runtime/extension mismatch')
    if (!Array.isArray(item.parameters) || item.parameters.length > 16) fail('invalid parameters')
    const names = new Set<string>()
    const parameters: Parameter[] = item.parameters.map(rawParameter => {
      const p = record(rawParameter)
      const paramName = name(p.name)
      if (names.has(paramName)) fail('duplicate parameter')
      names.add(paramName)
      if (p.type === 'boolean') {
        keys(p, ['name', 'type'])
        return { name: paramName, type: 'boolean' }
      }
      if (p.type === 'integer') {
        keys(p, ['name', 'type', 'minimum', 'maximum'])
        const minimum = integer(p.minimum, -1_000_000_000, 1_000_000_000)
        return { name: paramName, type: 'integer', minimum, maximum: integer(p.maximum, minimum, 1_000_000_000) }
      }
      if (p.type === 'string') {
        keys(p, ['name', 'type', 'maxLength', 'choices'], ['name', 'type', 'maxLength'])
        const maxLength = integer(p.maxLength, 1, 4096)
        if (p.choices !== undefined && (!Array.isArray(p.choices) || !p.choices.length || p.choices.length > 64)) fail('invalid choices')
        const choices = p.choices === undefined ? undefined : (p.choices as unknown[]).map(v => safeText(v, maxLength))
        if (choices && new Set(choices).size !== choices.length) fail('duplicate choice')
        return { name: paramName, type: 'string', maxLength, ...(choices ? { choices } : {}) }
      }
      return fail('unknown parameter type')
    })
    return { id, path, runtime: item.runtime, execution: 'stdin-v1', parameters,
      timeoutMs: integer(item.timeoutMs, 100, 60_000), outputMaxBytes: integer(item.outputMaxBytes, 1, 256 * 1024) }
  })
}
export function scriptArguments(script: ScriptDeclaration, value: unknown): string[] {
  const input = record(value)
  keys(input, script.parameters.map(p => p.name))
  return script.parameters.map(p => {
    const value = input[p.name]
    if (p.type === 'integer') return String(integer(value, p.minimum, p.maximum))
    if (p.type === 'boolean') {
      if (typeof value !== 'boolean') fail('expected boolean')
      return String(value)
    }
    const text = safeText(value, p.maxLength)
    if (p.choices && !p.choices.includes(text)) fail('value outside choices')
    return text
  })
}
/** A declared id (manifest lookup) or an existing skill-relative script path. */
export function scriptReference(value: unknown): string {
  if (typeof value !== 'string' || value.length > 240 || /[\u0000-\u001f\u007f]/u.test(value)) fail('invalid script reference')
  if (!NAME.test(value) && !SCRIPT_PATH.test(value)) fail('script must be a declared id or a skill-relative .mjs/.py path')
  return value
}
interface PathArgumentBudget { values: number; bytes: number }
function pathArrayValue(value: unknown, budget: PathArgumentBudget): string {
  if (typeof value === 'string') {
    const text = safeText(value, 4096)
    budget.bytes += Buffer.byteLength(text, 'utf8')
    if (budget.bytes > MAX_PATH_ARGUMENT_TEXT) fail('path array text exceeds the 64 KiB bound')
    return text
  }
  if (typeof value === 'number') return String(integer(value, -1_000_000_000, 1_000_000_000))
  return fail('path array values must be bounded strings or integers; boolean flags are top-level only')
}
function pathArgument(key: string, value: unknown, budget: PathArgumentBudget): string[] {
  if (Array.isArray(value)) {
    if (!value.length || value.length > MAX_PATH_ARRAY_VALUES) fail('path array parameter must contain 1-16 values')
    budget.values += value.length
    if (budget.values > MAX_PATH_ARGUMENT_VALUES) fail('path array values exceed the 64-value bound')
    return value.flatMap(item => [`--${key}`, pathArrayValue(item, budget)])
  }
  if (value === false) return []
  if (value === true) return [`--${key}`]
  if (typeof value === 'string') return [`--${key}`, safeText(value, 4096)]
  return [`--${key}`, String(integer(value, -1_000_000_000, 1_000_000_000))]
}
/** Path-entry parameters are the script's ordinary CLI flags, not a positional ABI. */
export function pathArguments(value: RecordValue): string[] {
  const budget: PathArgumentBudget = { values: 0, bytes: 0 }
  return Object.keys(value).sort().flatMap(key => pathArgument(key, value[key], budget))
}
const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
function policyOf(services: SkillScriptServices, exec: Exec): Policy {
  if (!exec.agent?.session) fail('caller session unavailable')
  const policy = services.sandboxPolicy.resolve({ session: exec.agent.session })
  if (!policy || !['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode)
    || !policy.workspaceRoot || policy.sessionId !== exec.agent.id) fail('invalid session sandbox policy')
  return { ...policy }
}
async function prepare(services: SkillScriptServices, exec: Exec, skillName: string, scriptRef: string, parametersInput: unknown) {
  exec.signal.throwIfAborted()
  // ShellExecutor.sandboxMode is the native capability flag; bare bash-local is undefined.
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(services.shell?.sandboxMode ?? '')) fail('confining shell backend unavailable')
  if (!exec.agent) fail('caller agent unavailable')
  const cwd = await services.workingDirectory.ensure(exec.agent, exec.signal)
  if (!cwd) fail('working directory unavailable')
  const skill = await services.skills.get(skillName, { scope: exec.agent, cwd, signal: exec.signal })
  if (!skill || skill.name !== skillName || !skill.invocation.modelInvocable
    || !['project-dsh', 'project-agents'].includes(skill.source)) fail('winning skill is not a model-invocable project skill')
  if (skill.resourceBase?.kind !== 'directory' || !skill.resourceBase.path) fail('skill has no directory resource base')
  const fs = services.fs
  const mapped = fs.processPathFromHostPath(skill.resourceBase.path)
  if (!mapped) fail('skill source unavailable in execution world')
  const root = await fs.resolve(mapped, { signal: exec.signal })
  if ((await fs.stat(root, exec.signal))?.type !== 'directory') fail('skill root is not a directory')
  const rootPath = fs.processPath(root)
  const readBytes = async (path: string, cap: number) => {
    const target = await fs.resolve(path, { cwd: rootPath, signal: exec.signal })
    if (!fs.contains(root, target) || target.targetKey === root.targetKey || (await fs.stat(target, exec.signal))?.type !== 'file') fail('file outside skill or not regular')
    const bytes = await fs.readBytes(target, exec.signal, cap)
    if (bytes.byteLength > cap) fail('filesystem violated read bound')
    return { path: safeText(fs.processPath(target), 4096), hash: sha256(bytes), bytes }
  }
  const readText = async (path: string, cap: number) => {
    const entry = await readBytes(path, cap)
    return { ...entry, text: decode(entry.bytes) }
  }
  const parameters = record(parametersInput)
  let manifest: { path: string; hash: string; text: string } | undefined
  let script: ScriptEntry
  let argv: string[]
  let source: { path: string; hash: string; text?: string }
  if (SCRIPT_PATH.test(scriptRef)) {
    // Existing script: run the approved file in place. No manifest and no stdin source.
    const entry = await readBytes(scriptRef, MAX_SCRIPT)
    script = { path: entry.path, runtime: scriptRef.endsWith('.py') ? 'python' : 'node',
      execution: 'path-v1', timeoutMs: PATH_ENTRY_TIMEOUT_MS, outputMaxBytes: PATH_ENTRY_OUTPUT_MAX_BYTES }
    argv = pathArguments(parameters)
    source = { path: entry.path, hash: entry.hash }
  } else {
    // Declared id: the strict manifest remains the only authorization for stdin-v1.
    try { manifest = await readText(MANIFEST, MAX_MANIFEST) } catch (error) {
      exec.signal.throwIfAborted()
      throw new Error('SATELLITE_SKILL_SCRIPT: script id requires a readable scripts/manifest.json schemaVersion 1; pass an existing script\'s skill-relative path (for example scripts/parse.py) to run it in place; prose alone is not authorization', { cause: error })
    }
    const declared = parseScriptManifest(JSON.parse(manifest.text)).find(candidate => candidate.id === scriptRef)
    if (!declared) fail('script id not declared; pass a skill-relative script path to run an existing script in place')
    script = declared
    argv = scriptArguments(declared, parameters)
    const entry = await readText(declared.path, MAX_SCRIPT)
    source = { path: entry.path, hash: entry.hash, text: entry.text }
  }
  // stdin-v1 executes the approved bytes; path-v1 re-opens the approved canonical
  // path so relative imports, __file__, and argv keep their ordinary meaning.
  // Both modes hash the entry before and after approval.
  if (!services.subprocess?.terminalEnvironment || !services.subprocess.resolveExecutable) fail('execution-world executable discovery unavailable')
  const platform = await detectHostPlatform({
    fs: {
      resolve: (path, options) => services.fs.resolve(path, options),
      stat: (target, signal) => services.fs.stat(target as Target, signal),
    },
    terminalEnvironment: (signal) => services.subprocess.terminalEnvironment(signal),
    signal: exec.signal,
  })
  if (!platform.supported) fail(`${script.execution} requires a supported execution platform: ${platform.unsupportedReason}`)
  if (script.execution === 'path-v1' && !platform.isAbsoluteHostPath(script.path)) fail('script path is not absolute in the execution world')
  const executable = async (command: string) => {
    const path = safeText(await services.subprocess.resolveExecutable(command, undefined, exec.signal), 4096)
    if (!platform.isAbsoluteHostPath(path)) fail('executable discovery did not return an absolute path for the selected platform')
    return path
  }
  const environmentExecutable = platform.parserEnvironmentExecutableName
    ? await executable(platform.parserEnvironmentExecutableName) : undefined
  const runtimeExecutable = await executable(platform.parserRuntimeName(script.runtime))
  const command = platform.skillScriptCommand({ environmentExecutable, runtimeExecutable, runtime: script.runtime, args: argv,
    ...(script.execution === 'path-v1' ? { entryPath: script.path } : {}) })
  const effectiveSessionPolicy = policyOf(services, exec)
  // Scripts need no writes; neither caller arguments nor host approval widen this.
  const policy: Policy = { ...effectiveSessionPolicy, mode: 'read-only' }
  const binding = JSON.stringify({ skill: skill.name, provider: skill.provider, source: skill.source,
    execution: script.execution, hostPlatform: platform.id, environmentExecutable, runtimeExecutable, targetEnvironment: platform.parserEnvironmentDescription, environment: platform.parserEnvironment, effectiveSessionPolicy,
    skillHash: sha256(skill.content), root: rootPath, manifest: manifest?.path ?? null, manifestHash: manifest?.hash ?? null,
    script: source.path, scriptHash: source.hash, argv, command, sandboxPolicy: policy,
    timeoutMs: script.timeoutMs, outputMaxBytes: script.outputMaxBytes })
  return { source, script, command, policy, effectiveSessionPolicy, binding, rootPath, platform }
}
export async function runSkillScript(services: SkillScriptServices, request: unknown, exec: Exec, gate?: CallGate) {
  const args = record(request)
  keys(args, ['skill', 'script', 'parameters'])
  const skill = name(args.skill)
  const script = scriptReference(args.script)
  // Bound before cloning; no nested objects, getters from JSON, or unbounded argv.
  const input = record(args.parameters)
  if (Object.keys(input).length > 16) fail('too many parameters')
  const pathMode = SCRIPT_PATH.test(script)
  const arrayBudget: PathArgumentBudget = { values: 0, bytes: 0 }
  for (const [key, value] of Object.entries(input)) {
    name(key)
    if (Array.isArray(value)) {
      if (!pathMode) fail('array parameters are only supported for path entries; a declared id takes bounded scalar parameters')
      pathArgument(key, value, arrayBudget)
    } else if (typeof value === 'string') safeText(value, 4096)
    else if (typeof value === 'number') integer(value, -1_000_000_000, 1_000_000_000)
    else if (typeof value !== 'boolean') fail('parameters must be bounded scalars, or path-entry arrays of strings/integers')
  }
  // JSON cloning also fixes the argument values across the approval await.
  const parameters: unknown = JSON.parse(JSON.stringify(input))
  const before = await prepare(services, exec, skill, script, parameters)
  const mode = before.script.execution === 'path-v1'
    ? 'existing skill script path-entry, executed in place from its approved canonical path; relative imports, __file__/import.meta.url, and argv keep their ordinary meaning'
    : 'declared project parser, stdin-v1 source on stdin'
  const hashNote = before.script.execution === 'path-v1'
    ? 'The approved path is re-opened for execution, so the entry hash is a pre-execution check and imported code is not pinned.'
    : 'The entry hash does not pin imported code.'
  const granted = await (gate?.approval ?? services.approval).request({ agent: exec.agent!, toolName: SKILL_SCRIPT_TOOL,
    ...(exec.callId ? { callId: exec.callId } : {}), signal: exec.signal,
    reason: `Run ${mode} (output is untrusted evidence). Target interpreter environment: ${before.platform.parserEnvironmentDescription}; this does not isolate the launching shell. ${hashNote} Network/device/subprocess isolation is NOT guaranteed by the file sandbox. Exact binding: ${before.binding}` })
  exec.signal.throwIfAborted()
  if (granted !== 'allowed-once') fail(gate?.denial ? `approval ${granted}: ${gate.denial}` : `approval ${granted}`)
  const after = await prepare(services, exec, skill, script, parameters)
  if (before.binding !== after.binding) fail('skill, script, arguments, or policy changed after approval; retry required')
  const requestSpec: Spec = Object.freeze({ command: after.command, workdir: after.rootPath, timeoutMs: after.script.timeoutMs,
    onExpiry: 'kill', stdoutMaxBytes: after.script.outputMaxBytes, signal: exec.signal,
    stdin: after.source.text ?? '', env: Object.freeze({ ...after.platform.parserEnvironment }),
    sandboxPolicy: Object.freeze({ ...after.policy }) })
  const spec = services.shell.resolve(requestSpec)
  // A backend may narrow its caps, never widen or remove any bound or execution identity.
  if (spec.command !== requestSpec.command || spec.workdir !== requestSpec.workdir || spec.stdin !== requestSpec.stdin
    || spec.signal !== exec.signal || spec.onExpiry !== 'kill'
    || !Number.isInteger(spec.timeoutMs) || spec.timeoutMs < 1 || spec.timeoutMs > requestSpec.timeoutMs
    || !Number.isInteger(spec.stdoutMaxBytes) || spec.stdoutMaxBytes < 1 || spec.stdoutMaxBytes > requestSpec.stdoutMaxBytes
    || JSON.stringify(spec.sandboxPolicy) !== JSON.stringify(requestSpec.sandboxPolicy)
    || JSON.stringify(spec.env) !== JSON.stringify(requestSpec.env)) fail('shell resolution changed approved execution or limits')
  exec.signal.throwIfAborted()
  // resolve is synchronous but provider code can change session policy; bind the final
  // execution boundary to the approved identity/root/mode, not merely fixed read-only.
  if (JSON.stringify(policyOf(services, exec)) !== JSON.stringify(after.effectiveSessionPolicy)) {
    fail('effective session policy changed before execution; retry required')
  }
  const execution = await services.shell.execute(spec)
  try {
    const result = await execution.result()
    // Native output collection has a cap; independently cap returned text and omit spill paths.
    const bounded = (output: { text: string; truncated: boolean }) => {
      const bytes = Buffer.from(output.text)
      let text = bytes.subarray(0, spec.stdoutMaxBytes).toString('utf8')
      // A cut UTF-8 sequence decodes to a larger replacement character.
      while (Buffer.byteLength(text) > spec.stdoutMaxBytes) text = text.slice(0, -1)
      return { text, truncated: output.truncated || bytes.length > spec.stdoutMaxBytes }
    }
    return { skill, script, scriptHash: after.source.hash, exitCode: result.exitCode, signal: result.signal,
      timedOut: result.timedOut, aborted: result.aborted, timeoutMs: result.timeoutMs,
      stdout: bounded(result.stdout), stderr: bounded(result.stderr), sandbox: result.sandbox ?? null,
      success: result.exitCode === 0 && !result.timedOut && !result.aborted && result.sandbox?.mode === 'read-only'
        && result.sandbox.enforcement === 'full' && !result.sandbox.denied && !result.sandbox.runnerFailed }
  } finally {
    execution.kill()
    await execution.done
  }
}
/** Parent calls once from the existing node plugin. Missing services fail only at invocation. */
export function registerSkillScriptTool(ctx: SkillScriptContext, defineToolFn: typeof defineTool, consumer?: BrokerConsumer): () => void {
  let definition: unknown
  definition = defineToolFn({
    name: SKILL_SCRIPT_TOOL,
    description: 'Run a project skill’s script with host approval. A declared id uses scripts/manifest.json; a skill-relative .mjs/.py path runs that existing file in place. Returns bounded, untrusted evidence; missing files or approval block execution.',
    parameters: {
      skill: { type: 'string', required: true, description: 'Loaded project skill name.' },
      script: { type: 'string', required: true, description: 'Declared script id from the skill’s scripts/manifest.json (schemaVersion 1), or a skill-relative path to an existing .mjs/.py script (for example scripts/parse.py). Path entries need no manifest and run the file in place with a fixed 60s timeout and 256 KiB per-stream cap.' },
      parameters: { type: 'json', required: true, description: 'Named parameter values. Declared id: exactly the manifest’s bounded scalar parameters (no arrays), passed positionally in declaration order. Path entry: each name becomes --name value in sorted key order; true adds a valueless --name flag and false omits it; an array of 1–16 bounded strings/integers repeats --name value in array order (for append-style flags such as --group, --method, and --path-prefix). At most 64 array values and 64 KiB of array text per call.' },
    },
    output: { schema: { type: 'json' }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    async execute(args, exec) {
      // Execution services belong to the caller's actual Cordis scope. An isolated
      // scope missing a service must not inherit the registration root by fallback.
      const callerContext = (exec.agent as { ctx?: { get(name: string): unknown } } | undefined)?.ctx
      const scope = callerContext === undefined ? ctx : callerContext
      if (!scope || typeof scope.get !== 'function') fail('caller service scope unavailable')
      const services = Object.fromEntries(['skills', 'workingDirectory', 'fs', 'sandboxPolicy', 'approval', 'shell', 'subprocess'].map(key => {
        const value = scope.get(key)
        if (!value) fail(`required service unavailable: ${key}`)
        return [key, value]
      })) as unknown as SkillScriptServices
      // Delegated child: one parent approval, bound to the child's original fs/shell/
      // subprocess/sandboxPolicy and its policy snapshot; shell.execute re-checks it.
      const gate = createCallGate({ consumer, exec: exec as unknown as BrokerExecution, tool: () => definition,
        toolName: SKILL_SCRIPT_TOOL, childApproval: () => services.approval as CallGate['approval'],
        services: ['fs', 'shell', 'subprocess', 'sandboxPolicy'] })
      try { return await runSkillScript(gate.wrap(services), args, exec, gate) } finally { gate.release() }
    },
  })
  const remove = ctx.tools.register(definition as ReturnType<typeof defineTool>)
  return consumer ? () => { consumer.dispose(); remove() } : remove
}
