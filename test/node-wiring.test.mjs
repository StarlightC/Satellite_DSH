import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { defineTool, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { DEFAULT_CONFIG } from '../lib/node/lib/config.js'

import { createAndroidValidationContext } from '../lib/android/lib/extension.js'
import { ANDROID_SKILL_NAMES, createAndroidNodeExtensions } from '../lib/android/lib/node-extensions.js'
import { createNodeCatalog, MATCH_YES, READY } from '../lib/contracts.js'
import { createSlotRegistry } from '../lib/registry.js'
import { resourceDirFrom } from '../lib/skills.js'
import { Config } from '../lib/node/index.js'
import { createNodeRuntime } from '../lib/node/lib/wiring.js'

// 从**构建产物入口**推导资源目录：构建后入口在 lib/node/，资源仍在包根的 node/。
const RESOURCE_DIR = resourceDirFrom(new URL('../lib/node/index.js', import.meta.url).href, 'node')
/** 真实包目录：`RoleConfig.cwd` 的写范围核对需要一个真实工作区。 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

function fakeDefineTool(options) {
  return { name: options.name, description: options.description, options }
}

/**
 * 装配级测试台。
 *
 * `withSandbox` 打开宿主侧的三个前提：`ctx.on`（`session/created` 订阅）、
 * `ctx.get('sessions')`、`ctx.get('sandboxPolicy')`。假的 `startActivation` 模拟
 * `dsh-session` 的 `create()`：先 `enter` 再**同步** `announce`，也就是同步派发
 * `session/created`，然后才返回 activation。
 * `interlopers` 用来在真正属于本次委派的子会话**之前**插入别的会话，验证识别不是"窗口内第一个就认"。
 */
function setup({
  withSkills = true,
  withSubagents = true,
  reply = '子 Agent 的正文结果',
  resultError,
  llm,
  selection,
  withRuntime = true,
  config,
  withSandbox = true,
  external = false,
  beforeCreate,
  setupMode,
  appendError = false,
  resolveError = false,
  readbackMode,
  // 只挂载会话事件与策略服务中的一个，用来验证"部分缺失也退化为不施加"。
  withSandboxPolicy = withSandbox,
  interlopers = [],
  afterListeners = [],
  earlierAgentListeners = [],
  // 会话工作区：`RoleConfig.cwd` 的包含关系与存在性都以它为边界。
  workspace = '/fake/project',
  // F1 回归：允许测试替换 skills.snapshot 的实现。
  skillsSnapshot,
  defineToolImpl = fakeDefineTool,
} = {}) {
  const catalog = createNodeCatalog()
  const registry = createSlotRegistry(catalog)
  const calls = { activations: [], tools: [], skills: [], nodes: [], sessions: [], sandboxEvents: [] }
  const disposers = []
  const skillNames = new Set()
  const sessionListeners = []
  const agentListeners = [...earlierAgentListeners]
  let sessionSequence = 0

  // 模拟官方 fold：最后一条 sandbox/mode 事件就是该会话的覆盖；没有事件时是部署默认。
  const sandboxPolicy = {
    resolve({ session }) {
      if (resolveError && session.header?.origin === 'subagent') throw new Error('resolve failed')
      if (readbackMode !== undefined && session.header?.origin === 'subagent') return { mode: readbackMode }
      const last = [...(session.events ?? [])].reverse().find((entry) => entry.type === 'sandbox/mode')
      return { mode: last?.data.mode ?? 'workspace-write', workspaceRoot: '/fake/project' }
    },
  }

  function makeSession(header = {}) {
    sessionSequence += 1
    const id = header.id ?? `child-${sessionSequence}`
    return {
      id,
      // header 由调用方给全（`origin` 缺省就是"不是子会话"）；这里只补 id 与 cwd。
      header: { id, cwd: '/fake/project', ...header },
      events: [],
      append(type, data) {
        if (appendError) throw new Error('append failed')
        this.events.push({ type, data })
        if (type === 'sandbox/mode') calls.sandboxEvents.push({ sessionId: id, type, data })
        return this.events.length
      },
    }
  }

  /** 同步派发一次 `session/created`，与 dsh-session 的 announce 一致。 */
  function fireSession(header) {
    const session = makeSession(header)
    calls.sessions.push(session)
    for (const listener of [...sessionListeners]) listener(session)
    return session
  }

  const ctx = {
    satelliteSlots: {
      defineNode(nodeId, options) {
        calls.nodes.push(nodeId)
        return catalog.defineNode(nodeId, options)
      },
      register: (extension) => registry.register(extension),
      resolve: (slot, facts, view, definitions) => registry.resolve(slot, facts, view, definitions),
      snapshot: () => registry.snapshot(),
      hasSlot: (name) => catalog.has(name),
      onSlotsChanged: () => () => {},
    },
    get(name) {
      if (name === 'skills' && withSkills) {
        return {
          register(skill) {
            calls.skills.push(skill)
            skillNames.add(skill.name)
            return () => {}
          },
          async snapshot(options) {
            if (skillsSnapshot) return skillsSnapshot(options)
            return { skills: [...skillNames].map((entry) => ({ name: entry })), complete: true }
          },
        }
      }
      if (name === 'subagents' && withSubagents) {
        return {
          list: () => ['spawn'],
          getProvider: () => ({
            ...(external ? {} : { prepareContinuable: async () => ({}) }),
            capabilities: { agentOptions: true, persona: true, toolFilter: true, depthLimit: true, outputSchema: true },
          }),
          resolveMaxDepth: (value) => value,
          async startActivation(spec) {
            calls.activations.push(spec)
            if (beforeCreate) await beforeCreate(spec)
            if (withSandbox) {
              for (const header of interlopers) fireSession(header)
              const session = fireSession({ id: spec.childId, parentSession: spec.request.parent.id, origin: 'subagent' })
              if (setupMode) session.append('sandbox/mode', { mode: setupMode, source: 'delegation' })
              for (const listener of agentListeners) await listener({ agent: { id: spec.childId, session } })
              calls.executed ??= []
              calls.executed.push({ childId: spec.childId, mode: sandboxPolicy.resolve({ session }).mode })
            }
            return {
              childId: spec.childId,
              get result() {
                return resultError
                  ? Promise.reject(resultError)
                  : Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: reply }] })
              },
              dispose: async () => {},
            }
          },
        }
      }
      if (name === 'workingDirectory') return { ensure: async () => workspace }
      if (name === 'llm') return llm
      if (name === 'subagentModelSelection') return selection
      if (name === 'sandboxPolicy' && withSandboxPolicy) return sandboxPolicy
      if (name === 'sessions' && withSandbox) return { list: () => calls.sessions }
      return undefined
    },
    tools: {
      register(definition) {
        calls.tools.push(definition)
        return () => {}
      },
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
  }
  if (withSandbox) {
    ctx.on = (name, listener) => {
      const listeners = name === 'session/created' ? sessionListeners : agentListeners
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    }
  }

  const runtime = withRuntime
    ? createNodeRuntime({ ctx, config, defineTool: defineToolImpl, resourceDir: RESOURCE_DIR })
    : undefined
  // 晚于本插件注册的监听器：用来验证"我们之后还有写入者"时仍然失败关闭。
  for (const listener of afterListeners) sessionListeners.push(listener)
  return { ctx, calls, registry, runtime, disposers, skillNames, fireSession }
}

/** F1 回归用台架：记录 skills.snapshot 收到的 view options，并允许改返回。 */
function fixtureSkillsProbe(seen) {
  let snapshotImpl = null
  const base = setup({
    skillsSnapshot(next) { snapshotImpl = next },
  })
  const originalGet = base.ctx.get.bind(base.ctx)
  base.ctx.get = (name) => {
    const value = originalGet(name)
    if (name !== 'skills' || !value) return value
    return {
      ...value,
      async snapshot(options) {
        seen.push(options)
        if (snapshotImpl) return snapshotImpl(options)
        return value.snapshot(options)
      },
    }
  }
  return {
    ...base,
    setSnapshot(next) { snapshotImpl = next },
  }
}

function fakeExec(id = 'session-1', mode = 'workspace-write') {
  return { agent: { id, session: { header: { id, cwd: '/fake/project' }, events: [{ type: 'sandbox/mode', data: { mode } }] } }, signal: new AbortController().signal }
}

/** 模拟 Android 组件：注册自己的技能与扩展（与真实入口同一份声明）。 */
function mountAndroid({ registry, skillNames }) {
  for (const extension of [createAndroidValidationContext(), ...createAndroidNodeExtensions()]) {
    registry.register(extension)
  }
  for (const name of ANDROID_SKILL_NAMES) skillNames.add(name)
}

test('角色说明复用装配配置并实时读取扩展，不启动角色或改变路由', () => {
  const config = Config({
    nodes: { validate: { role: 'custom-check' } },
    roles: { 'custom-check': { label: '项目检查', objective: '检查项目约定', sandbox: 'read-only' } },
    routes: [{ role: 'obsolete', provider: 'missing', model: 'untouched', maxTokens: 10 }],
  })
  const { runtime, registry, calls } = setup({ config })
  const first = runtime.describeRoles()
  assert.equal(first.roles.find((role) => role.role === 'validation').bindings.length, 0)
  const custom = first.roles.find((role) => role.role === 'custom-check')
  assert.equal(custom.label, '项目检查')
  assert.equal(custom.bindings[0].node, 'validate')
  assert.equal(first.roles.some((role) => role.role === 'obsolete'), false)
  const remove = registry.register(createAndroidValidationContext())
  assert.equal(runtime.describeRoles().roles.find((role) => role.role === 'android-context').bindings.length, 1)
  remove()
  assert.equal(runtime.describeRoles().roles.find((role) => role.role === 'android-context').bindings.length, 0)
  assert.deepEqual(config.routes.get(), [{ role: 'obsolete', provider: 'missing', model: 'untouched', maxTokens: 10 }])
  assert.equal(calls.activations.length, 0)
})

