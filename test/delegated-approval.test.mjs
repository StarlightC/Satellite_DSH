// Delegated-approval broker: a Satellite role child (approval pinned to never)
// routes exactly one approval per tool call to the exact live delegating parent.
import test from 'node:test'
import assert from 'node:assert/strict'

import { createCallGate, createDelegatedApprovalBroker } from '../lib/delegated-approval.js'
import { runCapture } from '../src/android/lib/execution/capture.ts'
import { runJourney } from '../src/android/lib/execution/journey.ts'
import { createDeviceCleanup } from '../src/android/lib/execution/cleanup.ts'
import { runBounded } from '../src/lib/bounded-process.ts'

const SERVICES = ['fs', 'sandbox', 'subprocess', 'sandboxPolicy']

function fakeSpawn(effects, argv) {
  effects.push(argv.join(' '))
  const reader = { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }
  return {
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate() {}, async waitForExit() { return true },
    collected: { stdout: reader, stderr: reader },
  }
}

function world(options = {}) {
  const parentSession = { id: 'root-session' }
  const childSession = { id: 'child-session' }
  const asked = []
  const parentApproval = {
    answer: options.answer ?? 'allowed-once',
    policy: options.policy ?? 'ask',
    config: { policy: 'ask' },
    overrideOf() { return this.policy },
    async request(req) {
      asked.push(req)
      if (options.onAsk) await options.onAsk(req)
      if (req.signal.aborted) return 'cancelled'
      return typeof this.answer === 'function' ? this.answer(req) : this.answer
    },
  }
  if (options.noPolicy) delete parentApproval.overrideOf
  const childAsked = []
  const effects = []
  const childPolicy = { mode: options.childMode ?? 'workspace-write', workspaceRoot: '/w' }
  const child_services = {
    approval: { async request(req) { childAsked.push(req); return 'rejected' } }, // pinned never
    sandboxPolicy: { resolve: () => ({ ...childPolicy }) },
    sandbox: { async confine(argv) { return { argv: [...argv], enforcement: 'full', denialSignatures: [] } } },
    subprocess: { spawn: (spec) => fakeSpawn(effects, spec.argv) },
    fs: {
      async stat() { return undefined },
      async writeText(target, content) { effects.push(`write ${target}`); return { ok: true } },
    },
    shell: { async execute(spec) { effects.push(`shell ${spec.command}`); return {} } },
  }
  const services = { approval: parentApproval }
  const parent = { id: 'root', session: parentSession, ctx: { get: (name) => services[name] } }
  const child = { id: 'child', session: childSession, ctx: { get: (name) => child_services[name] } }
  const tool = { name: 'satellite_x' }
  const nodeCall = new AbortController()
  const flags = { live: true, toolOf: () => tool }
  const broker = createDelegatedApprovalBroker()
  const unbind = broker.issuer.bind({
    child, childSession, parent, parentSession, runId: 'run-1', parentCallId: 'parent-call',
    signal: nodeCall.signal, live: () => flags.live, toolOf: (name) => flags.toolOf(name),
  })
  const consumer = broker.consumer()
  const call = (callId, agent = child) => {
    const controller = new AbortController()
    const exec = { agent, callId, signal: controller.signal }
    const gate = createCallGate({
      consumer, exec, tool: () => tool, toolName: 'satellite_x',
      childApproval: () => agent.ctx.get('approval'), services: SERVICES,
    })
    const own = { sandbox: agent.ctx.get('sandbox'), subprocess: agent.ctx.get('subprocess'), fs: agent.ctx.get('fs'), shell: agent.ctx.get('shell') }
    const svc = gate.wrap(own)
    const ask = (plan = 'plan A') => gate.approval.request({ agent, toolName: 'satellite_x', callId, reason: plan, signal: controller.signal })
    // Consumer pattern: only an allowed-once outcome proceeds to the gated confine → spawn.
    const spawn = (mode = 'workspace-write') => runBounded(svc, {
      executable: '/bin/true', args: [], cwd: '/w', mode, workspaceRoot: '/w', timeoutMs: 1000, outputMaxBytes: 1024,
    }, controller.signal)
    const run = async (plan) => {
      const outcome = await ask(plan)
      if (outcome !== 'allowed-once') return outcome
      const result = await spawn()
      return result.ok ? outcome : `failed: ${result.failure.message}`
    }
    return { exec, gate, ask, run, spawn, svc, controller }
  }
  return {
    parent, child, parentSession, childSession, services, child_services, childPolicy, parentApproval,
    childAsked, asked, tool, flags, nodeCall, broker, unbind, consumer, call, effects,
  }
}

