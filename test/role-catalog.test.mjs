import test from 'node:test'
import assert from 'node:assert/strict'
import { createNodeCatalog } from '../lib/contracts.js'
import { createSlotRegistry } from '../lib/registry.js'
import { normalizeConfig } from '../lib/node/lib/config.js'
import { buildRoleCatalog } from '../lib/node/lib/role-catalog.js'
import { createBuiltinAfterExtensions } from '../lib/node/lib/extensions.js'
import { createAndroidValidationContext } from '../lib/android/lib/extension.js'
import { createAndroidNodeExtensions } from '../lib/android/lib/node-extensions.js'

const roleByName = (catalog, name) => catalog.roles.find((entry) => entry.role === name)
const androidExtensions = () => [createAndroidValidationContext(), ...createAndroidNodeExtensions()]

function registryFor(config) {
  const nodes = createNodeCatalog()
  for (const node of Object.keys(config.nodes)) nodes.defineNode(node)
  return createSlotRegistry(nodes)
}

function noUndefined(value) {
  assert.notEqual(value, undefined)
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) noUndefined(item)
  }
}

test('目录来自有效角色覆盖，输出 JSON 数据而非路由或执行配置', () => {
  const config = normalizeConfig({
    roles: { validation: { label: '部署验证', objective: '只测部署声明范围', skill: 'deployed-validation', sandbox: 'read-only' } },
    routes: [{ role: 'removed-role', provider: 'old', model: 'old' }],
  })
  const catalog = buildRoleCatalog(config, [])
  assert.equal(catalog.version, 1)
  const validation = roleByName(catalog, 'validation')
  assert.deepEqual(validation, {
    role: 'validation', label: '部署验证', description: '只测部署声明范围',
    skill: 'deployed-validation', sandbox: 'read-only',
    bindings: [{ node: 'validate', phase: 'base', skill: 'deployed-validation', objective: '只测部署声明范围', condition: '调用 validate 节点时执行基础阶段。' }],
  })
  assert.equal(roleByName(catalog, 'removed-role'), undefined)
  for (const entry of catalog.roles) {
    assert.notEqual(entry.label, entry.role, '内置角色应有友好名称')
    assert.equal('agentOptions' in entry, false)
    assert.equal('provider' in entry, false)
  }
  noUndefined(catalog)
  assert.deepEqual(JSON.parse(JSON.stringify(catalog)), catalog)
})

test('节点换绑与自定义角色遵循有效配置，不保留静态挂载', () => {
  const config = normalizeConfig({
    nodes: { validate: { role: 'custom-audit' }, inspect: { role: 'custom-audit' }, orphan: { role: 'missing-role' } },
    roles: {
      'custom-audit': { objective: '部署自定义职责', sandbox: 'workspace-write' },
      'unbound-role': { label: '未挂载角色' },
      'invalid-sandbox': { sandbox: 'invalid' },
    },
  })
  const catalog = buildRoleCatalog(config, [])
  assert.deepEqual(roleByName(catalog, 'validation').bindings, [])
  const custom = roleByName(catalog, 'custom-audit')
  assert.equal(custom.label, 'custom-audit')
  assert.equal(custom.description, '部署自定义职责')
  assert.equal(custom.sandbox, 'workspace-write')
  assert.deepEqual(custom.bindings.map(({ node, phase }) => [node, phase]), [['validate', 'base'], ['inspect', 'base']])
  assert.equal('skill' in custom, false)
  assert.equal('skill' in custom.bindings[0], false)
  assert.equal(roleByName(catalog, 'missing-role'), undefined)
  assert.deepEqual(roleByName(catalog, 'unbound-role'), { role: 'unbound-role', label: '未挂载角色', description: '', sandbox: 'read-only', bindings: [] })
  assert.equal(roleByName(catalog, 'invalid-sandbox').sandbox, 'read-only')
  noUndefined(catalog)
})

test('注册与撤销快照决定扩展挂载；投影不调用执行钩子或猜测核心决定扩展的角色', () => {
  const config = normalizeConfig()
  const registry = registryFor(config)
  for (const extension of createBuiltinAfterExtensions(Object.keys(config.nodes))) registry.register(extension)
  const extension = createAndroidValidationContext()
  const trap = () => { throw new Error('projection must not execute hooks') }
  const remove = registry.register({ ...extension, match: trap, ready: trap, run: trap })
  const snapshot = registry.snapshot()
  const enabled = buildRoleCatalog(config, snapshot)
  assert.deepEqual(roleByName(enabled, 'android-context').bindings, [{
    node: 'validate', phase: 'before', extension: extension.id,
    skill: extension.role.skill, objective: extension.role.objective, condition: extension.role.condition,
  }])
  remove()
  assert.deepEqual(roleByName(buildRoleCatalog(config, registry.snapshot()), 'android-context').bindings, [])
  assert.equal(roleByName(buildRoleCatalog(config, snapshot), 'android-context').bindings.length, 1, '历史快照保持固定')
  assert.equal(enabled.roles.flatMap((entry) => entry.bindings).some((binding) => binding.extension?.startsWith('core.')), false)
  const removeAgain = registry.register(extension)
  assert.equal(roleByName(buildRoleCatalog(config, registry.snapshot()), 'android-context').bindings.length, 1)
  removeAgain()
})

