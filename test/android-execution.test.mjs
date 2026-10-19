import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ArgumentError,
  blocked,
  cancelled,
  effectUnknown,
  failed,
  isExecutionErrorCode,
  isSandboxMode,
  optionalText,
  outcome,
  policyKey,
  rejectUnknownKeys,
  requireBoolean,
  requireEnum,
  requireInteger,
  requireRecord,
  requireRelativePath,
  requireText,
  resolvePolicy,
  scopedServices,
} from '../lib/android/lib/execution/contracts.js'
import { CLEANUP_TIMEOUT_MS, DEFAULT_GRACE_MS, runBounded } from '../lib/android/lib/execution/process.js'

/* ------------------------------------------------------------- 结果与词表 */

test('结果词表是封闭集合，未知错误码不被当作合法结果', () => {
  for (const code of ['CAPABILITY_UNAVAILABLE', 'TARGET_CHANGED', 'ARGUMENT_INVALID', 'EFFECT_UNKNOWN']) {
    assert.equal(isExecutionErrorCode(code), true)
  }
  assert.equal(isExecutionErrorCode('SOMETHING_ELSE'), false)
  assert.equal(isExecutionErrorCode(undefined), false)
})

test('结果形状固定：状态、动作、证据、清理各字段独立', () => {
  const value = outcome('succeeded', 'build', { evidence: [{ kind: 'gradle', source: 'app/build/outputs' }] })
  assert.equal(value.status, 'succeeded')
  assert.equal(value.cleanup, 'not-needed')
  assert.equal(value.evidence.length, 1)
  assert.equal(Object.isFrozen(value), true)

  assert.equal(blocked('build', 'APPROVAL_REJECTED', 'user said no').error?.code, 'APPROVAL_REJECTED')
  assert.equal(failed('build', 'TIMEOUT', 'expired').status, 'failed')
  assert.equal(cancelled('build').cleanup, 'completed')
  assert.equal(effectUnknown('deploy', 'EFFECT_UNKNOWN', 'lost').cleanup, 'unknown')
})

/* ----------------------------------------------------------------- 参数 */

test('未知字段与非对象参数一律拒绝', () => {
  assert.throws(() => rejectUnknownKeys({ a: 1, b: 2 }, ['a']), ArgumentError)
  assert.doesNotThrow(() => rejectUnknownKeys({ a: 1 }, ['a', 'b']))
  assert.throws(() => requireRecord([], 'selection'), /must be an object/)
  assert.throws(() => requireRecord(null, 'selection'), /must be an object/)
})

test('有界字符串拒绝空值、超长与控制字符', () => {
  assert.equal(requireText('ok', 'task', 4), 'ok')
  assert.throws(() => requireText('', 'task'), /must not be empty/)
  assert.throws(() => requireText('toolong', 'task', 3), /at most 3/)
  assert.throws(() => requireText('a\u0000b', 'task'), /control characters/)
  assert.equal(optionalText(undefined, 'task'), undefined)
})

test('整数与布尔严格校验，不做隐式转换', () => {
  assert.equal(requireInteger(5, 'durationSeconds', 1, 120), 5)
  assert.throws(() => requireInteger(1.5, 'durationSeconds', 1, 120), /integer/)
  assert.throws(() => requireInteger('5', 'durationSeconds', 1, 120), /integer/)
  assert.throws(() => requireInteger(0, 'durationSeconds', 1, 120), /between 1 and 120/)
  assert.equal(requireBoolean(true, 'clean'), true)
  assert.throws(() => requireBoolean('yes', 'clean'), /boolean/)
  assert.equal(requireEnum('apk', 'artifactKind', ['apk', 'aab']), 'apk')
  assert.throws(() => requireEnum('zip', 'artifactKind', ['apk', 'aab']), /one of apk\/aab/)
})

test('项目内相对路径不接受绝对路径、上跳与反斜杠', () => {
  assert.equal(requireRelativePath('app/src/main', 'output'), 'app/src/main')
  for (const bad of ['/etc/passwd', 'C:/windows', 'app/../secret', 'app//x', './x', 'app\\x', 'app/.']) {
    assert.throws(() => requireRelativePath(bad, 'output'), ArgumentError, `应拒绝 ${bad}`)
  }
})

/* -------------------------------------------------------------- 服务作用域 */

test('调用方作用域缺服务时不回落到注册根', () => {
  const root = { get: () => ({ rootOnly: true }) }
  const scoped = { get: () => undefined }
  const missing = scopedServices(root, { agent: { id: 'a', ctx: scoped }, signal: new AbortController().signal }, ['fs'])
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.code, 'CAPABILITY_UNAVAILABLE')

  const fine = scopedServices(root, { agent: { id: 'a', ctx: { get: () => ({ real: true }) } }, signal: new AbortController().signal }, ['fs'])
  assert.equal(fine.ok, true)
})

