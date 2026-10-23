import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EMULATOR_TOOL, adbSerials, createOwnedResources, describeEmulatorPlan, newEmulatorSerial,
  parseAvdList, parseEmulatorRequest, startEmulator,
} from '../lib/android/lib/execution/emulator.js'
import { resolveExecutionConfig } from '../lib/android/index.js'
import { registerAndroidExecutionTools } from '../lib/android/lib/execution/tools.js'

const ROOT = '/project'
const ADB = '/usr/bin/adb'
const EMULATOR = '/opt/android/emulator/emulator'
// 测试 fixtures 显式构造 Apple 宿主，而不是依赖运行测试的机器平台。
const APPLE_FILES = {
  '/System/Library/CoreServices/SystemVersion.plist': 1,
  '/usr/bin/sw_vers': 1,
}

function emulatorConfig(extra = {}) {
  return resolveExecutionConfig({
    execution: { enabled: true, adbPath: ADB, emulatorPath: EMULATOR, avdmanagerPath: '/opt/android/cmdline-tools/avdmanager', bootPollIntervalMs: 5, ...extra },
  })
}

/* --------------------------------------------------------------- 纯解析 */

test('AVD 名称解析忽略日志行与重复项', () => {
  assert.deepEqual(parseAvdList('Pixel_6_API_34\nINFO | ignore me\nPixel_6_API_34\ntablet_x86\n'), ['Pixel_6_API_34', 'tablet_x86'])
  assert.deepEqual(parseAvdList(''), [])
  assert.deepEqual(parseAvdList('ERROR | something\n'), [])
})

test('新出现的 emulator serial 必须唯一，否则不猜', () => {
  assert.equal(newEmulatorSerial(['emulator-5554'], ['emulator-5554', 'emulator-5556']), 'emulator-5556')
  assert.equal(newEmulatorSerial([], ['emulator-5554', 'emulator-5556']), undefined)
  assert.equal(newEmulatorSerial(['emulator-5554'], ['emulator-5554']), undefined)
  assert.equal(newEmulatorSerial([], ['R58M12345']), undefined)
  assert.deepEqual(adbSerials('List of devices attached\nemulator-5554\tdevice\nR58 unauthorized\n'), ['emulator-5554', 'R58'])
})

test('模拟器请求严格校验：stop 必须二选一，create 不接受未安装镜像', () => {
  assert.deepEqual(parseEmulatorRequest({ action: 'list' }), { action: 'list' })
  assert.throws(() => parseEmulatorRequest({ action: 'list', avd: 'x' }), /takes no other arguments/)
  assert.throws(() => parseEmulatorRequest({ action: 'stop' }), /exactly one of/)
  assert.throws(() => parseEmulatorRequest({ action: 'stop', serial: 's', ownedResourceId: 'o' }), /exactly one of/)
  assert.deepEqual(parseEmulatorRequest({ action: 'stop', serial: 'emulator-5554' }), { action: 'stop', serial: 'emulator-5554' })
  assert.throws(() => parseEmulatorRequest({ action: 'start', avd: '../escape' }), /plain AVD name/)
  assert.deepEqual(parseEmulatorRequest({ action: 'start', avd: 'pixel' }), { action: 'start', avd: 'pixel' })
  assert.throws(() => parseEmulatorRequest({ action: 'create', avd: 'pixel', installedSystemImage: 'system images', deviceProfile: 'p' }), /already installed SDK package id/)
  assert.throws(() => parseEmulatorRequest({ action: 'delete', avd: 'pixel', serial: 's' }), /takes only avd/)
  assert.deepEqual(parseEmulatorRequest({ action: 'create', avd: 'pixel', installedSystemImage: 'system-images;android-34;google_apis;x86_64', deviceProfile: 'pixel_6' }), {
    action: 'create', avd: 'pixel', installedSystemImage: 'system-images;android-34;google_apis;x86_64', deviceProfile: 'pixel_6',
  })
  assert.throws(() => parseEmulatorRequest({ action: 'start', avd: 'pixel', startupTimeoutMs: 1 }), /between 10000 and 1800000/)
  assert.deepEqual(parseEmulatorRequest({ action: 'start', avd: 'Pixel_6', startupTimeoutMs: 60000 }), { action: 'start', avd: 'Pixel_6', startupTimeoutMs: 60000 })
})

