import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  createDeviceLock, createDeviceObservationStore, describeDevicePlan, identityDigest, lockKey,
  observeDevice, parseAdbDevicesL, parseDeviceRequest, parseForegroundPackage, parseGetprop,
  prepareDeviceAction, sameInstance,
} from '../lib/android/lib/execution/device.js'
import { resolveExecutionConfig } from '../lib/android/index.js'
import {
  BUILD_TOOL, DEVICE_TOOL, EMULATOR_TOOL, PROJECT_TOOL, registerAndroidExecutionTools,
} from '../lib/android/lib/execution/tools.js'

const ROOT = '/project'
// 测试 fixtures 显式构造 Apple 宿主，而不是依赖运行测试的机器平台。
const APPLE_FILES = {
  '/System/Library/CoreServices/SystemVersion.plist': 1,
  '/usr/bin/sw_vers': 1,
}
const sha = (value) => createHash('sha256').update(String(value)).digest('hex')

const DEVICES_L = [
  'List of devices attached',
  'emulator-5554          device product:sdk_gphone64 model:sdk_gphone64 device:emu64 transport_id:1',
  'R58M12345             unauthorized transport_id:2',
  '',
].join('\n')

const GETPROP = [
  '[ro.boot.serialno]: [emulator-5554]',
  '[ro.serialno]: [emulator-5554]',
  '[ro.build.fingerprint]: [google/sdk_gphone64/emu64:14/UP1A/1234:userdebug/test-keys]',
  '',
].join('\n')

const identity = (over = {}) => ({
  world: 'host-shared-v1', adbPath: '/usr/bin/adb', serverEndpoint: 'default', generation: 'gen-1',
  serial: 'emulator-5554', transportId: '1', state: 'device',
  bootSerial: 'emulator-5554', buildFingerprint: 'fp', ...over,
})

test('adb devices -l 只解析真实的设备行', () => {
  assert.deepEqual(parseAdbDevicesL(DEVICES_L), [
    { serial: 'emulator-5554', state: 'device', transportId: '1', product: 'sdk_gphone64', model: 'sdk_gphone64', device: 'emu64' },
    { serial: 'R58M12345', state: 'unauthorized', transportId: '2' },
  ])
  assert.deepEqual(parseAdbDevicesL('List of devices attached\n'), [])
  assert.deepEqual(parseAdbDevicesL(''), [])
})

test('getprop 解析只接受 [name]: [value] 行', () => {
  const props = parseGetprop(GETPROP)
  assert.equal(props['ro.boot.serialno'], 'emulator-5554')
  assert.equal(props['ro.build.fingerprint'], 'google/sdk_gphone64/emu64:14/UP1A/1234:userdebug/test-keys')
  assert.deepEqual(parseGetprop('garbage\n'), {})
})

test('同一实例比较包含 transport、server 与设备属性', () => {
  assert.equal(sameInstance(identity(), identity()).ok, true)
  for (const change of [{ transportId: '9' }, { serverEndpoint: 'tcp:5037' }, { bootSerial: 'other' }, { buildFingerprint: 'other' }]) {
    const result = sameInstance(identity(), identity(change))
    assert.equal(result.ok, false, `应拒绝 ${JSON.stringify(change)}`)
  }
  assert.equal(sameInstance(identity(), identity({ state: 'offline' })).ok, false)
  assert.equal(sameInstance(identity(), identity({ serial: 'other' })).ok, false)
})

test('身份摘要随 transport/属性变化，不是只看 serial', () => {
  assert.notEqual(identityDigest(sha, identity()), identityDigest(sha, identity({ transportId: '2' })))
  assert.notEqual(identityDigest(sha, identity()), identityDigest(sha, identity({ buildFingerprint: 'other' })))
  assert.equal(identityDigest(sha, identity()), identityDigest(sha, identity()))
})

test('锁按执行世界 + adb + endpoint + serial 键控，busy 立即拒绝', () => {
  const lock = createDeviceLock()
  const key = lockKey(identity())
  assert.equal(lock.tryAcquire(key), true)
  assert.equal(lock.tryAcquire(key), false)
  assert.equal(lock.held(key), true)
  lock.release(key)
  assert.equal(lock.tryAcquire(key), true)
  // 另一个 serial 不受影响。
  assert.equal(lock.tryAcquire(lockKey(identity({ serial: 'other' }))), true)
})

