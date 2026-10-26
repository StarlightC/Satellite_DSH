import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import { BUILTIN_ROLE_NAMES, BUILTIN_ROUTES, DEFAULT_CONFIG } from '../lib/node/lib/config.js'
import { Config } from '../lib/node/index.js'

const packageDir = new URL('../', import.meta.url)
const pkg = JSON.parse(await readFile(new URL('package.json', packageDir), 'utf8'))

/** 发布脚本用到的生命周期钩子：一个都不允许出现（它们能触发 git 依赖准备与隐式构建）。 */
const LIFECYCLE_HOOKS = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepack',
  'prepublish',
  'prepublishOnly',
  'publish',
]

const escapeForRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 解析一个 package.json 里的相对路径；`*` 视为通配（本包的 locale 导出是这样写的）。 */
function resolvedPathExists(relative) {
  if (!relative.includes('*')) return existsSync(new URL(relative, packageDir))
  const star = relative.indexOf('*')
  const directory = relative.slice(0, relative.lastIndexOf('/', star) + 1)
  const pattern = relative.slice(directory.length)
  const regex = new RegExp(`^${pattern.split('*').map(escapeForRegExp).join('.*')}$`)
  return readdirSync(new URL(directory, packageDir)).some((entry) => regex.test(entry))
}

test('发布质量门：scripts 不含任何生命周期钩子', () => {
  for (const hook of LIFECYCLE_HOOKS) {
    assert.equal(pkg.scripts?.[hook], undefined, `${hook} 不在允许的发布形态里`)
  }
  assert.deepEqual(Object.keys(pkg.scripts ?? {}).sort(), ['build', 'test', 'typecheck'])
})

test('发布质量门：main / exports / dsh.bundle.patch 指向的文件真实存在', () => {
  assert.ok(pkg.main, 'main 必须指向构建产物')
  const targets = [pkg.main, pkg.dsh.bundle.patch, ...Object.values(pkg.exports ?? {})]
  for (const target of targets) {
    assert.equal(typeof target, 'string', `exports 必须是字符串路径：${String(target)}`)
    assert.ok(resolvedPathExists(target), `发布入口不存在：${target}`)
  }
  for (const entry of ['.', './slots', './node', './android']) {
    assert.match(pkg.exports[entry], /^\.\/lib\//, `${entry} 应指向 lib/ 构建产物`)
  }
})

test('发布质量门：files 含 lib 与包内资源，且每个条目在磁盘上至少匹配一个文件', () => {
  assert.ok(pkg.files.includes('lib'))
  assert.ok(pkg.files.includes('cordis.patch.yml'))
  for (const entry of ['locale/*.json', 'icon.svg', 'slots/locale/*.json', 'node/skills', 'android/skills']) {
    assert.ok(pkg.files.includes(entry), `files 缺少资源：${entry}`)
  }
  for (const entry of pkg.files) {
    assert.ok(resolvedPathExists(entry), `files 条目在磁盘上不存在：${entry}`)
  }
  assert.equal(pkg.files.includes('src'), false, '源码不随包发布')
  assert.equal(pkg.files.includes('test'), false, '测试不随包发布')
})

test('发布质量门：不声明 dependencies，@deepseek-ai/* 走 peer 区间 + dev 钉版', () => {
  assert.equal(pkg.dependencies, undefined, '@deepseek-ai/* 由 Host 提供，不另装依赖树')
  const peers = Object.keys(pkg.peerDependencies ?? {}).filter((name) => name.startsWith('@deepseek-ai/'))
  const devs = Object.keys(pkg.devDependencies ?? {}).filter((name) => name.startsWith('@deepseek-ai/'))
  assert.deepEqual([...peers].sort(), [...devs].sort(), 'peer 与 dev 的 @deepseek-ai 包集合必须一致')
  assert.ok(peers.length > 0)
  for (const name of peers) {
    assert.match(pkg.peerDependencies[name], /^[~^]?\d|^>=/, `peer 必须是区间：${name}`)
  }
  for (const name of devs) {
    assert.match(pkg.devDependencies[name], /^\d+\.\d+\.\d+/, `dev 必须钉固定版本：${name}`)
  }
})

test('发布质量门：清单处于可发布形态（private 不得为真）', () => {
  // 界面插件的 peer 区间依赖本包可被解析；private: true 会让它永远装不上。
  assert.equal(pkg.private, undefined, '发布包不能声明 private')
  assert.equal(typeof pkg.name, 'string')
  assert.equal(typeof pkg.version, 'string')
})

test('发布质量门：engines、license 与构建/类型检查脚本齐备', () => {
  assert.ok(pkg.license, 'license 是发布模式的必需字段')
  assert.match(pkg.engines.node, /\d/)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.scripts.build, 'tsdown')
  assert.equal(pkg.scripts.typecheck, 'tsc -p tsconfig.json')
  assert.match(pkg.scripts.test, /^npm run build && node --test /)
})

