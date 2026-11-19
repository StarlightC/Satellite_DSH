// Real DSH 0.2.2-alpha.3 Loader integration for Satellite.
//
// Boots the shipped headless profile layers (dsh-base + dsh-headless) from the
// exact installed @deepseek-ai/dsh with the Satellite bundle layer in a
// temporary profile, through @deepseek-ai/dsh-app-boot. Every service is the
// production row: agent registry, agent loop, subagent manager + spawn
// provider, session + JSONL persistence, native tool executor, sandbox policy,
// sandbox/subprocess/fs, and the user-approval service. Only the model replies
// (scripted-llm) and the human answering an approval prompt
// (approval-answerer) are deterministic test inputs.
//
// Run: npm run test:loader
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { bootSatellite, createWorld, DSH_SOURCE, dshPackageDir, importDsh, INSTALL_ANCHOR } from './boot.mjs'
import { resetState, state } from './fixtures/script-state.mjs'
import { isInside } from './world-layout.mjs'

const NODES = ['context', 'solution', 'implement', 'validate', 'review', 'signoff']

let world
let ctx
const events = new Map()
/** Session headers of every Agent the runtime actually created. */
const createdAgents = []

let createUserMessage

test.before(async () => {
  state.dshLlm = await importDsh('@deepseek-ai/dsh-llm')
  ;({ createUserMessage } = state.dshLlm)
  world = createWorld()
  ctx = await bootSatellite(world)
  ctx.on('session/event', (session, event) => {
    const list = events.get(session.id) ?? []
    list.push(event)
    events.set(session.id, list)
  })
  ctx.on('agent/created', ({ agent }) => { createdAgents.push({ ...agent.session.header }) })
})

test.after(async () => {
  await ctx?.fiber.dispose()
  if (world && !process.env.SATELLITE_LOADER_KEEP) rmSync(world.root, { recursive: true, force: true })
})