test('批准理由说清常驻进程与不下载任何东西', () => {
  assert.match(describeEmulatorPlan({ action: 'start', avd: 'Pixel_6' }), /keeps running after this call/)
  assert.match(describeEmulatorPlan({ action: 'create', avd: 'a', installedSystemImage: 'x', deviceProfile: 'p' }), /Nothing is downloaded/)
  assert.match(describeEmulatorPlan({ action: 'stop', serial: 'emulator-5554' }), /does NOT claim ownership/)
  assert.match(describeEmulatorPlan({ action: 'stop', ownedResourceId: 'owned-1' }), /this component started/)
  assert.match(describeEmulatorPlan({ action: 'delete', avd: 'a' }), /removes the AVD definition/)
})

/* --------------------------------------------------- 所有权与幂等关闭 */

function fakeHandle() {
  const state = { terminated: 0, waited: 0 }
  return {
    state,
    handle: {
      terminate() { state.terminated += 1 },
      async waitForExit() { state.waited += 1; return true },
    },
  }
}

test('关闭是幂等的：并发 stop、owner 退出与卸载只终止一次且都等待', async () => {
  const resources = createOwnedResources()
  const first = fakeHandle()
  resources.adopt({ id: 'owned-1', ownerId: 'agent-a', avd: 'Pixel_6', serial: 'emulator-5554', handle: first.handle, ownerController: new AbortController() })
  const [a, b, c] = await Promise.all([resources.close('owned-1'), resources.close('owned-1'), resources.closeOwner('agent-a')])
  assert.equal(first.state.terminated, 1)
  assert.equal(first.state.waited, 1)
  assert.equal(a, 'completed')
  assert.equal(b, 'completed')
  assert.equal(c, 'completed')
  assert.equal(resources.size(), 0)
})

test('owned 记录按 owner 隔离：别人的 id 拿不到', () => {
  const resources = createOwnedResources()
  const handle = fakeHandle()
  resources.adopt({ id: 'owned-1', ownerId: 'agent-a', avd: 'Pixel_6', serial: 'emulator-5554', handle: handle.handle, ownerController: new AbortController() })
  assert.equal(resources.get('owned-1', 'agent-a')?.serial, 'emulator-5554')
  assert.equal(resources.get('owned-1', 'agent-b'), undefined)
  assert.equal(resources.get('owned-missing', 'agent-a'), undefined)
})

test('卸载时拒绝新的所有权转移，并要求调用方在本调用内清理', async () => {
  const resources = createOwnedResources()
  const handle = fakeHandle()
  resources.adopt({ id: 'owned-1', ownerId: 'agent-a', avd: 'Pixel_6', serial: 'emulator-5554', handle: handle.handle, ownerController: new AbortController() })
  await resources.closeAll()
  assert.throws(() => resources.adopt({
    id: 'owned-2', ownerId: 'agent-a', avd: 'Pixel_7', serial: 'emulator-5556', handle: handle.handle, ownerController: new AbortController(),
  }), /closing/)
})

test('清理超时算失败，不无限等待', async () => {
  const resources = createOwnedResources(20)
  resources.adopt({
    id: 'owned-slow', ownerId: 'agent-a', avd: 'Pixel_6', serial: 'emulator-5554',
    handle: { terminate() {}, waitForExit: () => new Promise(() => {}) },
    ownerController: new AbortController(),
  })
  assert.equal(await resources.close('owned-slow'), 'failed')
})

/* --------------------------------------------------------- 工具级流程 */