test('装配：声明节点、注册工具，且只注册本包自带的技能', () => {
  const { calls, runtime } = setup()
  assert.deepEqual(calls.nodes, ['context', 'solution', 'implement', 'validate', 'review', 'signoff', 'version-control'])
  assert.deepEqual(runtime.nodeIds, ['context', 'solution', 'implement', 'validate', 'review', 'signoff', 'version-control'])
  assert.deepEqual(calls.tools.map(tool => tool.name), ['satellite_version_control', 'satellite_node'])
  assert.deepEqual(calls.tools[1].options.parameters.node.required, true)
  assert.deepEqual(calls.skills.map((skill) => skill.name), [
    'satellite-base-flow',
    'satellite-validation',
    'satellite-change-review',
    'satellite-investigation',
    'satellite-solution',
    'satellite-acceptance',
    'satellite-implementation',
    'satellite-version-control',
  ])
})

test('缺guard只阻塞显式version-control，不影响旧节点；扩展不能取得保留角色身份', async () => {
  const { runtime, calls, registry } = setup()
  assert.equal(calls.activations.length, 0)
  const blocked = await runtime.tool.options.execute({ node: 'version-control', task: '明确请求status' }, fakeExec())
  assert.match(blocked.result, /guard/)
  assert.equal(calls.activations.length, 0)
  const ordinary = await runtime.tool.options.execute({ node: 'context', task: '旧调查节点' }, fakeExec())
  assert.equal(ordinary.kind, 'completed')
  registry.register(syntheticExtension({ id: 'test.reserved-role', slot: 'context.before', role: 'version-control', skill: 'satellite-version-control' }))
  const before = calls.activations.length
  const extension = await runtime.tool.options.execute({ node: 'context', task: '不能通过扩展调用保留角色' }, fakeExec('another'))
  assert.notEqual(extension.kind, 'completed')
  assert.equal(calls.activations.length, before)
})

test('没有技能表或子 Agent 服务时报告阻塞而不是抛错', () => {
  const noSkills = setup({ withSkills: false })
  assert.equal(noSkills.calls.skills.length, 0)
  const readiness = noSkills.runtime.checkRoleAndSkill('validation', 'satellite-base-flow')
  assert.equal(readiness.ready, false)
  assert.match(readiness.reason, /技能注册表/)

  const noSubagents = setup({ withSubagents: false })
  const second = noSubagents.runtime.checkRoleAndSkill('validation', 'satellite-base-flow')
  assert.equal(second.ready, false)
  assert.match(second.reason, /子 Agent 服务/)
})

test('before/base/after 全链路：领域扩展先跑，再跑基础节点', async () => {
  const { calls, registry, runtime, skillNames } = setup({ reply: '验证通过' })
  mountAndroid({ registry, skillNames })

  const value = await runtime.tool.options.execute(
    { node: 'validate', task: '跑一次真实验证', facts: { projectKind: 'android' } },
    fakeExec(),
  )

  assert.equal(value.kind, 'completed')
  assert.equal(value.node, 'validate')
  assert.deepEqual(
    calls.activations.map((activation) => activation.label),
    ['android.validation-context:android-context', 'satellite_node:validate'],
  )
  const base = calls.activations[1]
  assert.equal(base.provider, 'spawn')
  assert.equal(base.delivery, 'caller')
  assert.equal(base.request.cwd, '/fake/project')
  assert.deepEqual(base.request.toolFilter.deny, ['satellite_node'])
  assert.ok(base.request.persona, '默认 persona 不应被行配置顶掉')
  assert.match(base.request.prompt[0].text, /跑一次真实验证/)
  assert.match(calls.activations[0].request.prompt[0].text, /确认当前模块、变体/)
  assert.match(value.result, /验证通过/)
  assert.deepEqual(value.ran, ['android.validation-context'], '完成结果应报告实际执行的扩展')
})

test('review 节点：走完 before/base/after，子 Agent 用 change-review 的路由与只读工具过滤', async () => {
  const { ctx, calls, registry } = setup({ withRuntime: false, reply: '审查结论：未发现已证实缺陷' })
  const configured = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
  const scoped = createNodeRuntime({
    ctx,
    config: { routes: [{ role: 'change-review', ...configured }] },
    defineTool: fakeDefineTool,
    resourceDir: RESOURCE_DIR,
  })
  // 审查节点自己的 before/after 插槽必须先被声明，扩展才注册得上。
  for (const [id, slot] of [
    ['test.review-before', 'review.before'],
    ['test.review-after', 'review.after'],
  ]) {
    registry.register({
      id,
      slot,
      slotVersion: 1,
      match: () => MATCH_YES,
      ready: () => READY,
      run: () => ({ status: 'completed' }),
    })
  }

  const value = await scoped.tool.options.execute({ node: 'review', task: '独立审查当前差异' }, fakeExec())

  assert.equal(value.kind, 'completed')
  assert.equal(value.node, 'review')
  assert.deepEqual(value.ran, ['test.review-before', 'test.review-after'])
  assert.deepEqual(calls.activations.map((entry) => entry.label), ['satellite_node:review'])

  const base = calls.activations[0]
  assert.equal(base.provider, 'spawn')
  assert.deepEqual(base.request.agentOptions, configured, '审查角色按角色路由绑定模型')
  assert.deepEqual(base.request.toolFilter.deny, ['satellite_node', 'edit', 'write'])
  assert.equal(base.request.toolFilter.deny.includes('bash'), false)
  assert.equal(base.request.toolFilter.deny.includes('read'), false)
  assert.match(base.request.persona, /未验证/)
  assert.match(base.request.prompt[0].text, /独立审查当前差异/)
  assert.match(base.request.prompt[0].text, /satellite-change-review/)
  assert.match(value.result, /审查结论/)
})

test('context 节点：走完 before/base/after，子 Agent 用 investigation 的路由与只读工具过滤', async () => {
  const { ctx, calls, registry } = setup({ withRuntime: false, reply: '事实：入口在 src/node/lib/wiring.ts；缺口：未核对部署层覆盖' })
  const configured = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
  const scoped = createNodeRuntime({
    ctx,
    config: { routes: [{ role: 'investigation', ...configured }] },
    defineTool: fakeDefineTool,
    resourceDir: RESOURCE_DIR,
  })
  // 调查节点自己的 before/after 插槽必须先被声明，扩展才注册得上。
  for (const [id, slot] of [
    ['test.context-before', 'context.before'],
    ['test.context-after', 'context.after'],
  ]) {
    registry.register({
      id,
      slot,
      slotVersion: 1,
      match: () => MATCH_YES,
      ready: () => READY,
      run: () => ({ status: 'completed' }),
    })
  }

  const value = await scoped.tool.options.execute({ node: 'context', task: '有界调查：节点插槽的装配路径' }, fakeExec())

  assert.equal(value.kind, 'completed')
  assert.equal(value.node, 'context')
  assert.deepEqual(value.ran, ['test.context-before', 'test.context-after'])
  assert.deepEqual(calls.activations.map((entry) => entry.label), ['satellite_node:context'])

  const base = calls.activations[0]
  assert.equal(base.provider, 'spawn')
  assert.deepEqual(base.request.agentOptions, configured, '调查角色按角色路由绑定模型')
  assert.deepEqual(base.request.toolFilter.deny, ['satellite_node', 'edit', 'write'])
  assert.equal(base.request.toolFilter.deny.includes('bash'), false)
  assert.equal(base.request.toolFilter.deny.includes('read'), false)
  assert.match(base.request.persona, /缺口/)
  assert.match(base.request.prompt[0].text, /有界调查：节点插槽的装配路径/)
  assert.match(base.request.prompt[0].text, /satellite-investigation/)
  assert.match(value.result, /事实：入口在/)
})

test('solution 节点：走完 before/base/after，子 Agent 用 solution-design 的路由与只读工具过滤', async () => {
  const { ctx, calls, registry } = setup({ withRuntime: false, reply: '推荐方案：复用现有装配；需要的决定：由谁定路由默认值' })
  const configured = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
  const scoped = createNodeRuntime({
    ctx,
    config: { routes: [{ role: 'solution-design', ...configured }] },
    defineTool: fakeDefineTool,
    resourceDir: RESOURCE_DIR,
  })
  // 方案节点自己的 before/after 插槽必须先被声明，扩展才注册得上。
  for (const [id, slot] of [
    ['test.solution-before', 'solution.before'],
    ['test.solution-after', 'solution.after'],
  ]) {
    registry.register({
      id,
      slot,
      slotVersion: 1,
      match: () => MATCH_YES,
      ready: () => READY,
      run: () => ({ status: 'completed' }),
    })
  }

  const value = await scoped.tool.options.execute(
    { node: 'solution', task: '把当前差异的事实转成可评审的方案' },
    fakeExec(),
  )

  assert.equal(value.kind, 'completed')
  assert.equal(value.node, 'solution')
  assert.deepEqual(value.ran, ['test.solution-before', 'test.solution-after'])
  assert.deepEqual(calls.activations.map((entry) => entry.label), ['satellite_node:solution'])

  const base = calls.activations[0]
  assert.equal(base.provider, 'spawn')
  assert.deepEqual(base.request.agentOptions, configured, '方案角色按角色路由绑定模型')
  assert.deepEqual(base.request.toolFilter.deny, ['satellite_node', 'edit', 'write'])
  assert.equal(base.request.toolFilter.deny.includes('bash'), false)
  assert.equal(base.request.toolFilter.deny.includes('read'), false)
  assert.match(base.request.persona, /不编造信心/)
  assert.match(base.request.prompt[0].text, /把当前差异的事实转成可评审的方案/)
  assert.match(base.request.prompt[0].text, /satellite-solution/)
  assert.match(value.result, /推荐方案/)
})