async function mainAgent() {
  const registry = ctx.get('agents')
  for (let i = 0; i < 200; i++) {
    const roots = registry.list().filter((agent) => agent.session.header.origin !== 'subagent')
    if (roots.length === 1) return roots[0]
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('no root agent')
}

/** Drive one user turn on the configured root agent until whole-agent idle. */
async function runTurn(task) {
  const agent = await mainAgent()
  await agent.whenIdle()
  agent.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return agent
}

/** Tool results the root agent received in this run, in order. */
function mainToolResults() {
  return state.requests.filter((r) => r.kind === 'main').at(-1)?.messages.filter((m) => m.role === 'tool').map((m) => m.text) ?? []
}

/** The native macOS sandbox cannot apply inside an enclosing sandbox-exec. */
const NESTED_SANDBOX = /sandbox_apply: Operation not permitted/

/** Fail (never skip, never pass) with an explicit environment classification. */
function environmentBlocked(texts, what) {
  const hit = texts.find((text) => NESTED_SANDBOX.test(text ?? ''))
  if (hit !== undefined) {
    assert.fail(`ENVIRONMENT BLOCKED (${what}): native sandbox-exec cannot nest inside the enclosing macOS sandbox; `
      + `run \`npm run test:loader\` without an outer sandbox. Evidence: ${hit.slice(0, 300)}`)
  }
}

function nodeOf(request) {
  return /\[node=([\w-]+)\]/.exec(request.firstUser)?.[1]
}

test('composition: exact DSH 0.2.2-alpha.3 tree, one Cordis instance, Satellite rows active over native executor', () => {
  const anchor = JSON.parse(readFileSync(INSTALL_ANCHOR, 'utf8'))
  assert.equal(anchor.version, '0.2.2-alpha.3')
  const cordisFrom = (dir) => realpathSync(createRequire(join(dir, 'package.json')).resolve('@deepseek-ai/cordis'))
  // The staged Satellite package resolves the installation's single Cordis copy.
  const fromSatellite = cordisFrom(world.staged)
  assert.equal(fromSatellite, cordisFrom(dshPackageDir('@deepseek-ai/dsh-app-boot')))
  assert.equal(fromSatellite, cordisFrom(dshPackageDir('@deepseek-ai/dsh-agent')))
  assert.equal(fromSatellite, cordisFrom(dshPackageDir('@deepseek-ai/dsh-subagent')))
  assert.ok(fromSatellite.startsWith(realpathSync(DSH_SOURCE)), fromSatellite)
  for (const peer of ['@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-typert-protocol']) {
    const fromStaged = realpathSync(createRequire(join(world.staged, 'package.json')).resolve(peer))
    assert.ok(fromStaged.startsWith(`${dshPackageDir(peer)}/`), `${peer}: ${fromStaged}`)
  }
  const state = Object.fromEntries([...ctx.loader.entries()].map((e) => [e.options.id, e.options.disabled ? 'disabled' : e.fiber?.state]))
  for (const id of ['satellite-slots', 'satellite-node', 'subagent', 'subagent-spawn-in-process', 'approval', 'agent-loop', 'tool-executor-native', 'sandbox-policy']) {
    assert.equal(state[id], 2, `${id} active`)
  }
  assert.equal(state['tool-executor-ptc'], 'disabled')
  assert.ok(ctx.get('tools').get('satellite_node'))
  // Real native delegation row registered under a non-default alias.
  assert.equal(state['satellite-test-delegate-task'], 2, 'delegate_task row active')
  assert.ok(ctx.get('tools').get('delegate_task'))
  // Session persistence lives under the temporary DSH home, never in the repo.
  assert.ok(!isInside(world.repo, world.sessions), world.sessions)
  assert.ok(isInside(world.home, world.sessions), world.sessions)
  assert.ok(ctx.get('subagents').getProvider('spawn'))
})

test('ordinary: six base nodes through real satellite_node, role persona/filter, sandbox-mode report (enforcement: see ordinary sandbox), depth-2 guard, suspend + resume token', async () => {
  resetState()
  const plan = [
    ...NODES.slice(0, 5).map((node) => () => ({ tool: 'satellite_node', args: { node, task: `[node=${node}] loader integration` } })),
    () => ({ tool: 'satellite_node', args: { node: 'signoff', task: '[node=signoff] loader integration', facts: { 'acceptance.required': true } } }),
    (last) => {
      const token = /resume=(\S+)/.exec(last)?.[1]
      assert.ok(token, `signoff suspended with a token: ${last}`)
      return { tool: 'satellite_node', args: { node: 'signoff', task: '[node=signoff] loader integration', resume: token, decision: 'accept' } }
    },
  ]
  state.script = (req) => {
    if (req.kind === 'main') {
      const step = plan[req.toolResults]
      return step ? step(req.last?.text ?? '') : { text: 'MAIN DONE' }
    }
    const node = nodeOf(req)
    // First child step probes the boundary; second step reports.
    if (req.toolResults === 0) {
      if (node === 'implement') return { tool: 'write', args: { file_path: join(world.repo, 'impl.txt'), content: 'implemented\n' } }
      if (node === 'review') return { tool: 'write', args: { file_path: join(world.repo, 'review.txt'), content: 'x\n' } }
      if (node === 'validate') return { tool: 'subagent', args: { description: 'nested', prompt: 'nested delegation' } }
    }
    // Same intent through a real native delegation row renamed to an alias.
    if (req.toolResults === 1 && node === 'validate') {
      return { tool: 'delegate_task', args: { description: 'nested alias', prompt: 'nested alias delegation' } }
    }
    return { text: `CHILD ${node} DONE: ${req.last?.role === 'tool' ? req.last.text.slice(0, 200) : 'no tool'}` }
  }
  try {
    await runTurn('run the base flow')
    checkOrdinary()
  } finally {
    // This case's own side effect; later cases share the repo.
    rmSync(join(world.repo, 'impl.txt'), { force: true })
  }
})

function checkOrdinary() {
  const results = mainToolResults()
  assert.equal(results.length, 7, JSON.stringify(results, null, 1))
  for (const [index, node] of NODES.entries()) {
    assert.match(results[index], new RegExp(`节点 ${node}：(completed|suspended)`), results[index])
    assert.match(results[index], /已启动基础角色/, results[index])
  }
  assert.match(results[5], /suspended/)
  assert.match(results[6], /节点 signoff：completed/)

  const children = state.requests.filter((r) => r.kind === 'child')
  const byNode = (node) => children.filter((r) => nodeOf(r) === node)
  for (const node of NODES) assert.ok(byNode(node).length >= 1, `child for ${node} ran`)
  // Persona section installed in the exact child scope.
  assert.match(byNode('review')[0].system, /只依据实际差异与相关源码下结论/)
  assert.match(byNode('implement')[0].system, /区分"已同意的基线"与自己的发挥/)
  // Role filter: review cannot write; implementation can (workspace-write).
  const reviewTool = byNode('review')[1]?.last
  assert.match(reviewTool?.text ?? '', /角色不允许使用工具 write/)
  assert.equal(existsSync(join(world.repo, 'review.txt')), false)
  assert.equal(readFileSync(join(world.repo, 'impl.txt'), 'utf8'), 'implemented\n')
  // Depth-2 native delegation is rejected by the role guard.
  assert.match(byNode('validate')[1]?.last?.text ?? '', /角色不能使用不受控的委派\/通信入口 subagent/)
  // Coordinator itself never received ordinary tools beyond the boundary.
  assert.match(results[0], /沙箱：satellite_node:context=read-only/)
  assert.match(results[2], /沙箱：satellite_node:implement=workspace-write/)
  // Renamed native delegation: vetoed at creation, no grandchild Agent, no grandchild model call.
  const validateSession = byNode('validate')[0].sessionId
  assert.ok(validateSession, 'validate child session id')
  assert.match(byNode('validate')[2]?.last?.text ?? '', /不能创建下级 Agent/, JSON.stringify(byNode('validate').map((r) => r.last?.text)))
  assert.deepEqual(createdAgents.filter((h) => h.parentSession === validateSession), [])
  assert.equal(state.requests.filter((r) => /nested alias delegation|nested delegation/.test(r.firstUser ?? '')).length, 0)
}

test('version-control: first child tool is VC; real status/diff/log/stage/commit with fresh snapshot + real approval per write', async () => {
  const base = mainToolResults().length
  resetState()
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(world.repo, 'feature.txt'), 'feature\n')
  const headBefore = world.git('rev-parse', 'HEAD')
  const vc = (request) => ({ tool: 'satellite_version_control', args: { request: { repo: '.', ...request } } })
  const snapshotOf = (text) => /expectedSnapshot\W+([A-Za-z0-9_-]{8,})/.exec(text ?? '')?.[1]
  const childSteps = [
    () => vc({ action: 'status' }),
    () => vc({ action: 'diff', target: 'working' }),
    () => vc({ action: 'log', count: 3 }),
    () => vc({ action: 'status' }),
    (last) => vc({ action: 'stage', paths: ['feature.txt'], expectedSnapshot: snapshotOf(last) }),
    () => vc({ action: 'status' }),
    (last) => vc({ action: 'commit', message: 'loader: add feature', expectedSnapshot: snapshotOf(last) }),
  ]
  const childTexts = []
  state.script = (req) => {
    if (req.kind === 'main') {
      return req.toolResults === base
        ? { tool: 'satellite_node', args: { node: 'version-control', task: 'stage and commit feature.txt' } }
        : { text: 'MAIN DONE' }
    }
    if (req.last?.role === 'tool') childTexts.push(req.last.text)
    const step = childSteps[req.toolResults]
    return step ? step(req.last?.text) : { text: 'VC DONE' }
  }
  await runTurn('commit the feature')

  const results = mainToolResults().slice(base)
  assert.equal(results.length, 1)
  assert.match(results[0], /节点 version-control：completed/, results[0])
  assert.equal(childTexts.length, 7, JSON.stringify(childTexts, null, 1))
  if (process.env.SATELLITE_LOADER_DEBUG) console.error(childTexts)
  environmentBlocked(childTexts, 'version-control status/stage/commit')
  for (const [index, text] of childTexts.entries()) assert.doesNotMatch(text, /denied|拒绝|Error/i, `step ${index}: ${text}`)
  assert.match(childTexts[0], /feature\.txt/)
  // Exactly one real approval per write, both answered through the real service.
  assert.equal(state.approvals.length, 2, JSON.stringify(state.approvals))
  assert.ok(state.approvals.every((a) => a.toolName === 'satellite_version_control'))
  const audits = [...events.values()].flat().filter((e) => e.type === 'approval/asked' || e.type === 'approval/decided')
  assert.equal(audits.filter((e) => e.type === 'approval/decided' && e.data.outcome === 'allowed-once').length, 2)
  // Real Git state.
  assert.equal(world.git('rev-parse', 'HEAD~1'), headBefore)
  assert.equal(world.git('log', '-1', '--format=%s'), 'loader: add feature')
  assert.equal(world.git('show', '--name-only', '--format=', 'HEAD'), 'feature.txt')
  assert.equal(world.git('status', '--porcelain'), '')
  // The approval audit is persisted in the JSONL logs under the temporary DSH home.
  assert.equal(existsSync(join(world.repo, '.sessions')), false)
  const logs = readdirSync(world.sessions, { recursive: true }).filter((f) => String(f).endsWith('.jsonl'))
  const persisted = logs.map((f) => readFileSync(join(world.sessions, String(f)), 'utf8')).join('\n')
  assert.equal((persisted.match(/"approval\/decided"/g) ?? []).length >= 2, true, `persisted audits in ${world.sessions}`)
})

