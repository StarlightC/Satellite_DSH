import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CLI_VERSION_POLICY, createObservationStore, digestDynamicFacts, inspectStaticProject,
  parseAndroidCliDescribe, parseAndroidCliVersion,
} from '../lib/android/lib/execution/project.js'
import { BUILD_TOOL, PROJECT_TOOL, registerAndroidExecutionTools } from '../lib/android/lib/execution/tools.js'
import { resolveExecutionConfig } from '../lib/android/index.js'

const ROOT = '/project'
const DESCRIBE = [
  `Target project directory: ${ROOT}`,
  `Project directory exists: ${ROOT}`,
  'Parsed tasks:',
  'Task: :app',
  '    Variant: debug',
  '        APK: /project/app/build/outputs/apk/debug/app-debug.apk',
  '        APK: /project/app/build/outputs/apk/debug/app-debug-unsigned.apk (Exists)',
  'Task: :lib',
  '    Variant: release',
  'gradlew completed successfully.',
].join('\n')

const sha = (value) => `sha:${Buffer.from(String(value)).length}`

test('CLI 版本只接受 1.0.x', () => {
  assert.equal(parseAndroidCliVersion('1.0.7\n'), '1.0.7')
  assert.equal(parseAndroidCliVersion('2.0.0'), undefined)
  assert.equal(parseAndroidCliVersion('1.1.0'), undefined)
  assert.equal(parseAndroidCliVersion('android 1.0.7'), undefined)
  assert.equal(CLI_VERSION_POLICY, 'android-cli-1.0.x')
})

test('describe 报告解析出模块、变体与绝对产物路径', () => {
  const parsed = parseAndroidCliDescribe(DESCRIBE, ROOT)
  assert.equal(parsed.gradleWrapper, `${ROOT}/gradlew`)
  assert.deepEqual(parsed.modules, [
    { path: ':app', variants: [{ name: 'debug', artifacts: [
      { kind: 'apk', path: '/project/app/build/outputs/apk/debug/app-debug.apk' },
      { kind: 'apk', path: '/project/app/build/outputs/apk/debug/app-debug-unsigned.apk' },
    ] }] },
    { path: ':lib', variants: [{ name: 'release', artifacts: [] }] },
  ])
})

test('describe 报告的锚点、重复与相对路径一律拒绝', () => {
  const duplicateVariant = [
    `Target project directory: ${ROOT}`,
    `Project directory exists: ${ROOT}`,
    'Parsed tasks:',
    'Task: :app',
    '    Variant: debug',
    '    Variant: debug',
    'gradlew completed successfully.',
  ].join('\n')
  const cases = [
    [DESCRIBE.replace(`Target project directory: ${ROOT}`, 'Target project directory: /other'), /target does not match/],
    [DESCRIBE.replace(`Project directory exists: ${ROOT}`, ''), /did not confirm/],
    [DESCRIBE.replace('Parsed tasks:', ''), /missing its task section/],
    [DESCRIBE.replace('gradlew completed successfully.', ''), /did not complete Gradle/],
    [`${DESCRIBE}\nTask: :app`, /duplicate module/],
    [duplicateVariant, /duplicate variant/],
    [DESCRIBE.replace('APK: /project/app', 'APK: app'), /non-absolute APK path/],
    ['Target project directory: /project\nProject directory exists: /project\nParsed tasks:\ngradlew completed successfully.', /declared no modules/],
    [[
      `Target project directory: ${ROOT}`,
      `Project directory exists: ${ROOT}`,
      'Parsed tasks:',
      'Task: :app',
      '        APK: /x.apk',
      'gradlew completed successfully.',
    ].join('\n'), /before its variant/],
    [[
      `Target project directory: ${ROOT}`,
      `Project directory exists: ${ROOT}`,
      'Parsed tasks:',
      '    Variant: debug',
      'gradlew completed successfully.',
    ].join('\n'), /variant before its module/],
  ]
  for (const [text, pattern] of cases) {
    assert.throws(() => parseAndroidCliDescribe(text, ROOT), pattern, `应拒绝: ${pattern}`)
  }
})

test('静态检查只给线索，不声称 Gradle 任务', async () => {
  const fs = fakeFs({
    files: { [`${ROOT}/gradlew`]: 'x', [`${ROOT}/settings.gradle.kts`]: 'x', [`${ROOT}/app/build.gradle.kts`]: 'x' },
    dirs: { [ROOT]: ['app', 'build', '.git'] },
  })
  const facts = await inspectStaticProject({ projectRoot: ROOT, fs, signal: new AbortController().signal })
  assert.equal(facts.verified, false)
  assert.equal(facts.provenance, 'static-text')
  assert.deepEqual([...facts.leads.map((lead) => lead.kind)].sort(), ['module-dir', 'settings', 'wrapper'])
  assert.deepEqual([...facts.missing], [])
  // 模块线索明确标注"未经动态核对"，不冒充可执行事实。
  assert.match(facts.leads.find((lead) => lead.kind === 'module-dir').detail, /NOT verified/)
})

test('静态检查报告缺失的入口，而不是猜一个', async () => {
  const fs = fakeFs({ files: {}, dirs: { [ROOT]: [] } })
  const facts = await inspectStaticProject({ projectRoot: ROOT, fs, signal: new AbortController().signal })
  assert.deepEqual(facts.leads, [])
  assert.deepEqual([...facts.missing].sort(), ['gradlew', 'module build files'])
})