test('child pinned never: allowed-once from the parent answerer runs exactly once', async () => {
  const w = world()
  const { run } = w.call('child-call-1')
  assert.equal(await run('Run adb devices'), 'allowed-once')
  assert.equal(w.effects.length, 1)
  assert.equal(w.asked.length, 1)
  assert.equal(w.asked[0].agent, w.parent, 'asked of the exact parent object')
  assert.equal(w.asked[0].callId, 'parent-call', 'tagged with the parent satellite_node call')
  assert.match(w.asked[0].reason, /child call child-call-1/)
  assert.match(w.asked[0].reason, /Run adb devices/)
  assert.equal(w.childAsked.length, 0, 'child approval (never) is not consulted')
})

for (const [answer, outcome, detail] of [
  ['rejected', 'rejected', /parent user rejected/],
  ['unavailable', 'unavailable', /no parent approval answerer/],
  ['cancelled', 'cancelled', /cancelled/],
]) {
  test(`parent ${answer}: zero effect and an explicit reason`, async () => {
    const w = world({ answer })
    const { run, gate } = w.call('c1')
    assert.equal(await run(), outcome)
    assert.equal(w.effects.length, 0)
    assert.match(gate.denial, detail)
  })
}

test('parent policy never or unreadable: fail closed without asking', async () => {
  for (const [opts, reason] of [[{ policy: 'never' }, /policy is "never"/], [{ noPolicy: true }, /policy unavailable/]]) {
    const w = world(opts)
    const { run, gate } = w.call('c1')
    assert.equal(await run(), 'unavailable')
    assert.equal(w.asked.length, 0)
    assert.match(gate.denial, reason)
    assert.equal(w.effects.length, 0)
  }
})

test('same approval service object switches to never after approval: every permit check re-reads it', async () => {
  const w = world()
  const { ask, spawn, gate } = w.call('c1')
  assert.equal(await ask(), 'allowed-once')
  w.parentApproval.policy = 'never'
  assert.throws(() => gate.check(), /policy is "never"/)
  const result = await spawn()
  assert.equal(result.ok, false)
  assert.equal(w.effects.length, 0)
  // And back to an unreadable policy (override dropped and no default): still denied.
  w.parentApproval.policy = undefined
  w.parentApproval.config = {}
  assert.throws(() => gate.check(), /policy unavailable/)
})

test('lost delegation, replaced child or parent Session, shadowed tool, replaced service: never asked, zero effect', async () => {
  const cases = [
    ['live', (w) => { w.flags.live = false }, /no longer live/],
    ['child session', (w) => { w.child.session = { id: 'other' } }, /child session replaced/],
    ['parent session', (w) => { w.parent.session = { id: 'other' } }, /parent session replaced/],
    ['tool', (w) => { w.flags.toolOf = () => ({}) }, /canonical/],
    ['service', (w) => { w.services.approval = { request: async () => 'allowed-once', overrideOf: () => 'ask' } }, /approval service unavailable or changed/],
    ['node aborted', (w) => { w.nodeCall.abort() }, /cancelled/],
  ]
  for (const [name, mutate, reason] of cases) {
    const w = world()
    mutate(w)
    const { run, gate } = w.call('c1')
    assert.equal(await run(), 'unavailable', name)
    assert.equal(w.asked.length, 0, name)
    assert.match(gate.denial, reason, name)
    assert.equal(w.effects.length, 0, name)
  }
})

test('old binding, released issuer or an unbound sibling: no parent route, child never stays rejected (no root fallback)', async () => {
  const w = world()
  w.unbind()
  assert.equal(await w.call('c1').run(), 'rejected')
  assert.equal(w.childAsked.length, 1, 'the child\'s own never policy answered')
  const sibling = { id: 'sibling', session: {}, ctx: { get: (name) => (name === 'approval' ? { request: async () => 'rejected' } : w.child_services[name]) } }
  assert.equal(await w.call('c2', sibling).run(), 'rejected')
  assert.equal(w.asked.length, 0)
  assert.equal(w.effects.length, 0)
  const v = world()
  v.broker.issuer.release()
  assert.equal(await v.call('c1').run(), 'rejected')
  assert.equal(v.asked.length, 0)
  assert.throws(() => v.broker.issuer.bind({}), /released/)
  // Revoked between gate creation and the ask: a delegated gate never falls back to direct.
  const u = world()
  const late = u.call('c1')
  u.unbind()
  assert.equal(await late.run(), 'unavailable')
  assert.match(late.gate.denial, /delegation ended/)
  assert.equal(u.childAsked.length + u.asked.length, 0)
})