test('设备观测按调用方隔离并会过期', () => {
  let now = 1000
  let seq = 0
  const store = createDeviceObservationStore(() => now, () => `obs-${++seq}`, 100)
  const observation = store.put('caller-a', identity(), 'digest')
  assert.equal(store.get('obs-1').ok, true)
  assert.equal(store.getFor('obs-1', 'caller-b').ok, false)
  assert.equal(store.getFor('obs-1', 'caller-a').ok, true)
  now = 2000
  assert.equal(store.get('obs-1').ok, false)
})

test('前台包名解析失败时不猜', () => {
  assert.equal(parseForegroundPackage('mResumedActivity: ActivityRecord{abc u0 com.example.app/.MainActivity t42}'), 'com.example.app')
  assert.equal(parseForegroundPackage('nothing useful here'), undefined)
  assert.equal(parseForegroundPackage(''), undefined)
})

test('设备请求严格校验：discover 不带目标参数，install 只接受工作区相对产物', () => {
  assert.deepEqual(parseDeviceRequest({ action: 'discover', serial: 'emulator-5554' }), { action: 'discover', serial: 'emulator-5554' })
  assert.throws(() => parseDeviceRequest({ action: 'discover', serial: 's', observationId: 'obs-1' }), /does not take/)
  assert.throws(() => parseDeviceRequest({ action: 'discover' }), /serial/)
  assert.throws(() => parseDeviceRequest({ action: 'install', serial: 's', observationId: 'o', artifact: '/etc/passwd' }), /workspace-relative/)
  assert.throws(() => parseDeviceRequest({ action: 'install', serial: 's', observationId: 'o', artifact: 'a/../b.apk' }), /empty, "\." or "\.\."/)
  assert.throws(() => parseDeviceRequest({ action: 'launch', serial: 's', observationId: 'o', applicationId: 'not-a-package' }), /reverse-DNS/)
  assert.throws(() => parseDeviceRequest({ action: 'foreground', serial: 's', observationId: 'o', applicationId: 'com.example.app', extra: 1 }), /unknown field/)
  assert.deepEqual(parseDeviceRequest({ action: 'foreground', serial: 's', observationId: 'o', applicationId: 'com.example.app' }), {
    action: 'foreground', serial: 's', observationId: 'o', applicationId: 'com.example.app',
  })
})

test('批准理由说明真实影响，不隐藏 adb server 启动', () => {
  assert.match(describeDevicePlan({ action: 'discover' }), /may start the adb server/)
  assert.match(describeDevicePlan({ action: 'install', serial: 's', observationId: 'o', artifact: 'a.apk' }), /install -r/)
  assert.match(describeDevicePlan({ action: 'install', serial: 's', observationId: 'o', artifact: 'a.apk' }), /replaces the installed app/)
  assert.match(describeDevicePlan({ action: 'launch', serial: 's', observationId: 'o', applicationId: 'com.example.app' }), /foreground/)
})

/* ------------------------------------------------------------------ 工具层 */

function fakeFs({ files = { ...APPLE_FILES, [`${ROOT}/app.apk`]: 128 } } = {}) {
  return {
    async resolve(path, options = {}) {
      const base = options.cwd ?? ROOT
      const absolute = path.startsWith('/') ? path : `${base}/${path}`
      return { targetKey: absolute, displayPath: absolute }
    },
    async stat(target) {
      const size = files[target.targetKey]
      if (size !== undefined) return { type: 'file', size }
      if (target.targetKey === ROOT) return { type: 'directory' }
      return undefined
    },
    async listDir() { return [] },
    processPath: (target) => target.targetKey,
    processPathFromHostPath: (hostPath) => hostPath,
    async readBytes() { return Buffer.from('apk-bytes') },
  }
}

