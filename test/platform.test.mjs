import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createApplePlatform, detectHostPlatform, linuxPlatform, windowsPlatform, isAbsoluteHostPathSyntax,
} from '../lib/platform/index.js'

const APPLE = {
  '/System/Library/CoreServices/SystemVersion.plist': 1,
  '/usr/bin/sw_vers': 1,
}
const LINUX = { '/etc/os-release': 1 }

function fakeFs({ files = {}, dirs = {} } = {}) {
  return {
    async resolve(path) {
      return { targetKey: path, displayPath: path }
    },
    async stat(target) {
      const key = target.targetKey
      if (key in files) return { type: 'file' }
      if (key in dirs) return { type: 'directory' }
      return undefined
    },
  }
}

const posix = async (signal) => ({ platform: 'posix' })
const windows = async (signal) => ({ platform: 'windows' })

test('Apple 由 SystemVersion.plist 与 sw_vers 两个正向标记共同确认', async () => {
  const platform = await detectHostPlatform({ fs: fakeFs({ files: APPLE }), terminalEnvironment: posix, signal: new AbortController().signal })
  assert.equal(platform.id, 'apple')
  assert.equal(platform.supported, true)
  assert.equal(platform.gradleWrapperName, 'gradlew')
})

test('Linux 由 /etc/os-release 确认，且明确 unsupported', async () => {
  const platform = await detectHostPlatform({ fs: fakeFs({ files: LINUX }), terminalEnvironment: posix, signal: new AbortController().signal })
  assert.equal(platform.id, 'linux')
  assert.equal(platform.supported, false)
  assert.match(platform.unsupportedReason, /Linux host execution is not implemented/)
})

test('terminalEnvironment 为 windows 时直接 unsupported', async () => {
  const platform = await detectHostPlatform({ fs: fakeFs(), terminalEnvironment: windows, signal: new AbortController().signal })
  assert.equal(platform.id, 'windows')
  assert.equal(platform.supported, false)
  assert.match(platform.unsupportedReason, /Windows host execution is not implemented/)
})

test('无标记为 unknown，Apple 与 Linux 标记冲突同样为 unknown', async () => {
  const none = await detectHostPlatform({ fs: fakeFs(), terminalEnvironment: posix, signal: new AbortController().signal })
  assert.equal(none.id, 'unknown')
  assert.equal(none.supported, false)
  assert.match(none.unsupportedReason, /no supported host marker matched/)

  const conflict = await detectHostPlatform({ fs: fakeFs({ files: { ...APPLE, ...LINUX } }), terminalEnvironment: posix, signal: new AbortController().signal })
  assert.equal(conflict.id, 'unknown')
  assert.equal(conflict.supported, false)
  assert.match(conflict.unsupportedReason, /markers conflict/)
})

test('已取消的信号在探测前即抛出 AbortError', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    detectHostPlatform({ fs: fakeFs({ files: APPLE }), terminalEnvironment: posix, signal: controller.signal }),
    { name: 'AbortError' },
  )
})

test('fs 探测抛出的 AbortError 原样传播，不吞成 unknown', async () => {
  const throwing = {
    async resolve() { throw Object.assign(new Error('aborted mid-probe'), { name: 'AbortError' }) },
    async stat() { return { type: 'file' } },
  }
  await assert.rejects(
    detectHostPlatform({ fs: throwing, terminalEnvironment: posix, signal: new AbortController().signal }),
    { name: 'AbortError' },
  )
})

test('Apple 命令组装保留 env -i、单引号引用与 Node/Python stdin ABI', () => {
  const apple = createApplePlatform()
  assert.equal(apple.isAbsoluteHostPath('/usr/bin/env'), true)
  assert.equal(apple.isAbsoluteHostPath('node'), false)

  const nodeCommand = apple.skillScriptCommand({
    environmentExecutable: '/usr/bin/env', runtimeExecutable: '/usr/bin/node', runtime: 'node', args: ['summary', '2', 'true'],
  })
  assert.equal(nodeCommand, "'/usr/bin/env' '-i' '/usr/bin/node' '--input-type=module' '-' 'summary' '2' 'true'")

  const pythonCommand = apple.skillScriptCommand({
    environmentExecutable: '/usr/bin/env', runtimeExecutable: '/usr/bin/python3', runtime: 'python', args: ['x', "a'b"],
  })
  assert.equal(pythonCommand, "'/usr/bin/env' '-i' '/usr/bin/python3' '-I' '-' 'x' 'a'\\''b'")

  assert.equal(linuxPlatform().supported, false)
  assert.equal(windowsPlatform().supported, false)
  assert.equal(apple.gradleWrapperPath('/project/'), '/project/gradlew')
  assert.equal(apple.gradleWrapperPath('/project'), '/project/gradlew')
  assert.equal(apple.parserRuntimeName('python'), 'python3')
  assert.equal(apple.parserEnvironmentExecutableName, 'env')
})

