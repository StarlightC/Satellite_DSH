// Parent-request broker: the implement base child stages exactly one closed
// `plugin_manager` request; only a fully completed node publishes it, and the root
// guard claims it once for the exact parent and exact canonical arguments.
import test from 'node:test'
import assert from 'node:assert/strict'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Private test issuer: stands in for the runtime confirmation of the final tools/result. */
function openTicket(broker, ...args) {
  const audit = broker.publish(...args)
  if (audit?.ticket) broker.confirm(audit.ticket)
  return audit
}

import {
  canonicalJson, createParentGrantBroker, PARENT_REQUEST_TOOL, PARENT_REQUEST_TTL_MS, PARENT_TARGET_TOOL,
  parseParentRequest,
} from '../lib/node/lib/parent-grant.js'

const PARENT_CALL = 'parent-call-1'

function world({ now = () => 1_000_000 } = {}) {
  const parentSession = { id: 'root-session' }
  const parent = {
    id: 'root',
    session: parentSession,
    disposeFns: [],
    ctx: {
      get: () => undefined,
      effect(fn) {
        const dispose = fn()
        if (typeof dispose === 'function') parent.disposeFns.push(dispose)
        return () => {}
      },
    },
  }
  const child = { id: 'child', session: { id: 'child-session' }, ctx: {} }
  const definition = { name: PARENT_TARGET_TOOL, definition: 1 }
  const registered = new Map()
  const childDefs = new Map()
  const agents = new Map([[parent.id, parent]])
  const rootTools = {
    get(name, scope) {
      if (scope === child) return childDefs.get(name)
      if (scope === parent) {
        if (name === PARENT_TARGET_TOOL) return registered.get(PARENT_TARGET_TOOL)
        return undefined
      }
      return undefined
    },
    register: () => () => {},
  }
  registered.set(PARENT_TARGET_TOOL, definition)
  const guards = []
  child.ctx.get = (name) => {
    if (name !== 'tools') return undefined
    return {
      register(tool) { childDefs.set(tool.name, tool); return () => childDefs.delete(tool.name) },
      guard(fn) { guards.push(fn); return () => { const index = guards.indexOf(fn); if (index >= 0) guards.splice(index, 1) } },
      get(name) { return childDefs.get(name) },
    }
  }
  const root = {
    get(name) {
      if (name === 'tools') return rootTools
      if (name === 'agents') return { get: (id) => agents.get(id) }
      return undefined
    },
  }
  const broker = createParentGrantBroker({ defineTool, root, now })
  const controller = new AbortController()
  const flags = { live: true }
  const spec = {
    child, parent, parentSession, nodeId: 'implement', runId: 'run-1', callToken: 'call-token-1',
    parentCallId: PARENT_CALL, signal: controller.signal, live: () => flags.live,
  }
  const bind = (overrides = {}) => broker.issuer.bind({ ...spec, ...overrides })
  const request = (args, execOverrides = {}) => {
    const tool = childDefs.get(PARENT_REQUEST_TOOL)
    return tool.execute(args, { agent: child, callId: 'child-call-1', signal: controller.signal, ...execOverrides })
  }
  const claim = (args, options = {}) => broker.guard.claim({
    name: PARENT_TARGET_TOOL, agent: parent, arguments: args, callId: options.callId ?? 'parent-call-1', ...options,
  })
  return {
    parent, child, definition, registered, childDefs, agents, guardFns: guards, root, broker, controller,
    flags, bind, request, claim,
  }
}

const valid = { reason: '安装前先列出可用 bundle', arguments: { action: 'list_bundles', limit: 10 } }

test('request stages, publish creates one ticket, and the exact parent claims it once', async () => {
  const w = world()
  const unbind = w.bind()
  try {
    const staged = await w.request(valid)
    assert.equal(staged.status, 'proposed')
    assert.equal(staged.tool, PARENT_TARGET_TOOL)
    assert.deepEqual(staged.arguments, valid.arguments)
    assert.equal(staged.source.node, 'implement')
    assert.equal(staged.source.runId, 'run-1')
    assert.equal(w.claim(valid.arguments).kind, 'none', 'nothing is granted before the node completes')
    const published = openTicket(w.broker, 'call-token-1', w.controller.signal)
    assert.equal(published.status, 'ready')
    assert.match(published.ticket, /satellite-parent-request-/)
    const first = w.claim(valid.arguments)
    assert.deepEqual(first, { kind: 'allow' })
    const second = w.claim(valid.arguments)
    assert.equal(second.kind, 'deny')
    assert.match(second.reason, /已使用/)
  } finally { unbind() }
})

