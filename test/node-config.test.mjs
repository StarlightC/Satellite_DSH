import test from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../lib/node/index.js'

import { BUILTIN_ROLE_NAMES, BUILTIN_ROUTES, DEFAULT_CONFIG, EXECUTOR_TOOL_FILTER, IMPLEMENT_TOOL_FILTER, READ_ONLY_REVIEW_TOOL_FILTER, effectiveAgentOptions, effectiveSandboxMode, isSandboxMode, normalizeConfig, readLiveConfigValue, strictestSandboxMode } from '../lib/node/lib/config.js'


test('默认 provider 与默认角色存在', () => {
  const resolved = normalizeConfig()
  assert.equal(resolved.provider, 'spawn')
  assert.equal(resolved.nodes.validate.role, 'validation')
  assert.equal(resolved.roles.validation.skill, 'satellite-validation')
  assert.equal(resolved.roles['android-context'].skill, 'android-validation-context')
  // 第二个基础节点：当前差异的独立审查。
  assert.equal(resolved.nodes.review.role, 'change-review')
  assert.equal(resolved.roles['change-review'].skill, 'satellite-change-review')
  assert.match(resolved.roles['change-review'].objective, /独立审查/)
  assert.match(resolved.roles['change-review'].objective, /不自动修复/)
  assert.match(resolved.roles['change-review'].persona, /未验证/)
  // 第三个基础节点：流程第一步的有界调查。
  assert.equal(resolved.nodes.context.role, 'investigation')
  assert.equal(resolved.roles.investigation.skill, 'satellite-investigation')
  assert.match(resolved.roles.investigation.objective, /范围与停止条件/)
  assert.match(resolved.roles.investigation.objective, /只读/)
  assert.match(resolved.roles.investigation.persona, /事实/)
  assert.match(resolved.roles.investigation.persona, /缺口/)
  // 第四个基础节点：流程第二步的方案与决策（只读，到此停下等待决定）。
  assert.equal(resolved.nodes.solution.role, 'solution-design')
  assert.equal(resolved.roles['solution-design'].skill, 'satellite-solution')
  assert.match(resolved.roles['solution-design'].objective, /可评审/)
  assert.match(resolved.roles['solution-design'].objective, /决定/)
  assert.match(resolved.roles['solution-design'].objective, /不实施/)
  assert.match(resolved.roles['solution-design'].persona, /事实与推断/)
  assert.match(resolved.roles['solution-design'].persona, /不编造信心/)
  // 第六个基础节点：流程第三步的实施（唯一允许写文件的角色）。
  assert.equal(resolved.nodes.implement.role, 'implementation')
  assert.equal(resolved.roles.implementation.skill, 'satellite-implementation')
  assert.match(resolved.roles.implementation.objective, /已同意的基线/)
  assert.match(resolved.roles.implementation.objective, /一次一个单元/)
  assert.match(resolved.roles.implementation.objective, /不提交/)
  assert.match(resolved.roles.implementation.persona, /交回/)
  // 第五个基础节点：流程末步的验收（只按证据声明接受与否与剩余限制）。
  assert.equal(resolved.nodes.signoff.role, 'acceptance')
  assert.equal(resolved.roles.acceptance.skill, 'satellite-acceptance')
  assert.match(resolved.roles.acceptance.objective, /证据/)
  assert.match(resolved.roles.acceptance.objective, /不提交/)
  assert.match(resolved.roles.acceptance.objective, /不发布/)
  assert.match(resolved.roles.acceptance.objective, /不自动修复/)
  assert.match(resolved.roles.acceptance.persona, /未验证/)
  assert.match(resolved.roles.acceptance.persona, /业务验收/)
})

