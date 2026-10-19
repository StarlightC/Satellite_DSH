import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEVICE_TMP_DIR, JOURNEY_KEYS, MAX_JOURNEY_STEPS, MAX_WAIT_MS, STEP_TIMEOUT_MS,
  describeJourneyPlan, encodeInputText, parseForegroundPackage, parseJourneyRequest,
  parseUiTexts, runJourney,
} from '../src/android/lib/execution/journey.ts'

const SERIAL = 'emulator-5554'
const ROOT = '/project'
const ACTIVITY_DUMP = [
  'ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)',
  '  * Task{9f3a1b2 #42 type=standard A=10123:com.example.app}',
  '    mResumedActivity: ActivityRecord{a1b2c3 u0 com.example.app/.MainActivity t42}',
].join('\n')
const UI_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<hierarchy rotation="0">',
  '  <node index="0" text="" resource-id="root" class="android.widget.FrameLayout">',
  '    <node index="1" text="Sign in" resource-id="com.example.app:id/cta" class="android.widget.Button"/>',
  '    <node index="2" text="A &amp; B" class="android.widget.TextView"/>',
  '  </node>',
  '</hierarchy>',
].join('\n')

const PNG = Buffer.alloc(256, 7)

function normalize(cwd, path) {
  if (path.startsWith('/')) return path
  if (path === '.') return cwd
  return `${cwd}/${path}`
}

/**
 * 假执行世界：记录 argv、维护一个内存文件表。
 * `respond` 可以覆盖单个命令的响应，用来造出截断、失败、超时与清理失败。
 */