function harness({
  mode = 'workspace-write', approval = 'allowed-once', devicesOut = DEVICES_L, getpropOut = GETPROP,
  exitCode = 0, files, enabled = true, adbPath = '/usr/bin/adb',
} = {}) {
  const calls = { spawn: [], approvals: [] }
  const state = { devicesOut, getpropOut }
  const services = {
    fs: fakeFs({ files: { ...APPLE_FILES, [`${ROOT}/app.apk`]: 128, ...(files ?? {}) } }),
    sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: ROOT, sessionId: 's1' }) },
    approval: { async request(request) { calls.approvals.push(request); return approval } },
    sandbox: { async confine(argv) { return { argv: [...argv], enforcement: 'full', denialSignatures: [] } } },
    subprocess: {
      async terminalEnvironment() { return { platform: 'posix' } },
      async resolveExecutable(command) { return command },
      spawn(spec) {
        calls.spawn.push(spec)
        const isGetprop = spec.argv.includes('getprop')
        const isDevices = spec.argv.includes('devices')
        const isDumpsys = spec.argv.includes('dumpsys')
        const text = isGetprop ? state.getpropOut : isDevices ? state.devicesOut
          : isDumpsys ? 'mResumedActivity: ActivityRecord{x u0 com.example.app/.MainActivity t1}' : 'Success'
        return {
          done: Promise.resolve({ exitCode, signal: null }), terminate() {}, async waitForExit() { return true },
          collected: {
            stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          },
        }
      },
    },
  }
  const tools = {}
  const ctx = { get: (name) => services[name], tools: { register: (tool) => { tools[tool.name] = tool; return () => {} } }, effect: () => () => {} }
  // 传 null 表示"显式不配置"（传 undefined 会命中默认参数）。
  const config = resolveExecutionConfig({
    execution: { enabled, ...(adbPath === null ? {} : { adbPath }) },
  })
  registerAndroidExecutionTools(ctx, () => config)
  const exec = { agent: { id: 'caller-a', session: { header: { id: 'caller-a', cwd: ROOT } } }, callId: 'call-1', signal: new AbortController().signal }
  return { calls, tools, exec, state }
}

test('执行工具始终注册；未配置 adb 时设备工具在调用时失败关闭', async () => {
  const withAdb = harness()
  assert.equal(typeof withAdb.tools[DEVICE_TOOL]?.execute, 'function')

  const unconfigured = harness({ adbPath: null })
  assert.equal(typeof unconfigured.tools[DEVICE_TOOL]?.execute, 'function')
  const value = await unconfigured.tools[DEVICE_TOOL].execute({ action: 'discover', serial: 'emulator-5554' }, unconfigured.exec)
  assert.equal(value.status, 'blocked')
  assert.equal(value.error.code, 'CAPABILITY_UNAVAILABLE')
  assert.match(value.error.message, /adbPath/)
  assert.equal(unconfigured.calls.spawn.length, 0)
  assert.equal(unconfigured.calls.approvals.length, 0)
})

test('未启用执行时六个工具都在，但全部失败关闭且零副作用', async () => {
  const h = harness({ enabled: false })
  const cases = [
    [PROJECT_TOOL, { action: 'discover-build' }],
    [BUILD_TOOL, { action: 'build', observationId: 'x', module: ':app', variant: 'debug' }],
    [DEVICE_TOOL, { action: 'discover', serial: 'emulator-5554' }],
    [EMULATOR_TOOL, { action: 'list' }],
    ['satellite_android_journey', { serial: 's', observationId: 'o', applicationId: 'com.example.app', steps: [{ action: 'tap', x: 1, y: 2 }] }],
    ['satellite_android_capture', { action: 'logcat', serial: 's', observationId: 'o', durationSeconds: 5, output: 'a.txt' }],
  ]
  for (const [name, args] of cases) {
    assert.equal(typeof h.tools[name]?.execute, 'function', `${name} 应已注册`)
    const value = await h.tools[name].execute(args, h.exec)
    assert.equal(value.status, 'blocked', `${name} 应失败关闭`)
    assert.equal(value.error.code, 'CAPABILITY_UNAVAILABLE')
    assert.match(value.error.message, /not enabled/)
  }
  assert.equal(h.calls.spawn.length, 0)
  assert.equal(h.calls.approvals.length, 0)
})