/**
 * 设置契约（新原则）：**patch 只声明"行"，声明式默认值归代码，profile 只存用户选择**。
 *
 * 过去把整份 config（provider/nodes/roles/declaredRoles/routes）预置在 patch 里，profile 首次安装
 * 会物化这份快照，而 Loader 是整行替换、不深合并，于是代码里新增的节点/角色/默认模型会被旧快照
 * 长期盖住。这些断言把新原则钉在发布门里：patch 里没有 config，默认值由代码常量提供。
 */

/** 取 patch 里某个 id 的行块：从该 `- id:` 起，到下一个 `- id:` 之前（不含）。 */
function patchRowBlock(patch, id) {
  const lines = patch.split('\n')
  const start = lines.findIndex((line) => new RegExp(`^\\s*-\\s*id:\\s*${id}\\s*$`).test(line))
  assert.notEqual(start, -1, `patch 必须声明 ${id} 行`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^\s*-\s*id:/.test(line))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

test('设置契约：patch 只声明行，satellite-node 行不含 config 与默认值', async () => {
  const patch = await readFile(new URL('cordis.patch.yml', packageDir), 'utf8')
  const nodeRow = patchRowBlock(patch, 'satellite-node')
  assert.doesNotMatch(
    nodeRow,
    /^\s*config:/m,
    'satellite-node 行不得内联 config：profile 物化的旧快照会盖住代码里的新默认值',
  )
  for (const field of ['provider:', 'nodes:', 'roles:', 'declaredRoles:', 'routes:']) {
    assert.equal(nodeRow.includes(field), false, `satellite-node 行不得预置 ${field}（默认值归代码）`)
  }
  // 行本身仍在，id 与 name 是装配事实（patch 的职责）。
  assert.match(nodeRow, /^\s*name:\s*'satellite\/node'$/m)
  // 其余两行保持原样：行结构与默认关闭的 Android 扩展没被顺手改坏。
  assert.match(patch, /^\s*- id: satellite-slots\n\s*name: 'satellite\/slots'$/m)
  assert.match(patchRowBlock(patch, 'satellite-android'), /^\s*disabled:\s*true$/m)
})

test('默认值来自代码：BUILTIN_ROLE_NAMES/BUILTIN_ROUTES 与 DEFAULT_CONFIG 一致', () => {
  const declared = [...BUILTIN_ROLE_NAMES]
  assert.ok(declared.length > 0, '代码必须提供非空的内置角色清单')
  assert.deepEqual(declared, Object.keys(DEFAULT_CONFIG.roles), '角色清单必须与 DEFAULT_CONFIG.roles 的键（声明顺序）一致')
  // Public package defaults include the three tiered nodes' actual role variants.
  assert.deepEqual([...declared].sort(), [
    'acceptance',
    'android-context',
    'change-review',
    'change-review-critical',
    'change-review-light',
    'change-review-senior',
    'implementation',
    'implementation-critical',
    'implementation-light',
    'implementation-senior',
    'investigation',
    'solution-design',
    'solution-design-critical',
    'solution-design-light',
    'solution-design-senior',
    'validation',
    'version-control',
  ])
  assert.equal(declared.includes('validation-light'), false, '旧内置验证档位已移除')
  const rolesWithOptions = Object.entries(DEFAULT_CONFIG.roles)
    .filter(([, role]) => role.agentOptions)
    .map(([name]) => name)
  assert.deepEqual(
    BUILTIN_ROUTES.map((route) => route.role),
    rolesWithOptions,
    'BUILTIN_ROUTES 必须覆盖每个有 agentOptions 的角色，且顺序与声明一致',
  )
  for (const route of BUILTIN_ROUTES) {
    assert.ok(route.provider, `${route.role} 的默认 provider 不能为空`)
    assert.ok(route.model, `${route.role} 的默认 model 不能为空`)
  }
  const byRole = Object.fromEntries(BUILTIN_ROUTES.map((route) => [route.role, route]))
  assert.deepEqual(byRole.validation, { role: 'validation', provider: 'deepseek-official', model: 'deepseek-flash' })
  // 独立审查刻意不用 validation 的 flash：独立性的一半是与验证角色不同的模型。
  assert.equal(byRole['change-review'].model, 'deepseek-v4-pro')
  assert.notEqual(byRole['change-review'].model, byRole.validation.model)
})

test('schema 默认值来自代码：Config({}) 的 declaredRoles/routes 等于代码常量', () => {
  const resolved = Config({})
  // volatile 字段解析后是引用对象，用 .get() 读当前值（与插件读取方式一致）。
  assert.deepEqual(resolved.declaredRoles.get(), [...BUILTIN_ROLE_NAMES])
  assert.deepEqual(
    resolved.routes.get(),
    BUILTIN_ROUTES.map((route) => ({ ...route })),
  )
  // 用户保存的覆盖仍然生效：profile 里只该出现用户自己的选择。
  const overridden = Config({
    declaredRoles: ['custom-role'],
    routes: [{ role: 'custom-role', provider: 'p', model: 'm' }],
  })
  assert.deepEqual(overridden.declaredRoles.get(), ['custom-role'])
  assert.deepEqual(overridden.routes.get(), [{ role: 'custom-role', provider: 'p', model: 'm' }])
})
