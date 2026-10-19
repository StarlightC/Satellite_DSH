import test from 'node:test'
import assert from 'node:assert/strict'

import { createNodeCatalog, MATCH_NO, MATCH_YES, blocked, unknownMatch } from '../lib/contracts.js'
import { createSlotRegistry } from '../lib/registry.js'
import { createCallStore, runNode } from '../lib/node/lib/nodes.js'

function setup() {
  const catalog = createNodeCatalog()
  catalog.defineNode('validate')
  const registry = createSlotRegistry(catalog)
  const store = createCallStore()
  return { registry, store }
}

function extension(id, slot, overrides = {}) {
  return {
    id,
    slot,
    slotVersion: 1,
    match: () => MATCH_YES,
    ready: () => ({ ready: true }),
    run: async () => ({ status: 'completed' }),
    ...overrides,
  }
}

function runner(outcomes) {
  return async (ext) => {
    const result = outcomes[ext.id]
    if (typeof result === 'function') return result()
    return result ?? { status: 'completed' }
  }
}

const okBase = () => ({ status: 'completed', result: { ran: true } })

test('before 未解决时 base 不启动', async () => {
  const { registry, store } = setup()
  registry.register(extension('a.gap', 'validate.before', { match: () => unknownMatch(['projectKind']) }))
  let baseCalls = 0
  const result = await runNode({
    slots: registry,
    store,
    nodeId: 'validate',
    caller: 'agent-1',
    facts: { values: {} },
    runBase: async () => {
      baseCalls += 1
      return okBase()
    },
    runExtension: runner({}),
  })
  assert.equal(baseCalls, 0)
  assert.equal(result.kind, 'suspended')
  assert.equal(result.stage, 'before')
  assert.deepEqual([...result.missing], ['projectKind'])
  assert.ok(result.token)
})

test('before/base/after 顺序执行，扩展产出的事实要经核对才生效', async () => {
  const { registry, store } = setup()
  registry.register(extension('a.context', 'validate.before', { provides: ['validation.context'] }))
  registry.register(
    extension('b.consumer', 'validate.after', {
      requires: ['validation.context'],
      provides: ['validation.report'],
    }),
  )
  const ran = []
  const result = await runNode({
    slots: registry,
    store,
    nodeId: 'validate',
    caller: 'agent-1',
    facts: { values: {} },
    runBase: async () => {
      ran.push('base')
      return okBase()
    },
    runExtension: async (ext) => {
      ran.push(ext.id)
      if (ext.id === 'a.context') return { status: 'completed', facts: { 'validation.context': { module: 'app' } } }
      if (ext.id === 'b.consumer') return { status: 'completed', facts: { 'validation.report': 'ok' } }
      return { status: 'completed' }
    },
  })
  assert.deepEqual(ran, ['a.context', 'base', 'b.consumer'])
  assert.equal(result.kind, 'completed')
  assert.equal(result.facts.values['validation.report'], 'ok')
})

test('完成结果分别报告 before 与 after 实际执行的扩展', async () => {
  const { registry, store } = setup()
  registry.register(extension('a.before', 'validate.before'))
  registry.register(extension('b.after', 'validate.after'))
  const result = await runNode({
    slots: registry,
    store,
    nodeId: 'validate',
    caller: 'agent-1',
    facts: { values: {} },
    runBase: okBase,
    runExtension: runner({}),
  })
  assert.equal(result.kind, 'completed')
  assert.deepEqual(result.beforeRan, ['a.before'])
  assert.deepEqual(result.afterRan, ['b.after'])
})

test('未声明或未完成的产出不成为事实', async () => {
  const { registry, store } = setup()
  registry.register(extension('a.rogue', 'validate.before', { provides: ['declared.fact'] }))
  const result = await runNode({
    slots: registry,
    store,
    nodeId: 'validate',
    caller: 'agent-1',
    facts: { values: {} },
    runBase: okBase,
    runExtension: async () => ({
      status: 'completed',
      facts: { 'declared.fact': 1, 'undeclared.fact': 2 },
    }),
  })
  assert.equal(result.kind, 'completed')
  assert.equal(result.facts.values['declared.fact'], 1)
  assert.equal('undeclared.fact' in result.facts.values, false)
})

