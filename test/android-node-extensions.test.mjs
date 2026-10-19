import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ARGUMENT_INVALID,
  createAndroidAcceptanceEvidence,
  createAndroidDesignContext,
  createAndroidPlatformReview,
  createAndroidProjectContext,
  createAndroidValidationEvidence,
  parseEvidenceClaims,
  parseEvidenceRequirements,
  parseReviewScope,
} from '../lib/android/lib/node-extensions.js'

const source = (over = {}) => ({ kind: 'file', location: 'app/src/main/kotlin/sample.kt', revision: 'rev-1', ...over })
const target = (over = {}) => ({ project: 'sample-app', revision: 'rev-1', variant: 'debug', ...over })
const requirement = (over = {}) => ({ kind: 'build', target: target(), sources: [source()], ...over })

function facts(values) {
  return { values }
}

/** 记录调用作用域的 stub：断言未启动子会话时不产生任何调用。 */
function scope() {
  const calls = []
  return {
    calls,
    view: { checkRoleAndSkill: () => ({ ready: true }) },
    execution: {
      facts: undefined,
      runConfiguredRole: (role, task) => {
        calls.push({ role, task })
        return { status: 'completed', note: '报告正文' }
      },
    },
  }
}

test('专项开关不是 true 时不触发，普通任务不受影响', () => {
  const design = createAndroidDesignContext()
  assert.equal(design.match(facts({ projectKind: 'android' })).kind, 'no')
  assert.equal(design.match(facts({ 'android.design.required': 'yes', projectKind: 'android' })).kind, 'no')
  assert.equal(design.match(facts({ 'android.design.required': false, projectKind: 'android' })).kind, 'no')
})

test('明确要求但缺平台或来源字段时返回 unknown 并列出字段名', () => {
  const design = createAndroidDesignContext()
  const noPlatform = design.match(facts({ 'android.design.required': true }))
  assert.equal(noPlatform.kind, 'unknown')
  assert.deepEqual(noPlatform.missing, ['projectKind'])

  const noSource = design.match(facts({ 'android.design.required': true, projectKind: 'android' }))
  assert.equal(noSource.kind, 'unknown')
  assert.deepEqual(noSource.missing, ['android.design.source'])

  const other = design.match(facts({ 'android.design.required': true, projectKind: 'ios' }))
  assert.equal(other.kind, 'no')
})

test('来源齐全时专项适用', () => {
  const design = createAndroidDesignContext()
  const match = design.match(facts({
    'android.design.required': true, projectKind: 'android', 'android.design.source': source(),
  }))
  assert.equal(match.kind, 'yes')
})

test('非法结构在启动子会话前阻塞，错误码与字段位置可见', () => {
  const design = createAndroidDesignContext()
  const s = scope()
  s.execution.facts = facts({
    'android.design.required': true, projectKind: 'android',
    'android.design.source': source({ kind: 'shell' }),
  })
  const outcome = design.run(s.execution)
  assert.equal(outcome.status, 'blocked')
  assert.match(outcome.error, new RegExp(ARGUMENT_INVALID))
  assert.match(outcome.error, /kind/)
  assert.equal(s.calls.length, 0, '结构非法时不能创建子会话')
})

test('未知字段被拒绝，不被静默忽略', () => {
  const design = createAndroidDesignContext()
  const s = scope()
  s.execution.facts = facts({
    'android.design.required': true, projectKind: 'android',
    'android.design.source': source({ execute: 'rm -rf /' }),
  })
  const outcome = design.run(s.execution)
  assert.equal(outcome.status, 'blocked')
  assert.match(outcome.error, /unknown field/)
  assert.equal(s.calls.length, 0)
})

test('长度上限按契约执行', () => {
  assert.equal(parseReviewScope({
    files: [source({ location: 'x'.repeat(2049) })], checks: ['api'],
  }).ok, false)
  assert.equal(parseReviewScope({
    files: [source({ revision: 'r'.repeat(129) })], checks: ['api'],
  }).ok, false)
  assert.equal(parseReviewScope({ files: [source()], checks: ['api', 'api'] }).ok, false)
  assert.equal(parseReviewScope({ files: [source()], checks: ['unknown-face'] }).ok, false)
  assert.equal(parseReviewScope({ files: [], checks: ['api'] }).ok, false)
  assert.equal(parseReviewScope({ files: [source()], checks: ['api', 'ui'] }).ok, true)
})