test('每个默认角色都带代码默认的 agentOptions（provider/model 非空）', () => {
  const names = Object.keys(DEFAULT_CONFIG.roles)
  assert.ok(names.length > 0)
  for (const name of names) {
    const options = DEFAULT_CONFIG.roles[name].agentOptions
    assert.ok(options, `角色 ${name} 必须有代码默认的 agentOptions（默认值归代码，不归 patch）`)
    assert.ok(options.provider, `角色 ${name} 的默认 provider 不能为空`)
    assert.ok(options.model, `角色 ${name} 的默认 model 不能为空`)
  }
  // 归一化后默认仍在：没有行配置覆盖时，默认 provider/model 不被顶掉。
  const resolved = normalizeConfig()
  for (const name of names) {
    assert.equal(resolved.roles[name].agentOptions.provider, DEFAULT_CONFIG.roles[name].agentOptions.provider)
    assert.equal(resolved.roles[name].agentOptions.model, DEFAULT_CONFIG.roles[name].agentOptions.model)
  }
  // provider/model 缺一不列：BUILTIN_ROUTES 覆盖的角色集合正好是有 agentOptions 的那些。
  assert.deepEqual(
    [...BUILTIN_ROLE_NAMES],
    names,
    'BUILTIN_ROLE_NAMES 必须与 DEFAULT_CONFIG.roles 的键一致（保持声明顺序）',
  )
  assert.deepEqual(
    BUILTIN_ROUTES.map((route) => route.role),
    names,
  )
  for (const route of BUILTIN_ROUTES) {
    assert.deepEqual(route, { role: route.role, provider: DEFAULT_CONFIG.roles[route.role].agentOptions.provider, model: DEFAULT_CONFIG.roles[route.role].agentOptions.model })
  }
})

test('审查角色的工具过滤拒绝写操作，但保留读 diff 与源码的命令', () => {
  const resolved = normalizeConfig()
  const deny = resolved.roles['change-review'].toolFilter.deny
  for (const tool of ['satellite_node', 'edit', 'write']) {
    assert.ok(deny.includes(tool), `审查角色必须拒绝 ${tool}`)
  }
  for (const tool of ['bash', 'read', 'grep', 'glob']) {
    assert.equal(deny.includes(tool), false, `审查角色不得拒绝只读工具 ${tool}`)
  }
  // 专属常量，不污染执行角色共用的过滤。
  assert.deepEqual(READ_ONLY_REVIEW_TOOL_FILTER.deny, ['satellite_node', 'edit', 'write'])
  assert.deepEqual(EXECUTOR_TOOL_FILTER.deny, ['satellite_node'])
  assert.notEqual(resolved.roles['change-review'].toolFilter, EXECUTOR_TOOL_FILTER)
})

test('调查角色的工具过滤同样拒绝写操作，但保留读事实来源的命令', () => {
  const resolved = normalizeConfig()
  const deny = resolved.roles.investigation.toolFilter.deny
  for (const tool of ['satellite_node', 'edit', 'write']) {
    assert.ok(deny.includes(tool), `调查角色必须拒绝 ${tool}`)
  }
  for (const tool of ['bash', 'read', 'grep', 'glob']) {
    assert.equal(deny.includes(tool), false, `调查角色不得拒绝只读工具 ${tool}`)
  }
  // 只读边界用同一条常量表达，不另复制一份。
  assert.equal(resolved.roles.investigation.toolFilter, READ_ONLY_REVIEW_TOOL_FILTER)
  assert.notEqual(resolved.roles.investigation.toolFilter, EXECUTOR_TOOL_FILTER)
})

test('方案角色的工具过滤同样拒绝写操作，但保留读事实来源的命令', () => {
  const resolved = normalizeConfig()
  const deny = resolved.roles['solution-design'].toolFilter.deny
  for (const tool of ['satellite_node', 'edit', 'write']) {
    assert.ok(deny.includes(tool), `方案角色必须拒绝 ${tool}`)
  }
  for (const tool of ['bash', 'read', 'grep', 'glob']) {
    assert.equal(deny.includes(tool), false, `方案角色不得拒绝只读工具 ${tool}`)
  }
  // “不实施”用同一条只读常量表达，不另复制一份。
  assert.equal(resolved.roles['solution-design'].toolFilter, READ_ONLY_REVIEW_TOOL_FILTER)
  assert.notEqual(resolved.roles['solution-design'].toolFilter, EXECUTOR_TOOL_FILTER)
})

