import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CAPTURE_SETTLE_MS, LOG_DUMP_LINES, MAX_DURATION_SECONDS, PERFETTO_CONFIG_MAX_BYTES,
  describeCapturePlan, parseCaptureRequest, runCapture,
} from '../src/android/lib/execution/capture.ts'
import { DEVICE_TMP_DIR } from '../src/android/lib/execution/journey.ts'

const SERIAL = 'emulator-5554'
const ROOT = '/project'
const OUT = 'out/capture.txt'
const LOGCAT_TEXT = '01-01 00:00:00.000  1234  1234 I Example: hello\n'
const MEMINFO_TEXT = 'Applications Memory Usage (in Kilobytes):\n TOTAL 12345\n'
const CONFIG_TEXT = 'buffers: { size_kb: 1024 }\nduration_ms: 2000\n'
const TRACE = Buffer.alloc(512, 3)

function normalize(cwd, path) {
  if (path.startsWith('/')) return path
  if (path === '.') return cwd
  return `${cwd}/${path}`
}

function harness({ respond, files = {}, dirs = [ROOT, `${ROOT}/out`], mode = 'workspace-write', adbPath = '/usr/bin/adb', operationTimeoutMs = 120_000, settleMs, writeTampers = false } = {}) {
  const calls = { spawn: [], reads: [], writes: [], terminated: 0, waited: 0 }
  const table = new Map(Object.entries(files).map(([path, value]) => [path, Buffer.from(value)]))
  const directories = new Set(dirs)

  const defaultRespond = (args) => {
    const command = args.join(' ')
    // pull/rm 先匹配：perfetto 的产物名里也含 "perfetto"，顺序反了会漏掉真正的拉取。
    if (command.includes(' pull ')) {
      table.set(normalize(ROOT, args[args.length - 1]), TRACE)
      return { exitCode: 0, stdout: '1 file pulled' }
    }
    if (command.includes(' rm -f ')) return { exitCode: 0 }
    if (command.includes(' pidof ')) return { exitCode: 0, stdout: '4242\n' }
    if (command.includes('logcat')) return { exitCode: 0, stdout: LOGCAT_TEXT }
    if (command.includes('meminfo')) return { exitCode: 0, stdout: MEMINFO_TEXT }
    if (command.includes('screenrecord') || command.includes('perfetto')) return { exitCode: 0 }
    return { exitCode: 0 }
  }

  const services = {
    sandbox: {
      async confine(argv) { calls.push ?? 0; return { argv: [...argv], enforcement: 'full', denialSignatures: [] } },
    },
    subprocess: {
      async resolveExecutable(command) { return command.startsWith('/') ? command : `/usr/bin/${command}` },
      async terminalEnvironment() { return { platform: 'posix' } },
      spawn(spec) {
        calls.spawn.push({ argv: [...spec.argv], stdin: spec.stdio.stdin })
        const answer = (respond ?? defaultRespond)([...spec.argv], calls.spawn.length - 1) ?? {}
        const text = answer.stdout ?? ''
        const err = answer.stderr ?? ''
        const readers = {
          stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: answer.lossy === true }) },
          stderr: { readFrom: () => ({ text: err, nextOffset: err.length, lossy: false }) },
        }
        if (answer.hang === true) {
          return {
            done: new Promise((resolve) => {
              spec.signal.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true })
            }),
            terminate() { calls.terminated += 1 },
            async waitForExit() { calls.waited += 1; return true },
            collected: readers,
          }
        }
        return {
          done: Promise.resolve({ exitCode: answer.exitCode ?? 0, signal: null }),
          terminate() { calls.terminated += 1 },
          async waitForExit() { calls.waited += 1; return true },
          collected: readers,
        }
      },
    },
    fs: {
      async resolve(path, options = {}) { const absolute = normalize(options.cwd ?? ROOT, path); return { targetKey: absolute, displayPath: absolute } },
      async stat(target) {
        if (directories.has(target.targetKey)) return { type: 'directory' }
        const value = table.get(target.targetKey)
        return value === undefined ? undefined : { type: 'file', size: value.length }
      },
      processPath: (target) => target.targetKey,
      async readBytes(target, signal, maxBytes) {
        calls.reads.push({ path: target.targetKey, maxBytes })
        const value = table.get(target.targetKey)
        if (value === undefined) throw new Error('ENOENT')
        if (value.length > maxBytes) throw new Error('FS_TOO_LARGE')
        return value
      },
      async writeText(target, content, expected, signal, policy) {
        calls.writes.push({ path: target.targetKey, content, expected, signal, policy })
        table.set(target.targetKey, Buffer.from(writeTampers ? `${content}tampered` : content))
      },
    },
  }

  const exec = { agent: { id: 'caller-a', session: { header: { id: 'caller-a', cwd: ROOT } } }, callId: 'call-1', signal: new AbortController().signal }
  const deps = {
    fs: services.fs,
    sandbox: services.sandbox,
    subprocess: services.subprocess,
    binding: { root: ROOT, mode, workspaceRoot: ROOT, sessionId: 's1' },
    exec,
    adbPath,
    operationTimeoutMs,
    outputMaxBytes: 1024 * 1024,
    ...(settleMs !== undefined ? { settleMs } : {}),
  }
  return { calls, deps, table, exec, services, directories }
}

