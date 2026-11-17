// Real ToolRuntime/pipeline evidence for the parent-request root guard:
// - a host pre-execute policy `ask` runs BEFORE guards, so a wrong-argument call may
//   already have been approved by the host; the broker guard still keeps it out of the
//   target tool body (the plugin does not change host approval);
// - concurrent identical calls against one ticket: at most one reaches the body.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'

/** Private test issuer: stands in for the runtime confirmation of the final tools/result. */
function openTicket(broker, ...args) {
  const audit = broker.publish(...args)
  if (audit?.ticket) broker.confirm(audit.ticket)
  return audit
}

import { createParentGrantBroker, PARENT_REQUEST_TOOL } from '../lib/node/lib/parent-grant.js'

const PARENT_TARGET_TOOL = 'plugin_manager'

async function world() {
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools: () => () => {}, getSectionOrder: () => 800, section: () => () => {} })
  const asks = []
  ctx.provide('approval', { async request(request) { asks.push(request); return 'allowed-once' } })
  await ctx.plugin(ToolRuntime)
  // Host policy: every plugin_manager call asks first (pre-execute, before guards).
  ctx.on('tools/pre-execute', (exec, next) => (exec.name === PARENT_TARGET_TOOL ? { kind: 'ask', reason: 'policy' } : next()))

  const bodies = []
  ctx.tools.register(defineTool({
    name: PARENT_TARGET_TOOL,
    description: 'fixture plugin_manager (never installs anything)',
    parameters: { action: { type: 'string', required: true }, limit: { type: 'number' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) { bodies.push({ args, callId: exec.callId }); return 'ok' },
  }))

  const parentSession = { id: 'root-session' }
  const parent = { id: 'root', session: parentSession, ctx: { get: () => undefined } }
  const childDefs = new Map()
  const child = {
    id: 'child', session: {}, ctx: {
      get: (name) => name === 'tools'
        ? { register(t) { childDefs.set(t.name, t); return () => childDefs.delete(t.name) }, guard: () => () => {} }
        : undefined,
    },
  }
  const definition = ctx.tools.get(PARENT_TARGET_TOOL, parent)
  assert.ok(definition, 'the parent resolves the real registered plugin_manager definition')
  // The real registry decides get/executable; the fake child sees the global view.
  const rootTools = {
    get: (name, scope) => (scope === child ? childDefs.get(name) ?? ctx.tools.get(name) : ctx.tools.get(name, scope)),
    executable: (name, scope) => ctx.tools.executable(name, scope),
  }
  const broker = createParentGrantBroker({
    defineTool,
    root: { get: (name) => name === 'tools' ? rootTools : name === 'agents' ? { get: (id) => (id === parent.id ? parent : undefined) } : undefined },
  })
  // Same shape as the coordinator boundary: claim only for plugin_manager.
  ctx.tools.guard((exec) => {
    const claim = broker.guard.claim({ name: exec.name, agent: exec.agent, arguments: exec.arguments, callId: exec.callId })
    return claim.kind === 'deny' ? claim.reason : undefined
  })
  const signal = new AbortController().signal
  broker.issuer.bind({
    child, parent, parentSession, nodeId: 'implement', runId: 'run-1', callToken: 't1',
    parentCallId: 'p1', signal, live: () => true, childMode: 'workspace-write', parentMode: () => 'workspace-write',
  })
  const staged = await childDefs.get(PARENT_REQUEST_TOOL).execute(
    { tool: PARENT_TARGET_TOOL, reason: 'list first', arguments: { action: 'list_bundles', limit: 10 } },
    { agent: child, callId: 'c1', signal },
  )
  assert.equal(staged.status, 'proposed')
  assert.equal(openTicket(broker, 't1', signal, 'p1').status, 'ready')

  const pipeline = new ToolExecutionPipeline(ctx)
  const call = async (args, callId) => {
    const prepared = await pipeline.prepare({ name: PARENT_TARGET_TOOL, callId, arguments: args, agent: parent, signal })
    if (prepared.kind !== 'dispatch') return prepared
    const outcome = await pipeline.dispatch(prepared.exec)
    await pipeline.complete(prepared.exec, outcome)
    return { kind: 'ran', outcome }
  }
  return { asks, bodies, call }
}

test('real pipeline: policy ask may approve first, but wrong arguments never enter the plugin_manager body', async () => {
  const w = await world()
  const wrong = await w.call({ action: 'list_bundles', limit: 99 }, 'pm-wrong')
  assert.equal(w.asks.length, 1, 'the host pre-execute ask ran before the guard (unchanged host approval)')
  assert.notEqual(wrong.kind, 'ran')
  const text = JSON.stringify(wrong.result)
  assert.match(text, /未执行工具主体/)
  assert.match(text, /未进入目标工具主体内的审批/)
  assert.equal(w.bodies.length, 0, 'the body never ran for wrong arguments')

  // The ticket was not consumed by the mismatch: the exact call still runs once.
  const exact = await w.call({ limit: 10, action: 'list_bundles' }, 'pm-exact')
  assert.equal(exact.kind, 'ran')
  assert.equal(w.bodies.length, 1)
})

test('real pipeline: concurrent identical calls on one ticket reach the body at most once', async () => {
  const w = await world()
  const args = { action: 'list_bundles', limit: 10 }
  const results = await Promise.all([w.call(args, 'pm-a'), w.call(args, 'pm-b'), w.call(args, 'pm-c')])
  assert.equal(w.bodies.length, 1, 'exactly one call entered the body')
  assert.equal(results.filter((r) => r.kind === 'ran').length, 1)
  assert.equal(results.filter((r) => /已使用过/.test(JSON.stringify(r.result ?? ''))).length, 2)
})

