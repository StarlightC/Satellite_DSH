import test from 'node:test'
import assert from 'node:assert/strict'

import { createAndroidValidationContext, CONTEXT_FACT, ROLE, SKILL } from '../lib/android/lib/extension.js'

test('平台事实未知时返回 unknown，不当作不适用', () => {
  const extension = createAndroidValidationContext()
  const result = extension.match({ values: {} })
  assert.equal(result.kind, 'unknown')
  assert.deepEqual([...result.missing], ['projectKind'])
})

test('非 Android 项目不适用，已有有效事实不重复执行', () => {
  const extension = createAndroidValidationContext()
  assert.equal(extension.match({ values: { projectKind: 'other' } }).kind, 'no')
  assert.equal(
    extension.match({ values: { projectKind: 'android', [CONTEXT_FACT]: { modules: [] } } }).kind,
    'no',
  )
  assert.equal(extension.match({ values: { projectKind: 'android' } }).kind, 'yes')
})

test('就绪判定委托给调用作用域的能力检查，不自行判断授权', () => {
  const extension = createAndroidValidationContext()
  const calls = []
  const readiness = extension.ready({
    checkRoleAndSkill: (role, skill) => {
      calls.push({ role, skill })
      return { ready: false, reason: 'skill not visible' }
    },
  })
  assert.deepEqual(calls, [{ role: ROLE, skill: SKILL }])
  assert.deepEqual(readiness, { ready: false, reason: 'skill not visible' })
})

test('作用域未提供能力检查接口时报告阻塞而不是静默跳过', () => {
  const extension = createAndroidValidationContext()
  const readiness = extension.ready({})
  assert.equal(readiness.ready, false)
  assert.match(readiness.reason, /能力检查接口/)
})

test('执行委托给已配置角色，原样交付文字证据而非伪造机器事实', async () => {
  const extension = createAndroidValidationContext()
  const calls = []
  const outcome = await extension.run({
    runConfiguredRole: async (role, task) => {
      calls.push({ role, task })
      return {
        status: 'completed',
        note: '模块 app，变体 debug；证据：项目构建脚本。',
      }
    },
  })
  assert.equal(calls[0].role, ROLE)
  assert.equal(calls[0].task.skill, SKILL)
  assert.equal(outcome.note, '模块 app，变体 debug；证据：项目构建脚本。')
  assert.equal(outcome.facts, undefined)
})

test('文字调查不声明无法产出的机器事实', () => {
  const extension = createAndroidValidationContext()
  assert.deepEqual(extension.provides ?? [], [])
  assert.equal(extension.verify, undefined)
})