test('实施角色保留 edit/write 工具，仍拒绝递归节点入口', () => {
  const resolved = normalizeConfig()
  const deny = resolved.roles.implementation.toolFilter.deny
  assert.ok(deny.includes('satellite_node'), '实施角色必须拒绝 satellite_node（禁止递归包裹）')
  for (const tool of ['edit', 'write']) {
    assert.equal(deny.includes(tool), false, `写角色必须保留写工具 ${tool}`)
  }
  // 专属常量，不复用只读那条（复用会让"实施角色可写"看起来像误配）。
  assert.equal(resolved.roles.implementation.toolFilter, IMPLEMENT_TOOL_FILTER)
  assert.notEqual(IMPLEMENT_TOOL_FILTER, READ_ONLY_REVIEW_TOOL_FILTER)
  assert.notEqual(IMPLEMENT_TOOL_FILTER, EXECUTOR_TOOL_FILTER, '实施与验证保留各自的策略常量，当前工具列表相同')
  assert.deepEqual(IMPLEMENT_TOOL_FILTER.deny, ['satellite_node'])
})

test('验收角色的工具过滤同样拒绝写操作，但保留读证据的命令', () => {
  const resolved = normalizeConfig()
  const deny = resolved.roles.acceptance.toolFilter.deny
  for (const tool of ['satellite_node', 'edit', 'write']) {
    assert.ok(deny.includes(tool), `验收角色必须拒绝 ${tool}`)
  }
  for (const tool of ['bash', 'read', 'grep', 'glob']) {
    assert.equal(deny.includes(tool), false, `验收角色不得拒绝只读工具 ${tool}`)
  }
  // “不自动修复”用同一条只读常量表达，不另复制一份。
  assert.equal(resolved.roles.acceptance.toolFilter, READ_ONLY_REVIEW_TOOL_FILTER)
  assert.notEqual(resolved.roles.acceptance.toolFilter, EXECUTOR_TOOL_FILTER)
})

test('本包自带的技能清单同时包含基础流程、变更审查、有界调查、方案设计、验收与实施', () => {
  const expected = ['satellite-base-flow', 'satellite-validation', 'satellite-change-review', 'satellite-investigation', 'satellite-solution', 'satellite-acceptance', 'satellite-implementation']
  assert.deepEqual([...DEFAULT_CONFIG.skills], expected)
  assert.deepEqual([...normalizeConfig().skills], expected)
  assert.deepEqual(Object.keys(DEFAULT_CONFIG.nodes).sort(), ['context', 'implement', 'review', 'signoff', 'solution', 'validate'])
})

test('行配置只覆盖给出的字段，默认 persona 与 toolFilter 不被顶掉', () => {
  const resolved = normalizeConfig({
    nodes: { validate: { role: 'validation' } },
    roles: { validation: { objective: '自定义目标' } },
  })
  assert.equal(resolved.roles.validation.objective, '自定义目标')
  assert.equal(resolved.roles.validation.persona, DEFAULT_CONFIG.roles.validation.persona)
  assert.deepEqual(resolved.roles.validation.toolFilter, EXECUTOR_TOOL_FILTER)
  assert.equal(resolved.roles.validation.skill, 'satellite-validation')
})

test('执行角色的默认工具过滤拒绝继承节点入口', () => {
  const resolved = normalizeConfig()
  assert.deepEqual(resolved.roles.validation.toolFilter.deny, ['satellite_node'])
})

test('可以新增角色与节点、覆盖 provider，且不修改默认对象', () => {
  const resolved = normalizeConfig({
    provider: 'fork',
    nodes: { 'custom-node': { role: 'custom-role' } },
    roles: { 'custom-role': { skill: 'other-skill', agentOptions: { provider: 'x', model: 'y' } } },
  })
  assert.equal(resolved.provider, 'fork')
  assert.equal(resolved.nodes['custom-node'].role, 'custom-role')
  assert.equal(resolved.roles['custom-role'].agentOptions.model, 'y')
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.roles.validation), true)
  assert.equal(DEFAULT_CONFIG.roles['custom-role'], undefined)
})