test('cancellation: parent abort while the child awaits its model converges and releases the child', async () => {
  const base = mainToolResults().length
  resetState()
  const childWaiting = Promise.withResolvers()
  state.script = (req) => {
    if (req.kind === 'main') {
      return req.toolResults === base
        ? { tool: 'satellite_node', args: { node: 'context', task: '[node=context] wait' } }
        : { text: 'MAIN AFTER CANCEL' }
    }
    childWaiting.resolve(req.sessionId)
    return new Promise((resolve) => {
      if (req.signal?.aborted) return resolve({ text: 'aborted' })
      req.signal?.addEventListener('abort', () => resolve({ text: 'aborted' }), { once: true })
    })
  }
  const agent = await mainAgent()
  await agent.whenIdle()
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start and cancel' }], source: { kind: 'user' } }))
  const childId = await childWaiting.promise
  const registry = ctx.get('agents')
  assert.ok(registry.get(childId), 'child live while waiting')
  const started = Date.now()
  agent.cancel({ kind: 'user' })
  await agent.whenIdle()
  const elapsed = Date.now() - started
  assert.ok(elapsed < 5000, `converged in ${elapsed}ms`)
  for (let i = 0; i < 100 && registry.get(childId); i++) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(registry.get(childId), undefined, 'child released after parent abort')
  const childRequest = state.requests.find((r) => r.kind === 'child')
  assert.equal(childRequest.signal?.aborted, true, 'child model request signal aborted')
})