test('implement 节点：走完 before/base/after，继承父权限而不是通过 cwd 授权', async () => {
  const { ctx, calls, registry } = setup({
    withRuntime: false,
    withSandbox: true,
    workspace: PACKAGE_ROOT,
    reply: '实施单元：改了 X；检查：typecheck 通过',
  })
  const scoped = createNodeRuntime({
    ctx,
    config: {},
    defineTool: fakeDefineTool,
    resourceDir: RESOURCE_DIR,
  })
  for (const [id, slot] of [
    ['test.implement-before', 'implement.before'],
    ['test.implement-after', 'implement.after'],
  ]) {
    registry.register({
      id,
      slot,
      slotVersion: 1,
      match: () => MATCH_YES,
      ready: () => READY,
      run: () => ({ status: 'completed' }),
    })
  }

  const value = await scoped.tool.options.execute(
    { node: 'implement', task: '按已同意的单元改一处配置', unit: 'unit-1' },
    fakeExec(),
  )

  assert.equal(value.kind, 'completed')
  assert.equal(value.node, 'implement')
  assert.deepEqual(value.ran, ['test.implement-before', 'test.implement-after'])
  assert.deepEqual(calls.activations.map((entry) => entry.label), ['satellite_node:implement:unit-1'])

  const base = calls.activations[0]
  assert.equal(base.provider, 'spawn')
  // 写角色：不拒绝 edit/write，但仍拒绝节点入口（禁止递归包裹）。
  assert.deepEqual(base.request.toolFilter.deny, ['satellite_node'])
  assert.equal(base.request.toolFilter.deny.includes('edit'), false)
  assert.equal(base.request.toolFilter.deny.includes('write'), false)
  assert.equal(base.request.cwd, PACKAGE_ROOT, '只透传当前工作目录，不声称改变权限根')
  assert.match(base.request.prompt[0].text, /satellite-implementation/)
  assert.match(base.request.persona, /交回/)
  assert.deepEqual(calls.sandboxEvents.map((entry) => entry.data), [
    { mode: 'workspace-write', source: 'delegation' },
  ])
  assert.deepEqual(value.sandbox, ['satellite_node:implement:unit-1=workspace-write'])
  assert.match(value.result, /typecheck 通过/)
})

test('implement 节点：未配置 cwd 时子 Agent 用会话工作区（现状不变）', async () => {
  const { calls, runtime } = setup({ withSandbox: true, reply: '实施完成' })

  const value = await runtime.tool.options.execute({ node: 'implement', task: '改一个已同意的单元' }, fakeExec())

  assert.equal(value.kind, 'completed')
  assert.equal(calls.activations[0].request.cwd, '/fake/project')
  assert.deepEqual(calls.activations[0].request.toolFilter.deny, ['satellite_node'])
  assert.deepEqual(value.sandbox, ['satellite_node:implement=workspace-write'])
})

test('旧 role.cwd 的所有非 undefined 值都在创建前拒绝，包括存在的目录', async () => {
  for (const cwd of ['test', PACKAGE_ROOT, '../outside', 'no-such-unit-dir', 123, null, '']) {
    const { calls, runtime } = setup({ config: { roles: { implementation: { cwd } } } })
    const value = await runtime.tool.options.execute({ node: 'implement', task: '改已同意单元' }, fakeExec())
    assert.equal(calls.activations.length, 0)
    assert.equal(value.kind, 'failed')
    assert.match(value.result, /不支持 role.cwd 收窄写范围/)
  }
})

test('signoff 节点：走完 before/base/after，子 Agent 用 acceptance 的路由与只读工具过滤', async () => {
  const { ctx, calls, registry } = setup({ withRuntime: false, reply: '接受：100/100 通过；未验证：真机与发布路径' })
  const configured = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
  const scoped = createNodeRuntime({
    ctx,
    config: { routes: [{ role: 'acceptance', ...configured }] },
    defineTool: fakeDefineTool,
    resourceDir: RESOURCE_DIR,
  })
  // 验收节点自己的 before/after 插槽必须先被声明，扩展才注册得上。
  for (const [id, slot] of [
    ['test.signoff-before', 'signoff.before'],
    ['test.signoff-after', 'signoff.after'],
  ]) {
    registry.register({
      id,
      slot,
      slotVersion: 1,
      match: () => MATCH_YES,
      ready: () => READY,
      run: () => ({ status: 'completed' }),
    })
  }

  const value = await scoped.tool.options.execute(
    { node: 'signoff', task: '按证据声明接受与否与剩余限制' },
    fakeExec(),
  )

  assert.equal(value.kind, 'completed')
  assert.equal(value.node, 'signoff')
  assert.deepEqual(value.ran, ['test.signoff-before', 'test.signoff-after'])
  assert.deepEqual(calls.activations.map((entry) => entry.label), ['satellite_node:signoff'])

  const base = calls.activations[0]
  assert.equal(base.provider, 'spawn')
  assert.deepEqual(base.request.agentOptions, configured, '验收角色按角色路由绑定模型')
  assert.deepEqual(base.request.toolFilter.deny, ['satellite_node', 'edit', 'write'])
  assert.equal(base.request.toolFilter.deny.includes('bash'), false)
  assert.equal(base.request.toolFilter.deny.includes('read'), false)
  assert.match(base.request.persona, /业务验收/)
  assert.match(base.request.prompt[0].text, /按证据声明接受与否与剩余限制/)
  assert.match(base.request.prompt[0].text, /satellite-acceptance/)
  assert.match(value.result, /接受：100\/100/)
})

test('条件未知时在 before 暂停，基础节点不启动；恢复后补交事实再执行', async () => {
  const { ctx, calls, registry, runtime, skillNames } = setup()
  mountAndroid({ registry, skillNames })

  const suspended = await runtime.tool.options.execute({ node: 'validate', task: '验证' }, fakeExec())
  assert.equal(suspended.kind, 'suspended')
  assert.equal(suspended.stage, 'before')
  assert.deepEqual(suspended.missing, ['projectKind'])
  assert.ok(suspended.token)
  assert.equal(calls.activations.length, 0, 'base 与扩展都不应启动')

  const resumed = await runtime.tool.options.execute(
    { node: 'validate', task: '验证', resume: suspended.token, facts: { projectKind: 'android' } },
    fakeExec(),
  )
  assert.equal(resumed.kind, 'completed')
  assert.deepEqual(
    calls.activations.map((activation) => activation.label),
    ['android.validation-context:android-context', 'satellite_node:validate'],
  )
})

test('领域技能不可见时扩展不执行，也不启动基础节点', async () => {
  const { calls, registry, runtime } = setup()
  // 只注册扩展，不注册它的技能（模拟领域包未挂载或技能注册失败）。
  registry.register(createAndroidValidationContext())

  const value = await runtime.tool.options.execute(
    { node: 'validate', task: '验证', facts: { projectKind: 'android' } },
    fakeExec(),
  )
  assert.equal(value.kind, 'suspended')
  assert.equal(value.stage, 'before')
  assert.equal(value.reason, 'blocked')
  assert.match(value.blocked.join(' '), /技能在当前作用域不可见：android-validation-context/)
  assert.equal(calls.activations.length, 0)
})

/**
 * after 阶段的业务决定：core 自带扩展随节点装配一起注册（默认开启）。
 * 先暂停、再用同一 token 补交决定恢复；全程用 activation 计数证明 base 只跑一次。
 */
test('after 阶段索要业务决定：暂停后恢复，base 恰好只跑一次', async () => {
  const { calls, registry, runtime, skillNames } = setup({ reply: '验证通过' })
  mountAndroid({ registry, skillNames })
  assert.ok(
    registry.snapshot().some((entry) => entry.id === 'core.acceptance-decision.validate'),
    '默认配置应注册 core 的 after 扩展',
  )
  const baseRuns = () => calls.activations.filter((entry) => entry.label === 'satellite_node:validate').length

  const suspended = await runtime.tool.options.execute(
    { node: 'validate', task: '验证', facts: { projectKind: 'android', 'acceptance.required': true } },
    fakeExec(),
  )
  assert.equal(suspended.kind, 'suspended')
  assert.equal(suspended.stage, 'after')
  assert.equal(suspended.reason, 'needs_decision')
  assert.deepEqual(suspended.ran, ['android.validation-context', 'core.acceptance-decision.validate'])
  assert.deepEqual(
    calls.activations.map((activation) => activation.label),
    ['android.validation-context:android-context', 'satellite_node:validate'],
  )
  assert.equal(baseRuns(), 1, 'after 暂停前 base 已真实跑过一次')

  const resumed = await runtime.tool.options.execute(
    { node: 'validate', task: '验证', resume: suspended.token, decision: 'accept' },
    fakeExec(),
  )
  assert.equal(resumed.kind, 'completed')
  assert.equal(baseRuns(), 1, '恢复不得重跑 base')
  assert.deepEqual(
    calls.activations.map((activation) => activation.label),
    ['android.validation-context:android-context', 'satellite_node:validate'],
    '已完成的 before 也不重复执行',
  )
})

test('facts 描述中的扁平键 JSON 示例实际触发 after 暂停，恢复保留历史但不重跑 base', async () => {
  const { calls, runtime } = setup()
  const { tool } = runtime
  assert.match(tool.description, /扁平键 JSON（不是嵌套对象）/)
  const description = tool.options.parameters.facts.description
  assert.match(description, /点号是键名的一部分，不解析嵌套对象/)
  assert.match(description, /嵌套写法.*不会触发该暂停/)
  // 执行模型实际读到的示例，而不是另写一份正确参数掩盖说明错误。
  const example = description.match(/例如 (\{[^\n]*?\})（作为 facts 的值）/)
  assert.ok(example, 'facts 说明必须包含可直接解析的 JSON 示例')
  const facts = JSON.parse(example[1])
  assert.deepEqual(facts, { 'acceptance.required': true })
  const args = { node: 'validate', task: '验证说明示例', facts }
  const suspended = await tool.options.execute(args, fakeExec())
  assert.equal(suspended.kind, 'suspended')
  assert.equal(suspended.stage, 'after')
  assert.equal(suspended.reason, 'needs_decision')
  assert.equal(calls.activations.length, 1)
  const render = (value) => tool.options.output.render({}, value)[0].text
  assert.doesNotMatch(render(suspended), /历史暂停记录/)

  const resumed = await tool.options.execute(
    { node: args.node, task: args.task, resume: suspended.token, decision: 'accept' }, fakeExec(),
  )
  assert.equal(resumed.kind, 'completed')
  assert.equal(calls.activations.length, 1, '恢复不能重跑 base')
  assert.deepEqual(resumed.extensions, suspended.extensions, '机器输出必须保留历史状态与原文')
  assert.match(render(resumed), /历史暂停记录（当前节点已完成）：\n扩展 .*：needs_decision\n基础节点已完成，等待提交处理决定/)
})