test('配置按每次调用读取：设置变化立即生效，无需重新注册（volatile 语义）', async () => {
  let config = resolveExecutionConfig({ execution: { enabled: false, adbPath: '/usr/bin/adb' } })
  const tools = {}
  const spawned = { count: 0 }
  const services = {
    fs: fakeFs(),
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: ROOT, sessionId: 's1' }) },
    approval: { async request() { return 'allowed-once' } },
    sandbox: { async confine(argv) { return { argv: [...argv], enforcement: 'full', denialSignatures: [] } } },
    subprocess: {
      async terminalEnvironment() { return { platform: 'posix' } },
      async resolveExecutable(c) { return c },
      spawn() { spawned.count += 1; throw new Error('should not spawn while disabled') },
    },
  }
  const ctx = { get: (name) => services[name], tools: { register: (tool) => { tools[tool.name] = tool; return () => {} } }, effect: () => () => {} }
  registerAndroidExecutionTools(ctx, () => config)
  const exec = { agent: { id: 'a', session: { header: { id: 'a', cwd: ROOT } } }, callId: 'c', signal: new AbortController().signal }

  const disabled = await tools[DEVICE_TOOL].execute({ action: 'discover', serial: 'emulator-5554' }, exec)
  assert.match(disabled.error.message, /not enabled/)
  assert.equal(spawned.count, 0)

  // 只改闭包里的配置值，不重新注册：下一次调用立刻按新值判定（不会报 not enabled）。
  config = resolveExecutionConfig({ execution: { enabled: true, adbPath: '/usr/bin/adb' } })
  const enabled = await tools[DEVICE_TOOL].execute({ action: 'discover', serial: 'emulator-5554' }, exec)
  assert.doesNotMatch(String(enabled.error?.message ?? ''), /not enabled/)
})

test('discover 需要批准，且不替调用方挑设备', async () => {
  const h = harness()
  const missing = await h.tools[DEVICE_TOOL].execute({ action: 'discover' }, h.exec)
  assert.equal(missing.status, 'blocked')
  assert.equal(missing.error.code, 'ARGUMENT_INVALID')
  assert.equal(h.calls.spawn.length, 0)

  const value = await h.tools[DEVICE_TOOL].execute({ action: 'discover', serial: 'emulator-5554' }, h.exec)
  assert.equal(value.status, 'succeeded')
  assert.equal(value.identity.serial, 'emulator-5554')
  assert.equal(value.identity.transportId, '1')
  assert.equal(value.identity.bootSerial, 'emulator-5554')
  assert.equal(h.calls.approvals.length, 1)
  assert.match(h.calls.approvals[0].reason, /adb devices -l/)
})

test('未连接或未授权的设备明确不可用，而不是退回别的设备', async () => {
  const h = harness()
  const absent = await h.tools[DEVICE_TOOL].execute({ action: 'discover', serial: 'NOT-THERE' }, h.exec)
  assert.equal(absent.status, 'blocked')
  assert.equal(absent.error.code, 'TARGET_REQUIRED')

  const unauthorized = await h.tools[DEVICE_TOOL].execute({ action: 'discover', serial: 'R58M12345' }, h.exec)
  assert.equal(unauthorized.status, 'blocked')
  assert.match(unauthorized.error.message, /unauthorized/)
})

test('设备不报告任何 serial 属性时身份不可用', async () => {
  const h = harness({ getpropOut: '[ro.build.fingerprint]: [x]\n' })
  const value = await h.tools[DEVICE_TOOL].execute({ action: 'discover', serial: 'emulator-5554' }, h.exec)
  assert.equal(value.status, 'blocked')
  assert.match(value.error.message, /ro\.boot\.serialno/)
})

test('install 需要观测 id、复核设备并在批准后安装指定产物', async () => {
  const h = harness()
  const noObservation = await h.tools[DEVICE_TOOL].execute(
    { action: 'install', serial: 'emulator-5554', observationId: 'obs-x', artifact: 'app.apk' }, h.exec)
  assert.equal(noObservation.status, 'blocked')
  assert.equal(noObservation.error.code, 'TARGET_REQUIRED')

  const discovered = await h.tools[DEVICE_TOOL].execute({ action: 'discover', serial: 'emulator-5554' }, h.exec)
  const before = h.calls.spawn.length
  const installed = await h.tools[DEVICE_TOOL].execute({
    action: 'install', serial: 'emulator-5554', observationId: discovered.observationId, artifact: 'app.apk',
  }, h.exec)
  assert.equal(installed.status, 'succeeded')
  const install = h.calls.spawn.slice(before).find((spec) => spec.argv.includes('install'))
  assert.deepEqual(install.argv, ['/usr/bin/adb', '-s', 'emulator-5554', 'install', '-r', `${ROOT}/app.apk`])
  // 安装前做过一次设备复核（devices + getprop）。
  const reprobe = h.calls.spawn.slice(before).filter((spec) => spec.argv.includes('devices'))
  assert.equal(reprobe.length, 1)
  assert.equal(installed.evidence[0].digest, createHash('sha256').update(Buffer.from('apk-bytes')).digest('hex'))
})