const request = (over = {}) => parseCaptureRequest({
  action: 'logcat', serial: SERIAL, durationSeconds: 5, output: OUT, ...over,
})

/* ------------------------------------------------------------- 参数校验 */

test('四种采集动作的合法输入', () => {
  assert.equal(request().action, 'logcat')
  assert.equal(request({ action: 'memory', applicationId: 'com.example.app' }).applicationId, 'com.example.app')
  assert.equal(request({ action: 'record' }).durationSeconds, 5)
  const perfetto = request({ action: 'perfetto', configPath: 'trace/config.txt' })
  assert.equal(perfetto.configPath, 'trace/config.txt')
  assert.equal(MAX_DURATION_SECONDS, 120)
})

test('未知字段、未知动作与越界值在启动任何进程之前被拒绝', () => {
  const bad = [
    [{ action: 'shell', serial: SERIAL, durationSeconds: 5, output: OUT }, /must be one of/],
    [{ action: 'logcat', serial: SERIAL, durationSeconds: 5, output: OUT, extra: 1 }, /unknown field/],
    [{ action: 'logcat', serial: SERIAL, durationSeconds: 0, output: OUT }, /between 1 and 120/],
    [{ action: 'logcat', serial: SERIAL, durationSeconds: 121, output: OUT }, /between 1 and 120/],
    [{ action: 'logcat', serial: SERIAL, durationSeconds: 1.5, output: OUT }, /integer/],
    [{ action: 'logcat', serial: SERIAL, durationSeconds: 5, output: '/etc/passwd' }, /project-relative/],
    [{ action: 'logcat', serial: SERIAL, durationSeconds: 5, output: 'a/../b' }, /\.\./],
    [{ action: 'logcat', serial: 'ser ial', durationSeconds: 5, output: OUT }, /serial must match/],
    [{ action: 'logcat', serial: SERIAL, applicationId: 'nope', durationSeconds: 5, output: OUT }, /dotted package name/],
    [{ action: 'perfetto', serial: SERIAL, durationSeconds: 5, output: OUT }, /configPath is required/],
    [{ action: 'logcat', serial: SERIAL, durationSeconds: 5, output: OUT, configPath: 'x.txt' }, /only valid for perfetto/],
    [{ action: 'memory', serial: SERIAL, durationSeconds: 5, output: OUT, configPath: 'x.txt' }, /only valid for perfetto/],
  ]
  for (const [args, pattern] of bad) {
    assert.throws(() => parseCaptureRequest(args), pattern, `应拒绝: ${JSON.stringify(args).slice(0, 70)}`)
  }
})

