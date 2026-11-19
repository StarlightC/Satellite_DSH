import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { readFile } from 'node:fs/promises'
import { parseScriptManifest, pathArguments, runSkillScript, scriptArguments, registerSkillScriptTool, SKILL_SCRIPT_TOOL } from '../src/node/lib/skill-scripts.ts'
import { createDelegatedApprovalBroker } from '../src/lib/delegated-approval.ts'

const declaration = () => ({ id: 'extract', path: 'scripts/extract.mjs', runtime: 'node', execution: 'stdin-v1',
  parameters: [{ name: 'format', type: 'string', maxLength: 20, choices: ['summary', 'full'] },
    { name: 'count', type: 'integer', minimum: 1, maximum: 10 }, { name: 'compact', type: 'boolean' }],
  timeoutMs: 1000, outputMaxBytes: 100 })
const manifest = script => ({ schemaVersion: 1, scripts: [script ?? declaration()] })
const request = () => ({ skill: 'project-parser', script: 'extract', parameters: { compact: true, count: 2, format: 'summary' } })
function fixture() {
  const state = { approvals: [], specs: [], lookup: [], kills: 0, done: 0, reads: [],
    source: 'console.log(process.argv.slice(2))', manifest: manifest(),
    skill: { name: 'project-parser', source: 'project-agents', provider: 'filesystem', content: 'Use declared parser.',
      invocation: { modelInvocable: true }, resourceBase: { kind: 'directory', path: '/host/project/skill' } },
    policy: { mode: 'workspace-write', workspaceRoot: '/project', sessionId: 'caller' },
    outcome: 'allowed-once', result: { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000,
      stdout: { text: 'evidence', truncated: false }, stderr: { text: '', truncated: false },
      sandbox: { mode: 'read-only', denied: false, enforcement: 'full' } } }
  const controller = new AbortController()
  const exec = { agent: { id: 'caller', session: {} }, signal: controller.signal, callId: 'call-1' }
  const services = {
    workingDirectory: { async ensure() { return '/project' } },
    skills: { async get(name, options) { state.lookup.push({ name, options }); return state.skill } },
    fs: {
      processPathFromHostPath(path) { assert.equal(path, '/host/project/skill'); return '/project/skill' },
      async resolve(path, options) { const p = path.startsWith('/') ? path : `${options.cwd}/${path}`; return { targetKey: p, displayPath: p } },
      contains(parent, child) { return child.targetKey.startsWith(`${parent.targetKey}/`) },
      processPath(target) { return target.targetKey },
      async stat(target) {
        if (target.targetKey === '/project/skill') return { type: 'directory' }
        // 显式构造 Apple 宿主：SystemVersion.plist 与 sw_vers 是文件；Linux 标记缺失。
        if (target.targetKey === '/etc/os-release' || target.targetKey === '/proc/version') return undefined
        return { type: 'file' }
      },
      async readBytes(target, signal, cap) {
        assert.equal(signal, exec.signal)
        state.reads.push({ target, cap })
        return Buffer.from(target.targetKey.endsWith('manifest.json') ? JSON.stringify(state.manifest) : state.source)
      },
    },
    sandboxPolicy: { resolve({ session }) { assert.equal(session, exec.agent.session); return state.policy } },
    approval: { async request(req) { state.approvals.push(req); await state.onApproval?.(); return state.outcome } },
    subprocess: {
      async terminalEnvironment() { return { platform: 'posix' } },
      async resolveExecutable(command) { return `/trusted/bin/${command}` },
    },
    shell: {
      sandboxMode: 'read-only',
      resolve(spec) { return state.resolve ? state.resolve(spec) : spec },
      async execute(spec) { state.specs.push(spec); return { result: async () => state.result, kill() { state.kills++; return true },
        get done() { state.done++; return Promise.resolve() } } },
    },
  }
  return { state, services, exec, controller, run: (req = request()) => runSkillScript(services, req, exec) }
}

test('manifest strictness and fixed positional parameters', () => {
  const [script] = parseScriptManifest(manifest())
  assert.deepEqual(scriptArguments(script, request().parameters), ['summary', '2', 'true'])
  assert.throws(() => scriptArguments(script, { ...request().parameters, command: 'bad' }), /unknown/)
  assert.throws(() => scriptArguments(script, { ...request().parameters, count: 11 }), /integer/)
  assert.throws(() => scriptArguments(script, { ...request().parameters, compact: 'true' }), /boolean/)
  assert.throws(() => scriptArguments(script, { ...request().parameters, format: 'other' }), /choices/)
})
for (const [label, mutate] of [
  ['unknown version', m => { m.schemaVersion = 2 }],
  ['root unknown', m => { m.env = {} }],
  ['command field', m => { m.scripts[0].command = 'echo arbitrary' }],
  ['old path execution', m => { delete m.scripts[0].execution }],
  ['unknown execution', m => { m.scripts[0].execution = 'path' }],
  ['traversal', m => { m.scripts[0].path = 'scripts/../outside.mjs' }],
  ['absolute path', m => { m.scripts[0].path = '/scripts/script.mjs' }],
  ['backslash', m => { m.scripts[0].path = 'scripts\\script.mjs' }],
  ['runtime mismatch', m => { m.scripts[0].runtime = 'python' }],
  ['unknown runtime', m => { m.scripts[0].runtime = 'bash' }],
  ['duplicate script', m => { m.scripts.push(m.scripts[0]) }],
  ['duplicate parameter', m => { m.scripts[0].parameters.push(m.scripts[0].parameters[0]) }],
  ['unbounded timeout', m => { m.scripts[0].timeoutMs = 60001 }],
  ['unbounded output', m => { m.scripts[0].outputMaxBytes = 262145 }],
  ['parameter unknown', m => { m.scripts[0].parameters[0].pattern = '.*' }],
]) test(`rejects ${label}`, () => { const m = manifest(); mutate(m); assert.throws(() => parseScriptManifest(m)) })