test('批准后设备被换掉（transport 变化）则不执行安装', async () => {
  const h = harness()
  const discovered = await h.tools[DEVICE_TOOL].execute({ action: 'discover', serial: 'emulator-5554' }, h.exec)
  assert.equal(discovered.status, 'succeeded')
  // 复核时同一 serial 换了 transport：必须当成不同实例。
  h.state.devicesOut = DEVICES_L.replace('transport_id:1', 'transport_id:7')
  const before = h.calls.spawn.length
  const installed = await h.tools[DEVICE_TOOL].execute({
    action: 'install', serial: 'emulator-5554', observationId: discovered.observationId, artifact: 'app.apk',
  }, h.exec)
  assert.equal(installed.status, 'blocked')
  assert.equal(installed.error.code, 'TARGET_CHANGED')
  assert.match(installed.error.message, /transport changed/)
  assert.equal(h.calls.spawn.slice(before).some((spec) => spec.argv.includes('install')), false)
})

test('批准后设备不可见同样拒绝，并且不留下锁', async () => {
  const h = harness()
  const discovered = await h.tools[DEVICE_TOOL].execute({ action: 'discover', serial: 'emulator-5554' }, h.exec)
  h.state.devicesOut = 'List of devices attached\n'
  const attempted = await h.tools[DEVICE_TOOL].execute({
    action: 'launch', serial: 'emulator-5554', observationId: discovered.observationId, applicationId: 'com.example.app',
  }, h.exec)
  assert.equal(attempted.status, 'blocked')
  assert.equal(attempted.error.code, 'TARGET_CHANGED')
  // 锁已释放：同一目标可以再次进入准备阶段（这里设备仍不可见，所以仍是拒绝而不是 busy）。
  const again = await h.tools[DEVICE_TOOL].execute({
    action: 'launch', serial: 'emulator-5554', observationId: discovered.observationId, applicationId: 'com.example.app',
  }, h.exec)
  assert.equal(again.error.code, 'TARGET_CHANGED')
  assert.doesNotMatch(again.error.message, /already using/)
})

test('launch 与 foreground 各自映射到确切 adb 子命令，前台不符即失败', async () => {
  const h = harness()
  const discovered = await h.tools[DEVICE_TOOL].execute({ action: 'discover', serial: 'emulator-5554' }, h.exec)
  const before = h.calls.spawn.length
  const launched = await h.tools[DEVICE_TOOL].execute({
    action: 'launch', serial: 'emulator-5554', observationId: discovered.observationId, applicationId: 'com.example.app',
  }, h.exec)
  assert.equal(launched.status, 'succeeded')
  const launch = h.calls.spawn.slice(before).find((spec) => spec.argv.includes('monkey'))
  assert.deepEqual(launch.argv, [
    '/usr/bin/adb', '-s', 'emulator-5554', 'shell', 'monkey', '-p', 'com.example.app',
    '-c', 'android.intent.category.LAUNCHER', '1',
  ])

  const foreground = await h.tools[DEVICE_TOOL].execute({
    action: 'foreground', serial: 'emulator-5554', observationId: discovered.observationId, applicationId: 'com.example.app',
  }, h.exec)
  assert.equal(foreground.status, 'succeeded')
  assert.equal(foreground.foreground, 'com.example.app')

  const other = await h.tools[DEVICE_TOOL].execute({
    action: 'foreground', serial: 'emulator-5554', observationId: discovered.observationId, applicationId: 'com.other.app',
  }, h.exec)
  assert.equal(other.status, 'failed')
  assert.match(other.error.message, /not the foreground package/)
})