test('same callId replay or a changed plan for the same call: one question only', async () => {
  const w = world()
  const first = w.call('same')
  assert.equal(await first.run('plan A'), 'allowed-once')
  const again = w.call('same')
  assert.equal(await again.run('plan B'), 'unavailable')
  assert.match(again.gate.denial, /already used its one parent approval/)
  assert.equal(w.asked.length, 1)
  assert.equal(w.effects.length, 1)
})

test('changes after approval (revoke, parent, unload, approval/child service swap, child policy narrowed): zero new effects', async () => {
  for (const [name, mutate, reason] of [
    ['revoked', (w) => w.unbind(), /delegation ended/],
    ['parent replaced', (w) => { w.parent.session = {} }, /parent session replaced/],
    ['consumer unloaded', (w) => w.consumer.dispose(), /unloaded/],
    ['approval swapped', (w) => { w.services.approval = { request: async () => 'allowed-once', overrideOf: () => 'ask' } }, /approval service/],
    ['child subprocess replaced', (w) => { w.child_services.subprocess = { spawn: (spec) => fakeSpawn(w.effects, spec.argv) } }, /subprocess service replaced/],
    ['child sandbox replaced', (w) => { w.child_services.sandbox = { confine: async (argv) => ({ argv, enforcement: 'full' }) } }, /sandbox service replaced/],
    ['child policy narrowed', (w) => { w.childPolicy.mode = 'read-only' }, /sandbox policy changed/],
  ]) {
    const w = world()
    const { ask, spawn, gate, svc } = w.call('c1')
    assert.equal(await ask(), 'allowed-once', name)
    mutate(w)
    assert.throws(() => gate.check(), reason, name)
    assert.equal((await spawn()).ok, false, name)
    await assert.rejects(async () => svc.fs.writeText('/w/x', 'y', {}, undefined, { mode: 'workspace-write', workspaceRoot: '/w' }), reason, name)
    assert.equal(w.effects.length, 0, name)
  }
  // Mutation while the answer is pending: denied after approval, nothing ran.
  const w = world({ onAsk: async () => { w.childPolicy.mode = 'read-only' } })
  const { run, gate } = w.call('c1')
  assert.equal(await run(), 'unavailable')
  assert.match(gate.denial, /after approval/)
  assert.equal(w.effects.length, 0)
})

test('child policy changes during the final confine await: no spawn', async () => {
  const w = world()
  const real = w.child_services.sandbox.confine
  w.child_services.sandbox.confine = async (...args) => { const out = await real(...args); w.childPolicy.workspaceRoot = '/elsewhere'; return out }
  const { ask, spawn } = w.call('c1')
  assert.equal(await ask(), 'allowed-once')
  const result = await spawn()
  assert.equal(result.ok, false)
  assert.match(result.failure.message, /sandbox policy changed/)
  assert.equal(w.effects.length, 0)
})

test('danger cap: no selected mode may exceed the child limit; an automatic unconfined run is refused', async () => {
  const w = world()
  const { ask, spawn, svc } = w.call('c1')
  // Pre-approval: reads pass, side effects do not.
  assert.equal(await svc.fs.stat('/w/x'), undefined)
  await assert.rejects(async () => svc.fs.writeText('/w/x', 'y', {}, undefined, { mode: 'read-only', workspaceRoot: '/w' }), /no parent approval/)
  assert.equal(await ask(), 'allowed-once')
  // danger-full-access skips confine inside runBounded: refused at spawn.
  const danger = await spawn('danger-full-access')
  assert.equal(danger.ok, false)
  assert.match(danger.failure.message, /unconfined process is wider/)
  await assert.rejects(async () => svc.sandbox.confine(['/bin/true'], { mode: 'danger-full-access', workspaceRoot: '/w' }), /wider than the child/)
  await assert.rejects(async () => svc.sandbox.confine(['/bin/true'], { mode: 'workspace-write', workspaceRoot: '/' }), /root differs/)
  await assert.rejects(async () => svc.sandbox.confine(['/bin/true'], { mode: 'workspace-write', workspaceRoot: '/w', additionalWritableRoots: ['/etc'] }), /writable roots/)
  assert.throws(() => svc.subprocess.spawn({ argv: ['/bin/true'] }), /unconfined process/)
  await assert.rejects(async () => svc.fs.writeText('/w/x', 'y', {}, undefined), /explicit sandbox policy/)
  await assert.rejects(async () => svc.shell.execute({ command: 'x', sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: '/w' } }), /wider/)
  assert.equal(w.effects.length, 0)
  // Narrower than the child is fine.
  assert.equal((await spawn('read-only')).ok, true)
  assert.equal(w.effects.length, 1)
  // A child whose own policy is danger-full-access may run at that limit.
  const d = world({ childMode: 'danger-full-access' })
  const dc = d.call('c1')
  assert.equal(await dc.ask(), 'allowed-once')
  assert.equal((await dc.spawn('danger-full-access')).ok, true)
})

