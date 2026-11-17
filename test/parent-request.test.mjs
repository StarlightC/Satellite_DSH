// Parent-request broker: a non-read-only base child stages exactly one generic
// `{tool, arguments}` request for an existing parent tool; only a fully completed node
// publishes it, and the root guard claims it once for the exact parent and exact
// canonical arguments. Tool fixtures here never execute anything.
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
  canonicalJson, createParentGrantBroker, PARENT_REQUEST_TOOL, PARENT_REQUEST_TTL_MS,
  parseParentRequest,
} from '../lib/node/lib/parent-grant.js'

const PARENT_TARGET_TOOL = 'plugin_manager'
/** Fixture definitions with real JSON Schema parameters; no execute body is ever run. */
const pmParameters = {
  type: 'object',
  properties: {
    action: { type: 'string' }, target: { type: 'string' }, enabled: { type: 'boolean' },
    registry: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' },
  },
  required: ['action'],
}
const bashParameters = {
  type: 'object',
  properties: {
    description: { type: 'string' }, command: { type: 'string' },
    sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'] },
    justification: { type: 'string' },
  },
  required: ['description', 'command'],
  additionalProperties: false,
}

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
  const definition = { name: PARENT_TARGET_TOOL, definition: 1, parameters: pmParameters }
  const registered = new Map([['bash', { name: 'bash', parameters: bashParameters }]])
  const conditional = new Set()
  const childDefs = new Map()
  const agents = new Map([[parent.id, parent]])
  const rootTools = {
    get(name, scope) {
      if (scope === child) return childDefs.get(name) ?? registered.get(name)
      if (scope === parent) return registered.get(name)
      return undefined
    },
    executable(name, scope) {
      return conditional.has(name) ? undefined : rootTools.get(name, scope)
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
  const flags = { live: true, parentMode: 'workspace-write' }
  const spec = {
    child, parent, parentSession, nodeId: 'implement', runId: 'run-1', callToken: 'call-token-1',
    parentCallId: PARENT_CALL, signal: controller.signal, live: () => flags.live,
    childMode: 'workspace-write', parentMode: () => flags.parentMode,
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
    parent, child, definition, registered, conditional, childDefs, agents, guardFns: guards, root, broker, controller,
    flags, bind, request, claim,
  }
}

const valid = { tool: PARENT_TARGET_TOOL, reason: '安装前先列出可用 bundle', arguments: { action: 'list_bundles', limit: 10 } }

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

test('generic request validation: shape, excluded targets, target schema, visibility and role', async () => {
  // Generic shape only; no plugin_manager business allow-list remains.
  const parserRejected = [
    [{ arguments: {} }, /tool/],
    [{ tool: 'bad name', arguments: {} }, /tool/],
    [{ tool: 'satellite_node', arguments: {} }, /不能作为父请求目标/],
    [{ tool: 'run_code', arguments: {} }, /不能作为父请求目标/],
    [{ tool: PARENT_REQUEST_TOOL, arguments: {} }, /不能作为父请求目标/],
    [{ tool: 'subagent', arguments: {} }, /不受控的委派/],
    [{ tool: 'bash', arguments: 'ls' }, /普通对象/],
    [{ tool: 'bash', arguments: { command: 'x'.repeat(70_000) } }, /超过/],
  ]
  for (const [args, pattern] of parserRejected) {
    assert.throws(() => parseParentRequest(args), pattern, JSON.stringify(args).slice(0, 80))
  }
  const accessor = { tool: 'bash', arguments: { command: 'ls' } }
  Object.defineProperty(accessor.arguments, 'description', { enumerable: true, get: () => 'x' })
  assert.throws(() => parseParentRequest(accessor), /访问器/)
  // Former plugin_manager business fields are only judged by the target's own schema.
  assert.equal(parseParentRequest({ tool: 'plugin_manager', arguments: { action: 'set_version_exemption', acceptRisk: true } }).tool, 'plugin_manager')

  const w = world()
  w.bind()
  const schema = await w.request({ tool: 'bash', arguments: { command: 'ls', extra: 1 } })
  assert.equal(schema.status, 'rejected')
  assert.match(schema.note ?? '', /schema/)
  const unknown = await w.request({ tool: 'missing_tool', arguments: {} })
  assert.match(unknown.note ?? '', /父作用域没有可直接执行的 missing_tool/)
  w.conditional.add('bash')
  const conditional = await w.request({ tool: 'bash', arguments: { description: 'd', command: 'ls' } })
  assert.match(conditional.note ?? '', /条件注册/)

  const denied = world()
  denied.bind({ toolFilter: { deny: ['bash'] } })
  const role = await denied.request({ tool: 'bash', arguments: { description: 'd', command: 'ls' } })
  assert.equal(role.status, 'rejected')
  assert.match(role.note ?? '', /来源角色不允许 bash/)
})

test('read-only source or a wider parent provides no capability; a later widening revokes the ticket', async () => {
  const w = world()
  assert.throws(() => w.bind({ childMode: 'read-only' }), /只读/)
  w.flags.parentMode = 'danger-full-access'
  assert.throws(() => w.bind(), /更宽/)
  assert.match(w.broker.issuer.unavailableReason('workspace-write', 'danger-full-access') ?? '', /更宽/)

  const v = world()
  v.bind()
  await v.request(valid)
  openTicket(v.broker, 'call-token-1', v.controller.signal)
  v.flags.parentMode = 'danger-full-access'
  const denied = v.claim(valid.arguments)
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /更宽/)
  v.flags.parentMode = 'workspace-write'
  assert.equal(v.claim(valid.arguments).kind, 'deny', 'revoked for good')
})