test('计划描述把设备临时文件、工作区落点与配置来源都写出来', () => {
  const plan = describeCapturePlan(request({ action: 'perfetto', configPath: 'trace/config.txt', applicationId: 'com.example.app' }))
  assert.match(plan, new RegExp(DEVICE_TMP_DIR))
  assert.match(plan, /out\/capture\.txt/)
  assert.match(plan, /trace\/config\.txt/)
  assert.match(plan, /com\.example\.app/)
  const logcatPlan = describeCapturePlan(request())
  assert.match(logcatPlan, /No device files are written/)
})

/* ----------------------------------------------------------------- logcat */

test('logcat 用 dump 模式并核对写回内容', async () => {
  const h = harness()
  const value = await runCapture(h.deps, request(), Date.now())
  assert.equal(value.status, 'succeeded')
  assert.deepEqual(h.calls.spawn.map((entry) => entry.argv), [
    ['/usr/bin/adb', '-s', SERIAL, 'logcat', '-d', '-t', String(LOG_DUMP_LINES)],
  ])
  assert.deepEqual(h.calls.writes.map((entry) => [entry.path, entry.expected]), [[`${ROOT}/${OUT}`, { kind: 'createIfAbsent' }]])
  assert.equal(h.calls.writes[0].content, LOGCAT_TEXT)
  // 写回后必须读回校验。
  assert.deepEqual(h.calls.reads.map((entry) => entry.path), [`${ROOT}/${OUT}`])
  assert.equal(value.artifacts.length, 1)
  assert.equal(value.artifacts[0].digest.length, 64)
})

test('指定应用时先取 pid 再加 --pid，取不到 pid 就不 dump', async () => {
  const h = harness()
  const value = await runCapture(h.deps, request({ applicationId: 'com.example.app' }), Date.now())
  assert.equal(value.status, 'succeeded')
  assert.deepEqual(h.calls.spawn.map((entry) => entry.argv), [
    ['/usr/bin/adb', '-s', SERIAL, 'shell', 'pidof', 'com.example.app'],
    ['/usr/bin/adb', '-s', SERIAL, 'logcat', '-d', '-t', String(LOG_DUMP_LINES), '--pid', '4242'],
  ])

  const notRunning = harness({ respond: (args) => (args.join(' ').includes(' pidof ') ? { exitCode: 1, stdout: '' } : undefined) })
  const second = await runCapture(notRunning.deps, request({ applicationId: 'com.example.app' }), Date.now())
  assert.equal(second.status, 'failed')
  assert.equal(second.error.code, 'TARGET_REQUIRED')
  assert.equal(notRunning.calls.spawn.length, 1)
  assert.equal(notRunning.calls.writes.length, 0)
})

test('logcat 输出被截断时不算采集成功，也不写文件', async () => {
  const h = harness({ respond: (args) => (args.join(' ').includes('logcat') ? { exitCode: 0, stdout: LOGCAT_TEXT, lossy: true } : undefined) })
  const value = await runCapture(h.deps, request(), Date.now())
  assert.equal(value.status, 'failed')
  assert.match(value.error.message, /truncated/)
  assert.equal(h.calls.writes.length, 0)
  assert.equal(value.artifacts.length, 0)
})

/* ----------------------------------------------------------------- memory */

test('memory 没有包名时拒绝全量转储，有包名时按包采集', async () => {
  const blocked = harness()
  const first = await runCapture(blocked.deps, request({ action: 'memory' }), Date.now())
  assert.equal(first.status, 'blocked')
  assert.equal(first.error.code, 'TARGET_REQUIRED')
  assert.equal(blocked.calls.spawn.length, 0)

  const h = harness()
  const second = await runCapture(h.deps, request({ action: 'memory', applicationId: 'com.example.app' }), Date.now())
  assert.equal(second.status, 'succeeded')
  assert.deepEqual(h.calls.spawn.map((entry) => entry.argv), [
    ['/usr/bin/adb', '-s', SERIAL, 'shell', 'dumpsys', 'meminfo', 'com.example.app'],
  ])
  assert.equal(h.calls.writes[0].content, MEMINFO_TEXT)
})