function harness({ approval = 'allowed-once', bootSequence = [true], bootNever = false, listOut = 'Pixel_6_API_34\n', emulatorPath = EMULATOR } = {}) {
  const calls = { spawn: [], approvals: [], boot: 0, effects: [] }
  let devicesCall = 0
  const services = {
    fs: {
      async resolve(path, options = {}) {
        const base = options.cwd ?? ROOT
        const absolute = path.startsWith('/') ? path : `${base}/${path}`
        return { targetKey: absolute, displayPath: absolute }
      },
      async stat(target) {
        if (target.targetKey in APPLE_FILES) return { type: 'file', size: 1 }
        return target.targetKey === ROOT ? { type: 'directory' } : undefined
      },
      async listDir() { return [] },
      processPath: (target) => target.targetKey,
      processPathFromHostPath: (hostPath) => hostPath,
      async readBytes() { return Buffer.from('x') },
    },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: ROOT, sessionId: 's1' }) },
    approval: { async request(request) { calls.approvals.push(request); return approval } },
    sandbox: { async confine(argv) { return { argv: [...argv], enforcement: 'full', denialSignatures: [] } } },
    subprocess: {
      async terminalEnvironment() { return { platform: 'posix' } },
      async resolveExecutable(command) { return command },
      spawn(spec) {
        calls.spawn.push(spec)
        const oneShot = (text) => ({
          done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {}, async waitForExit() { return true },
          collected: {
            stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          },
        })
        if (spec.argv.includes('-list-avds')) {
          return oneShot(listOut)
        }
        if (spec.argv.includes('devices')) {
          devicesCall += 1
          const text = devicesCall === 1 ? 'List of devices attached\n' : 'List of devices attached\nemulator-5554\tdevice\n'
          return oneShot(text)
        }
        if (spec.argv.includes('getprop')) {
          calls.boot += 1
          const ready = bootNever ? false : (bootSequence[Math.min(calls.boot - 1, bootSequence.length - 1)] ?? true)
          return oneShot(ready ? '1\n' : '0\n')
        }
        if (!spec.argv.includes('-avd')) {
          // 其它 adb 子命令（emu kill 等）：一次性结束。
          return oneShot('OK\n')
        }
        // 模拟器进程本身：常驻，直到被 terminate。
        return {
          done: new Promise((resolve) => {
            spec.signal?.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true })
          }),
          terminate() { calls.effects.push('terminate') },
          async waitForExit() { calls.effects.push('wait'); return true },
          collected: { stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
        }
      },
    },
  }
  const tools = {}
  const disposers = []
  const ctx = {
    get: (name) => services[name],
    tools: { register: (tool) => { tools[tool.name] = tool; return () => {} } },
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
  }
  registerAndroidExecutionTools(ctx, () => emulatorConfig(emulatorPath === null ? { emulatorPath: undefined } : { emulatorPath }))
  const exec = {
    agent: { id: 'caller-a', session: { header: { id: 'caller-a', cwd: ROOT } } },
    callId: 'call-1',
    signal: new AbortController().signal,
  }
  return { calls, tools, exec, disposers, services }
}

test('模拟器工具始终注册；未配置 emulator 路径时调用即失败关闭', async () => {
  const h = harness({ emulatorPath: null })
  assert.equal(typeof h.tools[EMULATOR_TOOL]?.execute, 'function')
  const value = await h.tools[EMULATOR_TOOL].execute({ action: 'list' }, h.exec)
  assert.equal(value.status, 'blocked')
  assert.equal(value.error.code, 'CAPABILITY_UNAVAILABLE')
  assert.match(value.error.message, /emulatorPath/)
  assert.equal(h.calls.spawn.length, 0)
  assert.equal(h.calls.approvals.length, 0)
})

test('unsupported 宿主上模拟器工具零批准零进程', async () => {
  const h = harness()
  h.services.fs.stat = async (target) => {
    if (target.targetKey === ROOT) return { type: 'directory' }
    return undefined
  }
  const value = await h.tools[EMULATOR_TOOL].execute({ action: 'list' }, h.exec)
  assert.equal(value.status, 'blocked')
  assert.equal(value.error.code, 'CAPABILITY_UNAVAILABLE')
  assert.match(value.error.message, /no supported host marker matched/)
  assert.equal(h.calls.approvals.length, 0)
  assert.equal(h.calls.spawn.length, 0)
})