test('non-delegated callers keep their own services and approval unchanged', async () => {
  const w = world()
  w.unbind()
  const own = w.child_services
  const gate = createCallGate({ consumer: w.consumer, exec: { agent: w.child, callId: 'x', signal: new AbortController().signal },
    tool: () => w.tool, toolName: 'satellite_x', childApproval: () => own.approval, services: SERVICES })
  assert.equal(gate.delegated, false)
  const services = { fs: own.fs }
  assert.equal(gate.wrap(services), services)
  assert.doesNotThrow(() => gate.check())
})

test('cancellation and release after approval: zero effect', async () => {
  const w = world()
  const { ask, gate, controller } = w.call('c1')
  assert.equal(await ask(), 'allowed-once')
  controller.abort()
  assert.throws(() => gate.check(), /cancelled/)
  const v = world()
  const call = v.call('c2')
  assert.equal(await call.ask(), 'allowed-once')
  call.gate.release()
  assert.throws(() => call.gate.check(), /released/)
})

test('two concurrent calls: questions are serialized and one call’s grant never covers the other', async () => {
  let release
  const blocker = new Promise((resolve) => { release = resolve })
  const order = []
  const w = world({
    onAsk: async (req) => { order.push(`ask:${/child call (\S+)\./.exec(req.reason)[1]}`); if (order.length === 1) await blocker },
    answer: (req) => (/child call a\./.test(req.reason) ? 'allowed-once' : 'rejected'),
  })
  const a = w.call('a'), b = w.call('b')
  const pa = a.run(), pb = b.run()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(order, ['ask:a'], 'second question waits for the first answer')
  release()
  assert.equal(await pa, 'allowed-once')
  assert.equal(await pb, 'rejected')
  assert.deepEqual(order, ['ask:a', 'ask:b'])
  assert.equal(w.effects.length, 1)
  assert.throws(() => b.gate.check(), /no parent approval/, 'b has no permit: every side effect is refused')
  assert.match(b.gate.denial, /rejected/)
})

test('binding needs exact identities; double bind of one child refused', () => {
  const broker = createDelegatedApprovalBroker()
  assert.equal(typeof broker.claimIssuer, 'undefined', 'no public claim entry')
  assert.throws(() => broker.issuer.bind({ child: {}, parent: {}, runId: 'r', live: () => true, toolOf: () => {} }), /incomplete/)
  const child = { id: 'c' }, parent = { id: 'p' }
  const spec = { child, parent, runId: 'r', parentCallId: 'pc', signal: new AbortController().signal, live: () => true, toolOf: () => {} }
  broker.issuer.bind(spec)
  assert.throws(() => broker.issuer.bind(spec), /already bound/)
})

/* ----------------------------------------------------- bounded device cleanup */

function deviceDeps(w, gateCall, extra = {}) {
  const raw = { sandbox: w.child_services.sandbox, subprocess: w.child_services.subprocess }
  const binding = { root: '/w', mode: 'workspace-write', workspaceRoot: '/w' }
  const cleanup = createDeviceCleanup({ runner: raw, adbPath: '/usr/bin/adb', serial: 'emu-1', binding })
  return {
    fs: {
      async resolve(path, options = {}) { return `${options.cwd ?? '/w'}/${path}` },
      async stat(target) { return target === '/w/out' || target === '/w/.' ? { type: 'directory' } : undefined },
      processPath: (t) => t, async readBytes() { return new Uint8Array() },
      async writeText() { w.effects.push('write'); return {} },
    },
    sandbox: gateCall.svc.sandbox, subprocess: gateCall.svc.subprocess,
    binding, exec: gateCall.exec, adbPath: '/usr/bin/adb', operationTimeoutMs: 60_000, outputMaxBytes: 65536,
    cleanup, ...extra,
  }
}