test('winning scoped project skill, approval binding, native shell bounds and exact bytes', async () => {
  const f = fixture()
  const result = await f.run()
  assert.equal(result.success, true)
  assert.equal(f.state.lookup.length, 2)
  assert.equal(f.state.lookup[0].options.scope, f.exec.agent)
  assert.equal(f.state.lookup[0].options.cwd, '/project')
  assert.equal(f.state.lookup[0].options.signal, f.exec.signal)
  const approval = f.state.approvals[0]
  assert.equal(approval.agent, f.exec.agent)
  assert.equal(approval.callId, 'call-1')
  assert.match(approval.reason, /scriptHash/)
  assert.match(approval.reason, /manifestHash/)
  assert.match(approval.reason, /Network\/device/)
  const spec = f.state.specs[0]
  assert.equal(spec.stdin, f.state.source)
  assert.equal(spec.signal, f.exec.signal)
  assert.equal(spec.onExpiry, 'kill')
  assert.equal(spec.timeoutMs, 1000)
  assert.equal(spec.stdoutMaxBytes, 100)
  assert.equal(spec.sandboxPolicy.mode, 'read-only')
  assert.equal(f.state.kills, 1)
  assert.equal(f.state.done, 1)
})
for (const outcome of ['rejected', 'cancelled', 'unavailable', 'allowed']) test(`approval ${outcome} never executes`, async () => {
  const f = fixture(); f.state.outcome = outcome
  await assert.rejects(f.run(), /approval/)
  assert.equal(f.state.specs.length, 0)
})
for (const [label, change] of [
  ['script', f => { f.state.source += '\n// changed' }],
  ['manifest', f => { f.state.manifest.scripts[0].timeoutMs = 2000 }],
  ['skill content', f => { f.state.skill.content = 'changed' }],
  ['winner', f => { f.state.skill.provider = 'another-provider' }],
  ['policy root', f => { f.state.policy.workspaceRoot = '/another' }],
  ['policy mode', f => { f.state.policy.mode = 'read-only' }],
  ['interpreter', f => { f.services.subprocess.resolveExecutable = async command => `/changed/${command}` }],
]) test(`rechecks ${label} after approval`, async () => {
  const f = fixture(); f.state.onApproval = () => change(f)
  await assert.rejects(f.run(), /changed after approval/)
  assert.equal(f.state.specs.length, 0)
})
test('cancellation during approval prevents execution', async () => {
  const f = fixture(); f.state.onApproval = () => f.controller.abort()
  await assert.rejects(f.run(), { name: 'AbortError' }); assert.equal(f.state.specs.length, 0)
})
for (const target of ['windows', 'linux', 'unknown', 'denied']) {
  const changePlatform = f => {
    if (target === 'windows') { f.services.subprocess.terminalEnvironment = async () => ({ platform: 'windows' }); return }
    const stat = f.services.fs.stat
    f.services.fs.stat = async object => {
      const path = object.targetKey
      if (path === '/System/Library/CoreServices/SystemVersion.plist' || path === '/usr/bin/sw_vers') return undefined
      if (path === '/etc/os-release') {
        if (target === 'denied') throw Object.assign(new Error('denied'), { code: 'EACCES' })
        return target === 'linux' ? { type: 'file' } : undefined
      }
      return stat(object)
    }
  }
  test(`host platform ${target} before approval blocks without requesting execution`, async () => {
    const f = fixture(); changePlatform(f)
    await assert.rejects(f.run(), /supported execution platform/)
    assert.equal(f.state.approvals.length, 0)
    assert.equal(f.state.specs.length, 0)
  })
  test(`host platform change to ${target} during approval blocks execution`, async () => {
    const f = fixture(); f.state.onApproval = () => changePlatform(f)
    await assert.rejects(f.run(), /supported execution platform/)
    assert.equal(f.state.approvals.length, 1)
    assert.equal(f.state.specs.length, 0)
  })
}
for (const source of ['runtime', 'user-agents', 'bundled', 'custom']) test(`does not execute nonproject ${source}`, async () => {
  const f = fixture(); f.state.skill.source = source
  await assert.rejects(f.run(), /project skill/); assert.equal(f.state.approvals.length, 0)
})
test('non-model invocable winner does not fall back', async () => {
  const f = fixture(); f.state.skill.invocation.modelInvocable = false
  await assert.rejects(f.run(), /model-invocable/)
})
test('unmapped host source fails before reading', async () => {
  const f = fixture(); f.services.fs.processPathFromHostPath = () => undefined
  await assert.rejects(f.run(), /execution world/); assert.equal(f.state.reads.length, 0)
})
test('canonical symlink escape fails before approval', async () => {
  const f = fixture(); f.services.fs.contains = () => false
  await assert.rejects(f.run(), /manifest/); assert.equal(f.state.approvals.length, 0)
})
test('prose-only declaration cannot authorize script', async () => {
  const f = fixture(); f.services.fs.readBytes = async () => { throw new Error('missing') }
  await assert.rejects(f.run(), /prose alone/)
})
test('native read cap contract enforced independently', async () => {
  const f = fixture(); f.services.fs.readBytes = async () => new Uint8Array(32769)
  await assert.rejects(f.run(), /manifest/)
})
test('shell cannot remove timeout, cancellation, or policy', async () => {
  for (const patch of [{ onExpiry: 'none' }, { signal: undefined }, { sandboxPolicy: undefined }, { timeoutMs: 60001 }, { stdoutMaxBytes: Infinity }]) {
    const f = fixture(); f.state.resolve = spec => ({ ...spec, ...patch })
    await assert.rejects(f.run(), /resolution changed/); assert.equal(f.state.specs.length, 0)
  }
})
test('shell cannot mutate the approved request to defeat comparison', async () => {
  const f = fixture(); f.state.resolve = spec => { spec.timeoutMs = 60001; return spec }
  await assert.rejects(f.run()); assert.equal(f.state.specs.length, 0)
})
test('bounded output and failed execution stay evidence, not success', async () => {
  const f = fixture(); f.state.result.stdout.text = 'a'.repeat(500); f.state.result.timedOut = true
  const result = await f.run()
  assert.equal(result.success, false); assert.equal(result.stdout.truncated, true)
  assert.equal(Buffer.byteLength(result.stdout.text), 100); assert.equal(f.state.done, 1)
})
test('missing enforcement evidence cannot be accepted', async () => {
  const f = fixture(); delete f.state.result.sandbox
  assert.equal((await f.run()).success, false)
})
test('target environment is empty even for noncredential-shaped host PASSPHRASE', { skip: process.platform === 'win32' }, async () => {
  // OS argv/stdin ABI probe only. This does not stand in for DSH sandbox verification.
  const f = fixture()
  f.state.source = 'console.log(JSON.stringify({ marker: process.env.SATELLITE_TEST_PASSPHRASE ?? null, env: Object.keys(process.env), args: process.argv.slice(2) }))'
  f.state.manifest.scripts[0].outputMaxBytes = 1000
  f.services.subprocess.resolveExecutable = async command => command === 'env' ? '/usr/bin/env' : process.execPath
  let observed
  f.services.shell.execute = async spec => {
    observed = JSON.parse(execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', spec.command], {
      input: spec.stdin, encoding: 'utf8', cwd: process.cwd(), timeout: 5000,
      env: { ...process.env, SATELLITE_TEST_PASSPHRASE: 'synthetic-secret-not-forwarded' },
    }))
    return { result: async () => f.state.result, kill: () => true, done: Promise.resolve() }
  }
  await f.run()
  assert.equal(observed.marker, null)
  // macOS may synthesize this locale entry after env -i; it is not inherited credentials.
  assert.ok(observed.env.every(key => process.platform === 'darwin' && key === '__CF_USER_TEXT_ENCODING'))
  assert.deepEqual(observed.args, ['summary', '2', 'true'])
})
for (const [label, mutate] of [
  ['unconfined shell backend', f => { delete f.services.shell.sandboxMode }],
  ['missing executable discovery', f => { delete f.services.subprocess.resolveExecutable }],
  ['Windows backend', f => { f.services.subprocess.terminalEnvironment = async () => ({ platform: 'windows' }) }],
  ['failed executable lookup', f => { f.services.subprocess.resolveExecutable = async () => { throw new Error('missing executable') } }],
  ['relative executable', f => { f.services.subprocess.resolveExecutable = async () => 'node' }],
]) test(`${label} fails before approval and execution`, async () => {
  const f = fixture(); mutate(f)
  await assert.rejects(f.run()); assert.equal(f.state.approvals.length, 0); assert.equal(f.state.specs.length, 0)
})
test('UTF-8 output caps never grow through replacement decoding', async () => {
  const f = fixture(); f.state.result.stdout.text = '字'.repeat(100)
  const result = await f.run(); assert.ok(Buffer.byteLength(result.stdout.text) <= 100)
})
test('shell quoting preserves arbitrary scalar text as one argument', async () => {
  const f = fixture(); delete f.state.manifest.scripts[0].parameters[0].choices
  const args = request(); args.parameters.format = "x'; echo INJECTED; '"
  await f.run(args)
  assert.ok(f.state.specs[0].command.includes("'\\''"))
})
test('Python uses isolated stdin ABI, not file execution', async () => {
  const f = fixture(); Object.assign(f.state.manifest.scripts[0], { runtime: 'python', path: 'scripts/extract.py' })
  await f.run(); assert.match(f.state.specs[0].command, /'python3'|'\/trusted\/bin\/python3'/)
  assert.match(f.state.specs[0].command, /'-I' '-'/)
})
test('deferred parser contract is shipped and discoverable without loading full protocol', async () => {
  const base = new URL('../node/skills/satellite-investigation/', import.meta.url)
  const skill = await readFile(new URL('SKILL.md', base), 'utf8')
  const detail = await readFile(new URL('references/project-parsers.md', base), 'utf8')
  assert.match(skill, /\(references\/project-parsers\.md\)/)
  assert.match(skill, /satellite_reuse_query/)
  assert.match(detail, /stdin-v1/)
  assert.match(detail, /schemaVersion/)
  assert.match(detail, /sys\.argv\[1:\]/)
  assert.ok(!skill.includes('outputMaxBytes'))
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.files.includes('node/skills'))
})
class ServiceScope {
  constructor(services) { this.services = services; this.lookups = [] }
  get(key) { this.lookups.push(key); return this.services[key] }
}
function registered(root) {
  let tool
  const scope = new ServiceScope(root)
  scope.tools = { register(value) { tool = value; return () => {} } }
  registerSkillScriptTool(scope, value => value)
  return { tool, scope }
}
test('registered parser uses caller class scope and scoped fs/shell receivers, never root', async () => {
  const root = fixture(); const caller = fixture()
  class ReceiverFs {
    constructor(inner) { this.inner = inner; this.reads = 0 }
    processPathFromHostPath(...args) { return this.inner.processPathFromHostPath(...args) }
    resolve(...args) { return this.inner.resolve(...args) }
    contains(...args) { return this.inner.contains(...args) }
    processPath(...args) { return this.inner.processPath(...args) }
    stat(...args) { return this.inner.stat(...args) }
    readBytes(...args) { this.reads++; return this.inner.readBytes(...args) }
  }
  class ReceiverShell {
    constructor(inner) { this.inner = inner; this.executions = 0 }
    get sandboxMode() { return this.inner.sandboxMode }
    resolve(spec) { return this.inner.resolve(spec) }
    execute(spec) { this.executions++; return this.inner.execute(spec) }
  }
  caller.services.fs = new ReceiverFs(caller.services.fs)
  caller.services.shell = new ReceiverShell(caller.services.shell)
  caller.state.source = '// isolated source, not root'
  caller.exec.agent.ctx = new ServiceScope(caller.services)
  const { tool, scope } = registered(root.services)
  const result = await tool.execute(request(), caller.exec)
  assert.equal(result.success, true)
  assert.equal(scope.lookups.length, 0)
  assert.equal(root.state.approvals.length, 0)
  assert.equal(root.state.reads.length, 0)
  assert.equal(root.state.specs.length, 0)
  assert.equal(caller.services.fs.reads, 4)
  assert.equal(caller.services.shell.executions, 1)
  assert.equal(caller.state.specs[0].stdin, '// isolated source, not root')
})
for (const missing of ['fs', 'shell', 'approval', 'sandboxPolicy', 'skills', 'workingDirectory', 'subprocess']) {
  test(`isolated caller missing ${missing} does not fall back to root`, async () => {
    const root = fixture(); const caller = fixture(); delete caller.services[missing]
    caller.exec.agent.ctx = new ServiceScope(caller.services)
    const { tool, scope } = registered(root.services)
    await assert.rejects(tool.execute(request(), caller.exec), new RegExp(`service unavailable: ${missing}`))
    assert.equal(scope.lookups.length, 0)
    assert.equal(root.state.specs.length, 0)
    assert.equal(caller.state.specs.length, 0)
  })
}
test('root class scope remains compatible only when caller has no context', async () => {
  const f = fixture(); const { tool, scope } = registered(f.services)
  assert.equal((await tool.execute(request(), f.exec)).success, true)
  assert.equal(scope.lookups.length, 7)
})
test('malformed caller context cannot use root fallback', async () => {
  const f = fixture(); f.exec.agent.ctx = null
  const { tool, scope } = registered(f.services)
  await assert.rejects(tool.execute(request(), f.exec), /caller service scope/)
  assert.equal(scope.lookups.length, 0)
})
for (const [key, value] of [['mode', 'read-only'], ['workspaceRoot', '/changed-root'], ['sessionId', 'changed-session']]) {
  test(`policy ${key} changed synchronously by shell.resolve blocks final execute`, async () => {
    const f = fixture()
    f.state.resolve = spec => { f.state.policy[key] = value; return spec }
    await assert.rejects(f.run(), /policy/)
    assert.equal(f.state.approvals.length, 1)
    assert.equal(f.state.specs.length, 0)
  })
}
test('registration does not require execution services until called', async () => {
  let tool
  const dispose = () => {}
  assert.equal(registerSkillScriptTool({ tools: { register(value) { tool = value; return dispose } }, get() {} }, x => x), dispose)
  await assert.rejects(tool.execute(request(), fixture().exec), /service unavailable/)
})

