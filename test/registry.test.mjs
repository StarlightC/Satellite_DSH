import test from 'node:test'
import assert from 'node:assert/strict'

import { createNodeCatalog, MATCH_NO, MATCH_YES, blocked, unknownMatch } from '../lib/contracts.js'
import { createSlotRegistry } from '../lib/registry.js'

function setup() {
  const catalog = createNodeCatalog()
  catalog.defineNode('validate')
  const registry = createSlotRegistry(catalog)
  return { catalog, registry }
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

const SLOT = 'validate.before'

test('注册校验：重复 id、未知插槽、版本不符都拒绝', () => {
  const { catalog, registry } = setup()
  registry.register(extension('a.one', SLOT))
  assert.throws(() => registry.register(extension('a.one', SLOT)), /duplicate extension id/)
  assert.throws(() => registry.register(extension('a.two', 'nope.before')), /unknown slot/)
  assert.throws(
    () => registry.register(extension('a.three', SLOT, { slotVersion: 2 })),
    /expects version 1/,
  )
  assert.throws(() => registry.register(extension('a.four', SLOT, { match: undefined })), /match must be a function/)
  assert.equal(registry.snapshot().length, 1)
  assert.ok(catalog.has(SLOT))
})

test('三态：全不适用返回 empty，unknown 返回缺口而不是不适用', () => {
  const { registry } = setup()
  registry.register(extension('a.off', SLOT, { match: () => MATCH_NO }))
  assert.equal(registry.resolve(SLOT, { values: {} }, {}).kind, 'empty')

  registry.register(
    extension('b.unknown', SLOT, { match: () => unknownMatch(['projectKind']) }),
  )
  const resolution = registry.resolve(SLOT, { values: {} }, {})
  assert.equal(resolution.kind, 'gap')
  assert.deepEqual([...resolution.missing], ['projectKind'])
})

test('适用但能力缺失返回 blocked，不静默跳过', () => {
  const { registry } = setup()
  registry.register(
    extension('a.blocked', SLOT, { ready: () => blocked('缺少 android 技能', ['android-validation-context']) }),
  )
  const resolution = registry.resolve(SLOT, { values: {} }, {})
  assert.equal(resolution.kind, 'blocked')
  assert.equal(resolution.blocked[0].id, 'a.blocked')
  assert.match(resolution.blocked[0].reason, /缺少 android 技能/)
})

test('requires/provides 决定顺序，与注册顺序无关', () => {
  const { registry } = setup()
  registry.register(
    extension('b.needs-fact', SLOT, {
      requires: ['validation.context'],
      match: (facts) => (facts.values['validation.context'] ? MATCH_YES : unknownMatch(['validation.context'])),
    }),
  )
  registry.register(extension('a.provides-fact', SLOT, { provides: ['validation.context'] }))

  const resolution = registry.resolve(SLOT, { values: {} }, {})
  assert.equal(resolution.kind, 'waiting')
  assert.deepEqual(resolution.steps.map((step) => step.id), ['a.provides-fact'])

  const after = registry.resolve(SLOT, { values: { 'validation.context': { module: 'app' } } }, {})
  assert.equal(after.kind, 'run')
  assert.deepEqual(after.steps.map((step) => step.id), ['a.provides-fact', 'b.needs-fact'])
})

test('无序时按 id 稳定排序以便复现', () => {
  const { registry } = setup()
  registry.register(extension('z.late', SLOT))
  registry.register(extension('a.early', SLOT))
  registry.register(extension('m.middle', SLOT))
  const resolution = registry.resolve(SLOT, { values: {} }, {})
  assert.deepEqual(resolution.steps.map((step) => step.id), ['a.early', 'm.middle', 'z.late'])
})

test('依赖环、输出所有权与互斥组都返回冲突', () => {
  const { registry } = setup()
  registry.register(extension('a.one', SLOT, { requires: ['x'], provides: ['y'] }))
  registry.register(extension('a.two', SLOT, { requires: ['y'], provides: ['x'] }))
  const cycle = registry.resolve(SLOT, { values: {} }, {})
  assert.equal(cycle.kind, 'conflict')
  assert.equal(cycle.conflicts[0].kind, 'dependency-cycle')
})

test('多个扩展声称提供同一事实时冲突', () => {
  const { registry } = setup()
  registry.register(extension('a.one', SLOT, { provides: ['validation.context'] }))
  registry.register(extension('a.two', SLOT, { provides: ['validation.context'] }))
  const resolution = registry.resolve(SLOT, { values: {} }, {})
  assert.equal(resolution.kind, 'conflict')
  assert.equal(resolution.conflicts[0].kind, 'output-ownership')
})

test('同一 exclusiveGroup 出现多项时冲突，项目策略未选前不执行', () => {
  const { registry } = setup()
  registry.register(extension('a.one', SLOT, { exclusiveGroup: 'android.context' }))
  registry.register(extension('a.two', SLOT, { exclusiveGroup: 'android.context' }))
  const resolution = registry.resolve(SLOT, { values: {} }, {})
  assert.equal(resolution.kind, 'conflict')
  assert.equal(resolution.conflicts[0].kind, 'exclusive-group')
})

test('必需事实无人提供时是缺口，不执行部分流程', () => {
  const { registry } = setup()
  registry.register(extension('a.one', SLOT, { requires: ['missing.fact'] }))
  const resolution = registry.resolve(SLOT, { values: {} }, {})
  assert.equal(resolution.kind, 'gap')
  assert.deepEqual([...resolution.missing], ['missing.fact'])
})

test('撤销后定义消失，快照不被后续注册影响', () => {
  const { registry } = setup()
  const dispose = registry.register(extension('a.one', SLOT))
  const before = registry.snapshot()
  registry.register(extension('b.two', SLOT))
  assert.equal(before.length, 1)
  assert.equal(registry.resolve(SLOT, { values: {} }, {}, before).steps.length, 1)
  dispose()
  assert.equal(registry.snapshot().length, 1)
})