test('自带扩展开关默认开启，且逐字段合并而不是整体替换', () => {
  assert.equal(DEFAULT_CONFIG.builtinExtensions.acceptanceDecision, true)
  assert.equal(normalizeConfig().builtinExtensions.acceptanceDecision, true)
  assert.equal(
    normalizeConfig({ builtinExtensions: { acceptanceDecision: false } }).builtinExtensions.acceptanceDecision,
    false,
  )
  // 未知/非布尔值不改变默认，也不把默认对象改坏。
  assert.equal(normalizeConfig({ builtinExtensions: {} }).builtinExtensions.acceptanceDecision, true)
  assert.equal(
    normalizeConfig({ builtinExtensions: { acceptanceDecision: 'nope' } }).builtinExtensions.acceptanceDecision,
    true,
  )
  assert.equal(DEFAULT_CONFIG.builtinExtensions.acceptanceDecision, true)
})

test('活配置字段：引用对象用 get() 读，普通值原样返回，缺省走回落', () => {
  let current = { a: 1 }
  const ref = { get: () => current }
  assert.deepEqual(readLiveConfigValue(ref, 'fallback'), { a: 1 })
  current = undefined
  assert.equal(readLiveConfigValue(ref, 'fallback'), 'fallback')
  assert.deepEqual(readLiveConfigValue({ b: 2 }, 'fallback'), { b: 2 })
  assert.equal(readLiveConfigValue(undefined, 'fallback'), 'fallback')
  assert.equal(readLiveConfigValue(null, 'fallback'), 'fallback')
})

test('角色路由：活配置优先，未配置时回落到角色的 agentOptions', () => {
  const role = { agentOptions: { provider: 'p', model: 'm', maxTokens: 100 } }
  assert.deepEqual(effectiveAgentOptions({ role, roleName: 'validation', routes: [] }), role.agentOptions)
  assert.deepEqual(
    effectiveAgentOptions({
      role,
      roleName: 'validation',
      routes: [{ role: 'validation', provider: 'p2', model: 'm2' }],
    }),
    { provider: 'p2', model: 'm2', maxTokens: 100 },
  )
  assert.deepEqual(
    effectiveAgentOptions({
      role,
      roleName: 'other',
      routes: [{ role: 'validation', provider: 'p2', model: 'm2' }],
    }),
    role.agentOptions,
  )
})

test('活配置整体替换路由时带上 effort 与 maxTokens', () => {
  assert.deepEqual(
    effectiveAgentOptions({
      role: {},
      roleName: 'android-context',
      routes: [{ role: 'android-context', provider: 'p', model: 'm', reasoningEffort: 'low', maxTokens: 2048 }],
    }),
    { provider: 'p', model: 'm', reasoningEffort: 'low', maxTokens: 2048 },
  )
})

test('每个默认角色都带代码默认的 sandbox 模式：只读角色 read-only，可写角色 workspace-write', () => {
  const resolved = normalizeConfig()
  for (const name of ['investigation', 'solution-design', 'change-review', 'acceptance', 'android-context']) {
    assert.equal(DEFAULT_CONFIG.roles[name].sandbox, 'read-only', `角色 ${name} 默认 read-only`)
    assert.equal(resolved.roles[name].sandbox, 'read-only')
  }
  // 可写角色：validation 要跑测试/构建，implementation 要真实改文件。
  for (const name of ['validation', 'implementation']) {
    assert.equal(DEFAULT_CONFIG.roles[name].sandbox, 'workspace-write', `角色 ${name} 默认 workspace-write`)
    assert.equal(resolved.roles[name].sandbox, 'workspace-write')
  }
  // 每个内置角色都必须**显式**声明，不能靠"没写就走失败关闭"：否则以后新增角色会静默变成只读，
  // 排查时看不出是设计还是漏配。
  for (const name of Object.keys(DEFAULT_CONFIG.roles)) {
    assert.ok(DEFAULT_CONFIG.roles[name].sandbox, `角色 ${name} 必须显式声明 sandbox`)
  }
})