test('扩展角色元数据校验并复制冻结，不能在注册后悄悄修改目录', () => {
  const registry = registryFor(normalizeConfig())
  const extension = createAndroidValidationContext()
  for (const field of ['name', 'skill', 'objective', 'condition']) {
    assert.throws(() => registry.register({ ...extension, role: { ...extension.role, [field]: '' } }), new RegExp(`role\\.${field}`))
  }
  assert.throws(() => registry.register({ ...extension, role: [] }), /role must be an object/)
  const metadata = { ...extension.role }
  registry.register({ ...extension, role: metadata })
  metadata.condition = 'changed after registration'
  assert.equal(registry.snapshot()[0].role.condition, extension.role.condition)
  assert.equal(Object.isFrozen(registry.snapshot()[0].role), true)
})

test('Android 六个真实挂载与多位置触发说明均来自已注册定义', () => {
  const config = normalizeConfig({ roles: { 'android-context': { label: '部署 Android 调查', objective: '部署职责说明' } } })
  const registry = registryFor(config)
  const extensions = androidExtensions()
  for (const extension of extensions) registry.register(extension)
  const android = roleByName(buildRoleCatalog(config, registry.snapshot()), 'android-context')
  assert.equal(android.label, '部署 Android 调查')
  assert.equal(android.description, '部署职责说明')
  assert.equal(android.sandbox, 'read-only')
  assert.equal(android.bindings.length, 6)
  const expected = [
    ['android.validation-context', 'validate', 'before', 'android-validation-context', undefined, 'validation.context'],
    ['android.project-context', 'context', 'before', 'android-validation-context', 'android.context.required'],
    ['android.design-context', 'solution', 'before', 'android-design-handoff', 'android.design.required', 'android.design.source'],
    ['android.platform-review', 'review', 'after', 'android-change-review', 'android.review.required', 'android.review.scope'],
    ['android.validation-evidence', 'validate', 'after', 'android-validation-evidence', 'android.validation.required', 'android.validation.requirements'],
    ['android.acceptance-evidence', 'signoff', 'before', 'android-acceptance-evidence', 'android.acceptance.required', 'android.acceptance.evidence'],
  ]
  for (const [id, node, phase, skill, required, source] of expected) {
    const binding = android.bindings.find((entry) => entry.extension === id)
    assert.equal(binding.node, node)
    assert.equal(binding.phase, phase)
    assert.equal(binding.skill, skill)
    assert.match(binding.condition, /projectKind === 'android'/)
    if (required) assert.ok(binding.condition.includes(`${required} === true`))
    if (source) assert.ok(binding.condition.includes(source))
    assert.notEqual(binding.objective, android.description, '挂载专项目标不能被角色总职责覆盖')
    const extension = extensions.find((entry) => entry.id === id)
    assert.equal(extension.role.name, 'android-context')
    assert.equal(binding.objective, extension.role.objective)
    const values = required ? { [required]: true } : {}
    assert.deepEqual(extension.match({ values }), { kind: 'unknown', missing: ['projectKind'] })
    assert.equal(extension.match({ values: { ...values, projectKind: 'ios' } }).kind, 'no')
    if (required) assert.equal(extension.match({ values: { projectKind: 'android', [required]: 'true' } }).kind, 'no')
    if (required && source) assert.deepEqual(extension.match({ values: { ...values, projectKind: 'android' } }), { kind: 'unknown', missing: [source] })
    if (!required) assert.equal(extension.match({ values: { projectKind: 'android', 'validation.context': '' } }).kind, 'no')
  }
  noUndefined(android)
})

test('Android 元数据技能/目标与 ready、run 真正调用保持一致', () => {
  const source = { kind: 'file', location: 'app/build.gradle.kts', revision: 'rev-1' }
  const requirement = { kind: 'build', target: { project: 'sample', revision: 'rev-1' }, sources: [source] }
  const values = {
    projectKind: 'android',
    'android.context.required': true,
    'android.design.required': true,
    'android.design.source': source,
    'android.review.required': true,
    'android.review.scope': { files: [source], checks: ['api'] },
    'android.validation.required': true,
    'android.validation.requirements': [requirement],
    'android.acceptance.required': true,
    'android.acceptance.evidence': [{ ...requirement, reportedResult: 'passed' }],
  }
  for (const extension of androidExtensions()) {
    assert.equal(extension.match({ values }).kind, 'yes')
    let checked
    extension.ready({ checkRoleAndSkill: (...args) => { checked = args; return { ready: true } } })
    assert.deepEqual(checked, [extension.role.name, extension.role.skill])
    let called
    extension.run({ facts: { values }, runConfiguredRole: (role, task) => { called = { role, task }; return { status: 'completed' } } })
    assert.equal(called.role, extension.role.name)
    assert.equal(called.task.skill, extension.role.skill)
    assert.ok(called.task.objective.startsWith(extension.role.objective))
  }
})
