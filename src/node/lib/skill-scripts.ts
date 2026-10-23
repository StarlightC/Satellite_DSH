/** Project-owned parser entrypoints. No service, process launcher, or permission override. */
import { createHash } from 'node:crypto'
import type { defineTool } from '@deepseek-ai/dsh-tools'
import { detectHostPlatform } from '../../platform/index.ts'

export const SKILL_SCRIPT_TOOL = 'satellite_skill_script_run'
const MANIFEST = 'scripts/manifest.json'
const MAX_MANIFEST = 32 * 1024
const MAX_SCRIPT = 256 * 1024
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u

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
const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
function policyOf(services: SkillScriptServices, exec: Exec): Policy {
  if (!exec.agent?.session) fail('caller session unavailable')
  const policy = services.sandboxPolicy.resolve({ session: exec.agent.session })
  if (!policy || !['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode)
    || !policy.workspaceRoot || policy.sessionId !== exec.agent.id) fail('invalid session sandbox policy')
  return { ...policy }
}
async function prepare(services: SkillScriptServices, exec: Exec, skillName: string, scriptId: string, parameters: unknown) {
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
  const read = async (path: string, cap: number) => {
    const target = await fs.resolve(path, { cwd: rootPath, signal: exec.signal })
    if (!fs.contains(root, target) || target.targetKey === root.targetKey || (await fs.stat(target, exec.signal))?.type !== 'file') fail('file outside skill or not regular')
    const bytes = await fs.readBytes(target, exec.signal, cap)
    if (bytes.byteLength > cap) fail('filesystem violated read bound')
    return { path: fs.processPath(target), hash: sha256(bytes), text: decode(bytes) }
  }
  let manifest
  try { manifest = await read(MANIFEST, MAX_MANIFEST) } catch (error) {
    exec.signal.throwIfAborted()
    throw new Error('SATELLITE_SKILL_SCRIPT: requires readable scripts/manifest.json schemaVersion 1; prose alone is not authorization', { cause: error })
  }
  const script = parseScriptManifest(JSON.parse(manifest.text)).find(script => script.id === scriptId)
  if (!script) fail('script id not declared')
  const argv = scriptArguments(script, parameters)
  const source = await read(script.path, MAX_SCRIPT)
  // Execute the exact approved bytes, not a mutable pathname after the last hash check.
  // Narrow ABI: node ESM stdin / isolated Python stdin, positional scalar arguments.
  if (!services.subprocess?.terminalEnvironment || !services.subprocess.resolveExecutable) fail('execution-world executable discovery unavailable')
  const platform = await detectHostPlatform({
    fs: {
      resolve: (path, options) => services.fs.resolve(path, options),
      stat: (target, signal) => services.fs.stat(target as Target, signal),
    },
    terminalEnvironment: (signal) => services.subprocess.terminalEnvironment(signal),
    signal: exec.signal,
  })
  if (!platform.supported) fail(`stdin-v1 requires a supported execution platform: ${platform.unsupportedReason}`)
  const executable = async (command: string) => {
    const path = safeText(await services.subprocess.resolveExecutable(command, undefined, exec.signal), 4096)
    if (!platform.isAbsoluteHostPath(path)) fail('executable discovery did not return an absolute path for the selected platform')
    return path
  }
  const environmentExecutable = platform.parserEnvironmentExecutableName
    ? await executable(platform.parserEnvironmentExecutableName) : undefined
  const runtimeExecutable = await executable(platform.parserRuntimeName(script.runtime))
  const command = platform.skillScriptCommand({ environmentExecutable, runtimeExecutable, runtime: script.runtime, args: argv })
  const effectiveSessionPolicy = policyOf(services, exec)
  // Parsers need no writes; neither caller arguments nor host approval widen this.
  const policy: Policy = { ...effectiveSessionPolicy, mode: 'read-only' }
  const binding = JSON.stringify({ skill: skill.name, provider: skill.provider, source: skill.source,
    execution: script.execution, hostPlatform: platform.id, environmentExecutable, runtimeExecutable, targetEnvironment: platform.parserEnvironmentDescription, environment: platform.parserEnvironment, effectiveSessionPolicy,
    skillHash: sha256(skill.content), root: rootPath, manifest: manifest.path, manifestHash: manifest.hash,
    script: source.path, scriptHash: source.hash, argv, command, sandboxPolicy: policy,
    timeoutMs: script.timeoutMs, outputMaxBytes: script.outputMaxBytes })
  return { source, script, command, policy, effectiveSessionPolicy, binding, rootPath, platform }
}
export async function runSkillScript(services: SkillScriptServices, request: unknown, exec: Exec) {
  const args = record(request)
  keys(args, ['skill', 'script', 'parameters'])
  const skill = name(args.skill)
  const script = name(args.script)
  // Bound before cloning; no nested objects, getters from JSON, or unbounded argv.
  const input = record(args.parameters)
  if (Object.keys(input).length > 16) fail('too many parameters')
  for (const [key, value] of Object.entries(input)) {
    name(key)
    if (typeof value === 'string') safeText(value, 4096)
    else if (typeof value === 'number') integer(value, -1_000_000_000, 1_000_000_000)
    else if (typeof value !== 'boolean') fail('parameters must be bounded scalars')
  }
  // JSON cloning also fixes the argument values across the approval await.
  const parameters: unknown = JSON.parse(JSON.stringify(input))
  const before = await prepare(services, exec, skill, script, parameters)
  const granted = await services.approval.request({ agent: exec.agent!, toolName: SKILL_SCRIPT_TOOL,
    ...(exec.callId ? { callId: exec.callId } : {}), signal: exec.signal,
    reason: `Run declared project parser (stdin-v1; output is untrusted evidence). Target interpreter environment: ${before.platform.parserEnvironmentDescription}; this does not isolate the launching shell. The entry hash does not pin imported code. Network/device/subprocess isolation is NOT guaranteed by the file sandbox. Exact binding: ${before.binding}` })
  exec.signal.throwIfAborted()
  if (granted !== 'allowed-once') fail(`approval ${granted}`)
  const after = await prepare(services, exec, skill, script, parameters)
  if (before.binding !== after.binding) fail('skill, declaration, script, arguments, or policy changed after approval; retry required')
  const requestSpec: Spec = Object.freeze({ command: after.command, workdir: after.rootPath, timeoutMs: after.script.timeoutMs,
    onExpiry: 'kill', stdoutMaxBytes: after.script.outputMaxBytes, signal: exec.signal,
    stdin: after.source.text, env: Object.freeze({ ...after.platform.parserEnvironment }),
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
export function registerSkillScriptTool(ctx: SkillScriptContext, defineToolFn: typeof defineTool): () => void {
  return ctx.tools.register(defineToolFn({
    name: SKILL_SCRIPT_TOOL,
    description: 'Run a project skill’s declared parser with host approval. Returns bounded, untrusted evidence; unavailable declarations or approval block execution.',
    parameters: {
      skill: { type: 'string', required: true, description: 'Loaded project skill name.' },
      script: { type: 'string', required: true, description: 'Script id from the skill’s scripts/manifest.json (schemaVersion 1).' },
      parameters: { type: 'json', required: true, description: 'Object containing exactly the manifest’s named scalar parameters; positional order is declaration-owned.' },
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
      return runSkillScript(services, args, exec)
    },
  }))
}