test('base 业务失败仍检查 after，成功专用扩展不匹配，失败结论不被 after 抹去', async () => {
  const { registry, store } = setup()
  registry.register(
    extension('a.success-only', 'validate.after', {
      match: (facts) => (facts.values['base.completed'] ? MATCH_YES : MATCH_NO),
    }),
  )
  registry.register(
    extension('b.diagnostic', 'validate.after', {
      match: (facts) => (facts.values['base.failed'] ? MATCH_YES : MATCH_NO),
    }),
  )
  const ran = []
  const result = await runNode({
    slots: registry,
    store,
    nodeId: 'validate',
    caller: 'agent-1',
    facts: { values: {} },
    runBase: async () => ({ status: 'failed', error: 'compile error' }),
    runExtension: async (ext) => {
      ran.push(ext.id)
      return { status: 'completed' }
    },
  })
  assert.deepEqual(ran, ['b.diagnostic'])
  assert.equal(result.kind, 'failed')
  assert.equal(result.base.error, 'compile error')
})

test('取消后不启动 after，执行清理并保留取消结论', async () => {
  const { registry, store } = setup()
  registry.register(extension('a.after', 'validate.after'))
  let afterRan = false
  let cleaned = false
  const controller = new AbortController()
  const result = await runNode({
    slots: registry,
    store,
    nodeId: 'validate',
    caller: 'agent-1',
    facts: { values: {} },
    signal: controller.signal,
    runBase: async () => {
      controller.abort()
      return okBase()
    },
    runExtension: async (ext) => {
      if (ext.id === 'a.after') afterRan = true
      return { status: 'completed' }
    },
    cleanup: async () => {
      cleaned = true
    },
  })
  assert.equal(afterRan, false)
  assert.equal(cleaned, true)
  assert.equal(result.kind, 'cancelled')
})

test('after 暂停后恢复不重跑 base，并复用已完成的 before', async () => {
  const { registry, store } = setup()
  registry.register(extension('a.before', 'validate.before'))
  let afterCalls = 0
  const result = await runNode({
    slots: registry,
    store,
    nodeId: 'validate',
    caller: 'agent-1',
    facts: { values: {} },
    runBase: okBase,
    runExtension: async () => ({ status: 'completed' }),
  })
  assert.equal(result.kind, 'completed')

  // 第二次：after 需要决定。
  registry.register(
    extension('b.decide', 'validate.after', {
      match: (facts) => (facts.values['decision'] ? MATCH_YES : unknownMatch(['decision'])),
      provides: ['validation.decision.applied'],
    }),
  )
  let baseCalls = 0
  let beforeCalls = 0
  const first = await runNode({
    slots: registry,
    store,
    nodeId: 'validate',
    caller: 'agent-1',
    facts: { values: {} },
    runBase: async () => {
      baseCalls += 1
      return okBase()
    },
    runExtension: async (ext) => {
      if (ext.id === 'a.before') beforeCalls += 1
      if (ext.id === 'b.decide') afterCalls += 1
      return { status: 'completed' }
    },
  })
  assert.equal(first.kind, 'suspended')
  assert.equal(first.stage, 'after')
  assert.equal(baseCalls, 1)

  assert.equal(afterCalls, 0, '条件未知时不执行该扩展')

  const second = await runNode({
    slots: registry,
    store,
    nodeId: 'validate',
    caller: 'agent-1',
    resumeToken: first.token,
    facts: { values: { decision: 'apply' } },
    runBase: async () => {
      baseCalls += 1
      return okBase()
    },
    runExtension: async (ext) => {
      if (ext.id === 'a.before') beforeCalls += 1
      if (ext.id === 'b.decide') afterCalls += 1
      return { status: 'completed' }
    },
  })
  assert.equal(second.kind, 'completed')
  assert.equal(baseCalls, 1, 'base 不得因恢复重复执行')
  assert.equal(beforeCalls, 1, '已完成的 before 不重复执行')
  assert.equal(afterCalls, 1, '补交事实后 after 扩展才执行')
})