test('canonical key order is irrelevant; variant args are denied without consuming the ticket', async () => {
  const w = world()
  w.bind()
  await w.request(valid)
  openTicket(w.broker, 'call-token-1', w.controller.signal)
  assert.equal(w.claim({ limit: 10, action: 'list_bundles' }).kind, 'allow', 'same canonical JSON allows')
  // A separate world: a variant must not spend the real ticket.
  const v = world()
  v.bind()
  await v.request(valid)
  openTicket(v.broker, 'call-token-1', v.controller.signal)
  assert.equal(v.claim({ action: 'list_bundles' }).kind, 'deny', 'missing field is not the exact request')
  assert.equal(v.claim({ action: 'list_bundles', limit: 10, offset: 0 }).kind, 'deny', 'extra field is not the exact request')
  assert.equal(v.claim({ action: 'set_plugin', limit: 10 }).kind, 'deny', 'different action is not the exact request')
  assert.equal(v.claim({ action: 'list_bundles', limit: '10' }).kind, 'deny', 'different type is not the exact request')
  assert.equal(v.claim(valid.arguments).kind, 'allow', 'the exact request still holds after variants')
})

test('closed request validation rejects unsupported plugin_manager inputs', async () => {
  const w = world()
  w.bind()
  // Host schema validation happens before the body; these never reach the parser.
  const schemaRejected = [
    { reason: 'x', arguments: { action: 'set_version_exemption' } },
    { reason: 'x', arguments: { action: 'list_plugins', runtimeVersion: '1.0.0' } },
    { reason: 'x', arguments: { action: 'list_plugins', acceptRisk: true } },
    { reason: 'x', arguments: { action: 'install_bundle', approvedBuilds: [] } },
    { reason: 'x', arguments: { action: 'list_plugins', enabled: 'true' } },
    { reason: 'x', arguments: { action: 'list_plugins', target: 3 } },
    { reason: 'x', arguments: {} },
  ]
  for (const args of schemaRejected) {
    await assert.rejects(() => w.request(args), /invalid arguments/, JSON.stringify(args))
  }
  // The parser independently rejects closed-set violations the host schema cannot
  // express (or that a non-pipeline caller could supply).
  const parserRejected = [
    [{ reason: '', arguments: { action: 'list_plugins' } }, /reason/],
    [{ reason: 'x', arguments: { action: 'list_plugins', offset: -1 } }, /offset/],
    [{ reason: 'x', arguments: { action: 'list_plugins', offset: 1_000_001 } }, /offset/],
    [{ reason: 'x', arguments: { action: 'list_plugins', registry: '' } }, /registry/],
    [{ reason: 'x', arguments: {} }, /缺少 action/],
  ]
  for (const [args, pattern] of parserRejected) {
    assert.throws(() => parseParentRequest(args), pattern, JSON.stringify(args))
  }
  const bodyRejected = [
    { reason: 'x', arguments: { action: 'list_plugins', limit: 0 } },
    { reason: 'x', arguments: { action: 'list_plugins', limit: 101 } },
    { reason: 'x', arguments: { action: 'list_plugins', offset: -1 } },
    { reason: 'x', arguments: { action: 'list_plugins', offset: 1_000_001 } },
    { reason: 'x', arguments: { action: 'list_plugins', registry: '' } },
    { reason: '', arguments: { action: 'list_plugins' } },
  ]
  for (const args of bodyRejected) {
    const value = await w.request(args)
    assert.equal(value.status, 'rejected', JSON.stringify(args))
  }
  // Accessor-shaped input is rejected rather than read.
  const accessor = { reason: 'x', arguments: { action: 'list_plugins' } }
  Object.defineProperty(accessor.arguments, 'limit', { enumerable: true, get: () => 1 })
  assert.throws(() => parseParentRequest(accessor), /访问器/)
})

test('one request per node call (including resume), and only from the bound child scope', async () => {
  const w = world()
  w.bind()
  assert.equal((await w.request(valid)).status, 'proposed')
  const second = await w.request({ reason: 'again', arguments: { action: 'list_plugins' } })
  assert.equal(second.status, 'rejected')
  assert.match(second.note ?? '', /唯一一次/)
  // A non-member agent (even the parent) cannot stage a request.
  const outsider = { id: 'other', session: {}, ctx: {} }
  const tool = w.childDefs.get(PARENT_REQUEST_TOOL)
  const foreign = await tool.execute(valid, { agent: outsider, callId: 'x', signal: w.controller.signal })
  assert.equal(foreign.status, 'rejected')
  assert.match(foreign.note ?? '', /没有有效的父请求绑定/)
})