/**
 * Cross-layer contract: the registered tool owns an internal delegated broker.
 * The caller here is a role child (approval pinned to never) whose exact parent
 * would answer a real host approval; the tool must not consult the child's own
 * approval and must not need `satellite_parent_request`.
 */
function delegatedRegistration(child, options = {}) {
  const parentAsked = []
  const parentApproval = {
    policy: options.parentPolicy ?? 'ask',
    config: { policy: 'ask' },
    overrideOf() { return this.policy },
    async request(approvalRequest) { parentAsked.push(approvalRequest); return options.answer ?? 'allowed-once' },
  }
  const parent = { id: 'root', session: { id: 'root-session' }, ctx: new ServiceScope({ approval: parentApproval }) }
  child.exec.agent.ctx = new ServiceScope(child.services)
  const scope = new ServiceScope(child.services)
  let tool
  scope.tools = { register(value) { tool = value; return () => {} } }
  const broker = createDelegatedApprovalBroker()
  const remove = registerSkillScriptTool(scope, value => value, broker.consumer())
  const nodeCall = new AbortController()
  const unbind = broker.issuer.bind({
    child: child.exec.agent, childSession: child.exec.agent.session,
    parent, parentSession: parent.session, runId: 'run-1', parentCallId: 'parent-call-1',
    signal: nodeCall.signal, live: () => true,
    toolOf: (name) => name === SKILL_SCRIPT_TOOL ? tool : undefined,
  })
  return {
    child, parent, parentAsked, tool, unbind, nodeCall, remove,
    run: () => tool.execute(request(), child.exec),
  }
}