test('resume 令牌绑定调用者、节点与单元，且不可并发恢复', async () => {
  const { registry, store } = setup()
  registry.register(extension('a.decide', 'validate.after', { match: () => unknownMatch(['decision']) }))
  const first = await runNode({
    slots: registry,
    store,
    nodeId: 'validate',
    caller: 'agent-1',
    unit: 'unit-1',
    facts: { values: {} },
    runBase: okBase,
    runExtension: runner({}),
  })
  assert.equal(first.kind, 'suspended')

  const wrongCaller = await runNode({
    slots: registry,
    store,
    nodeId: 'validate',
    caller: 'agent-2',
    unit: 'unit-1',
    resumeToken: first.token,
    facts: { values: {} },
    runBase: okBase,
    runExtension: runner({}),
  })
  assert.equal(wrongCaller.kind, 'blocked')
  assert.match(wrongCaller.reason, /another caller/)

  const wrongUnit = await runNode({
    slots: registry,
    store,
    nodeId: 'validate',
    caller: 'agent-1',
    unit: 'unit-2',
    resumeToken: first.token,
    facts: { values: {} },
    runBase: okBase,
    runExtension: runner({}),
  })
  assert.equal(wrongUnit.kind, 'blocked')
  assert.match(wrongUnit.reason, /another unit/)
})

test('扩展抛错被归一化为失败，不逃逸出节点边界', async () => {
  const { registry, store } = setup()
  registry.register(extension('a.thrower', 'validate.before'))
  const result = await runNode({
    slots: registry,
    store,
    nodeId: 'validate',
    caller: 'agent-1',
    facts: { values: {} },
    runBase: okBase,
    runExtension: async () => {
      throw new Error('boom')
    },
  })
  assert.equal(result.kind, 'failed')
  assert.equal(result.reason, 'boom')
  assert.equal(result.extensions[0].error, 'boom')
  assert.equal(store.size(), 0)
})

test('适用但能力缺失时返回 blocked，而不是当作未注册', async () => {
  const { registry, store } = setup()
  registry.register(
    extension('a.blocked', 'validate.before', { ready: () => blocked('缺少领域技能') }),
  )
  let baseCalls = 0
  const result = await runNode({
    slots: registry,
    store,
    nodeId: 'validate',
    caller: 'agent-1',
    facts: { values: {} },
    runBase: async () => {
      baseCalls += 1
      return okBase()
    },
    runExtension: runner({}),
  })
  assert.equal(baseCalls, 0)
  assert.equal(result.kind, 'suspended')
  assert.equal(result.blocked[0].id, 'a.blocked')
})

test('同槽冲突不执行部分流程', async () => {
  const { registry, store } = setup()
  registry.register(extension('a.one', 'validate.before', { provides: ['validation.context'] }))
  registry.register(extension('a.two', 'validate.before', { provides: ['validation.context'] }))
  let ran = false
  const result = await runNode({
    slots: registry,
    store,
    nodeId: 'validate',
    caller: 'agent-1',
    facts: { values: {} },
    runBase: okBase,
    runExtension: async () => {
      ran = true
      return { status: 'completed' }
    },
  })
  assert.equal(ran, false)
  assert.equal(result.kind, 'suspended')
  assert.equal(result.reason, 'conflict')
  assert.equal(result.conflicts[0].kind, 'output-ownership')
})

test('不适用与未知事实的扩展不影响节点继续', async () => {
  const { registry, store } = setup()
  registry.register(extension('a.no', 'validate.before', { match: () => MATCH_NO }))
  const result = await runNode({
    slots: registry,
    store,
    nodeId: 'validate',
    caller: 'agent-1',
    facts: { values: {} },
    runBase: okBase,
    runExtension: runner({}),
  })
  assert.equal(result.kind, 'completed')
})