test('list 需要批准并返回解析后的 AVD 名称', async () => {
  const h = harness()
  const value = await h.tools[EMULATOR_TOOL].execute({ action: 'list' }, h.exec)
  assert.equal(value.status, 'succeeded')
  assert.deepEqual(value.evidence.map((entry) => entry.source), ['Pixel_6_API_34'])
  assert.equal(h.calls.approvals.length, 1)
  assert.equal(h.calls.approvals[0].toolName, EMULATOR_TOOL)
})

test('start 在 boot-ready 后转移所有权，并返回不透明 ownedResourceId', async () => {
  const h = harness()
  const started = await h.tools[EMULATOR_TOOL].execute({ action: 'start', avd: 'Pixel_6_API_34', startupTimeoutMs: 10000 }, h.exec)
  assert.equal(started.status, 'succeeded')
  assert.equal(started.cleanup, 'retained-owned')
  assert.equal(started.serial, 'emulator-5554')
  // 不透明 id：不含 AVD 名或 serial。
  assert.match(started.ownedResourceId, /^owned-[0-9a-f-]{36}$/)
  assert.doesNotMatch(started.ownedResourceId, /Pixel_6_API_34|emulator-5554/)
  // 转移后模拟器进程仍然活着：不应该被本调用终止。
  assert.deepEqual(h.calls.effects, [])
  // 显式 stop 关闭它，并且只终止一次。
  const stopped = await h.tools[EMULATOR_TOOL].execute({ action: 'stop', ownedResourceId: started.ownedResourceId }, h.exec)
  assert.equal(stopped.status, 'succeeded')
  assert.deepEqual(h.calls.effects, ['terminate', 'wait'])
})

test('start 超时未 boot 时在本调用内终止并等待，不留下资源', async () => {
  const h = harness({ bootNever: true })
  const started = await h.tools[EMULATOR_TOOL].execute({ action: 'start', avd: 'Pixel_6_API_34', startupTimeoutMs: 10000 }, h.exec)
  assert.equal(started.status, 'failed')
  assert.equal(started.error.code, 'TIMEOUT')
  // 清理结论必须写实：启动过并已终止，不是 not-needed。
  assert.equal(started.cleanup, 'completed')
  assert.deepEqual(h.calls.effects, ['terminate', 'wait'])
  // 没有可停止的 owned 资源。
  const stopped = await h.tools[EMULATOR_TOOL].execute({ action: 'stop', ownedResourceId: 'owned-00000000-0000-0000-0000-000000000000' }, h.exec)
  assert.equal(stopped.error.code, 'TARGET_REQUIRED')
})

test('stop 的 owned 分支只认本会话发过的 id，跨会话/不存在一律拒绝', async () => {
  const h = harness()
  const started = await h.tools[EMULATOR_TOOL].execute({ action: 'start', avd: 'Pixel_6_API_34', startupTimeoutMs: 10000 }, h.exec)
  const other = { ...h.exec, agent: { id: 'caller-b', session: { header: { id: 'caller-b', cwd: ROOT } } } }
  const foreign = await h.tools[EMULATOR_TOOL].execute({ action: 'stop', ownedResourceId: started.ownedResourceId }, other)
  assert.equal(foreign.error.code, 'TARGET_REQUIRED')
  // 原始 owner 仍然可以停止，说明没有被跨会话停掉。
  const stopped = await h.tools[EMULATOR_TOOL].execute({ action: 'stop', ownedResourceId: started.ownedResourceId }, h.exec)
  assert.equal(stopped.status, 'succeeded')
})