test('审查范围只接受声明的检查面', () => {
  const review = createAndroidPlatformReview()
  const s = scope()
  s.execution.facts = facts({
    'android.review.required': true, projectKind: 'android',
    'android.review.scope': { files: [source()], checks: ['lifecycle', 'resources'] },
  })
  const outcome = review.run(s.execution)
  assert.equal(outcome.status, 'completed')
  assert.equal(s.calls.length, 1)
  assert.equal(s.calls[0].role, 'android-context')
  assert.equal(s.calls[0].task.skill, 'android-change-review')
  assert.match(s.calls[0].task.objective, /lifecycle/)
})

test('证据要求：结构合法但未提供来源时拒绝假装已核对', () => {
  const evidence = createAndroidValidationEvidence()
  const s = scope()
  s.execution.facts = facts({
    'android.validation.required': true, projectKind: 'android',
    'android.validation.requirements': [requirement({ sources: [] })],
  })
  const outcome = evidence.run(s.execution)
  assert.equal(outcome.status, 'blocked')
  assert.match(outcome.error, /no source/)
  assert.equal(s.calls.length, 0)
})

test('证据要求与主张的条数上限与结果词表', () => {
  assert.equal(parseEvidenceRequirements([requirement()]).ok, true)
  assert.equal(parseEvidenceRequirements([]).ok, false)
  assert.equal(parseEvidenceRequirements(Array.from({ length: 9 }, () => requirement())).ok, false)
  assert.equal(parseEvidenceRequirements([requirement({ kind: 'guess' })]).ok, false)
  assert.equal(parseEvidenceRequirements([requirement({ target: target({ revision: '' }) })]).ok, false)
  assert.equal(parseEvidenceRequirements([requirement({ sources: Array.from({ length: 9 }, () => source()) })]).ok, false)

  assert.equal(parseEvidenceClaims([{ ...requirement(), reportedResult: 'passed' }]).ok, true)
  assert.equal(parseEvidenceClaims([{ ...requirement(), reportedResult: 'maybe' }]).ok, false)
  assert.equal(parseEvidenceClaims(Array.from({ length: 17 }, () => ({ ...requirement(), reportedResult: 'passed' }))).ok, false)
})

test('主张只表示调用者说法，不变成机器通过', () => {
  const acceptance = createAndroidAcceptanceEvidence()
  const s = scope()
  s.execution.facts = facts({
    'android.acceptance.required': true, projectKind: 'android',
    'android.acceptance.evidence': [{ ...requirement(), reportedResult: 'passed' }],
  })
  const outcome = acceptance.run(s.execution)
  assert.equal(outcome.status, 'completed')
  assert.match(s.calls[0].task.objective, /passed/)
  assert.match(s.calls[0].task.objective, /仍需自行读取并核对/)
})

test('专项不是权限：缺少执行接口时阻塞而不是抛错', () => {
  const context = createAndroidProjectContext()
  assert.equal(context.run({ facts: facts({}) }).status, 'blocked')
  assert.equal(context.run(undefined).status, 'blocked')
})

test('每个专项声明自己的插槽与只读方法技能', () => {
  const declared = [
    createAndroidProjectContext(), createAndroidDesignContext(), createAndroidPlatformReview(),
    createAndroidValidationEvidence(), createAndroidAcceptanceEvidence(),
  ].map((extension) => [extension.id, extension.slot])
  assert.deepEqual(declared, [
    ['android.project-context', 'context.before'],
    ['android.design-context', 'solution.before'],
    ['android.platform-review', 'review.after'],
    ['android.validation-evidence', 'validate.after'],
    ['android.acceptance-evidence', 'signoff.before'],
  ])
})