test('观测表按调用方隔离、会过期，id 不授予执行', () => {
  let now = 1000
  const store = createObservationStore(() => now, (() => { let n = 0; return () => `obs-${++n}` })(), 100)
  const facts = { projectRoot: ROOT, gradleWrapper: `${ROOT}/gradlew`, cliVersion: '1.0.7', observedAt: 'now', modules: [], provenance: 'android-cli-describe', cliPath: '/bin/android', inputDigests: {} }
  const observation = store.put('caller-a', facts, digestDynamicFacts(sha, facts))
  assert.equal(store.get('obs-1').ok, true)
  assert.equal(store.get('obs-missing').ok, false)
  assert.equal(store.getFor('obs-1', 'caller-b').ok, false)
  assert.equal(store.getFor('obs-1', 'caller-a').ok, true)
  now = 1200
  assert.equal(store.get('obs-1').ok, false)
})

test('执行配置默认关闭，非法值按未配置处理', () => {
  assert.equal(resolveExecutionConfig(undefined).enabled, false)
  assert.equal(resolveExecutionConfig({}).androidCli, undefined)
  const config = resolveExecutionConfig({
    execution: { enabled: true, androidCli: '/opt/android', privacy: 'explicit-user-opt-in', operationTimeoutMs: -5, outputMaxBytes: 10 ** 12 },
  })
  assert.equal(config.enabled, true)
  assert.equal(config.androidCli, '/opt/android')
  assert.equal(config.privacy, 'explicit-user-opt-in')
  assert.equal(config.operationTimeoutMs > 0, true)
  assert.equal(config.outputMaxBytes <= 4 * 1024 * 1024, true)
  assert.equal(resolveExecutionConfig({ execution: { enabled: true, privacy: 'whatever' } }).privacy, undefined)
})

/* ------------------------------------------------------------ 工具级流程 */

function fakeFs({ files = {}, dirs = {} } = {}) {
  const key = (path, cwd) => {
    if (path.startsWith('/')) return path
    const base = cwd ?? ROOT
    if (path === '.') return base
    return `${base}/${path}`
  }
  return {
    async resolve(path, options = {}) {
      const absolute = key(path, options.cwd)
      return { targetKey: absolute, displayPath: absolute }
    },
    async stat(target) {
      if (target.targetKey in files) return { type: 'file', size: 1 }
      if (target.targetKey in dirs) return { type: 'directory' }
      return undefined
    },
    async listDir(target) {
      return (dirs[target.targetKey] ?? []).map((name) => ({ name, type: name.includes('.') ? 'file' : 'directory' }))
    },
    processPath: (target) => target.targetKey,
    processPathFromHostPath: (hostPath) => hostPath,
    contains: (parent, child) => child.targetKey === parent.targetKey
      || child.targetKey.startsWith(`${parent.targetKey}/`),
    async readBytes() { return Buffer.from('wrapper') },
  }
}

function harness({
  mode = 'workspace-write', approval = 'allowed-once', cli, privacy, describeOut = DESCRIBE,
  versionOut = '1.0.7',
  // DESCRIBE 为该变体声明的两个 APK 默认存在：构建成功后才可能通过产物核对。
  files = {
    [`${ROOT}/app/build/outputs/apk/debug/app-debug.apk`]: 256,
    [`${ROOT}/app/build/outputs/apk/debug/app-debug-unsigned.apk`]: 256,
  },
  dirs = { [ROOT]: [] }, platform = 'posix', projectRoot = ROOT,
} = {}) {
  const calls = { spawn: [], approvals: [], confined: [] }
  const services = {
    fs: fakeFs({
      files: { [`${ROOT}/gradlew`]: 'x', ...files },
      dirs,
    }),
    sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: ROOT, sessionId: 's1' }) },
    approval: { async request(request) { calls.approvals.push(request); return approval } },
    sandbox: {
      async confine(argv) { calls.confined.push([...argv]); return { argv: [...argv], enforcement: 'full', denialSignatures: [] } },
    },
    subprocess: {
      async terminalEnvironment() { return { platform } },
      async resolveExecutable(command) { return command.startsWith('/') ? command : `/usr/bin/${command}` },
      spawn(spec) {
        calls.spawn.push(spec)
        const isVersion = spec.argv.includes('--version')
        const text = isVersion ? versionOut : describeOut
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          terminate() {},
          async waitForExit() { return true },
          collected: {
            stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          },
        }
      },
    },
  }
  const tools = {}
  const ctx = {
    get: (name) => services[name],
    tools: { register: (tool) => { tools[tool.name] = tool; return () => {} } },
    effect: () => () => {},
  }
  const config = resolveExecutionConfig({ execution: { enabled: true, ...(cli ? { androidCli: cli } : {}), ...(privacy ? { privacy } : {}) } })
  registerAndroidExecutionTools(ctx, () => config)
  const exec = {
    agent: { id: 'caller-a', session: { header: { id: 'caller-a', cwd: projectRoot } } },
    callId: 'call-1',
    signal: new AbortController().signal,
  }
  return { calls, tools, config, exec, services, ctx }
}