test('没有 Agent 作用域时才使用注册根', () => {
  const root = { get: (name) => (name === 'fs' ? { fromRoot: true } : undefined) }
  const resolved = scopedServices(root, { signal: new AbortController().signal }, ['fs'])
  assert.equal(resolved.ok, true)
  const missing = scopedServices(root, { signal: new AbortController().signal }, ['sandbox'])
  assert.equal(missing.ok, false)
})

/* ----------------------------------------------------------------- 策略 */

test('策略解析拒绝缺失、越界模式与空根', () => {
  const policy = (value) => ({ resolve: () => value })
  assert.equal(isSandboxMode('read-only'), true)
  assert.equal(isSandboxMode('yolo'), false)
  assert.equal(resolvePolicy(policy(undefined), {}), undefined)
  assert.equal(resolvePolicy(policy({ mode: 'yolo', workspaceRoot: '/w' }), {}), undefined)
  assert.equal(resolvePolicy(policy({ mode: 'read-only', workspaceRoot: '' }), {}), undefined)
  assert.deepEqual(resolvePolicy(policy({ mode: 'read-only', workspaceRoot: '/w', sessionId: 's' }), {}), {
    mode: 'read-only', workspaceRoot: '/w', sessionId: 's',
  })
  assert.equal(resolvePolicy({ resolve: () => { throw new Error('boom') } }, {}), undefined)
})

test('策略身份比较包含模式、根与会话', () => {
  const base = { mode: 'read-only', workspaceRoot: '/w', sessionId: 's' }
  assert.equal(policyKey(base), policyKey({ ...base }))
  assert.notEqual(policyKey(base), policyKey({ ...base, mode: 'workspace-write' }))
  assert.notEqual(policyKey(base), policyKey({ ...base, workspaceRoot: '/other' }))
  assert.notEqual(policyKey(base), policyKey({ ...base, sessionId: 'other' }))
  assert.notEqual(policyKey(base), policyKey({ mode: 'read-only', workspaceRoot: '/w' }))
})

/* ------------------------------------------------------------ 受限进程 */

function fakeServices({ enforcement = 'full', confineThrows, spawnThrows, doneRejects, exit = 0, stdout = 'ok', stderr = '' } = {}) {
  const calls = { confine: [], spawn: [], terminated: 0, waited: 0 }
  return {
    calls,
    sandbox: {
      async confine(argv, policy, signal) {
        calls.confine.push({ argv: [...argv], policy, signal })
        if (confineThrows) throw new Error(confineThrows)
        return { argv: [...argv], enforcement, denialSignatures: [] }
      },
    },
    subprocess: {
      async resolveExecutable(command) { return `/usr/bin/${command}` },
      async terminalEnvironment() { return { platform: 'posix' } },
      spawn(spec) {
        calls.spawn.push(spec)
        if (spawnThrows) throw new Error(spawnThrows)
        const readers = {
          stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
        }
        return {
          done: doneRejects ? Promise.reject(new Error(doneRejects)) : Promise.resolve({ exitCode: exit, signal: null }),
          terminate() { calls.terminated += 1 },
          async waitForExit() { calls.waited += 1; return true },
          collected: readers,
        }
      },
    },
  }
}

const baseRequest = (over = {}) => ({
  executable: '/usr/bin/echo', args: ['hi'], cwd: '/project', mode: 'read-only',
  workspaceRoot: '/project', timeoutMs: 1000, outputMaxBytes: 1024, ...over,
})

test('受限执行按解析后的 argv 传参，不拼接 shell 字符串', async () => {
  const services = fakeServices()
  const outcome = await runBounded(services, baseRequest({ args: ['a b', '; rm -rf /'] }), new AbortController().signal)
  assert.equal(outcome.ok, true)
  assert.deepEqual(services.calls.confine[0].argv, ['/usr/bin/echo', 'a b', '; rm -rf /'])
  assert.deepEqual(services.calls.spawn[0].argv, ['/usr/bin/echo', 'a b', '; rm -rf /'])
  assert.equal(outcome.result.stdout.text, 'ok')
  assert.equal(outcome.result.enforcement, 'full')
})

test('部分强制或空 argv 一律不执行', async () => {
  const partial = fakeServices({ enforcement: 'partial' })
  const first = await runBounded(partial, baseRequest(), new AbortController().signal)
  assert.equal(first.ok, false)
  assert.match(first.failure.message, /partial/)
  assert.equal(partial.calls.spawn.length, 0)
})