/* ---------------------------------------------------- record 与 perfetto */

test('screenrecord 用 --time-limit 录制，拉回并核对后删除设备副本', async () => {
  const h = harness()
  const value = await runCapture(h.deps, request({ action: 'record', durationSeconds: 7, output: 'out/screen.mp4' }), Date.now())
  assert.equal(value.status, 'succeeded')
  const record = h.calls.spawn.find((entry) => entry.argv.includes('screenrecord'))
  const pull = h.calls.spawn.find((entry) => entry.argv.includes('pull'))
  const rm = h.calls.spawn.find((entry) => entry.argv.includes('rm'))
  const devicePath = record.argv[record.argv.length - 1]
  assert.deepEqual(record.argv, ['/usr/bin/adb', '-s', SERIAL, 'shell', 'screenrecord', '--time-limit', '7', devicePath])
  assert.ok(devicePath.startsWith(`${DEVICE_TMP_DIR}/satellite-`))
  assert.deepEqual(pull.argv, ['/usr/bin/adb', '-s', SERIAL, 'pull', devicePath, 'out/screen.mp4'])
  assert.deepEqual(rm.argv, ['/usr/bin/adb', '-s', SERIAL, 'shell', 'rm', '-f', devicePath])
  // 二进制产物只经文件系统核对。
  assert.equal(h.calls.reads.some((entry) => entry.path === `${ROOT}/out/screen.mp4`), true)
  assert.equal(value.cleanup, 'completed')
  assert.equal(value.artifacts[0].digest.length, 64)
})

test('perfetto 从 stdin 喂已存在的配置，时窗由配置的 duration_ms 界定', async () => {
  const h = harness({ files: { [`${ROOT}/trace/config.txt`]: CONFIG_TEXT } })
  const value = await runCapture(h.deps, request({
    action: 'perfetto', durationSeconds: 9, output: 'out/trace.perfetto-trace', configPath: 'trace/config.txt',
  }), Date.now())
  assert.equal(value.status, 'succeeded')
  const run = h.calls.spawn.find((entry) => entry.argv.includes('perfetto'))
  const devicePath = run.argv[run.argv.length - 1]
  // 真机 perfetto 不认 --time-limit：不能把它塞进 argv，时窗只能来自配置。
  assert.deepEqual(run.argv, ['/usr/bin/adb', '-s', SERIAL, 'shell', 'perfetto', '-c', '-', '--txt', '-o', devicePath])
  assert.deepEqual(run.stdin, { data: CONFIG_TEXT })
  // 配置是从工作区读的，不是模型直接贴在参数里的。
  assert.equal(h.calls.reads.some((entry) => entry.path === `${ROOT}/trace/config.txt`), true)
  assert.equal(h.calls.reads.find((entry) => entry.path === `${ROOT}/trace/config.txt`).maxBytes, PERFETTO_CONFIG_MAX_BYTES)
})

test('perfetto 配置不存在时在启动任何进程之前阻塞', async () => {
  const h = harness()
  const value = await runCapture(h.deps, request({ action: 'perfetto', output: 'out/trace.perfetto-trace', configPath: 'trace/missing.txt' }), Date.now())
  assert.equal(value.status, 'blocked')
  assert.equal(value.error.code, 'TARGET_REQUIRED')
  assert.equal(h.calls.spawn.length, 0)
})