test('六个执行工具都注册且都只暴露结构化 action，没有 shell 入口', () => {
  const h = harness({ cli: '/opt/android/bin/android', privacy: 'verified-disabled' })
  assert.deepEqual(Object.keys(h.tools).sort(), [
    'satellite_android_build', 'satellite_android_capture', 'satellite_android_device',
    'satellite_android_emulator', 'satellite_android_journey', 'satellite_android_project',
  ].sort())
  for (const [name, tool] of Object.entries(h.tools)) {
    assert.equal(typeof tool.execute, 'function')
    // 每个工具都有受限枚举的动作：顶层 action 枚举，或旅程那种步骤数组里的 action 枚举。
    // 注册前经过 defineTool：参数已是 JSON Schema（properties/required 数组）。
    const properties = tool.parameters?.properties ?? {}
    const topLevelAction = Array.isArray(properties.action?.enum)
    const stepAction = Array.isArray(properties.steps?.items?.properties?.action?.enum)
    assert.ok(topLevelAction || stepAction, `${name} 应有受限的 action 枚举`)
    // 不允许出现任意命令/argv/shell 形状的参数。
    for (const key of Object.keys(properties)) {
      assert.doesNotMatch(key, /^(command|argv|shell|exec|script)$/i, `${name} 不应暴露 ${key}`)
    }
  }
})

test('inspect 动作是只读的：不调用批准，也不启动进程', async () => {
  const h = harness({ cli: '/opt/android/bin/android', privacy: 'verified-disabled', files: { [`${ROOT}/gradlew`]: 'x' } })
  const value = await h.tools[PROJECT_TOOL].execute({ action: 'inspect' }, h.exec)
  assert.equal(value.status, 'succeeded')
  assert.equal(value.facts.verified, false)
  assert.equal(h.calls.approvals.length, 0)
  assert.equal(h.calls.spawn.length, 0)
})

test('未配置 CLI 或隐私设置时 discover-build 明确不可用，且零进程零批准', async () => {
  const withoutCli = harness()
  const first = await withoutCli.tools[PROJECT_TOOL].execute({ action: 'discover-build' }, withoutCli.exec)
  assert.equal(first.status, 'blocked')
  assert.equal(first.error.code, 'CAPABILITY_UNAVAILABLE')
  assert.match(first.error.message, /androidCli/)

  const withoutPrivacy = harness({ cli: '/opt/android/bin/android' })
  const second = await withoutPrivacy.tools[PROJECT_TOOL].execute({ action: 'discover-build' }, withoutPrivacy.exec)
  assert.equal(second.status, 'blocked')
  assert.match(second.error.message, /privacy/)
  assert.equal(withoutPrivacy.calls.spawn.length, 0)
  assert.equal(withoutPrivacy.calls.approvals.length, 0)
})

test('只读会话里不做动态发现：写元数据的动作失败关闭', async () => {
  const h = harness({ cli: '/opt/android/bin/android', privacy: 'verified-disabled', mode: 'read-only' })
  const value = await h.tools[PROJECT_TOOL].execute({ action: 'discover-build' }, h.exec)
  assert.equal(value.status, 'blocked')
  assert.match(value.error.message, /workspace-write/)
  assert.equal(h.calls.spawn.length, 0)
})

test('非 POSIX 执行世界在批准之前就不可用', async () => {
  const h = harness({ cli: '/opt/android/bin/android', privacy: 'verified-disabled', platform: 'windows' })
  const value = await h.tools[PROJECT_TOOL].execute({ action: 'discover-build' }, h.exec)
  assert.equal(value.status, 'blocked')
  assert.match(value.error.message, /POSIX/)
  assert.equal(h.calls.approvals.length, 0)
})

test('批准被拒时零进程执行', async () => {
  const h = harness({ cli: '/opt/android/bin/android', privacy: 'verified-disabled', approval: 'rejected' })
  const value = await h.tools[PROJECT_TOOL].execute({ action: 'discover-build' }, h.exec)
  assert.equal(value.status, 'blocked')
  assert.equal(value.error.code, 'APPROVAL_REJECTED')
  assert.equal(h.calls.spawn.length, 0)
  assert.equal(h.calls.approvals.length, 1)
})

test('批准后按版本门与报告门产出观测 id 与动态事实', async () => {
  const h = harness({ cli: '/opt/android/bin/android', privacy: 'verified-disabled' })
  const value = await h.tools[PROJECT_TOOL].execute({ action: 'discover-build' }, h.exec)
  assert.equal(value.status, 'succeeded')
  assert.equal(typeof value.observationId, 'string')
  assert.equal(value.facts.cliVersion, '1.0.7')
  assert.equal(value.facts.gradleWrapper, `${ROOT}/gradlew`)
  assert.equal(value.facts.modules.length, 2)
  // 批准发生在任何进程之前，且理由包含精确命令与影响。
  assert.equal(h.calls.approvals.length, 1)
  assert.match(h.calls.approvals[0].reason, /--version/)
  assert.match(h.calls.approvals[0].reason, /describe/)
  assert.equal(h.calls.approvals[0].toolName, PROJECT_TOOL)
  assert.equal(h.calls.approvals[0].callId, 'call-1')
  assert.equal(h.calls.spawn.length, 2)
})

