import test from 'node:test'
import assert from 'node:assert/strict'

import { createNodeCatalog } from '../lib/contracts.js'
import { createSlotRegistry } from '../lib/registry.js'
import {
  ACCEPTANCE_DECISION_NOTE,
  ACCEPTANCE_REQUIRED_FACT,
  acceptanceDecisionId,
  createAcceptanceDecisionExtension,
  createBuiltinAfterExtensions,
  DECISION_FACT,
} from '../lib/node/lib/extensions.js'

const extension = () => createAcceptanceDecisionExtension('validate')

test('扩展声明稳定 id、after 插槽与版本', () => {
  const ext = extension()
  assert.equal(ext.id, 'core.acceptance-decision.validate')
  assert.equal(ext.id, acceptanceDecisionId('validate'))
  assert.equal(ext.slot, 'validate.after')
  assert.equal(ext.slotVersion, 1)
  // 不声明 provides：它只读既有事实，不产出新事实。
  assert.equal(ext.provides, undefined)
})

test('match：声明需要决定且未提交决定时才适用', () => {
  const ext = extension()
  assert.equal(ext.match({ values: { [ACCEPTANCE_REQUIRED_FACT]: true } }).kind, 'yes')
  assert.equal(
    ext.match({ values: { [ACCEPTANCE_REQUIRED_FACT]: true, [DECISION_FACT]: 'accept' } }).kind,
    'no',
  )
})

test('match：未声明需要决定时不适用', () => {
  const ext = extension()
  assert.equal(ext.match({ values: {} }).kind, 'no')
  assert.equal(ext.match({ values: { [DECISION_FACT]: 'accept' } }).kind, 'no')
  assert.equal(ext.match({ values: { [ACCEPTANCE_REQUIRED_FACT]: false } }).kind, 'no')
})

test('match：值非布尔一律按不适用处理，不产生缺口', () => {
  const ext = extension()
  for (const value of ['true', 1, 0, null, {}, []]) {
    const matched = ext.match({ values: { [ACCEPTANCE_REQUIRED_FACT]: value } })
    assert.equal(matched.kind, 'no', `acceptance.required=${JSON.stringify(value)} 不应适用`)
  }
})

test('ready 不依赖任何能力，run 返回需要决定并给出中文说明', () => {
  const ext = extension()
  assert.deepEqual(ext.ready(undefined), { ready: true })
  assert.deepEqual(ext.ready({}), { ready: true })
  assert.deepEqual(ext.run(undefined), { status: 'needs_decision', note: ACCEPTANCE_DECISION_NOTE })
  assert.match(ACCEPTANCE_DECISION_NOTE, /^基础节点已完成，等待提交处理决定$/)
})

test('工厂为每个已声明节点各造一个扩展', () => {
  const builtins = createBuiltinAfterExtensions(['validate', 'review'])
  assert.deepEqual(
    builtins.map((entry) => [entry.id, entry.slot]),
    [
      ['core.acceptance-decision.validate', 'validate.after'],
      ['core.acceptance-decision.review', 'review.after'],
    ],
  )
})

test('扩展能通过目录校验被真实注册表接受并解析为可执行步骤', () => {
  const catalog = createNodeCatalog()
  catalog.defineNode('validate')
  const registry = createSlotRegistry(catalog)
  registry.register(extension())
  // 注册校验后 provides 被规范化为空数组（它不产出新事实）。
  assert.deepEqual([...registry.snapshot()[0].provides], [])

  const skipped = registry.resolve('validate.after', { values: {} }, {})
  assert.equal(skipped.kind, 'empty')

  const runnable = registry.resolve(
    'validate.after',
    { values: { [ACCEPTANCE_REQUIRED_FACT]: true, 'base.completed': true } },
    {},
  )
  assert.equal(runnable.kind, 'run')
  assert.deepEqual(runnable.steps.map((step) => step.id), ['core.acceptance-decision.validate'])
})