test('delegated skill script: read-only child asks the exact parent once and runs once, without its own never approval', async () => {
  const f = fixture()
  f.state.policy.mode = 'read-only'
  const d = delegatedRegistration(f)
  try {
    const result = await d.run()
    assert.equal(result.success, true)
    assert.equal(d.parentAsked.length, 1)
    assert.equal(d.parentAsked[0].agent, d.parent, 'asked of the exact parent object')
    assert.equal(d.parentAsked[0].callId, 'parent-call-1', 'tagged with the parent satellite_node call')
    assert.match(d.parentAsked[0].reason, /Delegated child approval/)
    assert.match(d.parentAsked[0].reason, /child call call-1/)
    assert.equal(f.state.approvals.length, 0, 'the child pinned never is never consulted')
    assert.equal(f.state.specs.length, 1)
    assert.equal(f.state.specs[0].sandboxPolicy.mode, 'read-only')
  } finally {
    d.unbind()
    d.remove()
  }
})

for (const [label, options, pattern, asks] of [
  ['rejected', { answer: 'rejected' }, /approval rejected: parent user rejected/, 1],
  ['cancelled', { answer: 'cancelled' }, /approval cancelled: parent approval cancelled/, 1],
  ['unavailable', { answer: 'unavailable' }, /approval unavailable: no parent approval answerer available/, 1],
  ['parent never', { parentPolicy: 'never' }, /approval unavailable: .*never.*nothing ran/, 0],
]) test(`delegated skill script ${label}: zero execution, no child-policy fallback`, async () => {
  const f = fixture()
  f.state.policy.mode = 'read-only'
  const d = delegatedRegistration(f, options)
  try {
    await assert.rejects(d.run(), pattern)
    assert.equal(f.state.specs.length, 0, 'the native shell never received a spec')
    assert.equal(f.state.approvals.length, 0, 'the child never was not asked')
    assert.equal(d.parentAsked.length, asks)
  } finally {
    d.unbind()
    d.remove()
  }
})