test('同一目标的并发操作立即 busy，不排队', async () => {
  const h = harness()
  const discovered = await h.tools[DEVICE_TOOL].execute({ action: 'discover', serial: 'emulator-5554' }, h.exec)
  const lock = createDeviceLock()
  const key = lockKey(discovered.identity)
  lock.tryAcquire(key)
  const deps = {
    services: {
      sandbox: { async confine(argv) { return { argv: [...argv], enforcement: 'full', denialSignatures: [] } } },
      subprocess: { async terminalEnvironment() { return { platform: 'posix' } }, async resolveExecutable(c) { return c }, spawn() { throw new Error('must not spawn') } },
      approval: { async request() { return 'allowed-once' } },
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: ROOT, sessionId: 's1' }) },
    },
    binding: { root: ROOT, mode: 'workspace-write', workspaceRoot: ROOT, sessionId: 's1' },
    exec: h.exec,
    config: { adbPath: '/usr/bin/adb', operationTimeoutMs: 1000, outputMaxBytes: 1024 },
  }
  const store = createDeviceObservationStore(() => Date.now(), () => 'obs-lock')
  const observation = store.put('caller-a', discovered.identity, identityDigest(sha, discovered.identity))
  const result = await prepareDeviceAction(deps, lock, store, {
    action: 'install', serial: 'emulator-5554', observationId: observation.id, artifact: 'app.apk',
  }, { mode: 'workspace-write', workspaceRoot: ROOT, sessionId: 's1' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.outcome.error.message, /already using/)
})

test('观测缺失或过期时变更动作被拒', async () => {
  let now = 1000
  const store = createDeviceObservationStore(() => now, () => 'obs-1', 50)
  const lock = createDeviceLock()
  const deps = {
    services: {
      sandbox: { async confine(argv) { return { argv: [...argv], enforcement: 'full', denialSignatures: [] } } },
      subprocess: { async terminalEnvironment() { return { platform: 'posix' } }, async resolveExecutable(c) { return c }, spawn() { throw new Error('must not spawn') } },
      approval: { async request() { return 'allowed-once' } },
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: ROOT, sessionId: 's1' }) },
    },
    binding: { root: ROOT, mode: 'workspace-write', workspaceRoot: ROOT, sessionId: 's1' },
    exec: { agent: { id: 'caller-a', session: {} }, signal: new AbortController().signal },
    config: { adbPath: '/usr/bin/adb', operationTimeoutMs: 1000, outputMaxBytes: 1024 },
  }
  const unknown = await prepareDeviceAction(deps, lock, store, {
    action: 'launch', serial: 's', observationId: 'nope', applicationId: 'com.example.app',
  }, { mode: 'workspace-write', workspaceRoot: ROOT, sessionId: 's1' })
  assert.equal(unknown.ok, false)
  if (!unknown.ok) assert.equal(unknown.outcome.error.code, 'TARGET_REQUIRED')

  const observation = store.put('caller-a', identity(), 'd')
  now = 2000
  const expired = await prepareDeviceAction(deps, lock, store, {
    action: 'launch', serial: 'emulator-5554', observationId: observation.id, applicationId: 'com.example.app',
  }, { mode: 'workspace-write', workspaceRoot: ROOT, sessionId: 's1' })
  assert.equal(expired.ok, false)
  if (!expired.ok) assert.equal(expired.outcome.error.code, 'TARGET_CHANGED')
})

test('观测一台设备时只接受指定 serial，多个匹配视为歧义', async () => {
  const duplicated = [
    'List of devices attached',
    'emulator-5554          device transport_id:1',
    'emulator-5554          device transport_id:9',
    '',
  ].join('\n')
  const h = harness({ devicesOut: duplicated })
  const value = await h.tools[DEVICE_TOOL].execute({ action: 'discover', serial: 'emulator-5554' }, h.exec)
  assert.equal(value.status, 'blocked')
  assert.equal(value.error.code, 'TARGET_AMBIGUOUS')
})