test('逐角色合并不丢 sandbox：只覆盖别的字段时默认模式保留，显式覆盖能生效', () => {
  const merged = normalizeConfig({ roles: { validation: { objective: '自定义目标' } } })
  assert.equal(merged.roles.validation.sandbox, 'workspace-write', '默认沙箱模式不被整体顶掉')
  assert.equal(merged.roles.validation.objective, '自定义目标')
  assert.equal(merged.roles.validation.skill, 'satellite-validation')
  const overridden = normalizeConfig({ roles: { validation: { sandbox: 'read-only' } } })
  assert.equal(overridden.roles.validation.sandbox, 'read-only', '显式覆盖必须生效')
  assert.equal(overridden.roles.validation.persona, DEFAULT_CONFIG.roles.validation.persona)
  // 行配置新增的角色不写 sandbox 时字段保持缺省，由 effectiveSandboxMode 失败关闭。
  const added = normalizeConfig({ roles: { 'custom-role': { skill: 'other-skill' } } })
  assert.equal(added.roles['custom-role'].sandbox, undefined)
})

test('生效沙箱模式：合法值原样采用，缺失/非法一律失败关闭到 read-only', () => {
  assert.deepEqual(effectiveSandboxMode({ sandbox: 'workspace-write' }), { mode: 'workspace-write', source: 'role' })
  assert.deepEqual(effectiveSandboxMode({ sandbox: 'danger-full-access' }), {
    mode: 'danger-full-access',
    source: 'role',
  })
  assert.deepEqual(effectiveSandboxMode({}), { mode: 'read-only', source: 'missing-fallback' })
  assert.deepEqual(effectiveSandboxMode(undefined), { mode: 'read-only', source: 'missing-fallback' })
  // 非法字符串不能退化成"不施加"，也不能被当成合法模式传给原生事件。
  assert.deepEqual(effectiveSandboxMode({ sandbox: 'read-write' }), { mode: 'read-only', source: 'invalid-fallback' })
  assert.equal(isSandboxMode('read-only'), true)
  assert.equal(isSandboxMode('read-write'), false)
  assert.equal(isSandboxMode(undefined), false)
})

test('拿不准时取最严格：strictestSandboxMode 偏向更小权限', () => {
  assert.equal(strictestSandboxMode(['workspace-write', 'danger-full-access']), 'workspace-write')
  assert.equal(strictestSandboxMode(['read-only', 'workspace-write']), 'read-only')
  assert.equal(strictestSandboxMode(['danger-full-access']), 'danger-full-access')
  assert.equal(strictestSandboxMode([]), 'read-only')
})

test('旧 cwd 配置保留供执行入口明确拒绝，不静默删除', () => {
  assert.equal(DEFAULT_CONFIG.roles.implementation.cwd, undefined)
  for (const cwd of ['test', '/remote/project', '', null, 123]) {
    assert.equal(normalizeConfig({ roles: { implementation: { cwd } } }).roles.implementation.cwd, cwd)
  }
})


const ROUTE_SHAPES = [
  { label: 'schema默认', input: {} },
  { label: '空数组', input: { routes: [] } },
  { label: '仅其他角色的稀疏数组', input: { routes: [{ role: 'change-review', provider: 'example', model: 'review-model' }] } },
]

for (const shape of ROUTE_SHAPES) {
  test(`真实 Config 的 ${shape.label} 一致拒绝隐形内置角色模型覆盖`, () => {
    const config = Config({ ...shape.input, roles: { validation: { agentOptions: { provider: 'example', model: 'custom' } } } })
    assert.throws(() => normalizeConfig(config), /validation.*routes/)
  })
}

test('内置角色的完整相同历史快照可接受，与键顺序无关', () => {
  const roles = Object.fromEntries(Object.entries(DEFAULT_CONFIG.roles).map(([name, role]) => [name, {
    agentOptions: Object.fromEntries(Object.entries(role.agentOptions).reverse()),
  }]))
  for (const shape of ROUTE_SHAPES) {
    const config = Config({ ...shape.input, roles })
    const normalized = normalizeConfig(config)
    assert.deepEqual(normalized.roles.validation.agentOptions, DEFAULT_CONFIG.roles.validation.agentOptions)
    const actual = effectiveAgentOptions({ role: normalized.roles.validation, roleName: 'validation', routes: config.routes.get() })
    assert.deepEqual(actual, DEFAULT_CONFIG.roles.validation.agentOptions, '保存其他角色不能切换 validation 模型')
  }
  assert.doesNotThrow(() => normalizeConfig(Config({})))
})

