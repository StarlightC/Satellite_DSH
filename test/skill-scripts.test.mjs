import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { parseScriptManifest, runSkillScript, scriptArguments, registerSkillScriptTool } from '../src/node/lib/skill-scripts.ts'

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
      async stat(target) { return { type: target.targetKey === '/project/skill' ? 'directory' : 'file' } },
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