test('start 被拒时零进程；external stop 走 serial 且不认所有权', async () => {
  const rejected = harness({ approval: 'rejected' })
  const blockedValue = await rejected.tools[EMULATOR_TOOL].execute({ action: 'start', avd: 'Pixel_6_API_34' }, rejected.exec)
  assert.equal(blockedValue.error.code, 'APPROVAL_REJECTED')
  assert.equal(rejected.calls.spawn.filter((spec) => spec.argv.includes('-avd')).length, 0)

  const h = harness()
  const stopped = await h.tools[EMULATOR_TOOL].execute({ action: 'stop', serial: 'emulator-5554' }, h.exec)
  assert.equal(stopped.status, 'succeeded')
  const kill = h.calls.spawn.at(-1)
  assert.deepEqual(kill.argv, [ADB, '-s', 'emulator-5554', 'emu', 'kill'])
  assert.match(h.calls.approvals.at(-1).reason, /does NOT claim ownership/)
})

test('组件卸载等待所有 owned 资源关闭', async () => {
  const h = harness()
  const started = await h.tools[EMULATOR_TOOL].execute({ action: 'start', avd: 'Pixel_6_API_34', startupTimeoutMs: 10000 }, h.exec)
  assert.equal(started.status, 'succeeded')
  assert.equal(h.disposers.length > 0, true)
  // 触发 Agent 作用域清理（模拟 owner 退出）。
  const dispose = h.disposers.at(-1)
  dispose()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(h.calls.effects, ['terminate', 'wait'])
})

test('startEmulator 在缺少可注册 effect 时由调用方拒绝（单元层验证契约）', async () => {
  const resources = createOwnedResources()
  const h = harness()
  const deps = {
    services: { sandbox: { async confine(argv) { return { argv: [...argv], enforcement: 'full', denialSignatures: [] } } }, subprocess: { async terminalEnvironment() { return { platform: 'posix' } }, async resolveExecutable(c) { return c }, spawn() { throw new Error('no spawn expected') } }, approval: { async request() { return 'allowed-once' } } },
    binding: { root: ROOT, mode: 'workspace-write', workspaceRoot: ROOT, sessionId: 's1' },
    exec: { agent: { id: 'a', session: {} }, signal: new AbortController().signal },
    config: { emulatorPath: EMULATOR, adbPath: ADB, operationTimeoutMs: 1000, outputMaxBytes: 1024, bootPollIntervalMs: 5 },
  }
  // adopt 在卸载后会抛错，startEmulator 必须把它变成失败而不是留下进程。
  await resources.closeAll()
  const result = await startEmulator(deps, { action: 'start', avd: 'Pixel_6_API_34' }, resources, (resource) => resources.adopt(resource))
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(['CAPABILITY_UNAVAILABLE', 'EFFECT_UNKNOWN', 'TIMEOUT'].includes(result.outcome.error.code))
  assert.ok(h)
})

test('组件卸载会等待关闭已启动的模拟器（A1 回归）', async () => {
  const h = harness()
  const started = await h.tools[EMULATOR_TOOL].execute({ action: 'start', avd: 'Pixel_6_API_34', startupTimeoutMs: 10000 }, h.exec)
  assert.equal(started.status, 'succeeded')
  assert.deepEqual(h.calls.effects, [])
  // 触发**组件级** disposer（不是 Agent 作用域那个）：模拟器必须被终止并等待。
  for (const dispose of [...h.disposers].reverse()) {
    const result = dispose()
    if (result && typeof result.then === 'function') await result
  }
  assert.deepEqual(h.calls.effects, ['terminate', 'wait'])
})

