import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { registerCoordinatorBoundary } from '../lib/node/lib/wiring.js'
import { apply as applyNode, inject } from '../lib/node/index.js'

const WORK = ['read', 'write', 'bash', 'subagent', 'subagent_fork', 'workflow', 'send_message']
const COORDINATION = ['satellite_node', 'skill', 'ask_user_question', 'todo_write', 'list_agents']

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
    section(section) {
      sections.push(section)
      return () => {
        const index = sections.indexOf(section)
        if (index >= 0) sections.splice(index, 1)
      }
    },
  })
  ctx.provide('agents', { roots: () => roots })
  await ctx.plugin(ToolRuntime)
  for (const name of register) ctx.tools.register(defineTool({
    name, description: name, parameters: {},
    output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
    execute(args, exec) {
      executions.push({ name, agent: exec.agent })
      return name
    },
  }))
  const agent = id => ({ id })
  const call = (name, target) => ctx.tools.execute({
    name, arguments: {}, callId: `call-${++calls}`,
    signal: new AbortController().signal,
    ...(target ? { agent: target } : {}),
  })
  const mount = () => ctx.plugin({ inject: ['tools', 'agents', 'systemPrompt'], apply: registerCoordinatorBoundary })
  const promptFor = scope => sections.map(section => section.text({ scope })).filter(Boolean).join('\n')
  return { ctx, agent, call, mount, promptFor, roots, executions }
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