/**
 * Regression for the real profile block: an existing project skill script has no
 * `scripts/manifest.json`, so a path-entry request must run the file in place.
 * The pre-fix gate rejected the canonical real case before approval. These fixtures
 * never read a manifest in path mode.
 */
function pathFixture(options = {}) {
  const root = '/project/skill'
  const state = {
    approvals: [], specs: [], reads: [], lookup: [],
    scriptPath: options.scriptPath ?? 'scripts/parse.py',
    source: options.source ?? 'print("ok")',
    skill: { name: 'project-parser', source: 'project-agents', provider: 'filesystem',
      content: 'Run the existing parser.', invocation: { modelInvocable: true },
      resourceBase: { kind: 'directory', path: '/host/project/skill' } },
    policy: { mode: 'workspace-write', workspaceRoot: '/project', sessionId: 'caller' },
    outcome: 'allowed-once',
    result: { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 60000,
      stdout: { text: 'evidence', truncated: false }, stderr: { text: '', truncated: false },
      sandbox: { mode: 'read-only', denied: false, enforcement: 'full' } },
  }
  const controller = new AbortController()
  const exec = { agent: { id: 'caller', session: {} }, signal: controller.signal, callId: 'call-2' }
  const services = {
    workingDirectory: { async ensure() { return '/project' } },
    skills: { async get(name, lookup) { state.lookup.push({ name, lookup }); return state.skill } },
    fs: {
      processPathFromHostPath(path) { assert.equal(path, '/host/project/skill'); return root },
      async resolve(path, resolveOptions) {
        const resolved = path.startsWith('/') ? path : `${resolveOptions.cwd}/${path}`
        return { targetKey: resolved, displayPath: resolved }
      },
      contains(parent, child) {
        if (options.contains) return options.contains(parent, child)
        return child.targetKey.startsWith(`${parent.targetKey}/`)
      },
      processPath(target) { return target.targetKey },
      async stat(target) {
        if (target.targetKey === root) return { type: 'directory' }
        if (target.targetKey === '/etc/os-release' || target.targetKey === '/proc/version') return undefined
        if (target.targetKey.endsWith('/scripts/manifest.json')) return undefined
        if (target.targetKey === `${root}/${state.scriptPath}`) return options.missingScript ? undefined : { type: 'file' }
        return { type: 'file' }
      },
      async readBytes(target, signal, cap) {
        state.reads.push({ target, cap })
        if (target.targetKey.endsWith('manifest.json')) {
          const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error
        }
        return Buffer.from(state.source)
      },
    },
    sandboxPolicy: { resolve() { return state.policy } },
    approval: { async request(request) { state.approvals.push(request); await state.onApproval?.(); return state.outcome } },
    subprocess: {
      async terminalEnvironment() { return { platform: 'posix' } },
      async resolveExecutable(command) { return `/trusted/bin/${command}` },
    },
    shell: {
      sandboxMode: 'read-only',
      resolve(spec) { return spec },
      async execute(spec) {
        state.specs.push(spec)
        return { result: async () => state.result, kill() { return true }, done: Promise.resolve() }
      },
    },
  }
  return { state, services, exec, controller, run: request => runSkillScript(services, request, exec) }
}
const pathRequest = (overrides = {}) => ({ skill: 'project-parser', script: 'scripts/parse.py',
  parameters: { source: 'http://127.0.0.1:9/', 'allow-remote': true, 'allow-private-network': true,
    method: 'GET', path: '/spotlight/index/category' }, ...overrides })