test('journey cancelled after creating a device temp file: bounded cleanup removes exactly it, nothing else', async () => {
  const w = world()
  const call = w.call('j1')
  assert.equal(await call.ask(), 'allowed-once')
  // The first device command (screencap) runs, then the call is cancelled.
  const spawn = w.child_services.subprocess.spawn
  w.child_services.subprocess.spawn = (spec) => { const out = spawn(spec); if (/screencap/.test(spec.argv.join(' '))) call.controller.abort(); return out }
  const outcome = await runJourney(deviceDeps(w, call), { serial: 'emu-1', applicationId: 'com.example.app', steps: [{ action: 'screenshot', output: 'out/a.png' }] }, Date.now())
  assert.equal(outcome.status, 'cancelled')
  assert.equal(outcome.cleanup, 'completed')
  const removals = w.effects.filter((e) => / rm -f /.test(e))
  assert.equal(removals.length, 1)
  assert.match(removals[0], /^\/usr\/bin\/adb -s emu-1 shell rm -f \/data\/local\/tmp\/satellite-[a-z0-9-]+\.png$/)
  assert.equal(w.effects.some((e) => / pull /.test(e)), false, 'no pull after cancellation')
})

test('capture after a lost permit (revoked mid-call): cleanup still deletes the owned trace only', async () => {
  const w = world()
  const call = w.call('cap1')
  assert.equal(await call.ask(), 'allowed-once')
  const spawn = w.child_services.subprocess.spawn
  w.child_services.subprocess.spawn = (spec) => { const out = spawn(spec); if (/screenrecord/.test(spec.argv.join(' '))) w.unbind(); return out }
  const outcome = await runCapture(deviceDeps(w, call), { action: 'record', serial: 'emu-1', durationSeconds: 1, output: 'out/a.mp4' }, Date.now())
  // The recording already ran: neither "blocked" (nothing happened) nor success.
  assert.equal(outcome.status, 'effect-unknown')
  assert.equal(outcome.error.code, 'EFFECT_UNKNOWN')
  assert.match(outcome.error.message, /on-device effect occurred/)
  assert.match(outcome.error.message, /artifact was not produced/)
  assert.match(outcome.error.message, /not retried automatically/)
  assert.equal(outcome.artifacts.length, 0)
  assert.equal(outcome.cleanup, 'completed')
  assert.equal(w.effects.filter((e) => / pull /.test(e)).length, 0, 'the pull after revocation never ran')
  assert.deepEqual(w.effects.filter((e) => / rm -f /.test(e)).length, 1)
})

test('cleanup capability: only registered, generated device paths with the exact rm argv', async () => {
  const effects = []
  const runner = {
    sandbox: { async confine(argv) { return { argv: [...argv], enforcement: 'full' } } },
    subprocess: { spawn: (spec) => fakeSpawn(effects, spec.argv) },
  }
  const cleanup = createDeviceCleanup({ runner, adbPath: '/usr/bin/adb', serial: 'emu-1', binding: { root: '/w', mode: 'workspace-write', workspaceRoot: '/w' } })
  assert.equal(await cleanup.remove('/data/local/tmp/satellite-a.png'), false, 'unregistered')
  for (const bad of ['/sdcard/x.png', '/data/local/tmp/satellite-a.png; reboot', '/data/local/tmp/../x', '/data/local/tmp/other.png']) {
    assert.throws(() => cleanup.own(bad), /non-owned/)
  }
  cleanup.own('/data/misc/perfetto-traces/satellite-k1-ab.perfetto-trace')
  assert.equal(await cleanup.remove('/data/misc/perfetto-traces/satellite-k1-ab.perfetto-trace'), true)
  assert.equal(await cleanup.remove('/data/misc/perfetto-traces/satellite-k1-ab.perfetto-trace'), false, 'at most once')
  assert.deepEqual(effects, ['/usr/bin/adb -s emu-1 shell rm -f /data/misc/perfetto-traces/satellite-k1-ab.perfetto-trace'])
})