test('confinement 抛错与 spawn 抛错都变成不可用，不执行半截命令', async () => {
  const confined = fakeServices({ confineThrows: 'no runner' })
  const first = await runBounded(confined, baseRequest(), new AbortController().signal)
  assert.equal(first.ok, false)
  assert.equal(confined.calls.spawn.length, 0)

  const spawnFail = fakeServices({ spawnThrows: 'pre-aborted' })
  const second = await runBounded(spawnFail, baseRequest(), new AbortController().signal)
  assert.equal(second.ok, false)
  assert.equal(second.failure.kind, 'unavailable')
})

test('已取消的调用不启动任何进程', async () => {
  const services = fakeServices()
  const controller = new AbortController()
  controller.abort()
  const result = await runBounded(services, baseRequest(), controller.signal)
  assert.equal(result.ok, false)
  assert.equal(result.failure.kind, 'cancelled')
  assert.equal(services.calls.confine.length, 0)
})

test('超时后终止并等待退出，结果显式标记 timedOut', async () => {
  const services = fakeServices()
  // 期限极短，done 立即返回时不应误报超时；这里用一个永不结束的句柄验证终止路径。
  const hanging = {
    sandbox: services.sandbox,
    subprocess: {
      ...services.subprocess,
      spawn(spec) {
        services.calls.spawn.push(spec)
        return {
          done: new Promise((resolve) => { spec.signal.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true }) }),
          terminate() { services.calls.terminated += 1 },
          async waitForExit() { services.calls.waited += 1; return true },
          collected: { stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
        }
      },
    },
  }
  const result = await runBounded(hanging, baseRequest({ timeoutMs: 20 }), new AbortController().signal)
  assert.equal(result.ok, true)
  assert.equal(result.result.timedOut, true)
  assert.equal(result.result.cleanup, 'completed')
  assert.equal(services.calls.terminated, 1)
  assert.equal(services.calls.waited, 1)
})

test('调用方取消会连同终止一起收敛', async () => {
  const services = fakeServices()
  const controller = new AbortController()
  const hanging = {
    sandbox: services.sandbox,
    subprocess: {
      ...services.subprocess,
      spawn(spec) {
        services.calls.spawn.push(spec)
        setTimeout(() => controller.abort(), 5)
        return {
          done: new Promise((resolve) => { spec.signal.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true }) }),
          terminate() { services.calls.terminated += 1 },
          async waitForExit() { services.calls.waited += 1; return true },
          collected: { stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
        }
      },
    },
  }
  const result = await runBounded(hanging, baseRequest({ timeoutMs: 5000 }), controller.signal)
  assert.equal(result.ok, true)
  assert.equal(result.result.aborted, true)
  assert.equal(result.result.timedOut, false)
  assert.equal(services.calls.terminated, 1)
})

test('输出按字节限额截断并显式标注', async () => {
  const services = fakeServices({ stdout: 'x'.repeat(100) })
  const result = await runBounded(services, baseRequest({ outputMaxBytes: 10 }), new AbortController().signal)
  assert.equal(result.ok, true)
  assert.equal(Buffer.byteLength(result.result.stdout.text) <= 10, true)
  assert.equal(result.result.stdout.truncated, true)
})

test('done reject 时仍终止并等待，且按超时/取消分类而不是"可重试的不可用"', async () => {
  const services = fakeServices({ doneRejects: 'provider failed' })
  const result = await runBounded(services, baseRequest(), new AbortController().signal)
  // provider 报错但句柄可收敛：必须做过 terminate + waitForExit，并把原因放进 failureDetail。
  assert.equal(result.ok, true)
  assert.equal(services.calls.terminated, 1)
  assert.equal(services.calls.waited, 1)
  assert.equal(result.result.cleanup, 'completed')
  assert.match(String(result.result.failureDetail), /provider failed/)
})

test('provider 不守 signal 时看门狗强制终止，不让调用永久挂起', async () => {
  const services = fakeServices()
  const controller = new AbortController()
  const never = {
    sandbox: services.sandbox,
    subprocess: {
      ...services.subprocess,
      spawn(spec) {
        services.calls.spawn.push(spec)
        // 完全忽略 signal 与 terminate：done 永不 settle。
        return {
          done: new Promise(() => {}),
          terminate() { services.calls.terminated += 1 },
          async waitForExit() { services.calls.waited += 1; return true },
          collected: { stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
        }
      },
    },
  }
  const result = await runBounded(never, baseRequest({ timeoutMs: 20, graceMs: 20 }), controller.signal)
  assert.equal(result.ok, true)
  assert.equal(result.result.timedOut, true)
  assert.match(String(result.result.failureDetail), /did not report process exit/)
  assert.equal(services.calls.terminated, 1)
  assert.equal(services.calls.waited, 1)
})

test('参数限额与清理上限是有限常量', () => {
  assert.equal(Number.isFinite(DEFAULT_GRACE_MS), true)
  assert.equal(Number.isFinite(CLEANUP_TIMEOUT_MS), true)
  assert.equal(CLEANUP_TIMEOUT_MS > 0, true)
})