test('no-manifest path entry runs the existing Python script in place, not via stdin', async () => {
  const f = pathFixture()
  const result = await f.run(pathRequest())
  assert.equal(result.success, true)
  assert.equal(result.script, 'scripts/parse.py', 'production result keeps the requested reference string')
  assert.match(result.scriptHash, /^[0-9a-f]{64}$/)
  const spec = f.state.specs[0]
  assert.equal(spec.stdin, '', 'path entry must not receive the source on stdin')
  assert.match(spec.command, /'\/trusted\/bin\/python3' '-E' '-s' '\/project\/skill\/scripts\/parse\.py'/)
  assert.match(spec.command, /'--source' 'http:\/\/127\.0\.0\.1:9\/'/)
  assert.match(spec.command, /'--allow-remote'/)
  assert.match(spec.command, /'--allow-private-network'/)
  assert.match(spec.command, /'--method' 'GET'/)
  assert.match(spec.command, /'--path' '\/spotlight\/index\/category'/)
  assert.equal(spec.workdir, '/project/skill')
  assert.equal(spec.sandboxPolicy.mode, 'read-only')
  assert.equal(f.state.approvals.length, 1)
  assert.match(f.state.approvals[0].reason, /path-entry/)
  assert.match(f.state.approvals[0].reason, /scriptHash/)
  assert.equal(f.state.reads.some(read => read.target.targetKey.endsWith('manifest.json')), false,
    'path entry must not require or read a manifest')
})

test('path entry uses the path runtime and named flags for a Node script', async () => {
  const f = pathFixture({ scriptPath: 'scripts/parse.mjs', source: 'console.log("ok")' })
  await f.run({ skill: 'project-parser', script: 'scripts/parse.mjs',
    parameters: { count: 2, 'dry-run': true, label: 'weekly' } })
  const spec = f.state.specs[0]
  assert.match(spec.command, /'\/trusted\/bin\/node' '\/project\/skill\/scripts\/parse\.mjs'/)
  assert.doesNotMatch(spec.command, /--input-type=module/)
  assert.match(spec.command, /'--count' '2' '--dry-run' '--label' 'weekly'/)
  assert.equal(spec.stdin, '')
})

test('path entry omits false boolean flags and keeps true flags valueless', async () => {
  const f = pathFixture()
  await f.run({ ...pathRequest(), parameters: { source: 'x', 'allow-remote': false, pretty: true } })
  const command = f.state.specs[0].command
  assert.match(command, /'--source' 'x'/)
  assert.match(command, /'--pretty'/)
  assert.doesNotMatch(command, /--allow-remote/)
})