test('ordinary sandbox: read-only child — allowed read succeeds, write is refused by policy, zero file side effect', async () => {
  let base
  resetState()
  const probe = join(world.repo, 'context-probe.txt')
  const texts = []
  state.script = (req) => {
    if (req.kind === 'main') {
      base ??= req.toolResults
      return req.toolResults === base
        ? { tool: 'satellite_node', args: { node: 'context', task: '[node=context] sandbox control' } }
        : { text: 'MAIN DONE' }
    }
    if (req.last?.role === 'tool') texts.push(req.last.text)
    if (req.toolResults === 0) return { tool: 'bash', args: { description: 'positive control read', command: 'cat README.md && echo READ-OK' } }
    if (req.toolResults === 1) return { tool: 'bash', args: { description: 'negative control write', command: `touch ${probe} && echo WRITE-OK` } }
    return { text: 'CONTEXT DONE' }
  }
  await runTurn('sandbox control')
  const results = mainToolResults().slice(base)
  assert.match(results[0] ?? '', /沙箱：satellite_node:context=read-only/, results[0])
  assert.equal(texts.length, 2, JSON.stringify(texts, null, 1))
  // Zero side effect holds in every environment.
  assert.equal(existsSync(probe), false, 'forbidden write left no file')
  // Without a working positive control, the negative one proves nothing: classify, never pass.
  environmentBlocked(texts, 'ordinary read-only sandbox control')
  assert.match(texts[0], /seed/, `positive control: ${texts[0]}`)
  assert.match(texts[0], /READ-OK/)
  assert.doesNotMatch(texts[1], /WRITE-OK/, `negative control: ${texts[1]}`)
  assert.match(texts[1], /Operation not permitted|Read-only file system|denied|sandbox/i, `policy denial: ${texts[1]}`)
})

test('lifecycle: a later agent/created hook throws — manager rollback converges, child released, no live authority left', async () => {
  let base
  resetState()
  const disarm = state.armLateAgentCreated()
  state.script = (req) => {
    if (req.kind === 'main') {
      base ??= req.toolResults
      return req.toolResults === base
        ? { tool: 'satellite_node', args: { node: 'context', task: '[node=context] rollback' } }
        : { text: 'MAIN DONE' }
    }
    return { text: 'CHILD MUST NOT RUN' }
  }
  const started = Date.now()
  try {
    await Promise.race([
      runTurn('rollback'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DEADLOCK: rollback did not converge in 15s')), 15000)),
    ])
  } finally { disarm() }
  const elapsed = Date.now() - started
  const results = mainToolResults().slice(base)
  assert.equal(results.length, 1, JSON.stringify(results))
  assert.doesNotMatch(results[0], /节点 context：completed/, results[0])
  // The probe ran after Satellite's hook: the child already carried the enforced read-only mode.
  assert.equal(state.lifecycle.length, 1, JSON.stringify(state.lifecycle))
  assert.equal(state.lifecycle[0].mode, 'read-only')
  // The child never reached its model, and is not live afterwards.
  assert.equal(state.requests.filter((r) => r.kind === 'child').length, 0)
  const registry = ctx.get('agents')
  for (let i = 0; i < 100 && registry.get(state.lifecycle[0].id); i++) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(registry.get(state.lifecycle[0].id), undefined, 'rolled-back child released')
  assert.equal(registry.list().filter((agent) => agent.session.header.origin === 'subagent').length, 0, 'no child residue')
  // No version-control authority outside an explicit, active delegation.
  const root = await mainAgent()
  const vc = await ctx.get('tools').get('satellite_version_control')?.execute?.({ request: { action: 'status', repo: '.' } }, { agent: root, signal: new AbortController().signal })
  if (vc !== undefined) assert.equal(vc.status, 'blocked', JSON.stringify(vc))
  assert.ok(elapsed < 15000, `converged in ${elapsed}ms`)
})

test('version-control approval: revoking the delegation while the real approval is pending denies the write; asker is the exact live parent', async () => {
  let base
  resetState()
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(world.repo, 'pending.txt'), 'pending\n')
  const headBefore = world.git('rev-parse', 'HEAD')
  const snapshotOf = (text) => /expectedSnapshot\W+([A-Za-z0-9_-]{8,})/.exec(text ?? '')?.[1]
  const texts = []
  const root = await mainAgent()
  state.onApproval = async () => {
    // Revocation by the parent's own cancellation while the human is deciding.
    root.cancel({ kind: 'user' })
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  state.script = (req) => {
    if (req.kind === 'main') {
      base ??= req.toolResults
      return req.toolResults === base
        ? { tool: 'satellite_node', args: { node: 'version-control', task: 'stage pending.txt' } }
        : { text: 'MAIN DONE' }
    }
    if (req.last?.role === 'tool') texts.push(req.last.text)
    if (req.toolResults === 0) return { tool: 'satellite_version_control', args: { request: { repo: '.', action: 'status' } } }
    if (req.toolResults === 1) {
      return { tool: 'satellite_version_control', args: { request: { repo: '.', action: 'stage', paths: ['pending.txt'], expectedSnapshot: snapshotOf(req.last?.text) } } }
    }
    return { text: 'VC DONE' }
  }
  await runTurn('stage then revoke')
  environmentBlocked(texts, 'version-control approval chain')
  assert.equal(state.approvals.length, 1, JSON.stringify({ approvals: state.approvals, texts }))
  assert.equal(state.approvals[0].live, true, 'approval asked by the exact live registry identity')
  assert.equal(state.approvals[0].agentId, root.id, 'write approval is asked of the delegating parent')
  // Allowed-once arrived after revocation: no write may happen.
  assert.equal(world.git('diff', '--cached', '--name-only'), '')
  assert.equal(world.git('rev-parse', 'HEAD'), headBefore)
  const registry = ctx.get('agents')
  assert.equal(registry.list().filter((agent) => agent.session.header.origin === 'subagent').length, 0, 'child released')
  rmSync(join(world.repo, 'pending.txt'))
})

test('delegated approval: role child (policy never) asks the exact parent once; only allowed-once writes the reuse index', async () => {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(world.repo, 'App.kt'), 'class App\n')
  const index = join(world.repo, '.satellite-reuse-index.json')
  // Enable the Android row (registers satellite_reuse_maintain) for this case only.
  const androidEntry = [...ctx.loader.entries()].find((e) => e.options.id === 'satellite-android')
  await androidEntry.update({ ...androidEntry.options, disabled: false })
  for (let i = 0; i < 200 && !ctx.get('tools').get('satellite_reuse_maintain'); i++) await new Promise((r) => setTimeout(r, 25))
  assert.ok(ctx.get('tools').get('satellite_reuse_maintain'), 'android row active')
  const childAgents = []
  const off = ctx.on('agent/created', ({ agent }) => { if (agent.session.header.origin === 'subagent') childAgents.push(agent) })
  const runOnce = async (answer) => {
    let base
    resetState()
    state.approvalAnswer = answer
    const texts = []
    state.script = (req) => {
      if (req.kind === 'main') {
        base ??= req.toolResults
        return req.toolResults === base
          ? { tool: 'satellite_node', args: { node: 'implement', task: '[node=implement] reuse' } }
          : { text: 'MAIN DONE' }
      }
      if (req.last?.role === 'tool') texts.push(req.last.text)
      if (req.toolResults === 0) return { tool: 'satellite_reuse_maintain', args: { action: 'initialize', paths: ['App.kt'] } }
      return { text: 'CHILD DONE' }
    }
    await runTurn('reuse via child')
    return texts
  }
  try {
    const root = await mainAgent()
    const rejected = await runOnce('rejected')
    assert.equal(state.approvals.length, 1, JSON.stringify({ approvals: state.approvals, rejected }))
    assert.equal(state.approvals[0].agentId, root.id)
    assert.equal(state.approvals[0].live, true)
    assert.equal(existsSync(index), false, 'rejection leaves no index')
    assert.match(rejected[0] ?? '', /REUSE_APPROVAL_DENIED/, rejected[0])
    const allowed = await runOnce('allowed-once')
    assert.equal(state.approvals.length, 1, JSON.stringify({ approvals: state.approvals, allowed }))
    assert.equal(state.approvals[0].agentId, root.id, 'answerer saw the exact parent')
    assert.equal(state.approvals[0].toolName, 'satellite_reuse_maintain')
    assert.match(state.approvals[0].reason, /Delegated child approval/)
    assert.ok(existsSync(index), `allowed-once wrote the index: ${allowed[0]}`)
    // Child policy stays never; the audit pair is written to the parent session only.
    const approval = ctx.get('approval')
    const child = childAgents.at(-1)
    assert.equal(approval.effectivePolicy(child.session), 'never')
    const audit = (id) => (events.get(id) ?? []).filter((e) => e.type === 'approval/asked' || e.type === 'approval/decided')
    assert.ok(audit(root.id).some((e) => e.type === 'approval/decided' && e.data.outcome === 'allowed-once'))
    assert.ok(audit(root.id).some((e) => e.type === 'approval/decided' && e.data.outcome === 'rejected'))
    assert.equal(audit(child.id).length, 0)
  } finally {
    off?.()
    rmSync(index, { force: true })
    rmSync(join(world.repo, 'App.kt'), { force: true })
  }
})