test('dynamic bash and Gradle command strings use the same exact one-shot mechanism', async () => {
  const gradle = { description: 'build', command: './gradlew :app:assembleDebug --offline', sandbox_permissions: 'danger-full-access', justification: '需要访问 Gradle 缓存' }
  for (const args of [{ description: 'list', command: 'ls -la src' }, gradle]) {
    const w = world()
    w.bind()
    const staged = await w.request({ tool: 'bash', arguments: args })
    assert.equal(staged.status, 'proposed', staged.note)
    assert.equal(openTicket(w.broker, 'call-token-1', w.controller.signal).tool, 'bash')
    const claim = (a, name = 'bash') => w.claim(a, { name })
    assert.equal(claim(args, 'plugin_manager').kind, 'none', 'a ticket covers only its own tool')
    assert.equal(claim({ ...args, command: `${args.command} ` }).kind, 'deny', 'command text is matched exactly')
    if (args.sandbox_permissions) {
      const { sandbox_permissions: _omit, ...without } = args
      assert.equal(claim(without).kind, 'deny', 'omitted sandbox_permissions differs from the explicit value')
    }
    assert.equal(claim(args).kind, 'allow')
    assert.equal(claim(args).kind, 'deny', 'one exact call only')
  }
})

test('one request per node call (including resume), and only from the bound child scope', async () => {
  const w = world()
  w.bind()
  assert.equal((await w.request(valid)).status, 'proposed')
  const second = await w.request({ tool: PARENT_TARGET_TOOL, reason: 'again', arguments: { action: 'list_plugins' } })
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
  w.registered.set(PARENT_TARGET_TOOL, { name: PARENT_TARGET_TOOL, definition: 2, parameters: pmParameters })
  const dropped = openTicket(w.broker, 'call-token-1', w.controller.signal)
  assert.equal(dropped.status, 'dropped')
  assert.match(dropped.note ?? '', /定义已变化/)

  const v = world()
  v.bind()
  await v.request(valid)
  openTicket(v.broker, 'call-token-1', v.controller.signal)
  v.registered.set(PARENT_TARGET_TOOL, { name: PARENT_TARGET_TOOL, definition: 2, parameters: pmParameters })
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
    await w.request({ tool: PARENT_TARGET_TOOL, reason: 'second', arguments: { action: 'list_plugins' } })
    const next = openTicket(w.broker, 'call-token-2', w.controller.signal)
    assert.equal(next.status, 'ready')
    assert.notEqual(next.ticket, published.ticket)
    assert.match(next.note ?? '', /上一条票据已作废/)
    assert.equal(w.claim(valid.arguments).kind, 'deny', 'the old args no longer match any open ticket')
    assert.equal(w.claim({ action: 'list_plugins' }).kind, 'allow')
  } finally { second() }
})

test('binding needs identity and lifecycle; any base node may bind', async () => {
  const w = world()
  assert.throws(() => w.bind({ nodeId: '' }), /nodeId/)
  const dead = world()
  const unbind = dead.bind()
  dead.flags.live = false
  const value = await dead.request(valid)
  assert.equal(value.status, 'rejected')
  assert.match(value.note ?? '', /委派已结束/)
  unbind()
  const validateNode = world()
  validateNode.bind({ nodeId: 'validate' })
  assert.equal((await validateNode.request(valid)).status, 'proposed')
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
    const staged = await w.request({ tool: PARENT_TARGET_TOOL, reason: 'second', arguments: { action: 'list_plugins' } }, { signal: second.signal })
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