for (const stage of ['before', 'after']) {
  test(`${stage} resume retains facts and original notes without replaying completed side effects`, async () => {
    const { registry, store } = setup()
    registry.register(extension('a.producer', `validate.${stage}`, { provides: ['context'] }))
    registry.register(extension('b.decision', `validate.${stage}`, { requires: ['context'] }))
    let produced = 0
    let baseCalls = 0
    const params = {
      slots: registry, store, nodeId: 'validate', caller: 'caller',
      runBase: async (call) => {
        baseCalls++
        if (stage === 'before') {
          assert.equal(call.facts.values.context, 'verified-context')
          assert.equal(call.extensions[0].note, 'raw evidence')
        }
        return okBase()
      },
      runExtension: async (ext, context) => {
        if (ext.id === 'a.producer') { produced++; return { status: 'completed', facts: { context: 'verified-context' }, note: 'raw evidence' } }
        assert.equal(context.facts.values.context, 'verified-context')
        return context.facts.values.decision ? { status: 'completed' } : { status: 'needs_decision', note: 'choose explicitly' }
      },
    }
    const first = await runNode(params)
    assert.equal(first.kind, 'suspended')
    assert.equal(first.stage, stage)
    assert.equal(first.facts.values.context, 'verified-context')
    assert.equal(first.extensions[0].note, 'raw evidence')
    const resumed = await runNode({ ...params, resumeToken: first.token, facts: { values: { decision: 'yes' } } })
    assert.equal(resumed.kind, 'completed')
    assert.equal(produced, 1)
    assert.equal(baseCalls, 1)
    assert.equal(resumed.extensions.filter(x => x.id === 'a.producer').length, 1)
  })
}

test('verification rejection and throw prevent a requires consumer and base', async () => {
  for (const verify of [() => false, () => { throw new Error('bad fact') }]) {
    const { registry, store } = setup()
    registry.register(extension('a.producer', 'validate.before', { provides: ['fact'], verify }))
    registry.register(extension('b.consumer', 'validate.before', { requires: ['fact'] }))
    const ran = []
    const result = await runNode({ slots: registry, store, nodeId: 'validate', caller: 'caller',
      runBase: async () => { throw new Error('base must not run') },
      runExtension: async ext => { ran.push(ext.id); return { status: 'completed', facts: { fact: 'invalid' }, note: 'preserved' } },
    })
    assert.equal(result.kind, 'failed')
    assert.deepEqual(ran, ['a.producer'])
    assert.equal(Object.hasOwn(result.facts.values, 'fact'), false)
    assert.equal(result.extensions[0].note, 'preserved')
    assert.match(result.extensions[0].error, /rejected|bad fact/)
  }
})

test('declared but absent output never authorizes requires consumer', async () => {
  const { registry, store } = setup()
  registry.register(extension('a.producer', 'validate.before', { provides: ['fact'] }))
  registry.register(extension('b.consumer', 'validate.before', { requires: ['fact'] }))
  const ran = []
  const result = await runNode({ slots: registry, store, nodeId: 'validate', caller: 'caller', runBase: okBase,
    runExtension: async ext => { ran.push(ext.id); return { status: 'completed' } },
  })
  assert.equal(result.kind, 'suspended')
  assert.deepEqual(result.missing, ['fact'])
  assert.deepEqual(ran, ['a.producer'])
})

test('match is recomputed after each step; six-step chain has no artificial round cap', async () => {
  const { registry, store } = setup()
  for (let i = 0; i < 6; i++) registry.register(extension(`chain.${i}`, 'validate.before', {
    provides: [`f${i}`],
    match: facts => i === 0 || facts.values[`f${i - 1}`] ? MATCH_YES : unknownMatch([`f${i - 1}`]),
  }))
  registry.register(extension('z.skip', 'validate.before', { match: facts => facts.values.f0 ? MATCH_NO : MATCH_YES }))
  const ran = []
  const result = await runNode({ slots: registry, store, nodeId: 'validate', caller: 'caller', runBase: okBase,
    runExtension: async ext => { ran.push(ext.id); return { status: 'completed', facts: { [ext.provides[0]]: true } } },
  })
  assert.equal(result.kind, 'completed')
  assert.deepEqual(ran, Array.from({ length: 6 }, (_, i) => `chain.${i}`))
})

for (const mutation of ['remove', 'replace', 'add']) {
  test(`resume blocks definition ${mutation} rather than mixing snapshots`, async () => {
    const { registry, store } = setup()
    const remove = registry.register(extension('decision', 'validate.before'))
    const params = { slots: registry, store, nodeId: 'validate', caller: 'caller', runBase: okBase,
      runExtension: async () => ({ status: 'needs_decision', note: 'original' }),
    }
    const first = await runNode(params)
    if (mutation !== 'add') remove()
    if (mutation !== 'remove') registry.register(extension(mutation === 'add' ? 'extra' : 'decision', 'validate.before'))
    const second = await runNode({ ...params, resumeToken: first.token, runExtension: async () => { throw new Error('must not run') } })
    assert.equal(second.kind, 'blocked')
    assert.match(second.reason, /definitions changed/)
    assert.equal(second.extensions[0].note, 'original')
  })
}