/* --------- delegated approval through the real ToolRuntime: Android discover + skill script --------- */
// Only the execution methods of the child's real sandbox/subprocess/shell services are
// replaced (in place, so service identity is unchanged) by deterministic recorders: no
// device, adb or native sandbox is needed. Approval, delegation, policy and audit are real.
async function withFakeExecution(run) {
  const { symbols } = await import(pathToFileURL(createRequire(join(world.staged, 'package.json')).resolve('@deepseek-ai/cordis')).href)
  const target = (name) => { const s = ctx.get(name); return s?.[symbols.original] ?? s }
  const effects = []
  const sandbox = target('sandbox'), subprocess = target('subprocess'), shell = target('shell')
  const reader = (text) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  sandbox.confine = async (argv) => ({ argv: [...argv], enforcement: 'full', denialSignatures: [] })
  subprocess.spawn = (spec) => {
    const line = spec.argv.join(' ')
    effects.push(line)
    const out = /devices -l/.test(line)
      ? 'List of devices attached\nemulator-5554 device product:sdk model:sdk device:emu transport_id:1\n'
      : /getprop/.test(line) ? '[ro.boot.serialno]: [emulator-5554]\n' : ''
    return { done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {}, async waitForExit() { return true },
      collected: { stdout: reader(out), stderr: reader('') } }
  }
  shell.execute = async (spec) => {
    effects.push(`shell ${spec.command}`)
    return { kill() { return true }, done: Promise.resolve(), async result() {
      return { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
        stdout: { text: 'PARSED', truncated: false }, stderr: { text: '', truncated: false },
        sandbox: { mode: 'read-only', denied: false, enforcement: 'full' } }
    } }
  }
  try { return await run(effects) } finally {
    delete sandbox.confine; delete subprocess.spawn; delete shell.execute
  }
}