test('嵌套 acceptance.required 不归一化，不触发 after 暂停', async () => {
  const { calls, runtime } = setup()
  const value = await runtime.tool.options.execute(
    { node: 'validate', task: '保留既有事实语义', facts: { acceptance: { required: true } } }, fakeExec(),
  )
  assert.equal(value.kind, 'completed')
  assert.equal(calls.activations.length, 1)
  assert.deepEqual(value.extensions, [])
  assert.doesNotMatch(runtime.tool.options.output.render({}, value)[0].text, /历史暂停记录/)
})

test('关闭 core 自带扩展后 after 不再索要决定，节点直接完成', async () => {
  const { calls, registry, runtime, skillNames } = setup({
    reply: '验证通过',
    config: { builtinExtensions: { acceptanceDecision: false } },
  })
  mountAndroid({ registry, skillNames })
  assert.equal(
    registry.snapshot().some((entry) => entry.id === 'core.acceptance-decision.validate'),
    false,
  )

  const value = await runtime.tool.options.execute(
    { node: 'validate', task: '验证', facts: { projectKind: 'android', 'acceptance.required': true } },
    fakeExec(),
  )
  assert.equal(value.kind, 'completed')
  assert.deepEqual(
    calls.activations.map((activation) => activation.label),
    ['android.validation-context:android-context', 'satellite_node:validate'],
  )
})

test('未知节点与缺少调用方身份都返回阻塞结果', async () => {
  const { runtime } = setup()
  const unknown = await runtime.tool.options.execute({ node: 'nope', task: 'x' }, fakeExec())
  assert.equal(unknown.kind, 'blocked')
  assert.match(unknown.reason, /未知节点/)

  const noAgent = await runtime.tool.options.execute(
    { node: 'validate', task: 'x' },
    { signal: new AbortController().signal },
  )
  assert.equal(noAgent.kind, 'blocked')
  assert.match(noAgent.reason, /调用方 Agent 身份/)
})

test('输出渲染给出可读文本而不是原始 JSON', async () => {
  const { registry, runtime, skillNames } = setup()
  mountAndroid({ registry, skillNames })
  const value = await runtime.tool.options.execute(
    { node: 'validate', task: '验证', facts: { projectKind: 'android' } },
    fakeExec(),
  )
  const blocks = runtime.tool.options.output.render({}, value)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /节点 validate：completed/)
})

test('角色路由透传给原生创建请求', async () => {
  const { ctx, calls, registry, skillNames } = setup({ withRuntime: false })
  const configured = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
  const scoped = createNodeRuntime({
    ctx,
    config: { routes: [{ role: 'validation', ...configured }] },
    defineTool: fakeDefineTool,
    resourceDir: RESOURCE_DIR,
  })
  mountAndroid({ registry, skillNames })
  await scoped.tool.options.execute(
    { node: 'validate', task: '验证', facts: { projectKind: 'android' } },
    fakeExec(),
  )
  assert.deepEqual(calls.activations.at(-1).label, 'satellite_node:validate')
  assert.deepEqual(calls.activations.at(-1).request.agentOptions, configured)
})

test('非法路由在创建子 Agent 之前被原生校验拒绝，不产生子会话', async () => {
  const rejecting = {
    async resolveCallConfig(config) {
      throw new Error(`no adapter owns route ${config.provider}`)
    },
  }
  const { ctx, calls } = setup({ llm: rejecting, withRuntime: false })
  const scoped = createNodeRuntime({
    ctx,
    config: { routes: [{ role: 'validation', provider: 'no-such-provider', model: 'x' }] },
    defineTool: fakeDefineTool,
    resourceDir: RESOURCE_DIR,
  })
  const value = await scoped.tool.options.execute({ node: 'validate', task: '验证' }, fakeExec())
  assert.equal(calls.activations.length, 0, '预检失败不得创建子会话')
  assert.equal(value.kind, 'failed')
  assert.match(value.result, /no adapter owns route no-such-provider/)
})

test('宿主模型选择策略启用时，越界路由在创建前被拒绝', async () => {
  const selectionService = { current: () => ({ enabled: true, allowedModels: [{ provider: 'deepseek-official', model: 'deepseek-flash' }] }) }
  const { ctx, calls } = setup({ selection: selectionService, withRuntime: false })
  const scoped = createNodeRuntime({
    ctx,
    config: { routes: [{ role: 'validation', provider: 'deepseek-official', model: 'deepseek-v4-pro' }] },
    defineTool: fakeDefineTool,
    resourceDir: RESOURCE_DIR,
  })
  const value = await scoped.tool.options.execute({ node: 'validate', task: '验证' }, fakeExec())
  assert.equal(calls.activations.length, 0)
  assert.equal(value.kind, 'failed')
  assert.match(value.result, /不在宿主允许的模型列表内/)
})

test('改活配置后下一次调用立即生效，无需重新装配', async () => {
  const { ctx, calls, registry, skillNames } = setup({ withRuntime: false })
  let live = [{ role: 'validation', provider: 'deepseek-official', model: 'deepseek-flash' }]
  const routesRef = { get: () => live }
  const scoped = createNodeRuntime({
    ctx,
    config: { routes: routesRef },
    defineTool: fakeDefineTool,
    resourceDir: RESOURCE_DIR,
  })
  mountAndroid({ registry, skillNames })

  await scoped.tool.options.execute({ node: 'validate', task: '验证', facts: { projectKind: 'android' } }, fakeExec())
  assert.deepEqual(calls.activations.at(-1).request.agentOptions, { provider: 'deepseek-official', model: 'deepseek-flash' })

  // 不重建 runtime、不重新装配，只改活配置值
  live = [{ role: 'validation', provider: 'deepseek-official', model: 'deepseek-v4-pro' }]
  await scoped.tool.options.execute({ node: 'validate', task: '验证', facts: { projectKind: 'android' } }, fakeExec())
  assert.deepEqual(calls.activations.at(-1).request.agentOptions, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
})

test('行配置为空时走 schema 代码默认路由：review→v4-pro、validate→flash', async () => {
  const { ctx, calls, registry, skillNames } = setup({ withRuntime: false, reply: 'ok' })
  const scoped = createNodeRuntime({
    ctx,
    // 这就是 patch 不再写 config 之后 Loader 交给插件的形状：默认值全部来自代码常量。
    config: Config({}),
    defineTool: fakeDefineTool,
    resourceDir: RESOURCE_DIR,
  })
  mountAndroid({ registry, skillNames })

  await scoped.tool.options.execute({ node: 'review', task: '独立审查当前差异' }, fakeExec())
  assert.deepEqual(calls.activations.at(-1).request.agentOptions, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  })

  await scoped.tool.options.execute({ node: 'validate', task: '验证', facts: { projectKind: 'android' } }, fakeExec())
  assert.equal(calls.activations.at(-1).label, 'satellite_node:validate')
  assert.deepEqual(calls.activations.at(-1).request.agentOptions, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  })
})

test('活配置里的越界路由同样在创建前被拒绝', async () => {
  const llm = {
    async resolveCallConfig(config) {
      throw new Error(`no adapter owns route ${config.provider}`)
    },
  }
  const { ctx, calls } = setup({ withRuntime: false, llm })
  const routesRef = { get: () => [{ role: 'validation', provider: 'no-such-provider', model: 'x' }] }
  const scoped = createNodeRuntime({
    ctx,
    config: { routes: routesRef },
    defineTool: fakeDefineTool,
    resourceDir: RESOURCE_DIR,
  })
  const value = await scoped.tool.options.execute({ node: 'validate', task: '验证' }, fakeExec())
  assert.equal(calls.activations.length, 0)
  assert.equal(value.kind, 'failed')
  assert.match(value.result, /no-such-provider/)
})

test('装配：只读角色（change-review）在子会话建立时被施加 read-only 沙箱模式', async () => {
  const { calls, runtime } = setup({ withSandbox: true, reply: '审查结论：未发现已证实缺陷' })

  const value = await runtime.tool.options.execute({ node: 'review', task: '独立审查当前差异' }, fakeExec())

  assert.equal(value.kind, 'completed')
  assert.deepEqual(
    calls.sandboxEvents.map((entry) => entry.data),
    [{ mode: 'read-only', source: 'delegation' }],
    '子会话必须收到一条 read-only 的 sandbox/mode 事件（与原生委派播种同形）',
  )
  assert.deepEqual(value.sandbox, ['satellite_node:review=read-only'])
  const blocks = runtime.tool.options.output.render({}, value)
  assert.match(blocks[0].text, /沙箱：satellite_node:review=read-only/)
})

test('装配：验证角色（validation）在子会话建立时被施加 workspace-write 沙箱模式', async () => {
  const { calls, runtime } = setup({ withSandbox: true, reply: '验证通过' })

  const value = await runtime.tool.options.execute({ node: 'validate', task: '跑一次真实验证' }, fakeExec())

  assert.equal(value.kind, 'completed')
  assert.deepEqual(calls.sandboxEvents.map((entry) => entry.data), [
    { mode: 'workspace-write', source: 'delegation' },
  ])
  assert.deepEqual(value.sandbox, ['satellite_node:validate=workspace-write'])
})

test('装配：扩展角色（android-context）同样按角色模式施加，逐角色如实报告', async () => {
  const { calls, registry, runtime, skillNames } = setup({ withSandbox: true, reply: '确认完毕' })
  mountAndroid({ registry, skillNames })

  const value = await runtime.tool.options.execute(
    { node: 'validate', task: '验证', facts: { projectKind: 'android' } },
    fakeExec(),
  )

  assert.equal(value.kind, 'completed')
  assert.deepEqual(
    calls.sandboxEvents.map((entry) => entry.data),
    [
      { mode: 'read-only', source: 'delegation' },
      { mode: 'workspace-write', source: 'delegation' },
    ],
    '先跑的领域扩展是只读角色，后跑的基础节点是可写角色，各自拿到自己的模式',
  )
  assert.deepEqual(value.sandbox, [
    'android.validation-context:android-context=read-only',
    'satellite_node:validate=workspace-write',
  ])
})