test('observeDevice 在没有设备时不返回任何 identity', async () => {
  const empty = 'List of devices attached\n'
  const value = await observeDevice({
    services: {
      sandbox: { async confine(argv) { return { argv: [...argv], enforcement: 'full', denialSignatures: [] } } },
      subprocess: {
        async terminalEnvironment() { return { platform: 'posix' } },
        async resolveExecutable(command) { return command },
        spawn() {
          return {
            done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {}, async waitForExit() { return true },
            collected: {
              stdout: { readFrom: () => ({ text: empty, nextOffset: empty.length, lossy: false }) },
              stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
            },
          }
        },
      },
      approval: { async request() { return 'allowed-once' } },
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: ROOT, sessionId: 's1' }) },
    },
    binding: { root: ROOT, mode: 'workspace-write', workspaceRoot: ROOT, sessionId: 's1' },
    exec: { agent: { id: 'a', session: {} }, signal: new AbortController().signal },
    config: { adbPath: '/usr/bin/adb', operationTimeoutMs: 1000, outputMaxBytes: 1024 },
  }, 'emulator-5554', 'gen')
  assert.equal(value.ok, false)
  if (!value.ok) assert.equal(value.outcome.error.code, 'TARGET_REQUIRED')
})

test('旅程与采集必须绑定已观测设备，缺观测 id 时零进程（目标绑定回归）', async () => {
  const h = harness()
  // 缺 observationId 现在由工具层 schema 直接拒绝（defineTool 会校验必填参数）。
  await assert.rejects(h.tools.satellite_android_journey.execute({
    serial: 'emulator-5554', applicationId: 'com.example.app',
    steps: [{ action: 'tap', x: 10, y: 20 }],
  }, h.exec), /missing required property "observationId"/)

  await assert.rejects(h.tools.satellite_android_capture.execute({
    action: 'logcat', serial: 'emulator-5554', durationSeconds: 5, output: 'logs/cat.txt',
  }, h.exec), /missing required property "observationId"/)
  assert.equal(h.calls.spawn.length, 0)
  assert.equal(h.calls.approvals.length, 0)

  // 传了未知 id 时由处理逻辑失败关闭（不启动任何设备命令）。
  const unknown = await h.tools.satellite_android_journey.execute({
    serial: 'emulator-5554', observationId: 'obs-unknown', applicationId: 'com.example.app',
    steps: [{ action: 'tap', x: 10, y: 20 }],
  }, h.exec)
  assert.equal(unknown.status, 'blocked')
  assert.equal(unknown.error.code, 'TARGET_REQUIRED')
  assert.equal(h.calls.spawn.length, 0)
})

test('旅程在设备被换掉后拒绝执行，且不启动任何 adb 动作（目标绑定回归）', async () => {
  const h = harness()
  const discovered = await h.tools[DEVICE_TOOL].execute({ action: 'discover', serial: 'emulator-5554' }, h.exec)
  h.state.devicesOut = DEVICES_L.replace('transport_id:1', 'transport_id:9')
  const before = h.calls.spawn.length
  const journey = await h.tools.satellite_android_journey.execute({
    serial: 'emulator-5554', observationId: discovered.observationId,
    applicationId: 'com.example.app', steps: [{ action: 'tap', x: 10, y: 20 }],
  }, h.exec)
  assert.equal(journey.status, 'blocked')
  assert.equal(journey.error.code, 'TARGET_CHANGED')
  assert.match(journey.error.message, /transport changed/)
  const after = h.calls.spawn.slice(before)
  assert.equal(after.some((spec) => spec.argv.includes('input')), false)
})

test('旅程在观测有效时执行，并释放互斥锁（目标绑定回归）', async () => {
  const h = harness()
  const discovered = await h.tools[DEVICE_TOOL].execute({ action: 'discover', serial: 'emulator-5554' }, h.exec)
  const before = h.calls.spawn.length
  const journey = await h.tools.satellite_android_journey.execute({
    serial: 'emulator-5554', observationId: discovered.observationId,
    applicationId: 'com.example.app', steps: [{ action: 'tap', x: 10, y: 20 }],
  }, h.exec)
  assert.equal(journey.status, 'succeeded', JSON.stringify(journey))
  const tap = h.calls.spawn.slice(before).find((spec) => spec.argv.includes('input'))
  assert.deepEqual(tap.argv, ['/usr/bin/adb', '-s', 'emulator-5554', 'shell', 'input', 'tap', '10', '20'])
  // 锁已释放：同一设备可以再次进入准备阶段。
  const again = await h.tools.satellite_android_journey.execute({
    serial: 'emulator-5554', observationId: discovered.observationId,
    applicationId: 'com.example.app', steps: [{ action: 'tap', x: 11, y: 21 }],
  }, h.exec)
  assert.equal(again.status, 'succeeded')
  assert.doesNotMatch(String(again.error?.message ?? ''), /already using/)
})