test('path entry arrays repeat --name value in array order for append-style flags', async () => {
  const f = pathFixture()
  await f.run({ ...pathRequest(), parameters: { source: 'articles.js', group: ['Alpha', 'Beta'],
    method: ['POST', 'GET'], 'path-prefix': ['/beta', '/alpha'] } })
  const command = f.state.specs[0].command
  assert.match(command, /'--group' 'Alpha' '--group' 'Beta' '--method' 'POST' '--method' 'GET' '--path-prefix' '\/beta' '--path-prefix' '\/alpha' '--source' 'articles\.js'/)
  assert.equal(f.state.approvals.length, 1, 'the exact repeated argv is inside the approved binding')
  assert.match(f.state.approvals[0].reason, /"argv":\["--group","Alpha","--group","Beta"/)
})

test('path entry array values are quoted as single argv elements, not shell text', async () => {
  const f = pathFixture()
  const injected = "x'; echo INJECTED; '"
  await f.run({ ...pathRequest(), parameters: { group: [injected, 'Beta'] } })
  assert.ok(f.state.specs[0].command.includes(`'x'\\''; echo INJECTED; '\\'''`), f.state.specs[0].command)
  assert.deepEqual(pathArguments({ group: [injected, 'Beta'] }), ['--group', injected, '--group', 'Beta'])
})

test('path entry array parameters stay bounded and reject non-value elements', async () => {
  const cases = [
    ['empty array', { group: [] }],
    ['more than 16 per key', { group: Array.from({ length: 17 }, (_, index) => `g${index}`) }],
    ['more than 64 values total', Object.fromEntries(Array.from({ length: 5 },
      (_, index) => [`g${index}`, Array.from({ length: 16 }, (_, value) => `${index}-${value}`)]))],
    ['boolean element', { group: [true] }],
    ['nested array', { group: [['x']] }],
    ['object element', { group: [{ x: 1 }] }],
    ['control character', { group: ['a\nb'] }],
    ['fractional number', { group: [1.5] }],
  ]
  for (const [label, parameters] of cases) {
    const f = pathFixture()
    await assert.rejects(f.run({ ...pathRequest(), parameters }), /array|scalar|integer|text/, label)
    assert.equal(f.state.approvals.length, 0, `${label} fails before approval`)
    assert.equal(f.state.specs.length, 0, `${label} runs nothing`)
  }
})

test('declared id still refuses array parameters before any approval or manifest binding', async () => {
  const f = fixture()
  await assert.rejects(f.run({ ...request(), parameters: { ...request().parameters, group: ['Alpha'] } }),
    /array parameters are only supported for path entries/)
  assert.equal(f.state.approvals.length, 0)
  assert.equal(f.state.specs.length, 0)
})

for (const script of ['../outside.py', '/scripts/parse.py', 'scripts\\parse.py', 'scripts/../parse.py',
  'scripts/data.json', 'scripts/parse.sh']) {
  test(`path entry refuses non-contained or non-runtime reference ${script}`, async () => {
    const f = pathFixture()
    await assert.rejects(f.run({ ...pathRequest(), script }), /script/)
    assert.equal(f.state.approvals.length, 0)
    assert.equal(f.state.specs.length, 0)
  })
}

test('path entry refuses a canonical symlink outside the skill before approval', async () => {
  const f = pathFixture({ contains: () => false })
  await assert.rejects(f.run(pathRequest()), /outside skill/)
  assert.equal(f.state.approvals.length, 0)
  assert.equal(f.state.specs.length, 0)
})

test('path entry for a missing file fails before approval', async () => {
  const f = pathFixture({ missingScript: true })
  await assert.rejects(f.run(pathRequest()), /outside skill or not regular/)
  assert.equal(f.state.approvals.length, 0)
  assert.equal(f.state.specs.length, 0)
})

test('declared id without a manifest refuses and names the path-entry alternative', async () => {
  const f = pathFixture()
  await assert.rejects(f.run({ ...pathRequest(), script: 'extract' }), /readable scripts\/manifest\.json/)
  await assert.rejects(f.run({ ...pathRequest(), script: 'extract' }), /skill-relative path/)
  assert.equal(f.state.approvals.length, 0)
})

test('path entry approval rejection runs nothing', async () => {
  const f = pathFixture()
  f.state.outcome = 'rejected'
  await assert.rejects(f.run(pathRequest()), /approval/)
  assert.equal(f.state.specs.length, 0)
})

test('path entry content change after approval is rechecked and runs nothing', async () => {
  const f = pathFixture()
  f.state.onApproval = () => { f.state.source += '\n# changed' }
  await assert.rejects(f.run(pathRequest()), /changed after approval/)
  assert.equal(f.state.specs.length, 0)
})

/**
 * Real interpreter check for path-entry semantics: the script is opened by its
 * approved path (not source-on-stdin), so Node/Python see `__file__`/`import.meta.url`,
 * relative imports, and parameters in their normal argv positions.
 */
function realPathFixture(runtime, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'satellite-path-entry-'))
  const files = options.files ?? (runtime === 'node'
    ? [['scripts/helper.mjs', "export const value = 'relative-import-ok'\n"],
      ['scripts/parse.mjs',
        "import { fileURLToPath } from 'node:url'\nimport { value } from './helper.mjs'\n" +
        "console.log(JSON.stringify({ file: fileURLToPath(import.meta.url), argv: process.argv.slice(2), value, cwd: process.cwd() }))\n"]]
    : [['scripts/helper.py', "VALUE = 'relative-import-ok'\n"],
      ['scripts/parse.py',
        "import json, os, sys\nfrom helper import VALUE\n" +
        "print(json.dumps({'file': __file__, 'argv': sys.argv[1:], 'value': VALUE, 'cwd': os.getcwd()}))\n"]])
  for (const [path, content] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  const state = { approvals: [], specs: [], dir }
  const services = {
    workingDirectory: { async ensure() { return dir } },
    skills: { async get() {
      return { name: 'project-parser', source: 'project-agents', provider: 'filesystem',
        content: 'Run the existing parser.', invocation: { modelInvocable: true },
        resourceBase: { kind: 'directory', path: dir } }
    } },
    fs: {
      processPathFromHostPath(path) { assert.equal(path, dir); return dir },
      async resolve(path, resolveOptions) {
        return { targetKey: path.startsWith('/') ? path : join(resolveOptions.cwd, path) }
      },
      contains(parent, child) {
        return child.targetKey === parent.targetKey || child.targetKey.startsWith(`${parent.targetKey}/`)
      },
      processPath(target) { return target.targetKey },
      async stat(target) {
        try {
          const info = statSync(target.targetKey)
          return { type: info.isDirectory() ? 'directory' : 'file' }
        } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
          throw error
        }
      },
      async readBytes(target, signal, cap) {
        const bytes = readFileSync(target.targetKey)
        assert.ok(bytes.byteLength <= cap)
        return bytes
      },
    },
    sandboxPolicy: { resolve() { return { mode: 'workspace-write', workspaceRoot: dir, sessionId: 'caller' } } },
    approval: { async request(request) { state.approvals.push(request); return 'allowed-once' } },
    subprocess: {
      async terminalEnvironment() { return { platform: 'posix' } },
      async resolveExecutable(command) {
        if (command === 'env') return '/usr/bin/env'
        if (command === 'node') return process.execPath
        return '/usr/bin/python3'
      },
    },
    shell: {
      sandboxMode: 'read-only',
      resolve(spec) { return spec },
      async execute(spec) {
        state.specs.push(spec)
        let stdout = ''
        let stderr = ''
        let exitCode = 0
        try {
          stdout = execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', spec.command], {
            cwd: spec.workdir, input: spec.stdin, encoding: 'utf8', timeout: spec.timeoutMs, env: { ...process.env },
          })
        } catch (error) {
          stdout = String(error.stdout ?? '')
          stderr = String(error.stderr ?? '')
          exitCode = typeof error.status === 'number' ? error.status : 1
        }
        const result = { exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
          stdout: { text: stdout, truncated: false }, stderr: { text: stderr, truncated: false },
          sandbox: { mode: 'read-only', denied: false, enforcement: 'full' } }
        return { result: async () => result, kill() { return true }, done: Promise.resolve() }
      },
    },
  }
  const controller = new AbortController()
  const exec = { agent: { id: 'caller', session: {} }, signal: controller.signal, callId: 'call-3' }
  const script = options.script ?? (runtime === 'node' ? 'scripts/parse.mjs' : 'scripts/parse.py')
  const parameters = options.parameters ?? { source: 'alpha', 'dry-run': true, count: 2 }
  return {
    dir, state, exec, services,
    run: (next = parameters) => runSkillScript(services, { skill: 'project-parser', script, parameters: next }, exec),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
for (const runtime of ['node', 'python']) {
  test(`path entry runs a real ${runtime} script with relative import, file identity, and argv`,
    { skip: process.platform !== 'darwin' }, async () => {
      const f = realPathFixture(runtime)
      try {
        const result = await f.run()
        assert.equal(result.success, true, result.stderr.text)
        assert.match(f.state.approvals[0].reason, /path-entry/)
        assert.equal(f.state.specs[0].stdin, '')
        const observed = JSON.parse(result.stdout.text)
        assert.equal(observed.value, 'relative-import-ok')
        assert.ok(observed.file.endsWith(`scripts/parse.${runtime === 'node' ? 'mjs' : 'py'}`), observed.file)
        assert.equal(observed.cwd, realpathSync(f.dir))
        assert.deepEqual(observed.argv, ['--count', '2', '--dry-run', '--source', 'alpha'])
      } finally {
        f.cleanup()
      }
    })
}

/**
 * Regression for repeated append-style flags reaching a real interpreter
 * through the registered tool path. `apidoc_append_compat.py` is a
 * self-contained synthetic apiDoc-shaped fixture, not the Axon parser or any
 * external project source (see the fixture README); the earlier real-Axon
 * offline run is retained only in ignored local `.satellite` evidence.
 */
const APIDOC_FIXTURE = new URL('./fixtures/apidoc-append-compat/apidoc_append_compat.py', import.meta.url)
const APIDOC_FIXTURE_DOC = 'var apiData={schema:"0.3.0",generator:{name:"apiDoc",version:"1.2.0"},api:[' +
  '{id:"a1",group:"Alpha",name:"One",version:"1",type:"GET",url:"/alpha/one"},' +
  '{id:"b1",group:"Beta",name:"Two",version:"1",type:"POST",url:"/beta/two"},' +
  '{id:"a2",group:"Alpha",name:"Three",version:"1",type:"POST",url:"/alpha/three"}]};\n'
test('self-contained apiDoc compat CLI: path entry runs real python with repeated append flags',
  { skip: process.platform !== 'darwin' }, async () => {
    const parser = readFileSync(APIDOC_FIXTURE)
    const f = realPathFixture('python', {
      files: [['scripts/apidoc_append_compat.py', parser], ['articles.js', APIDOC_FIXTURE_DOC]],
      script: 'scripts/apidoc_append_compat.py',
      parameters: { source: 'articles.js', group: ['Alpha', 'Beta'],
        method: ['POST', 'GET'], 'path-prefix': ['/beta', '/alpha'] },
    })
    try {
      // Use the registered tool definition, not just an internal helper.
      const { tool } = registered(f.services)
      const call = parameters => tool.execute({ skill: 'project-parser', script: 'scripts/apidoc_append_compat.py', parameters }, f.exec)
      const result = await call({ source: 'articles.js', group: ['Alpha', 'Beta'],
        method: ['POST', 'GET'], 'path-prefix': ['/beta', '/alpha'] })
      assert.equal(result.success, true, result.stderr.text)
      assert.equal(result.script, 'scripts/apidoc_append_compat.py')
      assert.equal(f.state.specs[0].stdin, '', 'path entry must not receive source on stdin')
      assert.match(f.state.approvals[0].reason, /"argv":\["--group","Alpha","--group","Beta","--method","POST","--method","GET"/)
      const parsed = JSON.parse(result.stdout.text)
      assert.equal(parsed.status, 'success')
      assert.deepEqual(parsed.filters_applied, {
        group: ['Alpha', 'Beta'], method: ['POST', 'GET'], path_prefix: ['/beta', '/alpha'], path: null })
      assert.deepEqual(parsed.articles.map(article => article.id), ['a1', 'b1', 'a2'])

      // The same repeated flags must really filter: one group, one method, one prefix.
      const narrowedResult = await call({ source: 'articles.js', group: ['Beta'],
        method: ['POST'], 'path-prefix': ['/beta'] })
      assert.equal(narrowedResult.success, true, narrowedResult.stderr.text)
      const narrowed = JSON.parse(narrowedResult.stdout.text)
      assert.deepEqual(narrowed.filters_applied.group, ['Beta'])
      assert.deepEqual(narrowed.filters_applied.method, ['POST'])
      assert.deepEqual(narrowed.filters_applied.path_prefix, ['/beta'])
      assert.deepEqual(narrowed.articles.map(article => article.id), ['b1'])
    } finally {
      f.cleanup()
    }
  })