async function enableAndroidExecution() {
  const entry = [...ctx.loader.entries()].find((e) => e.options.id === 'satellite-android')
  await entry.update({ ...entry.options, disabled: false, config: { ...(entry.options.config ?? {}), execution: { enabled: true, adbPath: '/usr/bin/adb' } } })
  for (let i = 0; i < 200 && !ctx.get('tools').get('satellite_android_device'); i++) await new Promise((r) => setTimeout(r, 25))
  assert.ok(ctx.get('tools').get('satellite_android_device'), 'android execution tools registered')
}

async function delegatedChildCall(tool, args, answer) {
  let base
  resetState()
  state.approvalAnswer = answer
  const texts = []
  state.script = (req) => {
    if (req.kind === 'main') {
      base ??= req.toolResults
      return req.toolResults === base ? { tool: 'satellite_node', args: { node: 'implement', task: `[node=implement] ${tool}` } } : { text: 'MAIN DONE' }
    }
    if (req.last?.role === 'tool') texts.push(req.last.text)
    if (req.toolResults === 0) return { tool, args }
    return { text: 'CHILD DONE' }
  }
  await runTurn(`delegated ${tool}`)
  return texts
}

/** One base-node turn whose child calls the declared parser tool in the given order. */
async function delegatedNodeCalls(node, calls, answer) {
  let base
  resetState()
  state.approvalAnswer = answer
  const texts = []
  state.script = (req) => {
    if (req.kind === 'main') {
      base ??= req.toolResults
      return req.toolResults === base
        ? { tool: 'satellite_node', args: { node, task: `[node=${node}] declared parser` } }
        : { text: 'MAIN DONE' }
    }
    if (req.last?.role === 'tool') texts.push(req.last.text)
    const call = calls[req.toolResults]
    return call ? { tool: 'satellite_skill_script_run', args: call } : { text: 'CHILD DONE' }
  }
  await runTurn(`declared parser via ${node}`)
  return {
    texts,
    child: state.requests.find((request) => request.kind === 'child'),
    // The session keeps earlier turns' tool results; only this turn's are ours.
    main: mainToolResults().slice(base ?? 0),
  }
}

test('delegated approval: Android device discover through the real Loader (allowed-once / rejected / parent never)', async () => {
  await enableAndroidExecution()
  const root = await mainAgent()
  const approval = ctx.get('approval')
  const childAgents = []
  const off = ctx.on('agent/created', ({ agent }) => { if (agent.session.header.origin === 'subagent') childAgents.push(agent) })
  const discover = { action: 'discover', serial: 'emulator-5554' }
  try {
    await withFakeExecution(async (effects) => {
      const rejected = await delegatedChildCall('satellite_android_device', discover, 'rejected')
      assert.equal(state.approvals.length, 1)
      assert.equal(state.approvals[0].agentId, root.id)
      assert.equal(effects.length, 0, `rejected: zero effects ${rejected[0]}`)
      assert.match(rejected[0] ?? '', /APPROVAL_REJECTED|parent user rejected/, rejected[0])

      const allowed = await delegatedChildCall('satellite_android_device', discover, 'allowed-once')
      assert.equal(state.approvals.length, 1)
      assert.match(state.approvals[0].reason, /Delegated child approval/)
      assert.match(allowed[0] ?? '', /"status":"succeeded"/, allowed[0])
      assert.ok(effects.some((e) => /devices -l/.test(e)) && effects.some((e) => /getprop/.test(e)), JSON.stringify(effects))
      const afterAllowed = effects.length

      approval.setPolicy(root, 'never')
      try {
        const never = await delegatedChildCall('satellite_android_device', discover, 'allowed-once')
        assert.equal(state.approvals.length, 0, 'parent never: no prompt')
        assert.equal(effects.length, afterAllowed, 'parent never: zero new effects')
        assert.match(never[0] ?? '', /never/, never[0])
      } finally { approval.setPolicy(root, 'ask') }

      const unavailable = await delegatedChildCall('satellite_android_device', discover, 'unavailable')
      assert.equal(effects.length, afterAllowed, `unavailable: zero new effects ${unavailable[0]}`)
    })
    for (const child of childAgents) assert.equal(approval.effectivePolicy(child.session), 'never', 'child policy unchanged')
    const decided = (events.get(root.id) ?? []).filter((e) => e.type === 'approval/decided').map((e) => e.data.outcome)
    assert.ok(decided.includes('allowed-once') && decided.includes('rejected'), JSON.stringify(decided))
    for (const child of childAgents) assert.equal((events.get(child.id) ?? []).filter((e) => e.type === 'approval/asked').length, 0)
  } finally { off?.() }
})