test('无效观测 id 不会先发出批准请求（A5 回归）', async () => {
  const h = harness()
  const journey = await h.tools.satellite_android_journey.execute({
    serial: 'emulator-5554', observationId: 'obs-does-not-exist',
    applicationId: 'com.example.app', steps: [{ action: 'tap', x: 1, y: 2 }],
  }, h.exec)
  assert.equal(journey.status, 'blocked')
  assert.equal(journey.error.code, 'TARGET_REQUIRED')
  assert.equal(h.calls.approvals.length, 0, '观测无效时不应请求批准')

  const capture = await h.tools.satellite_android_capture.execute({
    action: 'logcat', serial: 'emulator-5554', observationId: 'obs-does-not-exist',
    durationSeconds: 5, output: 'logs/cat.txt',
  }, h.exec)
  assert.equal(capture.error.code, 'TARGET_REQUIRED')
  assert.equal(h.calls.approvals.length, 0)

  const device = await h.tools[DEVICE_TOOL].execute({
    action: 'launch', serial: 'emulator-5554', observationId: 'obs-does-not-exist', applicationId: 'com.example.app',
  }, h.exec)
  assert.equal(device.error.code, 'TARGET_REQUIRED')
  assert.equal(h.calls.approvals.length, 0)
})

test('批准理由引用已核对的目标，而不是模型给的 serial（A5 回归）', async () => {
  const h = harness()
  const discovered = await h.tools[DEVICE_TOOL].execute({ action: 'discover', serial: 'emulator-5554' }, h.exec)
  const launches = h.calls.approvals.length
  const journey = await h.tools.satellite_android_journey.execute({
    serial: 'emulator-5554', observationId: discovered.observationId,
    applicationId: 'com.example.app', steps: [{ action: 'tap', x: 1, y: 2 }],
  }, h.exec)
  assert.equal(journey.status, 'succeeded')
  const reason = h.calls.approvals[launches].reason
  assert.match(reason, /Verified target: emulator-5554/)
  assert.match(reason, /transport 1/)
})

test('同一目标被占用时旅程/采集的准备阶段立即 busy，不排队（工具级并发回归）', async () => {
  const { createDeviceLock, createDeviceObservationStore, identityDigest, lockKey, prepareObservedTarget } =
    await import('../lib/android/lib/execution/device.js')
  const lock = createDeviceLock()
  const store = createDeviceObservationStore(() => Date.now(), () => 'obs-busy')
  const identity = {
    world: 'host-shared-v1', adbPath: '/usr/bin/adb', serverEndpoint: 'default', generation: 'g',
    serial: 'emulator-5554', transportId: '1', state: 'device', bootSerial: 'emulator-5554', buildFingerprint: 'fp',
  }
  const observation = store.put('caller-a', identity, identityDigest((value) => String(value).length, identity))
  // 模拟另一个动作已经持有该目标。
  assert.equal(lock.tryAcquire(lockKey(identity)), true)
  const deps = {
    services: {
      sandbox: { async confine(argv) { return { argv: [...argv], enforcement: 'full', denialSignatures: [] } } },
      subprocess: { async terminalEnvironment() { return { platform: 'posix' } }, async resolveExecutable(c) { return c }, spawn() { throw new Error('必须不 spawn') } },
      approval: { async request() { return 'allowed-once' } },
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: ROOT, sessionId: 's1' }) },
    },
    binding: { root: ROOT, mode: 'workspace-write', workspaceRoot: ROOT, sessionId: 's1' },
    exec: { agent: { id: 'caller-a', session: {} }, signal: new AbortController().signal },
    config: { adbPath: '/usr/bin/adb', operationTimeoutMs: 1000, outputMaxBytes: 1024 },
  }
  for (const action of ['journey', 'capture']) {
    const result = await prepareObservedTarget(deps, lock, store, {
      action, serial: 'emulator-5554', observationId: observation.id,
    }, { mode: 'workspace-write', workspaceRoot: ROOT, sessionId: 's1' })
    assert.equal(result.ok, false, `${action} 应被占用拒绝`)
    if (!result.ok) {
      assert.equal(result.outcome.error.code, 'TARGET_CHANGED')
      assert.match(result.outcome.error.message, /already using/)
    }
  }
})
