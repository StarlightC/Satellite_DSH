import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createVersionControlBoundary } from '../lib/node/lib/version-control-runtime.js'
import { createNodeRuntime, registerCoordinatorBoundary } from '../lib/node/lib/wiring.js'
import { normalizeConfig, DEFAULT_CONFIG } from '../lib/node/lib/config.js'
import { createNodeCatalog, MATCH_YES, READY } from '../lib/contracts.js'
import { createSlotRegistry } from '../lib/registry.js'
import { resourceDirFrom } from '../lib/skills.js'
import { executeTool } from './tool-call-helper.mjs'

const LOCAL = 'satellite_version_control'
const denied = ['bash', 'write', 'edit', 'python', 'satellite_skill_script_run', 'web_fetch', 'web_search', 'subagent', 'subagent_fork', 'workflow', 'send_message', 'satellite_android_project']
const methods = ['skill', 'read', 'ask_user_question']
const simple = name => defineTool({ name, description: name, parameters: {}, output: { schema: { type: 'string' }, render: (_, text) => [{ type: 'text', text }] }, execute: async () => name })
const signal = () => new AbortController().signal
async function fixture(t) {
  const ctx = new Context(), roots = [], live = new Map(), owners = new Map(), scopes = [], calls = { spawn: [], approval: [], confine: [] }
  // Stand-in for the node runtime's private delegation record: membership is active only while listed.
  const delegated = new Set()
  ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {}, getSectionOrder: () => 1 })
  ctx.provide('agents', { get: id => live.get(id) })
  // DSH 0.2.2 three-state tree lookup: exact live caller, else throws.
  ctx.provide('subagents', {
    rootOf(caller) {
      if (live.get(caller.id) !== caller) throw new Error('UNAUTHORIZED')
      let current = caller
      while (owners.has(current.id)) current = owners.get(current.id)
      return current
    },
  })
  await ctx.plugin(ToolRuntime)
  for (const name of [...methods, ...denied]) ctx.tools.register(simple(name))
  const parent = await realpath(tmpdir()), root = await mkdtemp(join(parent, 'satellite-vc-runtime-'))
  assert.equal(await realpath(root), root)
  const cleanGitEnv = { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  execFileSync('/usr/bin/git', ['init', '--quiet', root], { env: cleanGitEnv })
  // The runtime runs Git under env -i with no global/system config, so the fixture must
  // carry its own identity instead of relying on whatever the host or CI happens to have.
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Fixture'], { cwd: root, env: cleanGitEnv })
  execFileSync('/usr/bin/git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root, env: cleanGitEnv })
  await writeFile(join(root, 'x'), 'test\n')
  const services = {
    workingDirectory: { ensure: async () => root },
    fs: { processPathFromHostPath: path => path, resolve: async path => ({ path }), processPath: target => target.path },
    sandboxPolicy: { resolve: ({ session }) => ({ mode: session.mode ?? 'workspace-write', workspaceRoot: root, sessionId: session.header.id }) },
    sandbox: { confine: async (argv, policy) => { calls.confine.push(policy); return { argv: [...argv], enforcement: 'full', denialSignatures: [] } } },
    approval: { request: async input => { calls.approval.push(input); return 'rejected' } },
    subprocess: {
      terminalEnvironment: async () => ({ platform: 'posix' }), resolveExecutable: async p => p,
      spawn(spec) {
        assert.equal(spec.cwd, root)
        calls.spawn.push(spec)
        const result = spawnSync(spec.argv[0], spec.argv.slice(1), { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 })
        if (result.error) throw result.error
        return { done: Promise.resolve({ exitCode: result.status, signal: result.signal }), terminate() {}, waitForExit: async () => true,
          collected: Object.fromEntries(['stdout', 'stderr'].map(name => [name, { readFrom: () => ({ text: result[name], nextOffset: Buffer.byteLength(result[name]), lossy: false }) }])) }
      },
    },
  }
  for (const [name, service] of Object.entries(services)) ctx.provide(name, service)
  function agent(id, parent) {
    const agent = { id, session: { header: { id, cwd: root }, mode: 'workspace-write' } }
    const scope = createScope(ctx, agent, parent ? { parent } : {})
    agent.ctx = scope.ctx
    scopes.push(scope); live.set(id, agent); if (parent) owners.set(id, parent); else roots.push(agent)
    return agent
  }
  let counter = 0
  const call = (name, agent, args = {}, extra = {}) => executeTool(ctx, { name, agent, arguments: args, callId: `runtime-${++counter}`, signal: signal(), ...extra })
  /** Bind as the node runtime does after its receipt, then mark the record active. */
  const bind = (boundary, child, parent, callId) => {
    const release = boundary.bind(child, parent, callId, () => delegated.has(child))
    delegated.add(child)
    return () => { delegated.delete(child); release() }
  }
  t.after(async () => {
    for (const scope of scopes.reverse()) await scope.dispose()
    await ctx.fiber.dispose()
    assert.equal(dirname(root), parent); assert.ok(root.startsWith(join(parent, 'satellite-vc-runtime-'))); assert.equal(await realpath(root), root)
    await rm(root, { recursive: true })
  })
  return { ctx, root, services, calls, agent, call, live, owners, scopes, bind, delegated }
}

test('reserved config cannot widen capability or route the identity through aliases/tiers', () => {
  assert.equal(Object.keys(DEFAULT_CONFIG.nodes).length, 7)
  assert.deepEqual(Object.entries(DEFAULT_CONFIG.nodes).slice(0, 6).map(([id, n]) => [id, n.role]), [
    ['context', 'investigation'], ['solution', 'solution-design'], ['implement', 'implementation'], ['validate', 'validation'], ['review', 'change-review'], ['signoff', 'acceptance'],
  ])
  assert.equal(DEFAULT_CONFIG.nodes['version-control'].tierRoles, undefined)
  for (const config of [
    { nodes: { 'version-control': { role: 'implementation' } } },
    { nodes: { 'version-control': { tierRoles: { light: 'implementation' } } } },
    { nodes: { alias: { role: 'version-control' } } },
    { roles: { 'version-control': { toolFilter: { allow: ['bash'] } } } },
    { roles: { 'version-control': { toolFilter: {} } } },
    { roles: { 'version-control': { sandbox: 'danger-full-access' } } },
    { roles: { 'version-control': { skill: 'satellite-implementation' } } },
  ]) assert.throws(() => normalizeConfig(config), /version-control/)
  const old = normalizeConfig({ roles: { implementation: { toolFilter: { deny: ['satellite_node', 'x'] } } } })
  assert.deepEqual(old.roles.implementation.toolFilter, { deny: ['satellite_node', 'x'] })
})

test('real ToolRuntime: main/ordinary/sibling/forged identity cannot invoke local tool; method-only child denies alternate entries and derived scopes', async t => {
  const f = await fixture(t), boundary = createVersionControlBoundary(f.ctx, defineTool)
  const root = f.agent('root'), child = f.agent('version', root), sibling = f.agent('implementation', root)
  const coordinator = await f.ctx.plugin({ inject: ['tools', 'agents', 'subagents', 'systemPrompt'], apply: registerCoordinatorBoundary })
  for (const agent of [root, child, sibling, undefined]) assert.equal((await f.call(LOCAL, agent, { request: { action: 'status', repo: '.' } })).isError, true)
  // Bound but record not yet active (provisional): every entry, including the local tool, is denied.
  const pendingRelease = boundary.bind(child, root, undefined, () => f.delegated.has(child))
  assert.equal((await f.call(LOCAL, child, { request: { action: 'status', repo: '.' } })).isError, true)
  for (const name of methods) assert.equal((await f.call(name, child)).isError, true, name)
  pendingRelease()
  const release = f.bind(boundary, child, root)
  for (const name of methods) assert.equal((await f.call(name, child)).isError, false, name)
  for (const name of denied) assert.equal((await f.call(name, child)).isError, true, name)
  // Own-scope registration is exempt from host allow masks: the guard must deny it.
  child.ctx.get('tools').register(simple('scoped_fake'))
  assert.equal((await f.call('scoped_fake', child)).isError, true)
  assert.equal((await f.call('bash', sibling)).isError, false)
  assert.equal((await f.call('bash', root)).isError, true)
  assert.equal((await f.call(LOCAL, { ...child }, { request: { action: 'status', repo: '.' } })).isError, true)
  const descendant = f.agent('descendant', child), derived = f.agent('derived', child)
  for (const agent of [descendant, derived]) {
    assert.equal((await f.call('read', agent)).isError, true)
    assert.equal((await f.call('bash', agent)).isError, true)
    assert.equal((await f.call(LOCAL, agent, { request: { action: 'status', repo: '.' } })).isError, true)
  }
  // Native pipeline: a model-direct run_code is denied by the version-control guard
  // itself (exact message), not passed through as a generic failure. The real
  // PTC-executor case is covered in coordinator-boundary/node-wiring tests.
  const ptc = await f.call('run_code', child, { code: 'print(1)' })
  assert.equal(ptc.isError, true)
  assert.match(ptc.error.message, /version-control permits only its fixed direct method tools/)
  // A nested (transport sub-dispatch) call of an allowed method is denied by the VC guard itself.
  const nested = await f.call('read', child, {}, { parent: Symbol('outer-run_code') })
  assert.equal(nested.isError, true)
  assert.match(nested.error.message, /version-control permits only its fixed direct method tools/)
  release()
  assert.equal((await f.call('bash', sibling)).isError, false)
  assert.equal((await f.call(LOCAL, sibling, { request: { action: 'status', repo: '.' } })).isError, true)
  boundary.dispose(); await coordinator.dispose()
})

test('runtime bridge reads real child services; closed input/missing mapping or services never spawn; rejected approval never writes', async t => {
  const f = await fixture(t)
  let rawExecute
  const boundary = createVersionControlBoundary(f.ctx, options => { rawExecute = options.execute; return defineTool(options) })
  const root = f.agent('root'), child = f.agent('version', root)
  f.bind(boundary, child, root)
  for (const request of [{ action: 'push', repo: '.' }, { action: 'status', repo: '.', remote: 'origin' }, { action: 'status', repo: '.', flags: ['--porcelain'] }]) {
    assert.equal((await f.call(LOCAL, child, { request })).isError, true)
  }
  assert.equal(f.calls.spawn.length, 0)
  const direct = f.ctx.tools.get(LOCAL)
  const invalid = await rawExecute({ request: { action: 'status', repo: '.', remote: 'origin' } }, { agent: child, signal: signal() })
  assert.equal(invalid.status, 'blocked'); assert.equal(f.calls.spawn.length, 0)
  const mapping = f.services.fs.processPathFromHostPath
  f.services.fs.processPathFromHostPath = () => undefined
  const mapped = await f.call(LOCAL, child, { request: { action: 'status', repo: '.' } })
  assert.equal(mapped.value.status, 'blocked'); assert.match(mapped.value.message, /mapping unavailable/); assert.equal(f.calls.spawn.length, 0)
  f.services.fs.processPathFromHostPath = mapping
  const observed = await f.call(LOCAL, child, { request: { action: 'status', repo: '.' } })
  assert.equal(observed.isError, false); assert.equal(observed.value.status, 'succeeded', JSON.stringify(observed))
  const staged = await f.call(LOCAL, child, { request: { action: 'stage', repo: '.', paths: ['x'], expectedSnapshot: observed.value.expectedSnapshot } })
  assert.equal(staged.value.status, 'blocked'); assert.match(staged.value.message, /approval rejected/)
  // Write approval is asked of the delegating PARENT (handoff), never the never-pinned child.
  assert.equal(f.calls.approval.length, 1); assert.ok(f.calls.approval[0].agent === root)
  assert.equal(f.calls.spawn.some(s => s.argv.includes('add') || s.argv.includes('commit')), false)
  // Child observes with its own scope; the handoff re-observes and probes under the parent session.
  assert.ok(f.calls.confine.some(p => p.sessionId === child.id))
  assert.ok(f.calls.confine.every(p => p.mode === 'read-only' || p.sessionId === root.id))
  const previous = child.ctx.get.bind(child.ctx)
  for (const missingService of ['subprocess', 'sandbox', 'sandboxPolicy', 'workingDirectory', 'approval', 'fs']) {
    child.ctx.get = name => name === missingService ? undefined : previous(name)
    const before = f.calls.spawn.length
    const missing = await direct.execute({ request: { action: 'status', repo: '.' } }, { agent: child, signal: signal() })
    assert.equal(missing.status, 'blocked'); assert.match(missing.message, /child scope service unavailable/); assert.equal(f.calls.spawn.length, before)
  }
  child.ctx.get = previous
  boundary.dispose()
})

test('real ToolRuntime: same-name scoped replacement is denied; scope disposal revokes membership; unload removes unrelated guards', async t => {
  const f = await fixture(t), boundary = createVersionControlBoundary(f.ctx, defineTool)
  const root = f.agent('root'), child = f.agent('version', root)
  const release = f.bind(boundary, child, root)
  const replace = child.ctx.get('tools').register(simple(LOCAL))
  assert.equal((await f.call(LOCAL, child)).isError, true)
  replace(); release()
  assert.equal((await f.call('bash', child)).isError, false)
  f.bind(boundary, child, root)
  await f.scopes.at(-1).dispose()
  const direct = f.ctx.tools.get(LOCAL)
  assert.equal((await direct.execute({ request: { action: 'status', repo: '.' } }, { agent: child, signal: signal() })).status, 'blocked')
  boundary.dispose()
  assert.equal(f.ctx.tools.get(LOCAL), undefined)
  assert.equal((await f.call('bash', root)).isError, false)
})

test('real coordinator/node creation boundary: provisional child is fully denied before the receipt, active only after it, cleared at completion', async t => {
  const f = await fixture(t), catalog = createNodeCatalog(), registry = createSlotRegistry(catalog), skills = new Set()
  const listeners = { 'session/created': [], 'agent/created': [], 'subagent/start': [], 'subagent/end': [] }
  f.ctx.provide('satelliteSlots', { defineNode: (...args) => catalog.defineNode(...args), register: ext => registry.register(ext), snapshot: () => registry.snapshot(), resolve: (...args) => registry.resolve(...args) })
  f.ctx.provide('skills', { register: skill => { skills.add(skill.name); return () => {} }, snapshot: async () => ({ complete: true, skills: [...skills].map(name => ({ name })) }) })
  f.ctx.provide('sessions', {})
  let child, started = 0
  const stages = []
  Object.assign(f.ctx.get('subagents'), {
    list: () => ['spawn'], getProvider: () => ({ prepareContinuable() {}, capabilities: { agentOptions: true, agentPreset: false, depthLimit: true, outputSchema: true } }),
    resolveMaxDepth: value => value,
    async startActivation(spec) {
      started++
      assert.deepEqual(stages, ['before'])
      assert.equal('request' in spec, false, 'flat DSH 0.2.2 activation spec')
      child = f.agent(spec.childId, spec.parent)
      child.session.header = { ...child.session.header, origin: 'subagent', parentSession: spec.parent.id }
      // DSH 0.2.2 Session: append is illegal until session/created has completed.
      let published = false
      child.session.append = (_, event) => {
        if (!published) throw new Error('Session append before session/created completed')
        child.session.mode = event.mode
      }
      for (const fn of listeners['session/created']) fn(child.session)
      published = true
      // Native setup may seed parent policy; the final creation gate narrows it.
      child.session.mode = 'danger-full-access'
      for (const fn of listeners['agent/created']) await fn({ agent: child })
      assert.equal(child.session.mode, 'workspace-write')
      for (const fn of listeners['subagent/start']) fn({ runId: 'run-1', provider: 'spawn', parentSessionId: spec.parent.id, id: child.id, local: true })
      // First-tool race before the receipt: everything is denied, including the method tools.
      for (const name of ['bash', 'read', LOCAL]) assert.equal((await f.call(name, child, name === LOCAL ? { request: { action: 'status', repo: '.' } } : {})).isError, true, name)
      return {
        childId: child.id,
        messageId: 'm-1',
        get result() {
          return (async () => {
            assert.equal((await f.call('bash', child)).isError, true)
            assert.equal((await f.call('read', child)).isError, false)
            const local = await f.call(LOCAL, child, { request: { action: 'status', repo: '.' } })
            assert.equal(local.value.status, 'succeeded', JSON.stringify(local))
            return { stopReason: 'completed', output: [{ type: 'text', text: 'observed only' }] }
          })()
        },
        dispose: async () => {},
      }
    },
  })
  const adapter = { get: name => f.ctx.get(name), tools: f.ctx.tools, satelliteSlots: f.ctx.get('satelliteSlots'), effect: fn => f.ctx.effect(fn), on: (name, fn) => { listeners[name].push(fn); return () => {} } }
  const runtime = createNodeRuntime({ ctx: adapter, defineTool, config: { roles: { 'version-control': { agentOptions: DEFAULT_CONFIG.roles['version-control'].agentOptions } } }, resourceDir: resourceDirFrom(new URL('../lib/node/index.js', import.meta.url).href, 'node') })
  for (const phase of ['before', 'after']) registry.register({
    id: `test.version-${phase}`, slot: `version-control.${phase}`, slotVersion: 1,
    match: () => MATCH_YES, ready: () => READY,
    run: () => { stages.push(phase); return { status: 'completed' } },
  })
  const root = f.agent('root')
  assert.equal(started, 0)
  const first = await f.call('satellite_node', root, { node: 'version-control', task: 'Explicit user request: local status only', facts: { 'acceptance.required': true } })
  assert.equal(first.isError, false, JSON.stringify(first)); assert.equal(first.value.kind, 'suspended', JSON.stringify(first)); assert.equal(started, 1)
  // Revoked before disposal; the child scope keeps denying until it is released.
  assert.equal((await f.call(LOCAL, child, { request: { action: 'status', repo: '.' } })).isError, true)
  assert.equal((await f.call('read', child)).isError, true)
  const resumed = await f.call('satellite_node', root, { node: 'version-control', task: 'same', resume: first.value.token, decision: 'accept' })
  assert.equal(resumed.value.kind, 'completed'); assert.equal(started, 1)
  assert.deepEqual(stages, ['before', 'after'])
  assert.deepEqual(runtime.nodeIds, ['context', 'solution', 'implement', 'validate', 'review', 'signoff', 'version-control'])
})

// ---- Parent-owned write handoff (real ToolRuntime) ----
const git = (root, ...args) => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
const writeSpawns = spawns => spawns.filter(s => s.argv.includes('add') || s.argv.includes('commit'))
async function handoff(t, { approve = 'allowed-once' } = {}) {
  const f = await fixture(t), boundary = createVersionControlBoundary(f.ctx, defineTool)
  const root = f.agent('root'), child = f.agent('version', root)
  const tagged = { parent: [], child: [], parentApproval: [], parentConfine: [] }
  // Distinct parent-scope service instances: proves the write uses PARENT services.
  const parentServices = {
    ...f.services,
    approval: { request: async input => { tagged.parentApproval.push(input); return typeof approve === 'function' ? approve(input) : approve } },
    sandbox: { confine: async (argv, policy, sig) => { tagged.parentConfine.push(policy); await parentServices.onConfine?.(policy); return f.services.sandbox.confine(argv, policy, sig) } },
    subprocess: { ...f.services.subprocess, spawn(spec) { tagged.parent.push(spec); return f.services.subprocess.spawn(spec) } },
  }
  // Cordis scope ctx assignments write through to a shared target: wrap per agent instead.
  const scoped = (agent, lookup) => {
    const original = agent.ctx, base = original.get.bind(original)
    const overrides = { get: name => lookup(name) ?? base(name) }
    agent.ctx = new Proxy(original, { get: (target, key) => (key in overrides ? overrides[key] : Reflect.get(target, key)) })
    return overrides
  }
  const rootCtx = scoped(root, name => (Object.hasOwn(parentServices, name) && name !== 'onConfine' ? parentServices[name] : undefined))
  const childSubprocess = { ...f.services.subprocess, spawn(spec) { tagged.child.push(spec); return f.services.subprocess.spawn(spec) } }
  const childApproval = { request: async () => { throw new Error('child approval must never be used') } }
  scoped(child, name => (name === 'subprocess' ? childSubprocess : name === 'approval' ? childApproval : undefined))
  f.bind(boundary, child, root, 'parent-node-call')
  const status = async (who = child) => (await f.call(LOCAL, who, { request: { action: 'status', repo: '.' } })).value
  const stage = async (token, who = child, paths = ['x']) => f.call(LOCAL, who, { request: { action: 'stage', repo: '.', paths, expectedSnapshot: token } })
  t.after(() => boundary.dispose())
  return { f, boundary, root, child, tagged, parentServices, rootCtx, status, stage }
}

test('handoff: host allowed-once executes the frozen stage+commit with parent scope services; child token is single-use and not transferable', async t => {
  const h = await handoff(t)
  const snap = await h.status()
  assert.equal(snap.status, 'succeeded')
  assert.equal(writeSpawns(h.tagged.child).length, 0)
  const staged = await h.stage(snap.expectedSnapshot)
  assert.equal(staged.value.status, 'succeeded', JSON.stringify(staged))
  assert.equal(h.tagged.parentApproval.length, 1)
  assert.ok(h.tagged.parentApproval[0].agent === h.root); assert.equal(h.tagged.parentApproval[0].callId, 'parent-node-call')
  assert.equal(writeSpawns(h.tagged.parent).length, 1); assert.equal(writeSpawns(h.tagged.child).length, 0)
  assert.ok(h.tagged.parentConfine.every(p => p.sessionId === h.root.id))
  assert.match(git(h.f.root, 'diff', '--cached', '--name-only'), /^x$/m)
  // Reuse of the consumed token and a forged token are refused before any approval.
  for (const token of [snap.expectedSnapshot, 'f'.repeat(64)]) {
    const reused = await h.stage(token)
    assert.equal(reused.value.status, 'blocked'); assert.match(reused.value.message, /expectedSnapshot/)
  }
  assert.equal(h.tagged.parentApproval.length, 1)
  // A sibling version child (other kernel) cannot spend this child's token.
  const other = h.f.agent('version-2', h.root); h.f.bind(h.boundary, other, h.root, 'other-call')
  const fresh = await h.status()
  const foreign = await h.stage(fresh.expectedSnapshot, other)
  assert.equal(foreign.value.status, 'blocked')
  const commitSnap = await h.status()
  const committed = await h.f.call(LOCAL, h.child, { request: { action: 'commit', repo: '.', message: 'fixture', expectedSnapshot: commitSnap.expectedSnapshot } })
  assert.equal(committed.value.status, 'succeeded', JSON.stringify(committed))
  assert.match(git(h.f.root, 'log', '--format=%s', '-1'), /fixture/)
  // Provenance: the commit uses the fixture-local identity, never an ambient one.
  assert.equal(git(h.f.root, 'log', '--format=%an <%ae>|%cn <%ce>', '-1').trim(), 'Fixture <fixture@example.invalid>|Fixture <fixture@example.invalid>')
  assert.equal(writeSpawns(h.tagged.child).length, 0)
})

test('handoff fail-closed: parent read-only / approval never / missing parent service / ownership lost / workspace differs never write', async t => {
  const h = await handoff(t, { approve: 'rejected' })
  const cases = [
    ['read-only', () => { h.root.session.mode = 'read-only' }, () => { h.root.session.mode = 'workspace-write' }, /parent sandbox denies writes|policy/],
    ['never', () => {}, () => {}, /approval rejected/],
    ['missing', () => { const g = h.rootCtx.get; h.rootCtx.get = n => n === 'approval' ? undefined : g(n); return g }, g => { h.rootCtx.get = g }, /parent scope service unavailable: approval/],
    ['record revoked', () => { h.f.delegated.delete(h.child) }, () => { h.f.delegated.add(h.child) }, /execution identity|delegation/],
    ['other tree', () => { const other = h.f.agent('other-root'); h.f.owners.set(h.child.id, other) }, () => { h.f.owners.set(h.child.id, h.root) }, /delegation/],
    ['cwd', () => { const s = h.parentServices.workingDirectory; h.parentServices.workingDirectory = { ensure: async () => dirname(h.f.root) }; return s }, s => { h.parentServices.workingDirectory = s }, /cwd outside|workspace differ/],
  ]
  for (const [name, arrange, restore, message] of cases) {
    const snap = await h.status()
    const token = arrange()
    const result = await h.stage(snap.expectedSnapshot)
    restore(token)
    // A revoked record is denied by the guard before the body: the failure is the tool error.
    const outcome = result.value ?? { status: 'blocked', message: result.error.message }
    assert.equal(outcome.status, 'blocked', name); assert.match(outcome.message, message, name)
  }
  assert.equal(writeSpawns([...h.tagged.parent, ...h.tagged.child]).length, 0)
  assert.equal(git(h.f.root, 'diff', '--cached', '--name-only'), '')
})

test('handoff: changes after approval or during the FINAL write confinement produce zero write spawn', async t => {
  const h = await handoff(t)
  const realNow = Date.now
  t.after(() => { Date.now = realNow })
  const mutations = {
    'file after approval': { approve: true, run: () => writeFileSync(join(h.f.root, 'x'), 'changed-after-approval\n') },
    'file in final confine': { run: () => writeFileSync(join(h.f.root, 'x'), 'changed-in-confine\n') },
    'index in final confine': { run: () => git(h.f.root, 'update-index', '--add', '--cacheinfo', '100644', git(h.f.root, 'hash-object', '-w', join(h.f.root, 'x')).trim(), 'y') },
    'config in final confine': { run: () => git(h.f.root, 'config', 'user.name', 'changed') },
    'policy read-only in final confine': { run: () => { h.root.session.mode = 'read-only' }, after: () => { h.root.session.mode = 'workspace-write' } },
    'snapshot expired in final confine': { run: () => { Date.now = () => realNow() + 60 * 60_000 }, after: () => { Date.now = realNow } },
  }
  for (const [name, m] of Object.entries(mutations)) {
    writeFileSync(join(h.f.root, 'x'), `${name}\n`)
    const snap = await h.status()
    let confines = 0
    h.parentServices.onConfine = m.approve ? undefined : policy => { if (policy.mode === 'workspace-write' && ++confines === 2) m.run() } // 1: probe, 2: final spawn confinement
    const approve = h.parentServices.approval.request
    if (m.approve) h.parentServices.approval = { request: async input => { const r = await approve(input); m.run(); return r } }
    const before = writeSpawns(h.tagged.parent).length
    const result = await h.stage(snap.expectedSnapshot)
    h.parentServices.approval = { request: approve }; h.parentServices.onConfine = undefined; m.after?.()
    assert.equal(result.value.status, 'blocked', `${name}: ${JSON.stringify(result.value)}`)
    if (!m.approve) assert.equal(confines, 2, name)
    assert.equal(writeSpawns(h.tagged.parent).length, before, name)
  }
  assert.equal(git(h.f.root, 'diff', '--cached', '--name-only').includes('x'), false)
})

test('real ToolRuntime: cancellation after the write spawned keeps ABORTED but surfaces effect-unknown (no auto-retry)', async t => {
  const h = await handoff(t)
  const snap = await h.status()
  const controller = new AbortController()
  const spawn = h.parentServices.subprocess.spawn
  h.parentServices.subprocess.spawn = spec => { const handle = spawn(spec); if (spec.argv.includes('add')) controller.abort(); return handle }
  const result = await executeTool(h.f.ctx, { name: LOCAL, agent: h.child, arguments: { request: { action: 'stage', repo: '.', paths: ['x'], expectedSnapshot: snap.expectedSnapshot } }, callId: 'cancel-1', signal: controller.signal })
  assert.equal(result.isError, true); assert.equal(result.error.info.name, 'AbortError')
  const text = result.content.map(c => c.text).join('\n')
  assert.match(text, /aborted/); assert.match(text, /effect-unknown: Write may have taken effect/); assert.match(text, /never automatically retry/)
  assert.match(git(h.f.root, 'diff', '--cached', '--name-only'), /^x$/m) // the write did happen
  // Repository queue released: a following observation proceeds.
  assert.equal((await h.status()).status, 'succeeded')
})

test('service identity: fresh Cordis proxies of the same original pass; a swapped original is refused; scopes stay isolated', async t => {
  const { Service, symbols } = await import('@deepseek-ai/cordis')
  const f = await fixture(t), boundary = createVersionControlBoundary(f.ctx, defineTool)
  const root = f.agent('root'), child = f.agent('version', root), sibling = f.agent('sibling', root)
  // Real Cordis Service rows: every ctx.get() is a fresh traceable proxy over one original.
  class SandboxRow extends Service { confine(...args) { return f.services.sandbox.confine(...args) } }
  class FirstRow extends SandboxRow { constructor(ctx) { super(ctx, 'vcSandboxA') } }
  class SecondRow extends SandboxRow { constructor(ctx) { super(ctx, 'vcSandboxB') } }
  await f.ctx.plugin(FirstRow); await f.ctx.plugin(SecondRow)
  const a = f.ctx.get('vcSandboxA'), b = f.ctx.get('vcSandboxA')
  assert.notEqual(a, b, 'Cordis returns a fresh proxy per get')
  assert.ok(a[symbols.original] && a[symbols.original] === b[symbols.original])
  assert.notEqual(a[symbols.original], f.ctx.get('vcSandboxB')[symbols.original])
  const base = child.ctx.get.bind(child.ctx)
  let row = 'vcSandboxA'
  child.ctx.get = name => (name === 'sandbox' ? f.ctx.get(row) : base(name))
  f.bind(boundary, child, root)
  const ok = await f.call(LOCAL, child, { request: { action: 'status', repo: '.' } })
  assert.equal(ok.value.status, 'succeeded', JSON.stringify(ok))
  // A different original after prepare: policy() re-reads before confine and refuses.
  const before = f.calls.spawn.length
  const confine = f.services.sandbox.confine
  f.services.sandbox.confine = async (...args) => { row = 'vcSandboxB'; return confine(...args) }
  const refused = await f.call(LOCAL, child, { request: { action: 'status', repo: '.' } })
  f.services.sandbox.confine = confine
  assert.equal(refused.value.status, 'blocked', JSON.stringify(refused))
  assert.match(refused.value.message, /scope service changed: sandbox/)
  assert.equal(f.calls.spawn.length, before, 'no spawn after the swap')
  child.ctx.get = base
  // Unwrapping identity does not merge scopes: a sibling is still not a member.
  assert.equal((await f.call(LOCAL, sibling, { request: { action: 'status', repo: '.' } })).isError, true)
})