test('录制失败不拉取，清理仍然执行', async () => {
  const h = harness({ respond: (args) => (args.join(' ').includes('screenrecord') ? { exitCode: 1, stderr: 'device busy' } : undefined) })
  const value = await runCapture(h.deps, request({ action: 'record', output: 'out/screen.mp4' }), Date.now())
  assert.equal(value.status, 'failed')
  assert.match(value.error.message, /screenrecord exited with 1/)
  assert.equal(h.calls.spawn.some((entry) => entry.argv.includes('pull')), false)
  assert.equal(h.calls.spawn.some((entry) => entry.argv.includes('rm')), true)
})

/* ----------------------------------------------------------- 产物与清理 */

test('输出已存在时拒绝覆盖', async () => {
  const h = harness({ files: { [`${ROOT}/${OUT}`]: 'existing' } })
  const value = await runCapture(h.deps, request(), Date.now())
  assert.equal(value.status, 'blocked')
  assert.equal(value.error.code, 'TARGET_CHANGED')
  assert.equal(h.calls.writes.length, 0)
})

test('写回内容与读回内容不一致时不算采集成功', async () => {
  const h = harness({ writeTampers: true })
  const value = await runCapture(h.deps, request(), Date.now())
  assert.equal(value.status, 'failed')
  assert.match(value.error.message, /does not match/)
  assert.equal(value.artifacts.length, 0)
})

test('输出目录不存在时在启动任何进程之前阻塞', async () => {
  const h = harness({ dirs: [ROOT] })
  const value = await runCapture(h.deps, request({ output: 'missing/capture.txt' }), Date.now())
  assert.equal(value.status, 'blocked')
  assert.equal(value.error.code, 'TARGET_REQUIRED')
  assert.equal(h.calls.spawn.length, 0)
})

test('设备副本删不掉时结果不是成功', async () => {
  const h = harness({ respond: (args) => (args.join(' ').includes(' rm -f ') ? { exitCode: 1, stderr: 'denied' } : undefined) })
  const value = await runCapture(h.deps, request({ action: 'record', output: 'out/screen.mp4' }), Date.now())
  assert.equal(value.status, 'failed')
  assert.equal(value.cleanup, 'failed')
  assert.equal(value.error.code, 'CLEANUP_FAILED')
})

test('取消在启动进程之前生效', async () => {
  const h = harness()
  const controller = new AbortController()
  controller.abort()
  h.exec.signal = controller.signal
  const value = await runCapture(h.deps, request(), Date.now())
  assert.equal(value.status, 'cancelled')
  assert.equal(h.calls.spawn.length, 0)
  assert.equal(h.calls.writes.length, 0)
})

test('录制超时会终止进程并等待退出', async () => {
  // 收尾预算与会话预算一起压到毫秒级：仍然走真实的期限→terminate→waitForExit 路径。
  const h = harness({
    operationTimeoutMs: 1100, settleMs: 50,
    respond: (args) => (args.join(' ').includes('screenrecord') ? { hang: true } : undefined),
  })
  const value = await runCapture(h.deps, request({ action: 'record', output: 'out/screen.mp4', durationSeconds: 1 }), Date.now())
  assert.equal(value.status, 'failed')
  assert.equal(value.error.code, 'TIMEOUT')
  assert.equal(h.calls.terminated, 1)
  assert.equal(h.calls.waited, 1)
})

test('时窗加收尾预算装不进行程预算时直接拒绝，不录到一半被杀', async () => {
  const h = harness({ operationTimeoutMs: 1000, settleMs: 50 })
  const value = await runCapture(h.deps, request({ action: 'record', output: 'out/screen.mp4', durationSeconds: 120 }), Date.now())
  assert.equal(value.status, 'blocked')
  assert.equal(value.error.code, 'CAPABILITY_UNAVAILABLE')
  assert.match(value.error.message, /does not fit/)
  assert.equal(h.calls.spawn.length, 0)
})