test('不支持的 CLI 版本在 describe 之前停止', async () => {
  const h = harness({ cli: '/opt/android/bin/android', privacy: 'verified-disabled', versionOut: '2.1.0' })
  const value = await h.tools[PROJECT_TOOL].execute({ action: 'discover-build' }, h.exec)
  assert.equal(value.status, 'blocked')
  assert.match(value.error.message, /android-cli-1\.0\.x/)
  assert.equal(h.calls.spawn.length, 1)
})

test('构建工具要求有效观测、拒绝未声明的模块与变体', async () => {
  const h = harness({ cli: '/opt/android/bin/android', privacy: 'verified-disabled' })
  const missing = await h.tools[BUILD_TOOL].execute(
    { action: 'build', observationId: 'obs-nope', module: ':app', variant: 'debug' }, h.exec)
  assert.equal(missing.status, 'blocked')
  assert.match(missing.error.message, /observation/)

  const discovered = await h.tools[PROJECT_TOOL].execute({ action: 'discover-build' }, h.exec)
  const wrongModule = await h.tools[BUILD_TOOL].execute(
    { action: 'build', observationId: discovered.observationId, module: ':nope', variant: 'debug' }, h.exec)
  assert.equal(wrongModule.status, 'blocked')
  assert.match(wrongModule.error.message, /module is not declared/)

  const wrongVariant = await h.tools[BUILD_TOOL].execute(
    { action: 'build', observationId: discovered.observationId, module: ':app', variant: 'staging' }, h.exec)
  assert.equal(wrongVariant.status, 'blocked')
  assert.match(wrongVariant.error.message, /variant is not declared/)
})

test('构建只执行由一个模块与变体派生的确切 Gradle 任务', async () => {
  const h = harness({ cli: '/opt/android/bin/android', privacy: 'verified-disabled' })
  const discovered = await h.tools[PROJECT_TOOL].execute({ action: 'discover-build' }, h.exec)
  const before = h.calls.spawn.length
  const built = await h.tools[BUILD_TOOL].execute({
    action: 'build', observationId: discovered.observationId, module: ':app', variant: 'debug',
    clean: true, offline: true, rerunTasks: true,
  }, h.exec)
  assert.equal(built.status, 'succeeded')
  const gradle = h.calls.spawn.slice(before).find((spec) => !spec.argv.includes('--version') && !spec.argv.includes('describe'))
  assert.deepEqual(gradle.argv, [`${ROOT}/gradlew`, 'clean', ':app:assembleDebug', '--console=plain', '--offline', '--rerun-tasks'])
  assert.equal(gradle.cwd, ROOT)

  const tested = await h.tools[BUILD_TOOL].execute({
    action: 'test', observationId: discovered.observationId, module: ':lib', variant: 'release',
  }, h.exec)
  assert.equal(tested.status, 'succeeded')
  const testSpec = h.calls.spawn.at(-1)
  assert.deepEqual(testSpec.argv, [`${ROOT}/gradlew`, ':lib:testReleaseUnitTest', '--console=plain'])
})