test('capture cancelled after the recording started: cancelled with an explicit effect note', async () => {
  const w = world()
  const call = w.call('cap2')
  assert.equal(await call.ask(), 'allowed-once')
  const spawn = w.child_services.subprocess.spawn
  w.child_services.subprocess.spawn = (spec) => { const out = spawn(spec); if (/screenrecord/.test(spec.argv.join(' '))) call.controller.abort(); return out }
  const outcome = await runCapture(deviceDeps(w, call), { action: 'record', serial: 'emu-1', durationSeconds: 1, output: 'out/a.mp4' }, Date.now())
  assert.equal(outcome.status, 'cancelled')
  assert.equal(outcome.error.code, 'CANCELLED')
  assert.match(outcome.error.message, /already started on the device/)
  assert.equal(w.effects.filter((e) => / pull /.test(e)).length, 0)
})

test('capture blocked before the recording started stays blocked with zero device effect', async () => {
  const w = world()
  const call = w.call('cap3')
  // No approval asked: the gate refuses the very first confine.
  const outcome = await runCapture(deviceDeps(w, call), { action: 'record', serial: 'emu-1', durationSeconds: 1, output: 'out/a.mp4' }, Date.now())
  assert.equal(outcome.status, 'blocked')
  assert.equal(w.effects.filter((e) => /screenrecord/.test(e)).length, 0)
})

test('journey screenshot: permit lost after screencap ran is not reported as blocked', async () => {
  const w = world()
  const call = w.call('j2')
  assert.equal(await call.ask(), 'allowed-once')
  const spawn = w.child_services.subprocess.spawn
  w.child_services.subprocess.spawn = (spec) => { const out = spawn(spec); if (/screencap/.test(spec.argv.join(' '))) w.unbind(); return out }
  const outcome = await runJourney(deviceDeps(w, call), { serial: 'emu-1', applicationId: 'com.example.app', steps: [{ action: 'screenshot', output: 'out/a.png' }] }, Date.now())
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.error.message, /already changed device state/)
  assert.equal(w.effects.filter((e) => / pull /.test(e)).length, 0)
})

test('journey cancelled after screencap carries an explicit effect note', async () => {
  const w = world()
  const call = w.call('j3')
  assert.equal(await call.ask(), 'allowed-once')
  const spawn = w.child_services.subprocess.spawn
  w.child_services.subprocess.spawn = (spec) => { const out = spawn(spec); if (/screencap/.test(spec.argv.join(' '))) call.controller.abort(); return out }
  const outcome = await runJourney(deviceDeps(w, call), { serial: 'emu-1', applicationId: 'com.example.app', steps: [{ action: 'screenshot', output: 'out/a.png' }] }, Date.now())
  assert.equal(outcome.status, 'cancelled')
  assert.match(outcome.error.message, /device commands already ran/)
})

function cleanupRunner(effects, behaviour) {
  return {
    sandbox: { async confine(argv) { return { argv: [...argv], enforcement: 'full' } } },
    subprocess: { spawn: (spec) => behaviour(effects, spec.argv) },
  }
}
const cleanupBinding = { root: '/w', mode: 'workspace-write', workspaceRoot: '/w' }

test('cleanup: concurrent removes of one path start exactly one rm', async () => {
  const effects = []
  let release
  const gateDone = new Promise((resolve) => { release = resolve })
  const runner = cleanupRunner(effects, (fx, argv) => {
    const out = fakeSpawn(fx, argv)
    return { ...out, done: gateDone.then(() => ({ exitCode: 0, signal: null })) }
  })
  const cleanup = createDeviceCleanup({ runner, adbPath: '/usr/bin/adb', serial: 'emu-1', binding: cleanupBinding })
  const path = '/data/local/tmp/satellite-c1.png'
  cleanup.own(path)
  const a = cleanup.remove(path), b = cleanup.remove(path)
  await new Promise((resolve) => setTimeout(resolve, 10))
  release()
  const results = await Promise.all([a, b])
  assert.deepEqual(results.sort(), [false, true])
  assert.equal(effects.length, 1)
})

test('cleanup: a failed removal is consumed and never starts a second rm', async () => {
  const effects = []
  const runner = cleanupRunner(effects, (fx, argv) => ({ ...fakeSpawn(fx, argv), done: Promise.resolve({ exitCode: 1, signal: null }) }))
  const cleanup = createDeviceCleanup({ runner, adbPath: '/usr/bin/adb', serial: 'emu-1', binding: cleanupBinding })
  const path = '/data/local/tmp/satellite-c2.xml'
  cleanup.own(path)
  assert.equal(await cleanup.remove(path), false, 'failed rm reported')
  assert.equal(await cleanup.remove(path), false, 'not re-armed')
  assert.equal(effects.length, 1)
})
