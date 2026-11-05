import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { registerCoordinatorBoundary } from '../lib/node/lib/wiring.js'
import { apply as applyNode, inject } from '../lib/node/index.js'
import { executeTool } from './tool-call-helper.mjs'

const WORK = ['read', 'write', 'bash', 'subagent', 'subagent_fork', 'workflow', 'send_message',
  // Pre-alpha.3 schedule names are not coordination tools.
  'schedule_update', 'schedule_delete']
const COORDINATION = ['satellite_node', 'skill', 'ask_user_question', 'todo_write', 'list_agents', 'interrupt_agent',
  'schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit']

async function fixture({ register = [...WORK, ...COORDINATION] } = {}) {
  const ctx = new Context()
  const sections = []
  const roots = []
  const executions = []
  let calls = 0
  // Native contracts used by the real ToolRuntime and the boundary; the tool
  // registry, guard chain and result shapes are the real implementations.
  ctx.provide('systemPrompt', {
    tools: () => () => {},
    getSectionOrder: () => 800,
    section(section) {
      sections.push(section)
      return () => {
        const index = sections.indexOf(section)
        if (index >= 0) sections.splice(index, 1)
      }
    },
  })
  // Exact live registry + three-state tree lookup (DSH 0.2.2 `agents.get`/`subagents.rootOf`).
  const live = new Map()
  const owners = new Map()
  ctx.provide('agents', { get: id => live.get(id) })
  ctx.provide('subagents', {
    // Target-source flat activation contract (only probed by the node row's host gate here).
    startActivation: async () => { throw new Error('not used by this fixture') },
    rootOf(caller) {
      if (live.get(caller.id) !== caller) throw new Error('UNAUTHORIZED')
      if (unowned.has(caller)) throw new Error('agent has no active runtime owner')
      // Fixture `child*` agents are members of the first live root's tree.
      return owners.get(caller) ?? (caller.id.startsWith('child') && roots[0] ? roots[0] : caller)
    },
  })
  const unowned = new Set()
  await ctx.plugin(ToolRuntime)
  for (const name of register) ctx.tools.register(defineTool({
    name, description: name, parameters: {},
    output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
    execute(args, exec) {
      executions.push({ name, agent: exec.agent })
      return name
    },
  }))
  // Every fixture agent is registered live under its id.
  const agent = (id) => {
    const value = { id }
    live.set(id, value)
    return value
  }
  const call = (name, target) => executeTool(ctx, {
    name, arguments: {}, callId: `call-${++calls}`,
    signal: new AbortController().signal,
    ...(target ? { agent: target } : {}),
  })
  const mount = () => ctx.plugin({ inject: ['tools', 'agents', 'systemPrompt'], apply: registerCoordinatorBoundary })
  const promptFor = scope => sections.map(section => section.text({ scope })).filter(Boolean).join('\n')
  return { ctx, agent, call, mount, promptFor, roots, executions, live, unowned, owners }
}

test('a live root coordinates but cannot run work tools itself', async () => {
  const f = await fixture()
  try {
    const root = f.agent('root')
    f.roots.push(root)
    await f.mount()
    for (const name of WORK) {
      const result = await f.call(name, root)
      assert.equal(result.isError, true, name)
      assert.match(result.error.message, /satellite_node/)
    }
    for (const name of COORDINATION) assert.equal((await f.call(name, root)).isError, false, name)
    // A denied call never reaches its body.
    assert.deepEqual(f.executions.map(({ name }) => name), COORDINATION)
  } finally { await f.ctx.fiber.dispose() }
})

test('a managed child keeps its role tools', async () => {
  const f = await fixture()
  try {
    const root = f.agent('root')
    const child = f.agent('child')
    f.roots.push(root)
    await f.mount()
    for (const name of WORK) assert.equal((await f.call(name, child)).isError, false, name)
    assert.equal((await f.call('read', root)).isError, true)
  } finally { await f.ctx.fiber.dispose() }
})

test('agentless host calls are not model calls and stay allowed', async () => {
  const f = await fixture()
  try {
    const root = f.agent('root')
    f.roots.push(root)
    await f.mount()
    assert.equal((await f.call('read')).isError, false)
    assert.equal((await f.call('bash')).isError, false)
    assert.deepEqual(f.executions.map(({ agent }) => agent), [undefined, undefined])
  } finally { await f.ctx.fiber.dispose() }
})