test('失败关闭：非子会话与其他父会话的 session/created 不消费期望，模式仍落到真正的子会话', async () => {
  const { calls, runtime } = setup({
    withSandbox: true,
    // 第一个是用户会话（无 origin），第二个是别的父会话的子会话：两者都不该被本次委派认领。
    interlopers: [{ parentSession: 'session-1' }, { parentSession: 'another-session', origin: 'subagent' }],
    reply: '审查结论',
  })

  const value = await runtime.tool.options.execute({ node: 'review', task: '独立审查当前差异' }, fakeExec())

  assert.equal(value.kind, 'completed')
  assert.deepEqual(
    calls.sessions.map((session) => session.events.length),
    [0, 0, 1],
    '用户会话与别的父会话都不该被写入 sandbox/mode',
  )
  assert.deepEqual(calls.sandboxEvents.map((entry) => entry.data), [
    { mode: 'read-only', source: 'delegation' },
  ])
})

test('角色 sandbox 配置非法时失败关闭到 read-only，并在结果里注明来源', async () => {
  const { calls, runtime } = setup({
    withSandbox: true,
    config: { roles: { validation: { sandbox: 'read-write' } } },
    reply: '验证通过',
  })

  const value = await runtime.tool.options.execute({ node: 'validate', task: '跑一次真实验证' }, fakeExec())

  assert.equal(value.kind, 'completed')
  assert.deepEqual(calls.sandboxEvents.map((entry) => entry.data), [{ mode: 'read-only', source: 'delegation' }])
  assert.deepEqual(value.sandbox, ['satellite_node:validate=read-only，角色 sandbox 配置非法，失败关闭'])
})

test('宿主未挂载沙箱服务时拒绝启动，不退化执行', async () => {
  const { calls, runtime } = setup({ withSandbox: false })
  const value = await runtime.tool.options.execute({ node: 'validate', task: '验证' }, fakeExec())
  assert.equal(value.kind, 'failed')
  assert.equal(calls.activations.length, 0)
  assert.match(value.result, /缺少沙箱策略/)
})

test('恢复路径复用已完成的基础结果时，如实说明本次没有重新施加模式', async () => {
  const { registry, runtime, skillNames } = setup({ withSandbox: true, reply: '验证通过' })
  mountAndroid({ registry, skillNames })

  const suspended = await runtime.tool.options.execute(
    { node: 'validate', task: '验证', facts: { projectKind: 'android', 'acceptance.required': true } },
    fakeExec(),
  )
  assert.equal(suspended.kind, 'suspended')
  const resumed = await runtime.tool.options.execute(
    { node: 'validate', task: '验证', resume: suspended.token, decision: 'accept' },
    fakeExec(),
  )
  assert.equal(resumed.kind, 'completed')
  assert.deepEqual(resumed.sandbox, ['satellite_node:validate=未重新施加（复用上次调用已完成的基础结果）'])
})

test('失败关闭：晚于本插件注册的监听器把模式改宽时，窗口关闭前重写并如实报告', async () => {
  // 合成的反例：一个在我们之后注册、无条件写 danger-full-access 的监听器。
  const widening = (session) => {
    if (session.header.origin === 'subagent') {
      session.append('sandbox/mode', { mode: 'danger-full-access', source: 'delegation' })
    }
  }
  const { calls, runtime } = setup({ withSandbox: true, afterListeners: [widening], reply: '审查结论' })

  const value = await runtime.tool.options.execute({ node: 'review', task: '独立审查当前差异' }, fakeExec())

  assert.deepEqual(
    calls.sandboxEvents.map((entry) => entry.data.mode),
    ['read-only', 'danger-full-access', 'read-only'],
    '发现被改宽后必须再写一次，让目标模式成为最后一条事件',
  )
  assert.deepEqual(value.sandbox, [
    'satellite_node:review=read-only',
  ])
})

test('只挂载会话事件但缺策略时启动前失败', async () => {
  const { calls, runtime } = setup({ withSandboxPolicy: false })
  const value = await runtime.tool.options.execute({ node: 'validate', task: '验证' }, fakeExec())
  assert.equal(value.kind, 'failed')
  assert.equal(calls.activations.length, 0)
  assert.equal(calls.sandboxEvents.length, 0)
})

for (const options of [{ appendError: true }, { resolveError: true }, { readbackMode: 'danger-full-access' }]) {
  test(`施加/读回失败在创建钩子 veto：${JSON.stringify(options)}`, async () => {
    const { calls, runtime } = setup(options)
    const value = await runtime.tool.options.execute({ node: 'review', task: '审查' }, fakeExec())
    assert.equal(value.kind, 'failed')
    assert.equal(calls.executed?.length ?? 0, 0)
    assert.equal(value.sandbox, undefined)
  })
}

test('父只读是上限，implementation 不得提升为 workspace-write', async () => {
  const { calls, runtime } = setup({ setupMode: 'read-only' })
  const value = await runtime.tool.options.execute({ node: 'implement', task: '实施' }, fakeExec('parent', 'read-only'))
  assert.equal(value.kind, 'completed')
  assert.equal(calls.executed[0].mode, 'read-only')
  assert.match(value.sandbox[0], /父会话权限上限/)
})

test('原生 setup 在 session/created 后播种父权限，agent/created 必须在执行前收窄', async () => {
  const { calls, runtime } = setup({ setupMode: 'workspace-write' })
  const value = await runtime.tool.options.execute({ node: 'review', task: '审查' }, fakeExec())
  assert.equal(value.kind, 'completed')
  assert.deepEqual(calls.sandboxEvents.map((entry) => entry.data.mode), ['read-only', 'workspace-write', 'read-only'])
  assert.equal(calls.executed[0].mode, 'read-only')
})

test('外部后端没有等效权限契约时启动前拒绝', async () => {
  const { calls, runtime } = setup({ external: true })
  const value = await runtime.tool.options.execute({ node: 'review', task: '审查' }, fakeExec())
  assert.equal(value.kind, 'failed')
  assert.equal(calls.activations.length, 0)
  assert.match(value.result, /不支持可验证的本地权限边界/)
})

test('同父乱序创建按预留 childId 绑定，普通子会话不能抢走限制', async () => {
  let releaseReview
  const reviewGate = new Promise((resolve) => { releaseReview = resolve })
  let reviewEntered
  const entered = new Promise((resolve) => { reviewEntered = resolve })
  const { calls, runtime } = setup({
    interlopers: [{ parentSession: 'session-1', origin: 'subagent' }],
    beforeCreate: async (spec) => {
      if (spec.label === 'satellite_node:review') { reviewEntered(); await reviewGate }
    },
  })
  const review = runtime.tool.options.execute({ node: 'review', task: '审查' }, fakeExec())
  await entered
  const implementation = await runtime.tool.options.execute({ node: 'implement', task: '实施' }, fakeExec())
  releaseReview()
  assert.equal((await review).kind, 'completed')
  assert.equal(implementation.kind, 'completed')
  for (const spec of calls.activations) {
    const session = calls.sessions.find((session) => session.id === spec.childId)
    assert.equal(session.events.at(-1).data.mode, spec.label === 'satellite_node:review' ? 'read-only' : 'workspace-write')
  }
  assert.equal(calls.sessions.filter((session) => session.id.startsWith('child-')).every((session) => session.events.length === 0), true)
})


test('启动等待期间父权限收紧，创建时重新读取且不可放宽', async () => {
  const exec = fakeExec()
  const { calls, runtime } = setup({
    beforeCreate: async () => { exec.agent.session.events.push({ type: 'sandbox/mode', data: { mode: 'read-only' } }) },
    setupMode: 'workspace-write',
  })
  const value = await runtime.tool.options.execute({ node: 'implement', task: '实施' }, exec)
  assert.equal(value.kind, 'completed')
  assert.equal(calls.executed[0].mode, 'read-only')
})

test('扩展收到节点任务和事实，base 收到前置原始结果，暂停仍展示证据', async () => {
  const { calls, registry, runtime, skillNames } = setup({ reply: '证据 UNIQUE-PRECHECK' })
  mountAndroid({ registry, skillNames })
  const value = await runtime.tool.options.execute({
    node: 'validate', task: 'TASK-UNIT-42', facts: { projectKind: 'android', 'acceptance.required': true },
  }, fakeExec())
  assert.equal(value.kind, 'suspended')
  assert.match(calls.activations[0].request.prompt[0].text, /TASK-UNIT-42/)
  assert.match(calls.activations[0].request.prompt[0].text, /projectKind/)
  assert.match(calls.activations[1].request.prompt[0].text, /UNIQUE-PRECHECK/)
  assert.match(calls.activations[1].request.prompt[0].text, /projectKind/)
  assert.equal(value.extensions.find((entry) => entry.id === 'android.validation-context').note, '证据 UNIQUE-PRECHECK')
  const text = runtime.tool.options.output.render({}, value)[0].text
  assert.match(text, /基础节点结果/)
  assert.match(text, /扩展 android.validation-context/)
  assert.match(text, /UNIQUE-PRECHECK/)
})

test('重复活配置角色路由在创建前明确拒绝', async () => {
  const { calls, runtime } = setup({ config: { routes: [
    { role: 'validation', provider: 'p', model: 'a' },
    { role: 'validation', provider: 'p', model: 'b' },
  ] } })
  const value = await runtime.tool.options.execute({ node: 'validate', task: '验证' }, fakeExec())
  assert.equal(value.kind, 'failed')
  assert.match(value.result, /角色路由重复/)
  assert.equal(calls.activations.length, 0)
})