test('a replaced parent tool definition blocks publish and revokes an open ticket', async () => {
  const w = world()
  w.bind()
  await w.request(valid)
  w.registered.set(PARENT_TARGET_TOOL, { name: PARENT_TARGET_TOOL, definition: 2 })
  const dropped = openTicket(w.broker, 'call-token-1', w.controller.signal)
  assert.equal(dropped.status, 'dropped')
  assert.match(dropped.note ?? '', /定义已变化/)

  const v = world()
  v.bind()
  await v.request(valid)
  openTicket(v.broker, 'call-token-1', v.controller.signal)
  v.registered.set(PARENT_TARGET_TOOL, { name: PARENT_TARGET_TOOL, definition: 2 })
  const denied = v.claim(valid.arguments)
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /定义已替换/)
  assert.equal(v.claim(valid.arguments).kind, 'deny')
})

test('TTL is fixed from request time; resume does not refresh it and expiry drops the ticket', async () => {
  let clock = 5_000_000
  const w = world({ now: () => clock })
  w.bind()
  await w.request(valid)
  clock += PARENT_REQUEST_TTL_MS + 1
  const expired = openTicket(w.broker, 'call-token-1', w.controller.signal)
  assert.equal(expired.status, 'expired')
  assert.match(expired.note ?? '', /10 分钟/)

  let tick = 7_000_000
  const v = world({ now: () => tick })
  v.bind()
  await v.request(valid)
  openTicket(v.broker, 'call-token-1', v.controller.signal)
  tick += PARENT_REQUEST_TTL_MS + 1
  const denied = v.claim(valid.arguments)
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /有效期/)
})

test('parent abort, parent loss, session replacement and row unload revoke delivery', async () => {
  const aborted = world()
  aborted.bind()
  await aborted.request(valid)
  aborted.controller.abort()
  const dropped = openTicket(aborted.broker, 'call-token-1', aborted.controller.signal)
  assert.equal(dropped.status, 'dropped')
  assert.match(dropped.note ?? '', /取消/)

  const missing = world()
  missing.bind()
  await missing.request(valid)
  missing.agents.delete(missing.parent.id)
  assert.equal(openTicket(missing.broker, 'call-token-1', missing.controller.signal).status, 'dropped')

  const replaced = world()
  replaced.bind()
  await replaced.request(valid)
  openTicket(replaced.broker, 'call-token-1', replaced.controller.signal)
  replaced.parent.session = { id: 'new-session' }
  const sessionDenied = replaced.claim(valid.arguments)
  assert.equal(sessionDenied.kind, 'deny')
  assert.match(sessionDenied.reason, /父会话已变化/)

  const unloaded = world()
  unloaded.bind()
  await unloaded.request(valid)
  openTicket(unloaded.broker, 'call-token-1', unloaded.controller.signal)
  unloaded.broker.release()
  // Unload clears the private table; no ticket remains, so nothing is granted.
  assert.equal(unloaded.claim(valid.arguments).kind, 'none')
})

test('parent scope dispose revokes the open ticket', async () => {
  const w = world()
  w.bind()
  await w.request(valid)
  openTicket(w.broker, 'call-token-1', w.controller.signal)
  assert.equal(w.parent.disposeFns.length, 1, 'one parent-scope dispose hook')
  w.parent.disposeFns[0]()
  const denied = w.claim(valid.arguments)
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /已作废/)
})

test('normal child end does not lose a staged request; a new publish voids the old ticket', async () => {
  const w = world()
  const unbind = w.bind()
  await w.request(valid)
  unbind() // child ended normally: the child tool/guard go away, the proposal stays
  assert.equal(w.childDefs.has(PARENT_REQUEST_TOOL), false)
  const published = openTicket(w.broker, 'call-token-1', w.controller.signal)
  assert.equal(published.status, 'ready')

  // Same parent, a second completed node call publishes a new ticket.
  const second = w.bind({ callToken: 'call-token-2', runId: 'run-2' })
  try {
    await w.request({ reason: 'second', arguments: { action: 'list_plugins' } })
    const next = openTicket(w.broker, 'call-token-2', w.controller.signal)
    assert.equal(next.status, 'ready')
    assert.notEqual(next.ticket, published.ticket)
    assert.match(next.note ?? '', /上一条票据已作废/)
    assert.equal(w.claim(valid.arguments).kind, 'deny', 'the old args no longer match any open ticket')
    assert.equal(w.claim({ action: 'list_plugins' }).kind, 'allow')
  } finally { second() }
})

test('binding requires the implement node and a resolvable parent plugin_manager', async () => {
  const w = world()
  assert.throws(() => w.bind({ nodeId: 'context' }), /implement/)
  const dead = world()
  const unbind = dead.bind()
  dead.flags.live = false
  const value = await dead.request(valid)
  assert.equal(value.status, 'rejected')
  assert.match(value.note ?? '', /委派已结束/)
  unbind()
  const missing = world()
  missing.registered.clear()
  assert.throws(() => missing.bind(), /plugin_manager/)
  assert.throws(() => w.bind({ runId: '' }), /runId/)
  assert.throws(() => w.bind({ callToken: '' }), /callToken/)
})