test('delegated approval (execution recorder): skill script asks the parent once; only allowed-once reaches the shell seam', async () => {
  // This is a Loader-level wiring/recorder test, NOT native execution: the shell
  // seam returns a fixed "PARSED" result. The native interpreter + sandbox chain
  // is covered by the next test on purpose.
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const dir = join(world.repo, '.dsh', 'skills', 'parser-skill')
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: parser-skill\ndescription: test parser\n---\nParse.\n')
  writeFileSync(join(dir, 'scripts', 'manifest.json'), JSON.stringify({ schemaVersion: 1, scripts: [{
    id: 'parse', path: 'scripts/parse.mjs', runtime: 'node', execution: 'stdin-v1', parameters: [], timeoutMs: 1000, outputMaxBytes: 1024 }] }))
  writeFileSync(join(dir, 'scripts', 'parse.mjs'), 'console.log("x")\n')
  const args = { skill: 'parser-skill', script: 'parse', parameters: {} }
  try {
    await withFakeExecution(async (effects) => {
      const rejected = await delegatedChildCall('satellite_skill_script_run', args, 'rejected')
      assert.equal(effects.filter((e) => e.startsWith('shell')).length, 0, `rejected: ${rejected[0]}`)
      assert.match(rejected[0] ?? '', /approval rejected/, rejected[0])
      const allowed = await delegatedChildCall('satellite_skill_script_run', args, 'allowed-once')
      assert.equal(state.approvals.length, 1)
      assert.match(state.approvals[0].reason, /Delegated child approval/)
      assert.equal(effects.filter((e) => e.startsWith('shell')).length, 1, `allowed: ${allowed[0]}`)
      assert.match(allowed[0] ?? '', /PARSED/, allowed[0])
    })
  } finally { rmSync(join(world.repo, '.dsh'), { recursive: true, force: true }) }
})