test('批准后模型变化则不执行 Gradle', async () => {
  const h = harness({ cli: '/opt/android/bin/android', privacy: 'verified-disabled' })
  const discovered = await h.tools[PROJECT_TOOL].execute({ action: 'discover-build' }, h.exec)
  // 第二次发现（构建的批准后复核）返回不同的报告。
  const original = h.services.subprocess.spawn
  h.services.subprocess.spawn = (spec) => {
    if (!spec.argv.includes('--version') && !spec.argv.includes('describe')) return original(spec)
    const changed = spec.argv.includes('--version')
    const text = changed ? '1.0.7' : DESCRIBE.replace('Task: :lib', 'Task: :lib2')
    h.calls.spawn.push(spec)
    return {
      done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {}, async waitForExit() { return true },
      collected: {
        stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
    }
  }
  const value = await h.tools[BUILD_TOOL].execute({
    action: 'build', observationId: discovered.observationId, module: ':app', variant: 'debug',
  }, h.exec)
  assert.equal(value.status, 'blocked')
  assert.equal(value.error.code, 'TARGET_CHANGED')
  assert.match(value.error.message, /changed after the observation/)
})

test('未知参数与越权路径在启动任何进程之前被拒绝', async () => {
  const h = harness({ cli: '/opt/android/bin/android', privacy: 'verified-disabled' })
  const extra = await h.tools[PROJECT_TOOL].execute({ action: 'inspect', command: 'rm -rf /' }, h.exec)
  assert.equal(extra.status, 'blocked')
  assert.equal(extra.error.code, 'ARGUMENT_INVALID')
  const escape = await h.tools[PROJECT_TOOL].execute({ action: 'inspect', project: '../outside' }, h.exec)
  assert.equal(escape.status, 'blocked')
  assert.equal(escape.error.code, 'ARGUMENT_INVALID')
  assert.equal(h.calls.spawn.length, 0)
})

test('子项目观测能被同一子项目的构建消费（F3 回归）', async () => {
  const sub = `${ROOT}/app`
  const subDescribe = DESCRIBE.replaceAll(ROOT, sub)
  const h = harness({
    cli: '/opt/android/bin/android', privacy: 'verified-disabled', projectRoot: ROOT,
    describeOut: subDescribe,
    dirs: { [ROOT]: ['app'], [sub]: [] },
    files: {
      [`${sub}/gradlew`]: 'x',
      [`${sub}/app/build/outputs/apk/debug/app-debug.apk`]: 256,
      [`${sub}/app/build/outputs/apk/debug/app-debug-unsigned.apk`]: 256,
    },
  })
  const discovered = await h.tools[PROJECT_TOOL].execute({ action: 'discover-build', project: 'app' }, h.exec)
  assert.equal(discovered.status, 'succeeded')
  assert.equal(discovered.facts.projectRoot, sub)
  const built = await h.tools[BUILD_TOOL].execute({
    action: 'build', project: 'app', observationId: discovered.observationId, module: ':app', variant: 'debug',
  }, h.exec)
  assert.equal(built.status, 'succeeded', JSON.stringify(built))
  const gradle = h.calls.spawn.at(-1)
  assert.deepEqual(gradle.argv, [`${sub}/gradlew`, ':app:assembleDebug', '--console=plain'])
  assert.equal(gradle.cwd, sub)
})

test('构建只发一次批准，且复核失败时不谎报成功（F4 回归）', async () => {
  const h = harness({ cli: '/opt/android/bin/android', privacy: 'verified-disabled' })
  const discovered = await h.tools[PROJECT_TOOL].execute({ action: 'discover-build' }, h.exec)
  assert.equal(h.calls.approvals.length, 1)
  const before = h.calls.approvals.length
  const built = await h.tools[BUILD_TOOL].execute({
    action: 'build', observationId: discovered.observationId, module: ':app', variant: 'debug',
  }, h.exec)
  assert.equal(built.status, 'succeeded')
  // discover 阶段 1 次 + build 阶段 1 次（复核包含在同一批准计划里），总共 2 次。
  assert.equal(h.calls.approvals.length - before, 1)
  assert.equal(h.calls.approvals.at(-1).toolName, BUILD_TOOL)
})

test('复核被拒时构建不执行，并且不报成 TARGET_CHANGED（F4 回归）', async () => {
  const h = harness({ cli: '/opt/android/bin/android', privacy: 'verified-disabled' })
  const discovered = await h.tools[PROJECT_TOOL].execute({ action: 'discover-build' }, h.exec)
  // 从第二次批准开始一律拒绝：构建批准本身被拒。
  h.services.approval.request = async (request) => { h.calls.approvals.push(request); return 'rejected' }
  const built = await h.tools[BUILD_TOOL].execute({
    action: 'build', observationId: discovered.observationId, module: ':app', variant: 'debug',
  }, h.exec)
  assert.equal(built.status, 'blocked')
  assert.equal(built.error.code, 'APPROVAL_REJECTED')
  assert.equal(h.calls.spawn.filter((spec) => spec.argv.includes('assembleDebug')).length, 0)
})

test('只有静态 inspect 被声明为并发安全（F6 回归）', () => {
  const h = harness({ cli: '/opt/android/bin/android', privacy: 'verified-disabled' })
  assert.equal(h.tools[PROJECT_TOOL].isConcurrencySafe({ action: 'inspect' }), true)
  assert.equal(h.tools[PROJECT_TOOL].isConcurrencySafe({ action: 'discover-build' }), false)
  assert.equal(h.tools[PROJECT_TOOL].isConcurrencySafe({}), false)
  assert.equal(h.tools[BUILD_TOOL].isConcurrencySafe({ action: 'build' }), false)
})

test('构建退出码 0 但声明的产物不存在时算失败，并列出缺失项（产物核对回归）', async () => {
  const h = harness({
    cli: '/opt/android/bin/android', privacy: 'verified-disabled',
    // 该变体声明的两个 APK 都不存在。
    files: {},
  })
  const discovered = await h.tools[PROJECT_TOOL].execute({ action: 'discover-build' }, h.exec)
  const built = await h.tools[BUILD_TOOL].execute({
    action: 'build', observationId: discovered.observationId, module: ':app', variant: 'debug',
  }, h.exec)
  assert.equal(built.status, 'failed')
  assert.equal(built.error.code, 'EFFECT_UNKNOWN')
  assert.match(built.error.message, /declared artifacts are missing/)
  assert.deepEqual(built.artifacts.missing, [
    `${ROOT}/app/build/outputs/apk/debug/app-debug.apk`,
    `${ROOT}/app/build/outputs/apk/debug/app-debug-unsigned.apk`,
  ])
  assert.equal(built.artifacts.verified, 0)
})

test('构建成功时核对每个声明产物的摘要，而不是只看退出码（产物核对回归）', async () => {
  const h = harness({ cli: '/opt/android/bin/android', privacy: 'verified-disabled' })
  const discovered = await h.tools[PROJECT_TOOL].execute({ action: 'discover-build' }, h.exec)
  const built = await h.tools[BUILD_TOOL].execute({
    action: 'build', observationId: discovered.observationId, module: ':app', variant: 'debug',
  }, h.exec)
  assert.equal(built.status, 'succeeded')
  assert.deepEqual(built.artifacts, { expected: 2, verified: 2, missing: [] })
  const artifactEvidence = built.evidence.filter((entry) => entry.kind === 'artifact')
  assert.equal(artifactEvidence.length, 2)
  for (const entry of artifactEvidence) assert.equal(String(entry.digest).length, 64)
})

test('CLI 与 Gradle 的用户目录定向到会话工作区内（受限会话可写）', async () => {
  const h = harness({ cli: '/opt/android/bin/android', privacy: 'verified-disabled' })
  const discovered = await h.tools[PROJECT_TOOL].execute({ action: 'discover-build' }, h.exec)
  assert.equal(discovered.status, 'succeeded')
  // discover 的两次 CLI 调用都带 ANDROID_USER_HOME，且落在工作区内。
  const cliRuns = h.calls.spawn.filter((spec) => spec.argv.includes('--version') || spec.argv.includes('describe'))
  assert.equal(cliRuns.length, 2)
  for (const spec of cliRuns) {
    assert.equal(spec.env.ANDROID_USER_HOME, `${ROOT}/.satellite/android-user-home`)
  }
  // 构建把 GRADLE_USER_HOME 定向到工作区内。
  const built = await h.tools[BUILD_TOOL].execute({
    action: 'build', observationId: discovered.observationId, module: ':app', variant: 'debug',
  }, h.exec)
  assert.equal(built.status, 'succeeded')
  const gradle = h.calls.spawn.at(-1)
  assert.equal(gradle.env.GRADLE_USER_HOME, `${ROOT}/.satellite/gradle-user-home`)
})

test('volatile execution 配置能正确归一化（防止把内层对象当外层传）', async () => {
  const { Config, resolveExecutionConfig } = await import('../lib/android/index.js')
  const resolved = Config({ execution: { enabled: true, adbPath: '/x/adb', androidCli: '/x/android', privacy: 'verified-disabled' } })
  assert.equal(typeof resolved.execution?.get, 'function', 'execution 必须是 volatile 句柄')
  const live = resolved.execution.get()
  // 生产路径：外层的 { execution } 形状。
  const normalized = resolveExecutionConfig({ execution: live })
  assert.equal(normalized.enabled, true)
  assert.equal(normalized.adbPath, '/x/adb')
  assert.equal(normalized.androidCli, '/x/android')
  assert.equal(normalized.privacy, 'verified-disabled')
  // 直接传内层对象是错的：这断言防止有人把两条形状搞混而静默关闭执行。
  assert.equal(resolveExecutionConfig(live).enabled, false)
  // 空配置仍是关闭。
  assert.equal(resolveExecutionConfig({ execution: Config({}).execution.get() }).enabled, false)
})

test('describe 报告缺锚点时把 CLI stderr 末尾带进错误（真实 CLI 失败仍 exit 0）', async () => {
  const h = harness({
    cli: '/opt/android/bin/android', privacy: 'verified-disabled',
    // Gradle 失败：stdout 只有锚点、缺 "gradlew completed successfully."，exit code 仍是 0。
    describeOut: [
      `Target project directory: ${ROOT}`,
      `Project directory exists: ${ROOT}`,
      'Parsed tasks:',
    ].join('\n'),
  })
  // 让 stderr 带上失败原因。
  const original = h.services.subprocess.spawn
  h.services.subprocess.spawn = (spec) => {
    const handle = original(spec)
    if (!spec.argv.includes('describe')) return handle
    const stderrText = 'BUILD FAILED in 259ms: java.io.FileNotFoundException: .gradle/9.4.1/fileHashes/fileHashes.lock'
    return {
      ...handle,
      collected: {
        ...handle.collected,
        stderr: { readFrom: () => ({ text: stderrText, nextOffset: stderrText.length, lossy: false }) },
      },
    }
  }
  const value = await h.tools[PROJECT_TOOL].execute({ action: 'discover-build' }, h.exec)
  assert.equal(value.status, 'failed')
  assert.match(value.error.message, /did not complete Gradle/)
  assert.match(value.error.message, /BUILD FAILED/)
})

test('旅程 key 参数的枚举直接来自解析器键表（描述不许另写一份）', async () => {
  const { JOURNEY_KEYS } = await import('../lib/android/lib/execution/journey.js')
  const h = harness({ cli: '/opt/android/bin/android', privacy: 'verified-disabled' })
  const journey = h.tools['satellite_android_journey']
  const properties = journey.parameters.properties
  assert.deepEqual(properties.steps.items.properties.key.enum, [...JOURNEY_KEYS])
  // 描述里不该再出现自成一体的键名清单。
  assert.doesNotMatch(properties.steps.items.properties.key.description, /VOLUME_UP|POWER|HOME,/)
})

/* ------------------------------------------- 工作区外的工程（逐次升级） */

const EXTERNAL = '/outside/devtarget'

function externalHarness(over = {}) {
  const h = harness({
    cli: '/opt/android/bin/android', privacy: 'verified-disabled',
    describeOut: DESCRIBE.replaceAll(ROOT, EXTERNAL),
    dirs: { [ROOT]: [], [EXTERNAL]: [] },
    files: {
      [`${EXTERNAL}/app/build/outputs/apk/debug/app-debug.apk`]: 10,
      [`${EXTERNAL}/app/build/outputs/apk/debug/app-debug-unsigned.apk`]: 10,
    },
    ...over,
  })
  // 让外部目录可解析，且根 wrapper 可读。
  h.services.fs.stat = async (target) => {
    if (target.targetKey === `${EXTERNAL}/gradlew`) return { type: 'file', size: 1 }
    if (target.targetKey === EXTERNAL || target.targetKey === ROOT) return { type: 'directory' }
    if (target.targetKey.startsWith(`${EXTERNAL}/app/build/`)) return { type: 'file', size: 10 }
    return undefined
  }
  return h
}

test('工作区外的工程：只读 inspect 可直接用，写/执行需要逐次升级', async () => {
  const h = externalHarness()
  const inspected = await h.tools[PROJECT_TOOL].execute({ action: 'inspect', project: EXTERNAL }, h.exec)
  assert.equal(inspected.status, 'succeeded')
  assert.equal(inspected.facts.projectRoot, EXTERNAL)

  const blockedDiscover = await h.tools[PROJECT_TOOL].execute({ action: 'discover-build', project: EXTERNAL }, h.exec)
  assert.equal(blockedDiscover.status, 'blocked')
  assert.equal(blockedDiscover.error.code, 'CAPABILITY_UNAVAILABLE')
  assert.match(blockedDiscover.error.message, /outside the session workspace/)
  assert.match(blockedDiscover.error.message, /sandboxPermissions/)
  assert.equal(h.calls.approvals.length, 0, '未要求升级时不发批准请求')
  assert.equal(h.calls.spawn.length, 0)
})

test('升级参数必须成对且只能是 danger-full-access', async () => {
  const h = externalHarness()
  const noJustification = await h.tools[PROJECT_TOOL].execute(
    { action: 'discover-build', project: EXTERNAL, sandboxPermissions: 'danger-full-access' }, h.exec)
  assert.equal(noJustification.error.code, 'ARGUMENT_INVALID')
  assert.match(noJustification.error.message, /justification/)

  // 枚举本身由工具 schema 拒绝（defineTool 校验），不到达处理逻辑。
  await assert.rejects(h.tools[PROJECT_TOOL].execute(
    { action: 'discover-build', project: EXTERNAL, sandboxPermissions: 'workspace-write', justification: 'x' }, h.exec),
  /must be one of \["danger-full-access"\]/)

  const justificationOnly = await h.tools[PROJECT_TOOL].execute(
    { action: 'discover-build', project: EXTERNAL, justification: 'x' }, h.exec)
  assert.equal(justificationOnly.error.code, 'ARGUMENT_INVALID')
  assert.equal(h.calls.approvals.length, 0)
})

test('工作区内的工程不需要升级：误传升级参数会被拒，避免无意义的批准', async () => {
  const h = harness({ cli: '/opt/android/bin/android', privacy: 'verified-disabled' })
  const value = await h.tools[PROJECT_TOOL].execute(
    { action: 'discover-build', sandboxPermissions: 'danger-full-access', justification: 'x' }, h.exec)
  assert.equal(value.error.code, 'ARGUMENT_INVALID')
  assert.match(value.error.message, /only meaningful for a project outside/)
  assert.equal(h.calls.approvals.length, 0)
})

test('升级批准后 CLI 以 unconfined 方式运行，批准理由写明外部路径与影响', async () => {
  const h = externalHarness()
  const discovered = await h.tools[PROJECT_TOOL].execute({
    action: 'discover-build', project: EXTERNAL,
    sandboxPermissions: 'danger-full-access', justification: '需要在外部测试工程里生成 AGP 元数据',
  }, h.exec)
  assert.equal(discovered.status, 'succeeded', JSON.stringify(discovered))
  assert.equal(discovered.facts.projectRoot, EXTERNAL)
  const reason = h.calls.approvals[0].reason
  assert.match(reason, new RegExp(EXTERNAL.replaceAll('/', '\\/')))
  assert.match(reason, /UNCONFINED/)
  assert.match(reason, /需要在外部测试工程里生成 AGP 元数据/)
  // harness 的 sandbox.confine 记录调用：外部工程不应经过 confine。
  assert.equal(h.calls.confined.length, 0, 'unconfined 运行不经过沙箱 confine')
})

test('外部工程的构建沿用同一份升级批准，且不重复请求', async () => {
  const h = externalHarness()
  const discovered = await h.tools[PROJECT_TOOL].execute({
    action: 'discover-build', project: EXTERNAL,
    sandboxPermissions: 'danger-full-access', justification: '外部工程构建验收',
  }, h.exec)
  const before = h.calls.approvals.length
  const built = await h.tools[BUILD_TOOL].execute({
    action: 'build', project: EXTERNAL, observationId: discovered.observationId,
    module: ':app', variant: 'debug',
    sandboxPermissions: 'danger-full-access', justification: '外部工程构建验收',
  }, h.exec)
  assert.equal(built.status, 'succeeded', JSON.stringify(built))
  assert.equal(h.calls.approvals.length - before, 1, '构建本身一次批准（复核包含在内）')
  assert.match(h.calls.approvals.at(-1).reason, /UNCONFINED/)
})

test('外部工程的升级运行不复用 Gradle daemon（避免旧围栏的 daemon 继续执行）', async () => {
  const h = externalHarness()
  const discovered = await h.tools[PROJECT_TOOL].execute({
    action: 'discover-build', project: EXTERNAL,
    sandboxPermissions: 'danger-full-access', justification: '外部工程验收',
  }, h.exec)
  // 发现阶段：Gradle 侧禁用 daemon（CLI 不能传 Gradle 参数，用环境变量）。
  const discoverEnv = h.calls.spawn.at(-1).env
  assert.match(discoverEnv.GRADLE_OPTS, /-Dorg\.gradle\.daemon=false$/)

  const built = await h.tools[BUILD_TOOL].execute({
    action: 'build', project: EXTERNAL, observationId: discovered.observationId,
    module: ':app', variant: 'debug', clean: true,
    sandboxPermissions: 'danger-full-access', justification: '外部工程验收',
  }, h.exec)
  assert.equal(built.status, 'succeeded', JSON.stringify(built))
  const buildSpawn = h.calls.spawn.at(-1)
  assert.ok(buildSpawn.argv.includes('--no-daemon'), '外部工程构建必须带 --no-daemon')
  assert.ok(buildSpawn.argv.includes('clean') && buildSpawn.argv.includes(':app:assembleDebug'))
})

test('工作区内构建仍然复用 daemon（不加 --no-daemon）', async () => {
  const h = harness({ cli: '/opt/android/bin/android', privacy: 'verified-disabled', dirs: { [ROOT]: [] } })
  const discovered = await h.tools[PROJECT_TOOL].execute({ action: 'discover-build' }, h.exec)
  const built = await h.tools[BUILD_TOOL].execute({
    action: 'build', observationId: discovered.observationId, module: ':app', variant: 'debug',
  }, h.exec)
  assert.equal(built.status, 'succeeded', JSON.stringify(built))
  const spawn = h.calls.spawn.at(-1)
  assert.equal(spawn.argv.includes('--no-daemon'), false)
  assert.equal(spawn.env.GRADLE_OPTS, undefined)
})

test('升级事实进入结果：外部工程的 discover/build 结果带 escalation 与 unconfined', async () => {
  const h = externalHarness()
  const discovered = await h.tools[PROJECT_TOOL].execute({
    action: 'discover-build', project: EXTERNAL,
    sandboxPermissions: 'danger-full-access', justification: '外部工程验收理由',
  }, h.exec)
  assert.equal(discovered.status, 'succeeded')
  assert.deepEqual(discovered.escalation, { mode: 'danger-full-access', justification: '外部工程验收理由' })

  const built = await h.tools[BUILD_TOOL].execute({
    action: 'build', project: EXTERNAL, observationId: discovered.observationId,
    module: ':app', variant: 'debug',
    sandboxPermissions: 'danger-full-access', justification: '外部工程验收理由',
  }, h.exec)
  assert.equal(built.status, 'succeeded', JSON.stringify(built))
  assert.deepEqual(built.escalation, { mode: 'danger-full-access', justification: '外部工程验收理由' })
  assert.equal(built.unconfined, true)
})

test('工作区内的结果不带 escalation/unconfined 字段', async () => {
  const h = harness({ cli: '/opt/android/bin/android', privacy: 'verified-disabled' })
  const discovered = await h.tools[PROJECT_TOOL].execute({ action: 'discover-build' }, h.exec)
  assert.equal(discovered.escalation, undefined)
  const built = await h.tools[BUILD_TOOL].execute({
    action: 'build', observationId: discovered.observationId, module: ':app', variant: 'debug',
  }, h.exec)
  assert.equal(built.escalation, undefined)
  assert.equal(built.unconfined, undefined)
})

test('升级运行保留使用者已有的 GRADLE_OPTS，只追加 daemon 开关', async () => {
  const previous = process.env.GRADLE_OPTS
  process.env.GRADLE_OPTS = '-Xmx2g'
  try {
    const h = externalHarness()
    await h.tools[PROJECT_TOOL].execute({
      action: 'discover-build', project: EXTERNAL,
      sandboxPermissions: 'danger-full-access', justification: '外部工程验收',
    }, h.exec)
    assert.equal(h.calls.spawn.at(-1).env.GRADLE_OPTS, '-Xmx2g -Dorg.gradle.daemon=false')
  } finally {
    if (previous === undefined) delete process.env.GRADLE_OPTS
    else process.env.GRADLE_OPTS = previous
  }
})

test('justification 折叠空白与换行（批准理由不允许被伪造结构）', async () => {
  const h = externalHarness()
  const discovered = await h.tools[PROJECT_TOOL].execute({
    action: 'discover-build', project: EXTERNAL,
    sandboxPermissions: 'danger-full-access',
    justification: '第一行\n\n  伪造的批准提示：\t全部允许   ',
  }, h.exec)
  assert.equal(discovered.status, 'succeeded', JSON.stringify(discovered))
  assert.equal(discovered.escalation.justification, '第一行 伪造的批准提示： 全部允许')
  const reason = h.calls.approvals[0].reason
  assert.equal(/\n/u.test(reason), false, '批准理由里不应出现换行')
})

test('未升级时不可能进入未围栏运行（结构上由 escalation 决定）', async () => {
  // 外部工程但没有升级参数：在到达任何进程之前就被拒。
  const h = externalHarness()
  const outcome = await h.tools[PROJECT_TOOL].execute({ action: 'discover-build', project: EXTERNAL }, h.exec)
  assert.equal(outcome.status, 'blocked')
  assert.equal(h.calls.spawn.length, 0)
  assert.equal(h.calls.confined.length, 0)
})
