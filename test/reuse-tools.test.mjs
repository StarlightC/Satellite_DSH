import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { registerReuseQuery, registerReuseMaintenance } from '../lib/node/lib/reuse-tools.js'
import { extractAndroidReuseSource, ANDROID_REUSE_SOURCE_REVISION } from '../lib/android/lib/reuse-source.js'
import { apply as applyAndroid, inject as applyAndroidInject } from '../lib/android/index.js'
import { apply as applyNode } from '../lib/node/index.js'
import { REUSE_INDEX_PATH } from '../lib/node/lib/reuse-index.js'

const SOURCE = 'app/src/main/java/example/Shared.kt'
const source = { extract: extractAndroidReuseSource, revision: ANDROID_REUSE_SOURCE_REVISION }
function setup() {
  const files = new Map([[`/project/${SOURCE}`, { content: '@Composable\nfun SharedCard() = Unit', version: 'v1' }]])
  const tools = new Map(), disposers = [], approvals = [], writes = []
  let seq = 1
  const fs = {
    processPathFromHostPath: p => p,
    fileUrl: t => `file://${t.targetKey}`,
    processPath: t => t.targetKey,
    resolve: async (p, options = {}) => ({ targetKey: path.posix.resolve(options.cwd ?? '/project', p), displayPath: p }),
    contains: (p, t) => t.targetKey === p.targetKey || t.targetKey.startsWith(`${p.targetKey}/`),
    stat: async t => {
      if (['/project', '/other'].includes(t.targetKey)) return { type: 'directory', version: 'dir' }
      const f = files.get(t.targetKey)
      return f ? { type: 'file', version: f.version, size: Buffer.byteLength(f.content) } : undefined
    },
    readBytes: async (t, signal, max) => {
      signal?.throwIfAborted()
      const bytes = Buffer.from(files.get(t.targetKey).content)
      if (bytes.length > max) throw new Error('FS_TOO_LARGE')
      return bytes
    },
    writeText: async (t, content, expected, signal, policy) => {
      signal?.throwIfAborted()
      const existing = files.get(t.targetKey)
      if (expected.kind === 'createIfAbsent' ? !!existing : expected.version !== existing?.version) throw new Error('FS_STALE_VERSION')
      writes.push({ t, content, expected, signal, policy })
      files.set(t.targetKey, { content, version: `v${++seq}` })
    },
  }
  let mode = 'workspace-write'
  const services = {
    fs,
    approval: { request: async request => { approvals.push(request); return 'allowed-once' } },
    sandboxPolicy: { resolve: ({ session }) => ({ mode, workspaceRoot: session.header.cwd, sessionId: 'fixture-session' }) },
  }
  const ctx = {
    tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    get(name) { return services[name] },
    effect(callback) { const dispose = callback(); disposers.push(dispose); return dispose },
  }
  const agent = { session: { header: { cwd: '/project' } }, ctx }
  const exec = { agent, callId: 'fixture-call', signal: new AbortController().signal }
  return { files, fs, services, tools, ctx, exec, approvals, writes, disposers, setMode: v => { mode = v } }
}
function register(f) { registerReuseQuery(f.ctx); registerReuseMaintenance(f.ctx, source) }
async function run(f, name, args, exec = f.exec) { return f.tools.get(name).execute(args, exec) }
const maintain = f => run(f, 'satellite_reuse_maintain', { action: 'initialize', paths: [SOURCE] })

test('real defineTool registrations expose distinct bounded query and maintenance contracts', () => {
  const f = setup(); register(f)
  const query = f.tools.get('satellite_reuse_query'), update = f.tools.get('satellite_reuse_maintain')
  assert.deepEqual(Object.keys(query.parameters.properties), ['terms', 'limit'])
  assert.deepEqual(Object.keys(update.parameters.properties), ['action', 'paths', 'adjustments'])
  assert.deepEqual(update.parameters.required, ['action', 'paths'])
  assert.equal(query.isConcurrencySafe({}), true)
  assert.equal(update.isConcurrencySafe({}), false)
  assert.match(update.description, /explicit files/i)
  f.disposers.forEach(d => d())
  assert.equal(f.tools.size, 0)
})