test('内置角色 agentOptions 的高级字段、不完整及非法覆盖必须显式迁移', () => {
  for (const roleName of BUILTIN_ROLE_NAMES) {
    const original = DEFAULT_CONFIG.roles[roleName].agentOptions
    for (const agentOptions of [
      { ...original, reasoningEffort: 'high' }, { ...original, maxTokens: 1024 },
      { ...original, extra: true }, { provider: original.provider }, { model: original.model },
      {}, null, undefined, [], 'invalid', 123,
    ]) {
      assert.throws(() => normalizeConfig(Config({ roles: { [roleName]: { agentOptions } } })), (error) => {
        assert.match(error.message, new RegExp(roleName))
        assert.match(error.message, /routes/)
        return true
      })
    }
  }
})

test('自定义角色仍可使用声明层默认，用户覆盖统一 routes 且保留高级选项', () => {
  const custom = { provider: 'example', model: 'custom', reasoningEffort: 'high', maxTokens: 1024 }
  const config = Config({
    roles: { 'custom-role': { agentOptions: custom } },
    routes: [{ role: 'validation', ...custom }],
  })
  const normalized = normalizeConfig(config)
  assert.deepEqual(normalized.roles['custom-role'].agentOptions, custom)
  assert.deepEqual(effectiveAgentOptions({ role: normalized.roles.validation, roleName: 'validation', routes: config.routes.get() }), custom)
  assert.deepEqual(effectiveAgentOptions({ role: normalized.roles['custom-role'], roleName: 'custom-role', routes: config.routes.get() }), custom)
})

// Entry: user changes node.role or supplies a partial explicit tier map in deployment Config.
test('tierRoles 整图替换，显式 role 覆盖即使同名也不继承隐式档位', () => {
  assert.equal(normalizeConfig().nodes.implement.tierRoles.senior, 'implementation-senior')
  const custom = normalizeConfig({ nodes: { implement: { role: 'custom' }, review: { role: 'change-review' } } })
  assert.equal(custom.nodes.implement.tierRoles, undefined)
  assert.equal(custom.nodes.review.tierRoles, undefined)
  const mapped = normalizeConfig({ nodes: { implement: { role: 'custom', tierRoles: { light: 'small' } }, validate: { tierRoles: {} } } })
  assert.deepEqual(mapped.nodes.implement.tierRoles, { light: 'small' })
  assert.deepEqual(mapped.nodes.validate.tierRoles, {})
})

// Entry: malformed user-provided tierRoles reaches normalizeConfig through the existing open nodes field.
test('拒绝非法 tierRoles 形状、未知档位与空角色', () => {
  for (const tierRoles of [null, [], 'light', { critical: 'implementation' }, { light: '' }, { senior: '  ' }, { standard: 4 }]) {
    assert.throws(() => normalizeConfig(Config({ nodes: { implement: { tierRoles } } })), /tierRoles/)
  }
})

// Entry: plugin upgrade adds defaults while a profile stores only one existing role override.
test('新增角色默认路由唯一且 sparse overrides 不冻结或丢失新增默认', () => {
  const config = Config({ routes: [{ role: 'implementation', provider: 'deepseek-official', model: 'deepseek-flash' }] })
  const normalized = normalizeConfig(config)
  assert.equal(new Set(BUILTIN_ROUTES.map((r) => r.role)).size, BUILTIN_ROUTES.length)
  for (const [variant, original] of [
    ['implementation-light', 'implementation'], ['implementation-senior', 'implementation'],
    ['change-review-light', 'change-review'], ['validation-light', 'validation'],
  ]) {
    assert.deepEqual(effectiveAgentOptions({ role: normalized.roles[variant], roleName: variant, routes: config.routes.get() }), DEFAULT_CONFIG.roles[original].agentOptions)
    assert.equal(normalized.roles[variant].skill, normalized.roles[original].skill)
    assert.deepEqual(normalized.roles[variant].toolFilter, normalized.roles[original].toolFilter)
    assert.equal(normalized.roles[variant].sandbox, normalized.roles[original].sandbox)
  }
  assert.equal(config.routes.get().length, 1)
  assert.equal(effectiveAgentOptions({ role: normalized.roles.implementation, roleName: 'implementation', routes: config.routes.get() }).model, 'deepseek-flash')
})