for (const abortAt of ['entry', 'before', 'after']) {
  test(`cancel at ${abortAt} prevents the next step and cleans up`, async () => {
    const { registry, store } = setup()
    const controller = new AbortController()
    for (const stage of ['before', 'after']) for (const id of ['a', 'b']) registry.register(extension(`${stage}.${id}`, `validate.${stage}`))
    const ran = []
    let cleaned = 0
    if (abortAt === 'entry') controller.abort()
    const result = await runNode({ slots: registry, store, nodeId: 'validate', caller: 'caller', signal: controller.signal,
      runBase: async () => { ran.push('base'); return okBase() },
      runExtension: async ext => { ran.push(ext.id); if (ext.id === `${abortAt}.a`) controller.abort(); return { status: 'completed', note: ext.id } },
      cleanup: async () => { cleaned++ },
    })
    assert.equal(result.kind, 'cancelled')
    assert.equal(cleaned, 1)
    assert.equal(store.size(), 0)
    assert.deepEqual(ran, abortAt === 'entry' ? [] : abortAt === 'before' ? ['before.a'] : ['before.a', 'before.b', 'base', 'after.a'])
    assert.equal(result.extensions.length, ran.filter(x => x !== 'base').length)
  })
}

test('after failure is terminal failure, not a resumable business decision', async () => {
  const { registry, store } = setup()
  registry.register(extension('after.failure', 'validate.after'))
  const result = await runNode({ slots: registry, store, nodeId: 'validate', caller: 'caller', runBase: okBase,
    runExtension: async () => ({ status: 'failed', error: 'post-check failed', note: 'original diagnostic' }),
  })
  assert.equal(result.kind, 'failed')
  assert.equal(result.token, undefined)
  assert.equal(result.base.status, 'completed')
  assert.equal(result.extensions[0].error, 'post-check failed')
  assert.equal(store.size(), 0)
})


test('unload during before blocks remaining steps and base immediately', async () => {
  const { registry, store } = setup()
  registry.register(extension('a.first', 'validate.before'))
  const remove = registry.register(extension('b.next', 'validate.before'))
  const ran = []
  const result = await runNode({ slots: registry, store, nodeId: 'validate', caller: 'caller',
    runBase: async () => { ran.push('base'); return okBase() },
    runExtension: async ext => { ran.push(ext.id); remove(); return { status: 'completed', note: 'first evidence' } },
  })
  assert.equal(result.kind, 'blocked')
  assert.deepEqual(ran, ['a.first'])
  assert.equal(result.extensions[0].note, 'first evidence')
})

test('readiness is rechecked between steps', async () => {
  const { registry, store } = setup()
  let ready = true
  registry.register(extension('a.first', 'validate.before'))
  registry.register(extension('b.next', 'validate.before', { ready: () => ready ? { ready: true } : blocked('service gone') }))
  const ran = []
  const result = await runNode({ slots: registry, store, nodeId: 'validate', caller: 'caller', runBase: okBase,
    runExtension: async ext => { ran.push(ext.id); ready = false; return { status: 'completed' } },
  })
  assert.equal(result.kind, 'suspended')
  assert.equal(result.blocked[0].reason, 'service gone')
  assert.deepEqual(ran, ['a.first'])
})

test('concurrent resume claims the record once until the pending extension returns', async () => {
  const { registry, store } = setup()
  registry.register(extension('a.decision', 'validate.before'))
  const params = { slots: registry, store, nodeId: 'validate', caller: 'caller', runBase: okBase,
    runExtension: async () => ({ status: 'needs_decision' }),
  }
  const first = await runNode(params)
  let release
  let entered
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  const inFlight = runNode({ ...params, resumeToken: first.token,
    runExtension: async () => { entered(); await gate; return { status: 'completed' } },
  })
  await started
  const duplicate = await runNode({ ...params, resumeToken: first.token })
  assert.equal(duplicate.kind, 'blocked')
  assert.match(duplicate.reason, /already being resumed/)
  release()
  assert.equal((await inFlight).kind, 'completed')
})