test('query missing index returns ordinary-search fallback and never requests approval', async () => {
  const f = setup(); registerReuseQuery(f.ctx)
  const result = await run(f, 'satellite_reuse_query', { terms: ['card'] })
  assert.equal(result.status, 'missing')
  assert.match(result.fallback, /ordinary search/)
  assert.equal(f.approvals.length, 0); assert.equal(f.writes.length, 0)
})

test('maintenance uses exact caller identity and full plan in real approval request, then query consumes data', async () => {
  const f = setup(); register(f)
  const result = await maintain(f)
  assert.equal(result.status, 'updated')
  assert.equal(f.approvals.length, 1)
  const ask = f.approvals[0]
  assert.equal(ask.agent, f.exec.agent)
  assert.equal(ask.toolName, 'satellite_reuse_maintain')
  assert.equal(ask.callId, 'fixture-call'); assert.equal(ask.signal, f.exec.signal)
  const plan = JSON.parse(ask.reason.slice(ask.reason.indexOf('\n') + 1))
  assert.equal(plan.project.backendId, 'host-shared-v1')
  assert.equal(plan.project.rootKey, '/project')
  assert.equal(plan.destination, `/project/${REUSE_INDEX_PATH}`)
  assert.deepEqual(plan.paths, [SOURCE]); assert.equal(plan.coverage, 'explicit-files')
  const resultQuery = await run(f, 'satellite_reuse_query', { terms: ['card'] })
  assert.equal(resultQuery.matches[0].symbol, 'SharedCard')
  assert.equal(resultQuery.recognitionStatus, 'unverified')
  assert.equal(resultQuery.matches[0].freshness, 'current')
})

test('readonly mode refuses before approval and runtime service absence affects only the tool', async () => {
  const f = setup(); register(f); f.setMode('read-only')
  await assert.rejects(maintain(f), /WRITE_DENIED/)
  assert.equal(f.approvals.length, 0)
  f.setMode('workspace-write')
  delete f.services.approval
  assert.equal((await maintain(f)).status, 'unavailable')
  assert.equal((await run(f, 'satellite_reuse_query', {})).status, 'missing')
  delete f.services.fs
  assert.equal((await run(f, 'satellite_reuse_query', {})).reason, 'REUSE_FILESYSTEM_UNAVAILABLE')
})

test('approval rejected/unavailable/cancelled never writes; only allowed-once grants', async () => {
  for (const outcome of ['rejected', 'unavailable', 'cancelled', true]) {
    const f = setup(); register(f)
    f.services.approval.request = async () => outcome
    await assert.rejects(maintain(f), /APPROVAL_DENIED/)
    assert.equal(f.writes.length, 0)
  }
})

test('mapping absence or inconsistent canonical mapping is unavailable, not guessed remote support', async () => {
  const f = setup(); register(f)
  f.fs.processPathFromHostPath = () => undefined
  assert.equal((await maintain(f)).reason, 'REUSE_HOST_SHARED_MAPPING_UNAVAILABLE')
  assert.equal(f.approvals.length, 0)
  let calls = 0
  f.fs.processPathFromHostPath = p => ++calls === 1 ? p : '/other'
  assert.equal((await run(f, 'satellite_reuse_query', {})).reason, 'REUSE_HOST_SHARED_MAPPING_UNVERIFIED')
})