test('delegated approval (native): read-only context runs an isolated declared parser with the real interpreter and sandbox; rejection zero, write denied, next call re-asks', async () => {
  // Real chain: no shell/fs/subprocess replacement. The only deterministic input
  // is the scripted model and the approval answerer (test input, NOT human
  // approval evidence). The parser reads a known fixture with the real node
  // interpreter under the real read-only file sandbox.
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const skillName = 'loader-native-parser'
  const dir = join(world.repo, '.dsh', 'skills', skillName)
  const payload = 'SATELLITE_KNOWN_FIXTURE_2f9c'
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${skillName}\ndescription: loader native parser fixture\n---\nRead the fixture with the declared parser.\n`)
  writeFileSync(join(dir, 'payload.txt'), `${payload}\n`)
  writeFileSync(join(dir, 'scripts', 'manifest.json'), JSON.stringify({ schemaVersion: 1, scripts: [
    { id: 'read-known', path: 'scripts/read-known.mjs', runtime: 'node', execution: 'stdin-v1', parameters: [], timeoutMs: 10000, outputMaxBytes: 4096 },
    { id: 'write-probe', path: 'scripts/write-probe.mjs', runtime: 'node', execution: 'stdin-v1', parameters: [], timeoutMs: 10000, outputMaxBytes: 4096 },
  ] }))
  writeFileSync(join(dir, 'scripts', 'read-known.mjs'), `import { readFileSync } from 'node:fs'
const payload = readFileSync('payload.txt', 'utf8').trim()
console.log(JSON.stringify({ payload, cwd: process.cwd(), args: process.argv.slice(2) }))
`)
  writeFileSync(join(dir, 'scripts', 'write-probe.mjs'), `import { writeFileSync } from 'node:fs'
writeFileSync('native-write-probe.txt', 'written\\n')
console.log('WROTE')
`)
  const read = { skill: skillName, script: 'read-known', parameters: {} }
  const write = { skill: skillName, script: 'write-probe', parameters: {} }
  const probe = join(dir, 'native-write-probe.txt')
  const childAgents = []
  const off = ctx.on('agent/created', ({ agent }) => { if (agent.session.header.origin === 'subagent') childAgents.push(agent) })
  try {
    const rejected = await delegatedNodeCalls('context', [read], 'rejected')
    assert.equal(state.approvals.length, 1)
    assert.equal(rejected.texts.length, 1, JSON.stringify(rejected.texts))
    assert.match(rejected.texts[0] ?? '', /approval rejected/, rejected.texts[0])
    assert.doesNotMatch(rejected.texts[0] ?? '', new RegExp(payload), 'rejection produced no parser evidence')

    const allowed = await delegatedNodeCalls('context', [read, write, read], 'allowed-once')
    assert.equal(allowed.texts.length, 3, JSON.stringify(allowed.texts, null, 1))
    // Wiring facts that do not depend on the native sandbox backend:
    // a new child call asks again: no cached/replayed permit, including after a
    // failed execution.
    assert.equal(state.approvals.length, 3, JSON.stringify(state.approvals))
    const root = await mainAgent()
    for (const approval of state.approvals) {
      assert.equal(approval.agentId, root.id, 'asked of the exact parent')
      assert.equal(approval.live, true)
      assert.match(approval.reason, /Delegated child approval/)
    }
    const childCallIds = state.approvals.map((approval) => /child call (\S+)\./.exec(approval.reason)?.[1])
    assert.equal(new Set(childCallIds).size, 3, JSON.stringify(childCallIds))
    for (const child of childAgents) assert.equal(ctx.get('approval').effectivePolicy(child.session), 'never')
    const child = allowed.child
    assert.ok(child, 'child model request captured')
    assert.ok(child.toolNames.includes('satellite_skill_script_run'), JSON.stringify(child.toolNames))
    assert.ok(!child.toolNames.includes('satellite_parent_request'), 'read-only context has no parent-request tool')
    assert.match(allowed.main[0] ?? '', /沙箱：satellite_node:context=read-only/)

    // Everything above is real Loader wiring. The assertions below also need the
    // host's native sandbox backend; classify an unavailable backend rather than
    // passing as if it were verified.
    environmentBlocked(allowed.texts, 'delegated native project parser')

    const first = JSON.parse(allowed.texts[0])
    assert.equal(first.success, true, allowed.texts[0])
    assert.equal(first.exitCode, 0)
    assert.equal(first.sandbox.mode, 'read-only')
    assert.equal(first.sandbox.enforcement, 'full')
    assert.equal(first.sandbox.denied, false)
    const firstOutput = JSON.parse(first.stdout.text)
    assert.equal(firstOutput.payload, payload)
    assert.equal(realpathSync(firstOutput.cwd), realpathSync(dir), 'real parser cwd is the winning skill directory')
    assert.deepEqual(firstOutput.args, [])

    const denied = JSON.parse(allowed.texts[1])
    assert.equal(denied.success, false, allowed.texts[1])
    assert.notEqual(denied.exitCode, 0)
    assert.match(denied.stderr.text, /EPERM|EACCES|EROFS|Operation not permitted|Read-only file system/i)
    assert.equal(existsSync(probe), false, 'the read-only sandbox left no write behind')

    const third = JSON.parse(allowed.texts[2])
    assert.equal(third.success, true, allowed.texts[2])
    assert.equal(JSON.parse(third.stdout.text).payload, payload, 'the next allowed call ran again after re-approval')
  } finally {
    off?.()
    rmSync(join(world.repo, '.dsh'), { recursive: true, force: true })
  }
})

test('delegated approval: managed emulator.start through the real Loader (allowed-once spawns once confined, rejected zero, owned handle released)', async () => {
  const entry = [...ctx.loader.entries()].find((e) => e.options.id === 'satellite-android')
  await entry.update({ ...entry.options, disabled: false, config: { ...(entry.options.config ?? {}),
    execution: { enabled: true, adbPath: '/usr/bin/adb', emulatorPath: '/opt/sdk/emulator/emulator', bootPollIntervalMs: 10 } } })
  for (let i = 0; i < 200 && !ctx.get('tools').get('satellite_android_emulator'); i++) await new Promise((r) => setTimeout(r, 25))
  const { symbols } = await import(pathToFileURL(createRequire(join(world.staged, 'package.json')).resolve('@deepseek-ai/cordis')).href)
  const target = (name) => { const s = ctx.get(name); return s?.[symbols.original] ?? s }
  const sandbox = target('sandbox'), subprocess = target('subprocess')
  const reader = (text) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  const effects = [], confined = [], terminated = []
  let running = false
  sandbox.confine = async (argv, policy) => { confined.push(`${policy.mode} ${argv.join(' ')}`); return { argv: ['/sandbox-exec', ...argv], enforcement: 'full', denialSignatures: [] } }
  subprocess.spawn = (spec) => {
    const line = spec.argv.join(' ')
    effects.push(line)
    if (/ -avd /.test(line)) {
      running = true
      let exit
      const done = new Promise((resolve) => { exit = resolve })
      return { done, terminate() { terminated.push(line); running = false; exit({ exitCode: 0, signal: null }) },
        async waitForExit() { await done; return true }, collected: { stdout: reader(''), stderr: reader('') } }
    }
    const out = / devices$/.test(line)
      ? `List of devices attached\n${running ? 'emulator-5556\tdevice\n' : ''}`
      : /sys\.boot_completed/.test(line) ? '1\n' : ''
    return { done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {}, async waitForExit() { return true },
      collected: { stdout: reader(out), stderr: reader('') } }
  }
  const start = { action: 'start', avd: 'Pixel_API_34' }
  const spawnedEmulators = () => effects.filter((e) => / -avd /.test(e))
  try {
    const rejected = await delegatedChildCall('satellite_android_emulator', start, 'rejected')
    assert.equal(spawnedEmulators().length, 0, `rejected: zero spawn ${rejected[0]}`)
    assert.match(rejected[0] ?? '', /APPROVAL_REJECTED|parent user rejected/, rejected[0])

    const allowed = await delegatedChildCall('satellite_android_emulator', start, 'allowed-once')
    assert.equal(state.approvals.length, 1)
    assert.match(state.approvals[0].reason, /Delegated child approval/)
    assert.match(allowed[0] ?? '', /"status":"succeeded"/, allowed[0])
    assert.match(allowed[0] ?? '', /"cleanup":"retained-owned"/, allowed[0])
    assert.equal(spawnedEmulators().length, 1, JSON.stringify(effects))
    assert.match(spawnedEmulators()[0], /^\/sandbox-exec \/opt\/sdk\/emulator\/emulator -avd Pixel_API_34$/, 'spawned the confined argv')
    assert.ok(confined.some((c) => /^workspace-write \/opt\/sdk\/emulator\/emulator -avd Pixel_API_34$/.test(c)), JSON.stringify(confined))
    // The child scope ended with the delegated turn: its owned emulator was terminated.
    for (let i = 0; i < 200 && terminated.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(terminated.length, 1, 'owned handle cleaned up with the owner scope')
  } finally {
    delete sandbox.confine; delete subprocess.spawn
  }
})
