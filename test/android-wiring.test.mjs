import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/android/index.js'
import { ANDROID_SKILL_NAMES } from '../lib/android/lib/node-extensions.js'
import { createNodeCatalog } from '../lib/contracts.js'
import { createSlotRegistry } from '../lib/registry.js'

/** 取本 setup 里注册过的执行工具（按名字过滤，reuse maintain 单独断言）。 */
function androidTools(calls) {
  return calls.tools.filter((entry) => String(entry.tool?.name ?? '').startsWith('satellite_android_'))
}

function setup() {
  const catalog = createNodeCatalog()
  const registry = createSlotRegistry(catalog)
  const listeners = new Set()
  const calls = { skills: [], registered: [], tools: [] }
  const disposers = []

  const ctx = {
    // 真实宿主只把 inject 里声明过的服务挂成属性；`tools` 现在已声明，
    // 所以这里必须提供 `ctx.tools`（漏了就会静默丢掉全部执行工具）。
    tools: {
      register(tool) {
        calls.tools.push({ tool })
        return () => {}
      },
    },
    satelliteSlots: {
      defineNode(nodeId, options) {
        const remove = catalog.defineNode(nodeId, options)
        for (const listener of [...listeners]) listener()
        return remove
      },
      register(extension) {
        calls.registered.push(extension.id)
        return registry.register(extension)
      },
      resolve: (slot, facts, view, definitions) => registry.resolve(slot, facts, view, definitions),
      snapshot: () => registry.snapshot(),
      hasSlot: (name) => catalog.has(name),
      onSlotsChanged(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    get: (name) => (name === 'tools' ? ctx.tools : name === 'logger' ? { error: () => {} } : undefined),
    inject(deps, callback) {
      if (!deps.includes('skills')) return
      callback({
        skills: {
          register(skill) {
            calls.skills.push(skill)
            return () => {}
          },
        },
        effect(fn) {
          const disposer = fn()
          if (typeof disposer === 'function') disposers.push(disposer)
        },
      })
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
  }

  return { ctx, catalog, registry, calls, disposers }
}

test('插槽尚未声明时不注册扩展，声明后由服务回调补齐', () => {
  const { ctx, registry, calls } = setup()
  apply(ctx)
  assert.deepEqual(registry.snapshot(), [], '未声明插槽时不应注册')

  ctx.satelliteSlots.defineNode('validate', { version: 1 })
  // validate 声明了 before 与 after 两个插槽，两个对应扩展各自跟随注册；
  // 是否真的适用由调用时的 match 决定。
  assert.deepEqual(calls.registered, ['android.validation-context', 'android.validation-evidence'])
  assert.equal(registry.snapshot().length, 2)
})

test('插槽已存在时 apply 立即注册，不依赖声明顺序', () => {
  const { ctx, catalog, registry } = setup()
  catalog.defineNode('validate', { version: 1 })
  apply(ctx)
  assert.equal(registry.snapshot().length, 2)
})

test('本包技能由自己在 apply 中注册', () => {
  const { ctx, calls } = setup()
  apply(ctx)
  assert.deepEqual(calls.skills.map((skill) => skill.name), [
    'android-validation-context',
    'android-design-handoff',
    'android-change-review',
    'android-validation-evidence',
    'android-acceptance-evidence',
  ])
  assert.equal(calls.skills[0].source, 'bundled')
  // 执行工具必须在行加载时就注册：漏声明 tools 依赖会让它们被静默丢弃。
  const names = calls.tools.map((entry) => entry.tool?.name ?? entry)
  assert.deepEqual([...names].sort(), [
    'satellite_android_build', 'satellite_android_capture', 'satellite_android_device',
    'satellite_android_emulator', 'satellite_android_journey', 'satellite_android_project',
    'satellite_reuse_maintain',
  ].sort())
  assert.equal(calls.skills.every((skill) => typeof skill.content === 'string' && skill.content.length > 0), true)
})

test('执行工具注册前经过 defineTool 归一化（否则宿主会拒绝 DSL 形状）', () => {
  const { ctx, catalog, calls } = setup()
  apply(ctx)
  catalog.defineNode('validate', { version: 1 })
  const android = androidTools(calls)
  assert.equal(android.length, 6, '六个执行工具都应注册')
  for (const { tool } of android) {
    // 作者 DSL 的 required:true 必须已归一成 JSON Schema 的 required:[...]。
    assert.equal(tool.parameters?.type, 'object', `${tool.name} 的参数应是对象根`)
    assert.ok(Array.isArray(tool.parameters?.required), `${tool.name}.parameters.required 应是数组`)
    assert.ok(Array.isArray(tool.output?.schema?.required), `${tool.name}.output.schema.required 应是数组`)
    assert.doesNotMatch(JSON.stringify(tool.output?.schema), /"required":true/, `${tool.name} 输出里不应残留 DSL 形状`)
    assert.doesNotMatch(JSON.stringify(tool.parameters), /"required":true/, `${tool.name} 参数里不应残留 DSL 形状`)
  }
})

test('每个专项扩展跟随自己的插槽声明，未被声明的插槽不注册', () => {
  const { ctx, calls } = setup()
  apply(ctx)
  // 通过插槽服务声明节点，与真实装配一致：声明后由回调补齐注册。
  for (const slot of ['context', 'solution', 'validate', 'review', 'signoff']) {
    ctx.satelliteSlots.defineNode(slot, { version: 1 })
  }
  assert.deepEqual(calls.registered, [
    // 注册顺序跟随插槽声明顺序：context → solution → validate → review → signoff。
    'android.project-context',
    'android.design-context',
    'android.validation-context',
    'android.validation-evidence',
    'android.platform-review',
    'android.acceptance-evidence',
  ])
})

test('声明的每个方法技能在包内都有真实可加载的文件', () => {
  const { ctx, calls } = setup()
  apply(ctx)
  assert.deepEqual(
    [...calls.skills.map((skill) => skill.name)].sort(),
    [...ANDROID_SKILL_NAMES].sort(),
  )
  // 顺序即注册顺序：领域技能必须真的能从包内资源目录读到，缺失会让上面这一步为空。
  assert.equal(calls.skills.length, ANDROID_SKILL_NAMES.length)
})

test('单个技能缺失只影响该专项，领域行其余扩展仍然注册', () => {
  const { ctx, registry } = setup()
  // 技能表存在但注册整批不可用（模拟方法技能文件缺失）时，
  // 扩展注册不依赖技能，仍跟随插槽声明。
  apply({ ...ctx, inject: (deps, callback) => {
    if (deps.includes('skills')) callback({ skills: { register() { return () => {} } }, effect(fn) { fn() } })
  } })
  ctx.satelliteSlots.defineNode('review', { version: 1 })
  assert.deepEqual(registry.snapshot().map((entry) => entry.id), ['android.platform-review'])
})

test('没有技能表时扩展仍注册，技能不可见在调用时阻塞', () => {
  const { ctx, registry } = setup()
  apply({ ...ctx, inject: () => {} })
  ctx.satelliteSlots.defineNode('validate', { version: 1 })
  assert.equal(registry.snapshot().length, 2)
})