for (const code of ['EACCES', 'EIO', undefined]) test(`inconclusive Linux probe (${code}) cannot authorize Apple selection`, async () => {
  const fs = fakeFs({ files: APPLE })
  const stat = fs.stat
  fs.stat = async target => {
    if (target.targetKey === '/etc/os-release') throw Object.assign(new Error('probe unavailable'), { code })
    return stat(target)
  }
  const platform = await detectHostPlatform({ fs, terminalEnvironment: posix, signal: new AbortController().signal })
  assert.equal(platform.id, 'unknown')
  assert.equal(platform.supported, false)
  assert.match(platform.unsupportedReason, /unavailable/)
})

for (const code of ['ENOENT', 'ENOTDIR']) test(`confirmed absent marker (${code}) is not a probe failure`, async () => {
  const fs = fakeFs({ files: APPLE })
  const resolve = fs.resolve
  fs.resolve = async path => {
    if (path === '/etc/os-release' || path === '/proc/version') throw Object.assign(new Error('absent'), { code })
    return resolve(path)
  }
  assert.equal((await detectHostPlatform({ fs, terminalEnvironment: posix, signal: new AbortController().signal })).id, 'apple')
})

test('Linux proc marker suffices without os-release; marker directories are not positive evidence', async () => {
  const signal = new AbortController().signal
  assert.equal((await detectHostPlatform({ fs: fakeFs({ files: { '/proc/version': 1 } }), terminalEnvironment: posix, signal })).id, 'linux')
  assert.equal((await detectHostPlatform({ fs: fakeFs({ files: APPLE, dirs: LINUX }), terminalEnvironment: posix, signal })).id, 'unknown')
})

test('unrecognised terminal family cannot select Apple even with Apple markers', async () => {
  const result = await detectHostPlatform({ fs: fakeFs({ files: APPLE }), terminalEnvironment: async () => ({ platform: 'other' }), signal: new AbortController().signal })
  assert.equal(result.id, 'unknown')
})

for (const family of ['windows', 'posix']) test(`pre-cancelled ${family} detection does not even call provider`, async () => {
  const controller = new AbortController(); controller.abort()
  let calls = 0
  await assert.rejects(detectHostPlatform({ fs: fakeFs(), terminalEnvironment: async () => { calls++; return { platform: family } }, signal: controller.signal }), { name: 'AbortError' })
  assert.equal(calls, 0)
})

test('cancellation after terminal or final stat cannot return a platform', async () => {
  const controller = new AbortController()
  await assert.rejects(detectHostPlatform({ fs: fakeFs(), terminalEnvironment: async () => { controller.abort(); return { platform: 'windows' } }, signal: controller.signal }), { name: 'AbortError' })
  const later = new AbortController()
  const fs = fakeFs({ files: APPLE }); const stat = fs.stat
  fs.stat = async target => { if (target.targetKey === '/proc/version') later.abort(); return stat(target) }
  await assert.rejects(detectHostPlatform({ fs, terminalEnvironment: posix, signal: later.signal }), { name: 'AbortError' })
})

test('standalone stat AbortError is propagated even when signal is not aborted', async () => {
  const fs = fakeFs({ files: APPLE })
  fs.stat = async () => { throw Object.assign(new Error('cancelled provider'), { name: 'AbortError' }) }
  await assert.rejects(detectHostPlatform({ fs, terminalEnvironment: posix, signal: new AbortController().signal }), { name: 'AbortError' })
})

test('static path syntax recognises both families without selecting execution support', () => {
  for (const path of ['/projects/demo', 'C:\\projects\\demo', '\\\\server\\share\\demo']) assert.equal(isAbsoluteHostPathSyntax(path), true)
  for (const path of ['projects/demo', 'C:relative']) assert.equal(isAbsoluteHostPathSyntax(path), false)
  assert.equal(windowsPlatform().supported, false)
})