test('start 成功后探测失败时，清理结论如实报告而不是 not-needed（A3 回归）', async () => {
  const h = harness()
  // 让 getprop 探测失败（返回非零退出码）。
  const originalSpawn = h.calls.spawn
  const failAfterSpawn = (spec) => {
    if (spec.argv.includes('getprop')) {
      return {
        done: Promise.resolve({ exitCode: 1, signal: null }), terminate() {}, async waitForExit() { return true },
        collected: { stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
      }
    }
    return undefined
  }
  assert.ok(originalSpawn)
  // 重新注册一份：用模块级 startEmulator 直接验证（工具层不便注入部分失败）。
  const { startEmulator, createOwnedResources } = await import('../lib/android/lib/execution/emulator.js')
  const deps = {
    services: {
      sandbox: { async confine(argv) { return { argv: [...argv], enforcement: 'full', denialSignatures: [] } } },
      subprocess: {
        async terminalEnvironment() { return { platform: 'posix' } },
        async resolveExecutable(c) { return c },
        spawn(spec) {
          const failure = failAfterSpawn(spec)
          if (failure) return failure
          if (!spec.argv.includes('-avd')) {
            const text = 'List of devices attached\nemulator-5554\tdevice\n'
            return { done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {}, async waitForExit() { return true },
              collected: { stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } } }
          }
          return {
            done: new Promise((resolve) => { spec.signal?.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true }) }),
            terminate() { h.calls.effects.push('terminate') },
            async waitForExit() { h.calls.effects.push('wait'); return true },
            collected: { stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
          }
        },
      },
      approval: { async request() { return 'allowed-once' } },
    },
    binding: { root: '/project', mode: 'workspace-write', workspaceRoot: '/project', sessionId: 's1' },
    exec: { agent: { id: 'a', session: {} }, signal: new AbortController().signal },
    config: { emulatorPath: '/opt/emulator', adbPath: '/usr/bin/adb', operationTimeoutMs: 1000, outputMaxBytes: 1024, bootPollIntervalMs: 5 },
  }
  const resources = createOwnedResources()
  const result = await startEmulator(deps, { action: 'start', avd: 'Pixel_6_API_34', startupTimeoutMs: 10000 }, resources, (r) => resources.adopt(r))
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.outcome.action, 'emulator.start')
    assert.equal(result.outcome.cleanup, 'completed')
    assert.notEqual(result.outcome.cleanup, 'not-needed')
  }
  assert.deepEqual(h.calls.effects, ['terminate', 'wait'])
})

test('adopt 拒绝同 id 覆盖，不孤立先前的 handle（A4 回归）', () => {
  const resources = createOwnedResources()
  const handle = fakeHandle()
  const resource = { id: 'owned-same', ownerId: 'agent-a', avd: 'Pixel_6', serial: 'emulator-5554', handle: handle.handle, ownerController: new AbortController() }
  resources.adopt(resource)
  assert.throws(() => resources.adopt({ ...resource, avd: 'Other' }), /already exists/)
})

for (const target of ['windows', 'linux', 'unknown']) {
  for (const duringApproval of [false, true]) {
    test(`owned stop ${target} ${duringApproval ? 'during' : 'before'} approval does not bypass gate or abandon unload cleanup`, async () => {
      const h = harness()
      const started = await h.tools[EMULATOR_TOOL].execute({ action: 'start', avd: 'Pixel_6_API_34', startupTimeoutMs: 10000 }, h.exec)
      assert.equal(started.status, 'succeeded', JSON.stringify(started))
      const change = () => {
        h.services.subprocess.terminalEnvironment = async () => ({ platform: target === 'windows' ? 'windows' : 'posix' })
        h.services.fs.stat = async ({ targetKey }) => {
          if (targetKey === ROOT) return { type: 'directory' }
          if (target === 'linux' && targetKey === '/etc/os-release') return { type: 'file' }
          return undefined
        }
      }
      if (duringApproval) h.services.approval.request = async (request) => { h.calls.approvals.push(request); change(); return 'allowed-once' }
      else change()
      h.calls.spawn.length = 0
      h.calls.approvals.length = 0
      const stopped = await h.tools[EMULATOR_TOOL].execute({ action: 'stop', ownedResourceId: started.ownedResourceId }, h.exec)
      assert.equal(stopped.status, 'blocked')
      assert.match(stopped.error.message, /supported host platform/)
      assert.equal(h.calls.spawn.length, 0)
      assert.equal(h.calls.approvals.length, duringApproval ? 1 : 0)
      assert.deepEqual(h.calls.effects, [])
      for (const dispose of h.disposers) await dispose()
      assert.deepEqual(h.calls.effects, ['terminate', 'wait'], 'owned handle cleanup must still run on platform mismatch')
    })
  }
}