test('the root prompt appears only for roots and is released on unload', async () => {
  const f = await fixture()
  try {
    const root = f.agent('root')
    const child = f.agent('child')
    f.roots.push(root)
    assert.equal(f.promptFor(root), '')
    const boundary = await f.mount()
    assert.match(f.promptFor(root), /satellite_node/)
    assert.equal(f.promptFor(child), '')
    assert.equal((await f.call('read', root)).isError, true)
    await boundary.dispose()
    assert.equal((await f.call('read', root)).isError, false)
    assert.equal(f.promptFor(root), '')
    const again = await f.mount()
    assert.equal((await f.call('read', root)).isError, true)
    assert.match(f.promptFor(root), /satellite_node/)
    await again.dispose()
  } finally { await f.ctx.fiber.dispose() }
})

test('the real node entry mounts the boundary for live roots', async () => {
  const f = await fixture({ register: WORK })
  try {
    f.ctx.provide('satelliteSlots', {
      defineNode: () => () => {},
      register: () => () => {},
      snapshot: () => [],
    })
    f.ctx.provide('skills', { register: () => () => {} })
    const root = f.agent('root')
    const child = f.agent('child')
    f.roots.push(root)
    const row = await f.ctx.plugin({ inject, apply: applyNode }, {})
    assert.ok(f.ctx.tools.get('satellite_node', root))
    assert.equal((await f.call('read', root)).isError, true)
    assert.equal((await f.call('read', child)).isError, false)
    assert.match(f.promptFor(root), /satellite_node/)
    assert.equal(f.promptFor(child), '')
    await row.dispose()
    assert.equal((await f.call('read', root)).isError, false)
  } finally { await f.ctx.fiber.dispose() }
})

test('unknown tree identity is denied for work tools, never treated as a member', async () => {
  const f = await fixture()
  try {
    const root = f.agent('root')
    f.roots.push(root)
    await f.mount()
    const orphan = f.agent('child-orphan')
    f.unowned.add(orphan)
    const stale = { id: 'root' } // same id, not the exact live object
    for (const target of [orphan, stale, { id: 'never-registered' }]) {
      // Identity is decided before the coordination allow-list: no name bypasses unknown.
      for (const name of ['read', 'satellite_node', 'skill', 'list_agents']) {
        const result = await f.call(name, target)
        assert.equal(result.isError, true, name)
        assert.match(result.error.message, /无法确认/)
      }
      assert.equal(f.promptFor(target), '')
    }
    assert.deepEqual(f.executions, [])
  } finally { await f.ctx.fiber.dispose() }
})

test('real PTC executor: coordinator run_code gets the native-only diagnostic and no program runs', async () => {
  const f = await fixture()
  const { apply: applyPtc } = await import('@deepseek-ai/dsh-tool-executor-ptc')
  try {
    let programs = 0
    f.ctx.provide('ptcRuntime', {
      language: 'typescript', programFormat: 'script', sandboxMode: 'read-only',
      resolve: (spec) => spec,
      run: async () => { programs++; return { ok: true } },
    })
    const root = f.agent('root')
    const child = f.agent('child')
    f.roots.push(root)
    await f.mount()
    await f.ctx.plugin({ inject: ['tools', 'systemPrompt', 'ptcRuntime'], apply: applyPtc }, {})
    const batch = (agent, name, args = {}) => f.ctx.tools.execute({
      agent, signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id: `c-${name}`, name, arguments: JSON.stringify(args) }],
    }).then(({ results }) => results[0].result)
    // The real PTC executor rejects a direct native name as UNKNOWN_TOOL before guards…
    const direct = await batch(root, 'satellite_node')
    assert.equal(direct.isError, true)
    assert.doesNotMatch(direct.error.message, /Satellite/)
    // …and admits only run_code, which the coordinator guard denies with the native-only diagnostic.
    const run = await batch(root, 'run_code', { code: 'await tools.read({})' })
    assert.equal(run.isError, true)
    assert.match(run.error.message, /PTC 工具执行器（run_code）.*native/)
    assert.equal(programs, 0, 'a denied run_code never reaches the PTC runtime')
    // A member is not the coordinator: the root guard does not decide for it.
    const member = await batch(child, 'run_code', { code: '1' })
    assert.doesNotMatch(member.isError ? member.error.message : '', /PTC 工具执行器/)
    assert.deepEqual(f.executions, [])
  } finally { await f.ctx.fiber.dispose() }
})