test('adb 未解析成绝对路径时不可用', async () => {
  const h = harness({ adbPath: 'adb' })
  const value = await runCapture(h.deps, request(), Date.now())
  assert.equal(value.status, 'blocked')
  assert.equal(h.calls.spawn.length, 0)
})

test('采集只做一次有界调用：不提供跨调用 start/stop 协议', async () => {
  const h = harness()
  await runCapture(h.deps, request({ action: 'record', output: 'out/screen.mp4' }), Date.now())
  // 一次调用里的全部命令都在同一批 spawn 中，且方法表不导出 start/stop。
  assert.equal(h.calls.spawn.length, 3)
  assert.equal(CAPTURE_SETTLE_MS > 0, true)
})

test('文本产物写入必须带 per-call 沙箱策略（宿主按它围栏）', async () => {
  const h = harness()
  await runCapture(h.deps, request(), Date.now())
  assert.equal(h.calls.writes.length, 1)
  const write = h.calls.writes[0]
  assert.ok(write.policy, '必须传 sandboxPolicy，否则宿主按默认策略拒绝写入')
  assert.equal(write.policy.mode, 'workspace-write')
  assert.equal(write.policy.workspaceRoot, ROOT)
  assert.equal(write.signal, h.deps.exec.signal)
})

test('perfetto 配置没声明 duration_ms 时在启动任何进程之前阻塞', async () => {
  const h = harness({ files: { [`${ROOT}/trace/config.txt`]: 'buffers: { size_kb: 1024 }\n' } })
  const value = await runCapture(h.deps, request({ action: 'perfetto', output: 'out/trace.perfetto-trace', configPath: 'trace/config.txt' }), Date.now())
  assert.equal(value.status, 'blocked')
  assert.match(value.error.message, /duration_ms/)
  assert.equal(h.calls.spawn.length, 0)
})

test('perfetto 产物落在 perfetto 自己的 traces 目录（真机 /data/local/tmp 不可写）', async () => {
  const h = harness({ files: { [`${ROOT}/trace/config.txt`]: CONFIG_TEXT } })
  const value = await runCapture(h.deps, request({
    action: 'perfetto', output: 'out/trace.perfetto-trace', configPath: 'trace/config.txt',
  }), Date.now())
  assert.equal(value.status, 'succeeded')
  const run = h.calls.spawn.find((entry) => entry.argv.includes('perfetto'))
  const devicePath = run.argv[run.argv.length - 1]
  assert.match(devicePath, /^\/data\/misc\/perfetto-traces\/satellite-[0-9a-z-]+\.perfetto-trace$/)
  // 录屏仍用共享临时目录。
  const record = harness({ respond: () => ({ exitCode: 0 }) })
  await runCapture(record.deps, request({ action: 'record', output: 'out/screen.mp4' }), Date.now())
  const recordRun = record.calls.spawn.find((entry) => entry.argv.includes('screenrecord'))
  assert.match(recordRun.argv[recordRun.argv.length - 1], /^\/data\/local\/tmp\//)
})

// Pure execution helper contract: syntax validation is not a Windows support grant.
// The public tools separately reject unsupported hosts before these helpers run.
test('host adb absolute-path validation accepts drive and UNC syntax, not relative paths', async () => {
  for (const adbPath of ['C:\\sdk\\adb.exe', '\\\\server\\sdk\\adb.exe']) {
    const h = harness({ adbPath })
    h.services.subprocess.resolveExecutable = async (command) => command
    const value = await runCapture(h.deps, request(), Date.now())
    assert.equal(value.status, 'succeeded', JSON.stringify(value))
    assert.equal(h.calls.spawn[0].argv[0], adbPath)
  }
  const h = harness({ adbPath: 'sdk/adb' })
  const value = await runCapture(h.deps, request(), Date.now())
  assert.equal(value.status, 'blocked')
  assert.match(value.error.message, /absolute path/)
  assert.equal(h.calls.spawn.length, 0)
})