test('model cannot supply root, backend identity or permission and current cwd is irrelevant', async () => {
  const f = setup(); register(f)
  for (const extra of [{ projectRoot: '/other' }, { backendId: 'invented' }, { approved: true }]) {
    await assert.rejects(run(f, 'satellite_reuse_query', extra), /UNKNOWN_ARGUMENT/)
  }
  f.exec.agent.currentDirectory = '/other'
  await maintain(f)
  assert.equal(f.writes[0].t.targetKey, `/project/${REUSE_INDEX_PATH}`)
  const noRoot = { ...f.exec, agent: { session: { header: {} }, ctx: f.ctx } }
  assert.equal((await run(f, 'satellite_reuse_query', {}, noRoot)).reason, 'REUSE_SESSION_ROOT_UNAVAILABLE')
})

test('Agent-scoped capabilities do not fall back to unrelated host services', async () => {
  const f = setup(); register(f)
  const isolated = { ...f.exec, agent: { session: f.exec.agent.session, ctx: { get: () => undefined } } }
  assert.equal((await run(f, 'satellite_reuse_query', {}, isolated)).reason, 'REUSE_FILESYSTEM_UNAVAILABLE')
})

test('cancellation propagates without converting it into successful unavailable output', async () => {
  const f = setup(); register(f)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(run(f, 'satellite_reuse_query', {}, { ...f.exec, signal: controller.signal }), /abort/i)
  const pending = new AbortController()
  f.services.approval.request = async () => { pending.abort(); return 'allowed-once' }
  await assert.rejects(run(f, 'satellite_reuse_maintain', { action: 'initialize', paths: [SOURCE] }, { ...f.exec, signal: pending.signal }), /abort/i)
  assert.equal(f.writes.length, 0)
})

test('policy is resolved again at write time rather than reusing initial permission', async () => {
  const f = setup(); register(f)
  f.services.approval.request = async () => { f.setMode('read-only'); return 'allowed-once' }
  await assert.rejects(maintain(f), /WRITE_DENIED/)
  assert.equal(f.writes.length, 0)
})

test('core apply validates builtin role options before registering any operation', () => {
  const f = setup()
  assert.throws(() => applyNode(f.ctx, { roles: { validation: { agentOptions: { provider: 'unapproved', model: 'override' } } } }), /routes/)
  assert.equal(f.tools.size, 0)
  assert.equal(f.disposers.length, 0)
})

test('core real apply mounts node, read-only role service, generic query and script entry without Android recognizer', async () => {
  const f = setup()
  const owner = new Context()
  const fibers = []
  applyNode({
    ...f.ctx,
    plugin(plugin, options) { const fiber = owner.plugin(plugin, options); fibers.push(fiber); return fiber },
    satelliteSlots: { defineNode: () => () => {}, register: () => () => {}, snapshot: () => [] },
  }, {})
  await Promise.all(fibers)
  try {
    assert.deepEqual([...f.tools.keys()].sort(), ['satellite_node', 'satellite_reuse_query', 'satellite_skill_script_run'])
    const catalog = owner.get('satelliteRoles').describe()
    assert.equal(catalog.version, 1)
    assert.equal(catalog.roles.find((role) => role.role === 'android-context').bindings.length, 0)
  } finally {
    await Promise.all(fibers.map((fiber) => fiber.dispose()))
  }
  assert.equal(owner.get('satelliteRoles'), undefined)
})

test('Android real apply declares tools and registers maintenance (not the query tool)', () => {
  const f = setup()
  const slots = { hasSlot: () => false, register: () => () => {}, onSlotsChanged: () => () => {} }
  // 真实宿主只把 inject 里声明过的服务挂成属性：`tools` 现在是硬依赖。
  assert.ok(applyAndroidInject.includes('tools'), 'tools 必须是声明依赖，否则注册会被静默丢弃')
  assert.ok(applyAndroidInject.includes('satelliteSlots'))
  const ctx = { ...f.ctx, satelliteSlots: slots, tools: f.ctx.tools, inject: () => {} }
  applyAndroid(ctx)
  assert.ok(f.tools.has('satellite_reuse_maintain'), '维护工具由 Android 行注册')
  assert.equal(f.tools.has('satellite_reuse_query'), false, '查询工具由 node 行注册，不在这里重复')
})