test('resume cannot overwrite verified facts; equal evidence and new decisions remain usable', async () => {
  const { registry, store } = setup()
  registry.register(extension('a.producer', 'validate.before', { provides: ['context'], verify: () => true }))
  registry.register(extension('b.decision', 'validate.before'))
  let calls = 0
  const params = { slots: registry, store, nodeId: 'validate', caller: 'caller', runBase: okBase,
    runExtension: async (ext, context) => {
      calls++
      if (ext.id === 'a.producer') return { status: 'completed', facts: { context: { module: 'real' } } }
      return { status: context.facts.values.decision ? 'completed' : 'needs_decision' }
    },
  }
  const first = await runNode(params)
  const changed = await runNode({ ...params, resumeToken: first.token, facts: { values: { context: { module: 'forged' }, decision: 'yes' } } })
  assert.equal(changed.kind, 'blocked')
  assert.match(changed.reason, /verified extension fact cannot be overwritten/)
  assert.deepEqual(changed.facts.values.context, { module: 'real' })
  assert.equal(changed.facts.values.decision, undefined, 'reject the entire submitted merge')
  assert.equal(calls, 2)
  const same = await runNode({ ...params, resumeToken: first.token, facts: { values: { context: { module: 'real' }, decision: 'yes' } } })
  assert.equal(same.kind, 'completed')
  assert.equal(calls, 3)
})

for (const name of ['base.completed', 'base.failed']) {
  test(`caller cannot supply reserved runtime fact ${name} on entry or resume`, async () => {
    const { registry, store } = setup()
    registry.register(extension('decision', 'validate.after'))
    let baseCalls = 0
    const params = { slots: registry, store, nodeId: 'validate', caller: 'caller',
      runBase: async () => { baseCalls++; return okBase() },
      runExtension: async () => ({ status: 'needs_decision' }),
    }
    const forged = await runNode({ ...params, facts: { values: { [name]: true } } })
    assert.equal(forged.kind, 'blocked')
    assert.equal(store.size(), 0)
    assert.equal(baseCalls, 0)
    const first = await runNode(params)
    const changed = await runNode({ ...params, resumeToken: first.token, facts: { values: { [name]: false } } })
    assert.equal(changed.kind, 'blocked')
    assert.match(changed.reason, /reserved runtime fact/)
    assert.equal(changed.facts.values['base.completed'], true)
    assert.equal(changed.facts.values['base.failed'], false)
    assert.equal(baseCalls, 1)
  })
}

test('completed provider retains ownership when another provider becomes applicable', async () => {
  const { registry, store } = setup()
  registry.register(extension('a.owner', 'validate.before', { provides: ['fact'], match: facts => facts.values.fact ? MATCH_NO : MATCH_YES }))
  registry.register(extension('b.late', 'validate.before', { provides: ['fact'], match: facts => facts.values.fact ? MATCH_YES : MATCH_NO }))
  const ran = []
  const result = await runNode({ slots: registry, store, nodeId: 'validate', caller: 'caller', runBase: okBase,
    runExtension: async ext => { ran.push(ext.id); return { status: 'completed', facts: { fact: 'first' } } },
  })
  assert.equal(result.kind, 'suspended')
  assert.equal(result.conflicts[0].kind, 'output-ownership')
  assert.deepEqual(result.conflicts[0].ids, ['a.owner', 'b.late'])
  assert.equal(result.facts.values.fact, 'first')
  assert.deepEqual(ran, ['a.owner'])
})

test('extensions cannot forge reserved base outcome facts either', async () => {
  const { registry, store } = setup()
  registry.register(extension('forger', 'validate.before', { provides: ['base.completed'] }))
  let baseCalls = 0
  const result = await runNode({ slots: registry, store, nodeId: 'validate', caller: 'caller',
    runBase: async () => { baseCalls++; return okBase() },
    runExtension: async () => ({ status: 'completed', facts: { 'base.completed': true } }),
  })
  assert.equal(result.kind, 'failed')
  assert.match(result.reason, /reserved runtime fact/)
  assert.equal(baseCalls, 0)
})