test('the child guard rejects a replaced scoped tool and the broker tool cannot be claimed by another parent', async () => {
  const w = world()
  w.bind()
  const guard = w.guardFns.find((fn) => fn({ name: PARENT_REQUEST_TOOL, agent: w.child, arguments: {} }) === undefined)
  assert.ok(guard)
  await w.request(valid)
  const original = w.childDefs.get(PARENT_REQUEST_TOOL)
  w.childDefs.set(PARENT_REQUEST_TOOL, { name: PARENT_REQUEST_TOOL, replaced: true })
  assert.match(guard({ name: PARENT_REQUEST_TOOL, agent: w.child, arguments: {} }) ?? '', /替换/)
  w.childDefs.set(PARENT_REQUEST_TOOL, original)
  const other = { id: 'root-2', session: w.parent.session, ctx: { get: () => undefined } }
  openTicket(w.broker, 'call-token-1', w.controller.signal)
  assert.equal(w.broker.guard.claim({ name: PARENT_TARGET_TOOL, agent: other, arguments: valid.arguments }).kind, 'none')
  assert.equal(w.claim(valid.arguments).kind, 'allow')
})

test('canonicalJson sorts keys and rejects non-JSON values', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: true, c: null }] }), '{"a":[{"c":null,"d":true}],"b":1}')
  assert.throws(() => canonicalJson({ a: undefined }), /无损 JSON/)
  assert.throws(() => canonicalJson({ a: Number.NaN }), /有限数字/)
  assert.throws(() => canonicalJson({ a: 1n }), /无损 JSON/)
})

/** Count live abort listeners on a real AbortSignal without replacing its behaviour. */
function tracked(signal) {
  const live = new Set()
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  signal.addEventListener = (type, fn, opts) => { if (type === 'abort') live.add(fn); return add(type, fn, opts) }
  signal.removeEventListener = (type, fn, opts) => { if (type === 'abort') live.delete(fn); return remove(type, fn, opts) }
  return live
}

test('claim fails closed on an aborted source even when no abort listener ran', async () => {
  const w = world()
  w.bind()
  await w.request(valid)
  const resume = new AbortController()
  resume.signal.addEventListener = () => {} // a listener that never fires
  openTicket(w.broker, 'call-token-1', resume.signal, 'resume-call')
  resume.abort()
  const denied = w.claim(valid.arguments)
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /已取消/)
})

test('an old ticket source abort does not revoke a newer ticket for the same parent', async () => {
  const w = world()
  const unbind = w.bind()
  await w.request(valid)
  const first = new AbortController()
  assert.equal(openTicket(w.broker, 'call-token-1', first.signal, 'p-1').status, 'ready')
  unbind()
  const second = new AbortController()
  const unbindSecond = w.bind({ callToken: 'call-token-2', runId: 'run-2', signal: second.signal })
  try {
    const staged = await w.request({ reason: 'second', arguments: { action: 'list_plugins' } }, { signal: second.signal })
    assert.equal(staged.status, 'proposed')
    assert.equal(openTicket(w.broker, 'call-token-2', second.signal, 'p-2').status, 'ready')
    first.abort()
    w.controller.abort() // the first staging call's signal, too
    assert.equal(w.claim({ action: 'list_plugins' }).kind, 'allow', 'the newer ticket survives the old abort')
  } finally { unbindSecond() }
})

test('normal completion keeps the ticket valid; consume, new ticket and release detach listeners', async () => {
  const w = world()
  const staging = tracked(w.controller.signal)
  w.bind()
  await w.request(valid)
  const resume = new AbortController()
  const publishing = tracked(resume.signal)
  openTicket(w.broker, 'call-token-1', resume.signal, 'resume-call')
  assert.equal(staging.size, 1)
  assert.equal(publishing.size, 1)
  // The calls completed without aborting; the ticket stays valid.
  assert.equal(w.claim(valid.arguments).kind, 'allow')
  assert.equal(staging.size, 0, 'consume removes the staging listener')
  assert.equal(publishing.size, 0, 'consume removes the publishing listener')

  const r = world()
  const live = tracked(r.controller.signal)
  r.bind()
  await r.request(valid)
  openTicket(r.broker, 'call-token-1', r.controller.signal)
  assert.equal(live.size, 1, 'one listener when staging and publishing share a signal')
  r.broker.release()
  assert.equal(live.size, 0, 'release removes listeners')
})