function harness({ respond, files = {}, dirs = [ROOT], mode = 'workspace-write', adbPath = '/usr/bin/adb', operationTimeoutMs = 120_000 } = {}) {
  const calls = { spawn: [], confined: [], reads: [], terminated: 0, waited: 0 }
  const table = new Map(Object.entries(files).map(([path, value]) => [path, Buffer.from(value)]))
  const directories = new Set(dirs)

  const defaultRespond = (args) => {
    const command = args.join(' ')
    if (command.includes(' pull ')) {
      const destination = args[args.length - 1]
      const absolute = normalize(ROOT, destination)
      if (!directories.has(absolute.slice(0, absolute.lastIndexOf('/')) || '/')) return { exitCode: 1, stderr: 'no such directory' }
      table.set(absolute, PNG)
      return { exitCode: 0, stdout: '1 file pulled' }
    }
    if (command.includes(' rm -f ')) return { exitCode: 0 }
    if (command.includes('dumpsys activity')) return { exitCode: 0, stdout: ACTIVITY_DUMP }
    if (command.includes('uiautomator dump')) return { exitCode: 0, stdout: 'UI hierchary dumped to: /data/local/tmp/x.xml' }
    if (command.includes('exec-out cat')) return { exitCode: 0, stdout: UI_XML }
    if (command.includes('screencap')) return { exitCode: 0 }
    return { exitCode: 0 }
  }

  const services = {
    sandbox: {
      async confine(argv) { calls.confined.push([...argv]); return { argv: [...argv], enforcement: 'full', denialSignatures: [] } },
    },
    subprocess: {
      async resolveExecutable(command) { return command.startsWith('/') ? command : `/usr/bin/${command}` },
      async terminalEnvironment() { return { platform: 'posix' } },
      spawn(spec) {
        calls.spawn.push({ argv: [...spec.argv], cwd: spec.cwd, stdin: spec.stdio.stdin })
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
  }
  return { calls, deps, table, exec, services, directories }
}

const request = (over = {}) => parseJourneyRequest({
  serial: SERIAL, applicationId: 'com.example.app',
  steps: [{ action: 'tap', x: 10, y: 20 }], ...over,
})

/* ------------------------------------------------------------- 参数校验 */

test('合法旅程被解析成不可变步骤列表', () => {
  const parsed = request({
    steps: [
      { action: 'tap', x: 0, y: 0 },
      { action: 'text', text: 'hello world' },
      { action: 'key', key: 'KEYCODE_ENTER' },
      { action: 'wait', ms: 500 },
      { action: 'assert-foreground', package: 'com.example.app' },
      { action: 'assert-ui-text', text: 'Sign in' },
      { action: 'screenshot', output: 'out/step-1.png' },
    ],
  })
  assert.equal(parsed.serial, SERIAL)
  assert.equal(parsed.applicationId, 'com.example.app')
  assert.equal(parsed.steps.length, 7)
  assert.equal(Object.isFrozen(parsed.steps), true)
})

test('未知字段、未知动作与非法值在启动任何进程之前被拒绝', () => {
  const bad = [
    [{ serial: SERIAL, applicationId: 'com.example.app', steps: [{ action: 'tap', x: 1, y: 1 }], extra: 1 }, /unknown field/],
    [{ serial: SERIAL, applicationId: 'com.example.app', steps: [{ action: 'tap', x: 1, y: 1, z: 2 }] }, /unknown field/],
    [{ serial: SERIAL, applicationId: 'com.example.app', steps: [] }, /must not be empty/],
    [{ serial: SERIAL, applicationId: 'com.example.app', steps: Array.from({ length: 31 }, () => ({ action: 'wait', ms: 1 })) }, /at most 30/],
    [{ serial: SERIAL, applicationId: 'com.example.app', steps: [{ action: 'shell', command: 'rm -rf /' }] }, /must be one of/],
    [{ serial: SERIAL, applicationId: 'com.example.app', steps: [{ action: 'tap', x: -1, y: 0 }] }, /between 0 and 100000/],
    [{ serial: SERIAL, applicationId: 'com.example.app', steps: [{ action: 'wait', ms: 0 }] }, /between 1 and 30000/],
    [{ serial: SERIAL, applicationId: 'com.example.app', steps: [{ action: 'wait', ms: MAX_WAIT_MS + 1 }] }, /between 1 and 30000/],
    [{ serial: SERIAL, applicationId: 'com.example.app', steps: [{ action: 'text', text: 'x'.repeat(1025) }] }, /at most 1024/],
    // 注入形状的文本在解析期就被拒绝，不会等到设备已经改过状态才发现。
    [{ serial: SERIAL, applicationId: 'com.example.app', steps: [{ action: 'text', text: 'a; rm -rf /' }] }, /letters, digits, space/],
    [{ serial: SERIAL, applicationId: 'com.example.app', steps: [{ action: 'assert-ui-text', text: 'x'.repeat(513) }] }, /at most 512/],
    [{ serial: SERIAL, applicationId: 'com.example.app', steps: [{ action: 'key', key: 'KEYCODE_REBOOT' }] }, /must be one of/],
    [{ serial: SERIAL, applicationId: 'com.example.app', steps: [{ action: 'screenshot', output: '/etc/passwd' }] }, /project-relative/],
    [{ serial: SERIAL, applicationId: 'com.example.app', steps: [{ action: 'screenshot', output: '../outside.png' }] }, /\.\./],
    [{ serial: 'emulator 5554', applicationId: 'com.example.app', steps: [{ action: 'wait', ms: 1 }] }, /serial must match/],
    [{ serial: '-s', applicationId: 'com.example.app', steps: [{ action: 'wait', ms: 1 }] }, /serial must match/],
    [{ serial: SERIAL, applicationId: 'not a package', steps: [{ action: 'wait', ms: 1 }] }, /dotted package name/],
    [{ serial: SERIAL, applicationId: 'com.example.app', steps: [{ action: 'assert-foreground', package: 'a; rm -rf /' }] }, /dotted package name/],
  ]
  for (const [args, pattern] of bad) {
    assert.throws(() => parseJourneyRequest(args), pattern, `应拒绝: ${JSON.stringify(args).slice(0, 80)}`)
  }
  assert.equal(JOURNEY_KEYS.includes('KEYCODE_HOME'), true)
})

test('输入文本去掉 shell 元字符，空格编码成 %s', () => {
  assert.equal(encodeInputText('hello world'), 'hello%sworld')
  assert.equal(encodeInputText('a.b_c@d:e+f=g-h/i,j'), 'a.b_c@d:e+f=g-h/i,j')
  for (const bad of ['a;b', 'a$b', 'a`b`', 'a&b', 'a|b', 'a*b', 'a?b', 'a"b', "a'b", 'a\nb', 'a(b', 'a>b', 'a%b']) {
    assert.throws(() => encodeInputText(bad), /letters, digits, space/, `应拒绝 ${JSON.stringify(bad)}`)
  }
  // 以 "-" 开头会被设备端 input 当作选项，单独拒绝。
  assert.throws(() => encodeInputText('-leading'), /must not start with/)
})

test('计划描述写明设备临时文件与工作区落点', () => {
  const plan = describeJourneyPlan(request({
    steps: [{ action: 'screenshot', output: 'out/shot.png' }, { action: 'assert-ui-text', text: 'Sign in' }],
  }))
  assert.match(plan, /out\/shot\.png/)
  assert.match(plan, new RegExp(DEVICE_TMP_DIR))
  assert.match(plan, /no shell strings/i)
})

/* ------------------------------------------------------------- 命令映射 */

test('每一步都映射成一条精确的 adb argv', async () => {
  const h = harness()
  const value = await runJourney(h.deps, request({
    steps: [
      { action: 'tap', x: 10, y: 20 },
      { action: 'text', text: 'hello world' },
      { action: 'key', key: 'KEYCODE_ENTER' },
    ],
  }), Date.now())
  assert.equal(value.status, 'succeeded')
  assert.deepEqual(h.calls.spawn.map((entry) => entry.argv), [
    ['/usr/bin/adb', '-s', SERIAL, 'shell', 'input', 'tap', '10', '20'],
    ['/usr/bin/adb', '-s', SERIAL, 'shell', 'input', 'text', 'hello%sworld'],
    ['/usr/bin/adb', '-s', SERIAL, 'shell', 'input', 'keyevent', 'KEYCODE_ENTER'],
  ])
  assert.equal(h.calls.spawn.every((entry) => entry.cwd === ROOT), true)
  assert.deepEqual(value.steps.map((step) => step.status), ['succeeded', 'succeeded', 'succeeded'])
})

test('断言失败立即停止后续步骤，并如实标记失败', async () => {
  const h = harness()
  const value = await runJourney(h.deps, request({
    steps: [
      { action: 'tap', x: 1, y: 1 },
      { action: 'assert-foreground', package: 'com.other.app' },
      { action: 'tap', x: 2, y: 2 },
    ],
  }), Date.now())
  assert.equal(value.status, 'failed')
  assert.equal(value.error.code, 'CAPABILITY_UNAVAILABLE')
  assert.match(value.error.message, /com\.other\.app/)
  assert.match(value.error.message, /stopped at step 1/)
  assert.deepEqual(value.steps.map((step) => step.status), ['succeeded', 'failed', 'skipped'])
  // 第三个 tap 从未发给设备。
  assert.equal(h.calls.spawn.some((entry) => entry.argv.join(' ') === '/usr/bin/adb -t emulator-5554 shell input tap 2 2'), false)
  assert.equal(h.calls.spawn.length, 2)
})

test('前台断言读不出前台活动时失败，而不是通过', async () => {
  const h = harness({ respond: (args) => (args.join(' ').includes('dumpsys activity') ? { exitCode: 0, stdout: 'no activity here' } : undefined) })
  const value = await runJourney(h.deps, request({ steps: [{ action: 'assert-foreground', package: 'com.example.app' }] }), Date.now())
  assert.equal(value.status, 'failed')
  assert.match(value.error.message, /could not read a foreground activity/)
})

test('截断的转储不当作断言通过', async () => {
  const h = harness({ respond: (args) => (args.join(' ').includes('dumpsys activity') ? { exitCode: 0, stdout: ACTIVITY_DUMP, lossy: true } : undefined) })
  const value = await runJourney(h.deps, request({ steps: [{ action: 'assert-foreground', package: 'com.example.app' }] }), Date.now())
  assert.equal(value.status, 'failed')
  assert.match(value.error.message, /truncated/)
})

test('UI 文本断言解析不出节点或内容截断时都不通过', async () => {
  const noNodes = harness({ respond: (args) => (args.join(' ').includes('exec-out cat') ? { exitCode: 0, stdout: '<hierarchy></hierarchy>' } : undefined) })
  const first = await runJourney(noNodes.deps, request({ steps: [{ action: 'assert-ui-text', text: 'Sign in' }] }), Date.now())
  assert.equal(first.status, 'failed')
  assert.match(first.error.message, /no readable text nodes/)

  const truncated = harness({ respond: (args) => (args.join(' ').includes('exec-out cat') ? { exitCode: 0, stdout: UI_XML, lossy: true } : undefined) })
  const second = await runJourney(truncated.deps, request({ steps: [{ action: 'assert-ui-text', text: 'Sign in' }] }), Date.now())
  assert.equal(second.status, 'failed')
  assert.match(second.error.message, /truncated/)

  const absent = harness()
  const third = await runJourney(absent.deps, request({ steps: [{ action: 'assert-ui-text', text: 'Sign out' }] }), Date.now())
  assert.equal(third.status, 'failed')
  assert.match(third.error.message, /was not found/)
})

test('UI 文本断言命中时成功，并按设备临时文件清理', async () => {
  const h = harness()
  const value = await runJourney(h.deps, request({ steps: [{ action: 'assert-ui-text', text: 'Sign in' }] }), Date.now())
  assert.equal(value.status, 'succeeded')
  const uia = h.calls.spawn.find((entry) => entry.argv.includes('uiautomator'))
  const devicePath = uia.argv[uia.argv.length - 1]
  assert.ok(devicePath.startsWith(`${DEVICE_TMP_DIR}/satellite-`), devicePath)
  const rm = h.calls.spawn.find((entry) => entry.argv.includes('rm'))
  assert.deepEqual(rm.argv, ['/usr/bin/adb', '-s', SERIAL, 'shell', 'rm', '-f', devicePath])
  assert.equal(value.cleanup, 'completed')
})

test('截图走设备文件 + pull，并用文件系统核对后再删设备副本', async () => {
  const h = harness({ dirs: [ROOT, `${ROOT}/out`] })
  const value = await runJourney(h.deps, request({ steps: [{ action: 'screenshot', output: 'out/step-1.png' }] }), Date.now())
  assert.equal(value.status, 'succeeded')
  const screencap = h.calls.spawn.find((entry) => entry.argv.includes('screencap'))
  const pull = h.calls.spawn.find((entry) => entry.argv.includes('pull'))
  const rm = h.calls.spawn.find((entry) => entry.argv.includes('rm'))
  const devicePath = screencap.argv[screencap.argv.length - 1]
  assert.deepEqual(screencap.argv, ['/usr/bin/adb', '-s', SERIAL, 'shell', 'screencap', '-p', devicePath])
  assert.deepEqual(pull.argv, ['/usr/bin/adb', '-s', SERIAL, 'pull', devicePath, 'out/step-1.png'])
  assert.deepEqual(rm.argv, ['/usr/bin/adb', '-s', SERIAL, 'shell', 'rm', '-f', devicePath])
  // 二进制产物只经文件系统核对：读过 pull 落点，且没有被当作文本解码。
  assert.deepEqual(h.calls.reads.map((entry) => entry.path), [`${ROOT}/out/step-1.png`])
  assert.equal(value.evidence.some((entry) => entry.kind === 'artifact' && entry.digest.length === 64), true)
})

test('截图目录不存在时在启动任何进程之前阻塞', async () => {
  const h = harness({ dirs: [ROOT] })
  const value = await runJourney(h.deps, request({ steps: [{ action: 'screenshot', output: 'missing/step-1.png' }] }), Date.now())
  assert.equal(value.status, 'blocked')
  assert.equal(value.error.code, 'TARGET_REQUIRED')
  assert.equal(h.calls.spawn.length, 0)
})

test('拉回的产物为空时失败，不声称已采集', async () => {
  const h = harness({
    dirs: [ROOT, `${ROOT}/out`],
    respond: (args) => {
      const command = args.join(' ')
      if (command.includes(' pull ')) { h.table.set(`${ROOT}/out/empty.png`, Buffer.alloc(0)); return { exitCode: 0 } }
      if (command.includes('screencap')) return { exitCode: 0 }
      return { exitCode: 0 }
    },
  })
  const value = await runJourney(h.deps, request({ steps: [{ action: 'screenshot', output: 'out/empty.png' }] }), Date.now())
  assert.equal(value.status, 'failed')
  assert.match(value.error.message, /empty/)
})

test('前面步骤已经改过设备后，后续阻塞不能再声称零副作用', async () => {
  const h = harness({ dirs: [ROOT] })
  const value = await runJourney(h.deps, request({
    steps: [{ action: 'tap', x: 1, y: 1 }, { action: 'screenshot', output: 'missing/step.png' }],
  }), Date.now())
  assert.equal(value.status, 'failed')
  assert.match(value.error.message, /earlier steps already changed device state/)
  assert.deepEqual(value.steps.map((step) => step.status), ['succeeded', 'failed'])
})

test('设备副本删不掉时结果不是成功', async () => {
  const h = harness({ respond: (args) => (args.join(' ').includes(' rm -f ') ? { exitCode: 1, stderr: 'denied' } : undefined) })
  const value = await runJourney(h.deps, request({ steps: [{ action: 'assert-ui-text', text: 'Sign in' }] }), Date.now())
  assert.equal(value.status, 'failed')
  assert.equal(value.cleanup, 'failed')
  assert.equal(value.error.code, 'CLEANUP_FAILED')
})

test('取消在启动进程之前生效，且不产生任何 argv', async () => {
  const h = harness()
  const controller = new AbortController()
  controller.abort()
  h.exec.signal = controller.signal
  const value = await runJourney(h.deps, request({ steps: [{ action: 'tap', x: 1, y: 1 }] }), Date.now())
  assert.equal(value.status, 'cancelled')
  assert.equal(h.calls.spawn.length, 0)
})

test('超时会终止进程、等待退出，并停止后续步骤', async () => {
  // 用很短的会话预算把单步期限压到毫秒级，避免测试真的等 30 秒。
  const h = harness({ operationTimeoutMs: 200, respond: (args) => (args.join(' ').includes('input tap') ? { hang: true } : undefined) })
  const value = await runJourney(h.deps, request({
    steps: [{ action: 'tap', x: 1, y: 1 }, { action: 'tap', x: 2, y: 2 }],
  }), Date.now())
  assert.equal(value.status, 'failed')
  assert.equal(value.error.code, 'TIMEOUT')
  assert.equal(h.calls.terminated, 1)
  assert.equal(h.calls.waited, 1)
  assert.equal(h.calls.spawn.length, 1)
  assert.deepEqual(value.steps.map((step) => step.status), ['failed', 'skipped'])
})

test('单步上限与整体期限都有界', async () => {
  const h = harness({ operationTimeoutMs: 30 })
  const value = await runJourney(h.deps, request({ steps: [{ action: 'wait', ms: 5_000 }] }), Date.now())
  assert.equal(value.status, 'failed')
  assert.equal(value.error.code, 'TIMEOUT')
  assert.equal(STEP_TIMEOUT_MS, 30_000)
})

test('adb 未解析成绝对路径时不可用', async () => {
  const h = harness({ adbPath: 'adb' })
  const value = await runJourney(h.deps, request({ steps: [{ action: 'tap', x: 1, y: 1 }] }), Date.now())
  assert.equal(value.status, 'blocked')
  assert.equal(h.calls.spawn.length, 0)
})

/* ------------------------------------------------------------- 纯解析器 */

test('前台包名与 UI 文本解析器按真实形状取值', () => {
  assert.equal(parseForegroundPackage(ACTIVITY_DUMP), 'com.example.app')
  assert.equal(parseForegroundPackage('nothing here'), undefined)
  assert.deepEqual(parseUiTexts(UI_XML), ['', 'Sign in', 'A & B'])
  assert.deepEqual(parseUiTexts('<hierarchy/>'), [])
  assert.deepEqual(MAX_JOURNEY_STEPS, 30)
})