test('更早 agent/created 钩子施加更严子权限时保留只读，不写回可写', async () => {
  const { calls, runtime } = setup({
    earlierAgentListeners: [({ agent }) => {
      agent.session.append('sandbox/mode', { mode: 'read-only', source: 'delegation' })
    }],
  })
  const value = await runtime.tool.options.execute({ node: 'implement', task: '实施' }, fakeExec())
  assert.equal(value.kind, 'completed')
  assert.equal(calls.executed[0].mode, 'read-only')
  assert.deepEqual(calls.sandboxEvents.map((entry) => entry.data.mode), ['workspace-write', 'read-only'])
  assert.match(value.sandbox[0], /read-only/)
})

test('首次预检失败不谎报复用旧基础结果', async () => {
  const { calls, runtime } = setup({ withSandbox: false })
  const value = await runtime.tool.options.execute({ node: 'validate', task: '验证' }, fakeExec())
  assert.equal(value.kind, 'failed')
  assert.equal(calls.activations.length, 0)
  assert.equal(value.sandbox, undefined)
  assert.doesNotMatch(runtime.tool.options.output.render({}, value)[0].text, /复用/)
})


test('声明层内置角色模型覆盖在装配前拒绝，而不是潜伏到选择该角色时', () => {
  const { ctx, calls } = setup({ withRuntime: false })
  assert.throws(() => createNodeRuntime({
    ctx,
    config: Config({ roles: { validation: { agentOptions: { provider: 'example', model: 'custom' } } }, routes: [] }),
    defineTool: fakeDefineTool,
    resourceDir: RESOURCE_DIR,
  }), /validation.*routes/)
  assert.equal(calls.tools.length, 0)
  assert.equal(calls.skills.length, 0)
  assert.equal(calls.activations.length, 0)
})

/**
 * 合成扩展：只验证执行桥的契约，不冒充任何领域能力。
 * `capture` 拿到扩展实际收到的执行上下文，用于断言证据视图。
 */
function syntheticExtension({ id, slot, role = 'android-context', skill, objective = '合成扩展目标', capture, onRun }) {
  return {
    id,
    slot,
    slotVersion: 1,
    match: () => MATCH_YES,
    ready: (view) => view.checkRoleAndSkill(role, skill),
    run(execution) {
      capture?.(execution)
      if (onRun) return onRun(execution)
      return execution.runConfiguredRole(role, skill === undefined ? { objective } : { objective, skill })
    },
  }
}

test('扩展显式声明的方法技能真的进入子会话提示，且不改变角色权限与模型', async () => {
  const { calls, registry, runtime, skillNames } = setup({ reply: '方法执行结果' })
  skillNames.add('android-change-review')
  const seen = []
  registry.register(syntheticExtension({
    id: 'test.method-override', slot: 'review.after', skill: 'android-change-review', capture: (e) => seen.push(e),
  }))
  const value = await runtime.tool.options.execute({ node: 'review', task: '专项审查' }, fakeExec())
  assert.equal(value.kind, 'completed')
  const extensionRole = calls.activations.at(-1)
  assert.match(extensionRole.label, /test\.method-override/)
  assert.match(extensionRole.request.prompt[0].text, /android-change-review/)
  assert.doesNotMatch(extensionRole.request.prompt[0].text, /android-validation-context/)
  // 覆盖只影响方法：角色、provider、模型与工具限制仍来自用户配置。
  assert.equal(extensionRole.provider, 'spawn')
  assert.deepEqual(extensionRole.request.agentOptions, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  assert.equal(value.sandbox.length > 0, true)
})

test('未声明方法时沿用角色默认技能，保持既有兼容', async () => {
  const { calls, registry, runtime, skillNames } = setup({ reply: '默认方法结果' })
  mountAndroid({ registry, skillNames })
  registry.register(syntheticExtension({ id: 'test.default-skill', slot: 'review.after' }))
  const value = await runtime.tool.options.execute({ node: 'review', task: '默认技能审查' }, fakeExec())
  assert.equal(value.kind, 'completed')
  const extensionActivation = calls.activations.at(-1)
  assert.match(extensionActivation.label, /test\.default-skill/)
  assert.match(extensionActivation.request.prompt[0].text, /android-validation-context/)
})

test('扩展声明的方法不可见时阻塞，且不创建任何子会话', async () => {
  const { calls, registry, runtime, skillNames } = setup()
  mountAndroid({ registry, skillNames })
  registry.register(syntheticExtension({
    id: 'test.missing-method', slot: 'review.before', skill: 'android-missing-method',
  }))
  const value = await runtime.tool.options.execute({ node: 'review', task: '缺方法审查' }, fakeExec())
  assert.equal(value.kind, 'suspended')
  assert.match(value.blocked.join(' '), /android-missing-method/)
  assert.equal(calls.activations.length, 0)
})

test('after 扩展收到基础原始结果与已完成扩展，before 看不到尚未运行的 base', async () => {
  const { calls, registry, runtime, skillNames } = setup({ reply: 'BASE-EVIDENCE-MARKER' })
  mountAndroid({ registry, skillNames })
  const before = []
  const after = []
  registry.register(syntheticExtension({
    id: 'test.before-evidence', slot: 'review.before', capture: (e) => before.push(e),
  }))
  registry.register(syntheticExtension({
    id: 'test.after-evidence', slot: 'review.after', capture: (e) => after.push(e),
  }))
  const value = await runtime.tool.options.execute({ node: 'review', task: '证据交接' }, fakeExec())
  assert.equal(value.kind, 'completed')
  assert.equal(before.length, 1)
  assert.equal(after.length, 1)
  // before：没有未来 base，证据阶段明确。
  assert.equal(before[0].evidence.stage, 'before')
  assert.equal(before[0].evidence.base, undefined)
  assert.equal(before[0].evidence.previousExtensions.length, 0)
  // after：拿到本次调用真实的基础结果（含唯一 marker）与已完成扩展。
  assert.equal(after[0].evidence.stage, 'after')
  assert.equal(after[0].evidence.base.status, 'completed')
  assert.match(JSON.stringify(after[0].evidence.base.result), /BASE-EVIDENCE-MARKER/)
  assert.deepEqual(after[0].evidence.previousExtensions.map((entry) => entry.id), ['test.before-evidence'])
  assert.equal(after[0].evidence.previousExtensions[0].status, 'completed')
  // 扩展角色的提示里确实能看到这段基础证据，而不只是代码里拿到对象。
  const afterActivation = calls.activations.find((entry) => /test\.after-evidence/.test(entry.label))
  assert.match(afterActivation.request.prompt[0].text, /BASE-EVIDENCE-MARKER/)
  assert.match(afterActivation.request.prompt[0].text, /test\.before-evidence/)
})

test('执行证据是只读快照：扩展改写不会污染基础结果或后续扩展', async () => {
  const { calls, registry, runtime, skillNames } = setup({ reply: 'IMMUTABLE-BASE' })
  mountAndroid({ registry, skillNames })
  let captured
  registry.register(syntheticExtension({
    id: 'test.evidence-mutation',
    slot: 'review.after',
    capture: (e) => { captured = e.evidence },
    onRun: (execution) => {
      // 冻结快照：越权写入必须失败，而不是静默污染记录。
      let mutated = false
      try { execution.evidence.previousExtensions.push({ id: 'injected', slot: 'review.after', status: 'completed' }) }
      catch { mutated = false }
      try { execution.evidence.base.result = 'tampered' }
      catch { /* 冻结对象写入被拒绝 */ }
      try { execution.evidence.base.result.output = 'tampered-inner' }
      catch { /* 内层字段同样被拒绝 */ }
      return execution.runConfiguredRole('android-context', { skill: 'android-validation-context', objective: `变异尝试 ${mutated}` })
    },
  }))
  const value = await runtime.tool.options.execute({ node: 'review', task: '证据不可变' }, fakeExec())
  assert.equal(value.kind, 'completed')
  assert.equal(Object.isFrozen(captured), true)
  assert.equal(Object.isFrozen(captured.previousExtensions), true)
  assert.equal(Object.isFrozen(captured.base), true)
  assert.equal(Object.isFrozen(captured.base.result), true)
  assert.match(JSON.stringify(captured.base.result), /IMMUTABLE-BASE/)
  // 内层改写必须失败，最终渲染给父 Agent 的仍是原始基础正文。
  assert.match(String(value.result), /IMMUTABLE-BASE/)
  assert.doesNotMatch(String(value.result), /tampered/)
  assert.deepEqual(value.extensions.map((entry) => entry.id), ['test.evidence-mutation'])
  assert.equal(value.extensions.some((entry) => entry.id === 'injected'), false)
})

test('真实 Android 专项：未声明 required 时不进入普通节点', async () => {
  const { calls, registry, runtime, skillNames } = setup({ reply: '普通审查' })
  mountAndroid({ registry, skillNames })
  const value = await runtime.tool.options.execute({ node: 'review', task: '普通审查' }, fakeExec())
  assert.equal(value.kind, 'completed')
  assert.deepEqual(value.extensions ?? [], [])
  assert.equal(calls.activations.length, 1)
  assert.match(calls.activations[0].label, /satellite_node:review/)
})

test('真实 Android 专项：review.after 用声明的方法技能并看到基础原文', async () => {
  const { calls, registry, runtime, skillNames } = setup({ reply: 'BASE-REVIEW-MARKER' })
  mountAndroid({ registry, skillNames })
  const scope = { files: [{ kind: 'file', location: 'app/src/main/kotlin/Screen.kt', revision: 'rev-7' }], checks: ['lifecycle'] }
  const value = await runtime.tool.options.execute({
    node: 'review',
    task: '按声明检查面审查本单元变更',
    facts: { projectKind: 'android', 'android.review.required': true, 'android.review.scope': scope },
  }, fakeExec())
  assert.equal(value.kind, 'completed')
  assert.deepEqual(value.extensions.map((entry) => entry.id), ['android.platform-review'])
  const extensionActivation = calls.activations.find((entry) => /android\.platform-review/.test(entry.label))
  assert.ok(extensionActivation, '专项扩展必须真的启动了角色')
  assert.match(extensionActivation.request.prompt[0].text, /android-change-review/)
  assert.match(extensionActivation.request.prompt[0].text, /BASE-REVIEW-MARKER/)
  assert.match(extensionActivation.request.prompt[0].text, /lifecycle/)
  // 只读角色边界不变。
  assert.equal(calls.executed.every((entry) => entry.mode === 'read-only'), true)
})

test('真实 Android 专项：非法结构在启动子会话前阻塞，且不掩盖基础结果', async () => {
  const { calls, registry, runtime, skillNames } = setup({ reply: 'BASE-ONLY' })
  mountAndroid({ registry, skillNames })
  const value = await runtime.tool.options.execute({
    node: 'review',
    task: '非法专项结构',
    facts: {
      projectKind: 'android',
      'android.review.required': true,
      'android.review.scope': { files: [{ kind: 'shell', location: 'x', revision: 'r' }], checks: ['lifecycle'] },
    },
  }, fakeExec())
  assert.equal(value.kind, 'suspended')
  assert.equal(value.extensions[0].id, 'android.platform-review')
  assert.match(value.extensions[0].error, /ARGUMENT_INVALID/)
  const text = runtime.tool.options.output.render({}, value)[0].text
  assert.match(text, /ARGUMENT_INVALID/)
  assert.equal(calls.activations.length, 1, '只应跑基础节点，不启动专项子会话')
  assert.match(calls.activations[0].label, /satellite_node:review/)
  assert.equal(String(value.result).includes('BASE-ONLY'), true)
})

test('真实 Android 专项：明确要求但缺来源事实时暂停并列出缺失字段', async () => {
  const { calls, registry, runtime, skillNames } = setup()
  mountAndroid({ registry, skillNames })
  const value = await runtime.tool.options.execute({
    node: 'solution',
    task: '需要设计来源',
    facts: { projectKind: 'android', 'android.design.required': true },
  }, fakeExec())
  assert.equal(value.kind, 'suspended')
  assert.deepEqual(value.missing, ['android.design.source'])
  assert.equal(calls.activations.length, 0)
})

test('技能目录按调用方作用域与 cwd 查询，发现未完成时阻塞（F1 回归）', async () => {
  const seen = []
  const f = fixtureSkillsProbe(seen)
  const { registry, runtime, calls, skillNames } = f
  mountAndroid({ registry, skillNames })
  // 模拟"发现未完成"：snapshot 返回 complete:false → 无法核对 → 专项阻塞，零子会话。
  f.setSnapshot(() => ({ skills: [], complete: false }))
  const blockedValue = await runtime.tool.options.execute({
    node: 'validate', task: '不完整目录', facts: { projectKind: 'android' },
  }, fakeExec())
  assert.equal(blockedValue.kind, 'suspended')
  assert.match(blockedValue.blocked.join(' '), /无法核对技能可见性/)
  assert.equal(calls.activations.length, 0)
  // 每次查询都必须带 scope（调用方 Agent）与 cwd，否则只会读到全局层。
  assert.ok(seen.length > 0)
  for (const options of seen) {
    assert.ok(options && typeof options === 'object', 'snapshot 必须带 view options')
    assert.ok('scope' in options, 'snapshot 必须带 scope')
    assert.equal(typeof options.cwd, 'string')
  }
})

test('扩展声明的方法技能类型非法时显式失败，不静默退回默认技能（F1 回归）', async () => {
  const { calls, registry, runtime, skillNames } = setup()
  mountAndroid({ registry, skillNames })
  registry.register({
    id: 'test.bad-skill', slot: 'review.after', slotVersion: 1,
    match: () => MATCH_YES,
    ready: () => READY,
    run: (execution) => execution.runConfiguredRole('android-context', { objective: 'x', skill: 123 }),
  })
  const value = await runtime.tool.options.execute({ node: 'review', task: '坏技能声明' }, fakeExec())
  assert.equal(value.kind, 'suspended')
  assert.match(value.extensions.at(-1).error, /非空字符串/)
  assert.equal(calls.activations.length, 1, '只应跑基础节点')
})

// Entry: existing caller omits tier, including a deployed node.role override.
test('省略 tier 保持节点默认，自定义 role 不暗中继承内置档位', async () => {
  const original = setup()
  const old = await original.runtime.tool.options.execute({ node: 'implement', task: '旧调用' }, fakeExec())
  assert.deepEqual(old.selection, { role: 'implementation' })
  assert.equal(old.execution.role, 'implementation')
  const f = setup({ config: {
    nodes: { implement: { role: 'local-implementation' } },
    roles: { 'local-implementation': { ...DEFAULT_CONFIG.roles.implementation, objective: 'LOCAL-ROLE' } },
  } })
  const oldCustom = await f.runtime.tool.options.execute({ node: 'implement', task: '旧自定义调用' }, fakeExec())
  assert.deepEqual(oldCustom.selection, { role: 'local-implementation' })
  assert.match(f.calls.activations[0].request.prompt[0].text, /LOCAL-ROLE/)
  const blocked = await f.runtime.tool.options.execute({ node: 'implement', task: '显式档位', tier: 'light' }, fakeExec())
  assert.equal(blocked.kind, 'blocked')
  assert.equal(f.calls.activations.length, 1)
})

// Entry: public node calls select each builtin supported mapping, using real defineTool.
test('solution/implement/review 三个节点的四档经公开 schema 使用正确方法与路由', async () => {
  const cases = [
    ['solution', 'light', 'solution-design-light'],
    ['solution', 'standard', 'solution-design'],
    ['solution', 'senior', 'solution-design-senior'],
    ['solution', 'critical', 'solution-design-critical'],
    ['implement', 'light', 'implementation-light'],
    ['implement', 'standard', 'implementation'],
    ['implement', 'senior', 'implementation-senior'],
    ['implement', 'critical', 'implementation-critical'],
    ['review', 'light', 'change-review-light'],
    ['review', 'standard', 'change-review'],
    ['review', 'senior', 'change-review-senior'],
    ['review', 'critical', 'change-review-critical'],
  ]
  const baseRoles = {
    solution: 'solution-design',
    implement: 'implementation',
    review: 'change-review',
  }
  for (const [node, tier, role] of cases) {
    const checked = []
    const f = setup({
      defineToolImpl: defineTool,
      config: { roles: { [role]: { objective: `SELECTED:${role}` } } },
      llm: { resolveCallConfig(options) { checked.push(options) } },
    })
    const value = await f.runtime.tool.execute({ node, task: '一个已确认的有界单元', tier }, fakeExec())
    assert.equal(value.kind, 'completed')
    assert.equal(f.calls.activations.length, 1)
    const actual = f.calls.activations[0].request
    assert.deepEqual(value.selection, { role, tier })
    const packet = JSON.parse(actual.prompt[0].text.split('\n').find((line) => line.startsWith('{"selection":')))
    assert.deepEqual(packet.selection, value.selection, 'child receives the frozen assigned tier as task data')
    assert.deepEqual(value.execution, { role, ...DEFAULT_CONFIG.roles[role].agentOptions })
    assert.deepEqual(actual.agentOptions, DEFAULT_CONFIG.roles[role].agentOptions)
    assert.equal(checked.length, 1)
    assert.deepEqual(checked[0], actual.agentOptions, 'native preflight checks the selected request route')
    // Production output validation uses this validator; this does not run the complete registry pipeline.
    assert.deepEqual(validateJsonSchemaValue(f.runtime.tool.output.schema, value), [])
    assert.match(actual.prompt[0].text, new RegExp(`SELECTED:${role}`))
    assert.ok(actual.prompt[0].text.includes(DEFAULT_CONFIG.roles[role].skill))
    const baseRole = baseRoles[node]
    assert.deepEqual(actual.toolFilter, DEFAULT_CONFIG.roles[baseRole].toolFilter, '档位不提升工具权限')
    assert.equal(f.calls.executed[0].mode, DEFAULT_CONFIG.roles[baseRole].sandbox, '档位不提升文件权限')
  }
})

// Entry: a model emits invalid tier, or requests a tier from a node with no default mapping.
test('真实 defineTool 拒绝非法 tier，默认不分级节点拒绝显式档，未知角色在子调用前阻塞', async () => {
  const f = setup({ defineToolImpl: defineTool })
  assert.deepEqual(f.runtime.tool.parameters.properties.tier.enum, ['light', 'standard', 'senior', 'critical'])
  for (const tier of ['critical-plus', '', null, 1]) {
    await assert.rejects(f.runtime.tool.execute({ node: 'implement', task: '坏参数', tier }, fakeExec()), /tier/)
  }
  for (const node of ['context', 'validate', 'signoff']) {
    for (const tier of ['light', 'standard', 'senior', 'critical']) {
      const value = await f.runtime.tool.execute({ node, task: '默认未分级', tier }, fakeExec())
      assert.equal(value.kind, 'blocked')
      assert.match(value.reason, /未配置.*档角色/)
      assert.match(value.reason, /省略 tier 使用节点默认角色/)
      assert.equal(value.execution, undefined)
    }
  }
  assert.equal(f.calls.activations.length, 0)
  const missing = setup({ config: { nodes: { implement: { tierRoles: { senior: 'missing-role' } } } } })
  const value = await missing.runtime.tool.options.execute({ node: 'implement', task: '未知角色', tier: 'senior' }, fakeExec())
  assert.equal(value.kind, 'blocked')
  assert.match(value.reason, /未配置角色/)
  assert.equal(missing.calls.activations.length, 0)
})

// Entry: a deployment saved a route and mapping that referenced the removed builtin role.
test('旧 validation-light 路由保留但不再派发，也不静默回退默认角色', async () => {
  const routes = [{ role: 'validation-light', provider: 'deepseek-official', model: 'deepseek-flash' }]
  const f = setup({
    config: {
      routes: { get: () => routes },
      nodes: { validate: { tierRoles: { light: 'validation-light' } } },
    },
  })
  const value = await f.runtime.tool.options.execute({ node: 'validate', task: '旧档位', tier: 'light' }, fakeExec())
  assert.equal(value.kind, 'blocked')
  assert.match(value.reason, /未配置角色：validation-light/)
  assert.equal(value.execution, undefined)
  assert.equal(f.calls.activations.length, 0)
  assert.deepEqual(routes, [{ role: 'validation-light', provider: 'deepseek-official', model: 'deepseek-flash' }])
})

// Entry: a profile still carries the removed builtin role's old local override.
test('旧 validation-light 局部覆盖在装配前以迁移错误拒绝，不注册工具也不激活', () => {
  const { ctx, calls } = setup({ withRuntime: false })
  const config = Config({
    roles: { 'validation-light': { objective: '旧局部覆盖' } },
    nodes: { validate: { tierRoles: { light: 'validation-light' } } },
    routes: [{ role: 'validation-light', provider: 'deepseek-official', model: 'deepseek-flash' }],
  })
  assert.throws(() => createNodeRuntime({
    ctx,
    config,
    defineTool: fakeDefineTool,
    resourceDir: RESOURCE_DIR,
  }), /内置角色 validation-light 已移除[\s\S]*删除该局部覆盖/)
  assert.equal(calls.tools.length, 0)
  assert.equal(calls.skills.length, 0)
  assert.equal(calls.activations.length, 0)
  assert.deepEqual(config.routes.get(), [{ role: 'validation-light', provider: 'deepseek-official', model: 'deepseek-flash' }])
})

// Entry: deployment maps Senior to a read-only specialist with stricter tools than its custom default role.
test('显式 tierRoles 可绑定自定义角色，不开放调用方任意 role 注入', async () => {
  const f = setup({ config: {
    nodes: { review: { role: 'local-review', tierRoles: { senior: 'specialist' } } },
    roles: {
      'local-review': { ...DEFAULT_CONFIG.roles['change-review'], sandbox: 'workspace-write' },
      specialist: {
        ...DEFAULT_CONFIG.roles['change-review'], objective: 'SPECIALIST-METHOD', sandbox: 'read-only',
        toolFilter: { deny: ['satellite_node', 'edit', 'write', 'bash'] },
      },
    },
  } })
  const value = await f.runtime.tool.options.execute({
    node: 'review', task: '专项', tier: 'senior', facts: { role: 'implementation' },
  }, fakeExec())
  assert.equal(value.execution.role, 'specialist')
  assert.match(f.calls.activations[0].request.prompt[0].text, /SPECIALIST-METHOD/)
  assert.deepEqual(f.calls.activations[0].request.toolFilter.deny, ['satellite_node', 'edit', 'write', 'bash'])
  assert.equal(f.calls.executed[0].mode, 'read-only')
})

// Entry: a deployment opts a default non-tiered node into a custom tier map.
test('默认不分级节点仍可通过自定义 tierRoles 选用角色，不硬编码禁止', async () => {
  const f = setup({ config: {
    nodes: { validate: { tierRoles: { critical: 'special-validator' } } },
    roles: {
      'special-validator': {
        ...DEFAULT_CONFIG.roles.validation,
        objective: 'SPECIAL-VALIDATION-METHOD',
      },
    },
  } })
  const value = await f.runtime.tool.options.execute({
    node: 'validate', task: '专项验证', tier: 'critical',
  }, fakeExec())
  assert.deepEqual(value.selection, { role: 'special-validator', tier: 'critical' })
  assert.match(f.calls.activations[0].request.prompt[0].text, /SPECIAL-VALIDATION-METHOD/)
  assert.deepEqual(f.calls.activations[0].request.toolFilter, DEFAULT_CONFIG.roles.validation.toolFilter)
  assert.equal(f.calls.executed[0].mode, DEFAULT_CONFIG.roles.validation.sandbox)
})

// Entry: before extension pauses; caller retries with a different tier or identity, then resumes.
test('before 恢复冻结选择并保留身份绑定，省略 tier 继承且未启动时不报执行', async () => {
  const f = setup()
  f.registry.register({
    id: 'test.tier-before', slot: 'implement.before', slotVersion: 1,
    match: () => MATCH_YES, ready: () => READY,
    run: ({ facts }) => ({ status: facts.values.ready ? 'completed' : 'needs_decision' }),
  })
  const args = { node: 'implement', task: '冻结单元', unit: 'unit-tier' }
  const first = await f.runtime.tool.options.execute({ ...args, tier: 'light' }, fakeExec())
  assert.equal(first.kind, 'suspended')
  assert.deepEqual(first.selection, { role: 'implementation-light', tier: 'light' })
  assert.equal(first.execution, undefined)
  assert.match(f.runtime.tool.options.output.render({}, first)[0].text, /尚无已确认启动记录/)
  const changed = await f.runtime.tool.options.execute({ ...args, resume: first.token, tier: 'senior' }, fakeExec())
  assert.equal(changed.kind, 'blocked')
  assert.match(changed.reason, /不能改变.*省略 tier 可继续原调用/)
  assert.ok(f.runtime.tool.options.output.render({}, changed)[0].text.includes(`resume=${first.token}`))
  const wrongCaller = await f.runtime.tool.options.execute({ ...args, resume: first.token }, fakeExec('other-caller'))
  assert.equal(wrongCaller.kind, 'blocked')
  const wrongUnit = await f.runtime.tool.options.execute({ ...args, unit: 'other-unit', resume: first.token }, fakeExec())
  assert.equal(wrongUnit.kind, 'blocked')
  assert.equal(f.calls.activations.length, 0)
  // A caller may omit the frozen tier while still waiting for evidence, then repeat it explicitly.
  const stillWaiting = await f.runtime.tool.options.execute({ ...args, resume: first.token }, fakeExec())
  assert.equal(stillWaiting.kind, 'suspended')
  assert.deepEqual(stillWaiting.selection, first.selection)
  const resumed = await f.runtime.tool.options.execute({ ...args, resume: first.token, tier: 'light', facts: { ready: true } }, fakeExec())
  assert.equal(resumed.kind, 'completed')
  assert.deepEqual(resumed.selection, first.selection)
  assert.equal(resumed.execution.role, 'implementation-light')
  assert.equal(f.calls.activations.length, 1)
  const packet = JSON.parse(f.calls.activations[0].request.prompt[0].text.split('\n').find((line) => line.startsWith('{"selection":')))
  assert.deepEqual(packet.selection, first.selection, 'resume sends the original selection, not the changed request')
})

// Entry: after pauses, live route changes, then the same completed base is resumed.
test('after 恢复不重跑 base 且报告原请求路由，新调用才使用活路由', async () => {
  let model = 'deepseek-v4-pro'
  const f = setup({ config: { routes: { get: () => [{ role: 'implementation-light', provider: 'deepseek-official', model }] } } })
  const args = { node: 'implement', task: '完成后待决定', unit: 'after-unit' }
  const first = await f.runtime.tool.options.execute({ ...args, tier: 'light', facts: { 'acceptance.required': true } }, fakeExec())
  assert.equal(first.kind, 'suspended')
  assert.equal(first.stage, 'after')
  assert.equal(first.execution.model, 'deepseek-v4-pro')
  model = 'deepseek-flash'
  const changed = await f.runtime.tool.options.execute({ ...args, resume: first.token, tier: 'senior', decision: 'accept' }, fakeExec())
  assert.equal(changed.kind, 'blocked')
  assert.deepEqual(changed.execution, first.execution)
  const resumed = await f.runtime.tool.options.execute({ ...args, resume: first.token, decision: 'accept' }, fakeExec())
  assert.equal(resumed.kind, 'completed')
  assert.deepEqual(resumed.execution, first.execution)
  assert.equal(f.calls.activations.length, 1)
  const rendered = f.runtime.tool.options.output.render({}, resumed)[0].text
  assert.match(rendered, /请求路由 deepseek-official\/deepseek-v4-pro/)
  assert.doesNotMatch(rendered, /请求路由 deepseek-official\/deepseek-flash/)
  const next = await f.runtime.tool.options.execute({ ...args, tier: 'light' }, fakeExec())
  assert.equal(next.execution.model, 'deepseek-flash')
  assert.equal(f.calls.activations.length, 2)
})

// Entry: a new role is denied by native model policy, or inherits a read-only parent.
test('新角色仍经原生 preflight 与父权限收窄，拒绝路由不能伪称已启动', async () => {
  const denied = setup({ selection: { current: () => ({ enabled: true, allowedModels: [] }) } })
  const failed = await denied.runtime.tool.options.execute({ node: 'implement', task: '受限模型', tier: 'senior' }, fakeExec())
  assert.equal(failed.selection.role, 'implementation-senior')
  assert.equal(failed.execution, undefined)
  assert.equal(denied.calls.activations.length, 0)
  assert.match(failed.result, /不在宿主允许/)
  assert.match(denied.runtime.tool.options.output.render({}, failed)[0].text, /尚无已确认启动记录/)
  const readonly = setup({ reply: '仍有验收阻塞，未完成' })
  const result = await readonly.runtime.tool.options.execute({ node: 'implement', task: '只读父任务', tier: 'senior' }, fakeExec('parent-ro', 'read-only'))
  assert.equal(readonly.calls.executed[0].mode, 'read-only')
  assert.equal(result.execution.role, 'implementation-senior')
  assert.match(result.result, /仍有验收阻塞/)
  // Runtime completion preserves the raw report; it does not count failures or grant acceptance.
  assert.equal(result.kind, 'completed')
})

// Entry: the base activation passed creation checks but its managed result rejects afterward.
test('基础启动后 result 拒绝仍保留已启动角色和请求路由证据', async () => {
  const f = setup({ resultError: new Error('managed result unavailable'), defineToolImpl: defineTool })
  const value = await f.runtime.tool.execute({ node: 'implement', task: '结果通道失败', tier: 'light' }, fakeExec())
  assert.equal(f.calls.activations.length, 1)
  assert.equal(value.kind, 'failed')
  assert.match(value.result, /managed result unavailable/)
  assert.deepEqual(value.execution, { role: 'implementation-light', ...DEFAULT_CONFIG.roles['implementation-light'].agentOptions })
  assert.deepEqual(validateJsonSchemaValue(f.runtime.tool.output.schema, value), [])
  assert.match(f.runtime.tool.output.render({}, value)[0].text, /已启动基础角色：implementation-light.*请求路由/)
})
