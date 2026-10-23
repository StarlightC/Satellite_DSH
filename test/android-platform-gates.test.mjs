import test from 'node:test'
import assert from 'node:assert/strict'
import { registerAndroidExecutionTools } from '../lib/android/lib/execution/tools.js'
import { resolveExecutionConfig } from '../lib/android/index.js'

const ROOT = '/project'
const SERIAL = 'emulator-5554'
const APP = 'com.example.app'
const APPLE = ['/System/Library/CoreServices/SystemVersion.plist', '/usr/bin/sw_vers']
const LINUX = ['/etc/os-release', '/proc/version']
const DESCRIBE = `Target project directory: ${ROOT}\nProject directory exists: ${ROOT}\nParsed tasks:\nTask: :app\n    Variant: debug\n        APK: ${ROOT}/app.apk\ngradlew completed successfully.`

// All subprocesses are fakes. Real public-tool discovery issues the observation ids used below.
function fixture() {
  const state = { platform: 'apple', onApproval: undefined }
  const calls = { spawn: [], approvals: [] }
  const files = new Set([`${ROOT}/gradlew`, `${ROOT}/app.apk`, `${ROOT}/trace.cfg`])
  const services = {
    fs: {
      async resolve(path, options = {}) { return { targetKey: path.startsWith('/') ? path : `${options.cwd ?? ROOT}/${path}` } },
      async stat(target) {
        const path = target.targetKey
        if (path === ROOT) return { type: 'directory' }
        if (files.has(path) || (state.platform === 'apple' && APPLE.includes(path)) || (state.platform === 'linux' && LINUX.includes(path))) return { type: 'file', size: 16 }
        return undefined
      },
      async listDir() { return [] },
      processPath: (target) => target.targetKey,
      processPathFromHostPath: (path) => path,
      contains: (parent, child) => child.targetKey === parent.targetKey || child.targetKey.startsWith(`${parent.targetKey}/`),
      async readBytes() { return Buffer.from('fixture') },
      async writeText() { throw new Error('no artifact write is expected in gate tests') },
    },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: ROOT, sessionId: 's1' }) },
    approval: { async request(request) { calls.approvals.push(request); state.onApproval?.(); return 'allowed-once' } },
    sandbox: { async confine(argv) { return { argv: [...argv], enforcement: 'full', denialSignatures: [] } } },
    subprocess: {
      async terminalEnvironment() { return { platform: state.platform === 'windows' ? 'windows' : 'posix' } },
      async resolveExecutable(command) { return command },
      spawn(spec) {
        calls.spawn.push(spec)
        let text = ''
        if (spec.argv.includes('--version')) text = '1.0.7'
        else if (spec.argv.includes('describe')) text = DESCRIBE
        else if (spec.argv.includes('devices')) text = `List of devices attached\n${SERIAL} device product:sdk model:sdk device:emu transport_id:1\n`
        else if (spec.argv.includes('getprop')) text = `[ro.boot.serialno]: [${SERIAL}]\n[ro.serialno]: [${SERIAL}]\n[ro.build.fingerprint]: [fixture-fp]\n`
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {}, async waitForExit() { return true },
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
    tools: { register(tool) { tools[tool.name] = tool; return () => {} } },
    effect() {},
  }
  registerAndroidExecutionTools(ctx, () => resolveExecutionConfig({ execution: {
    enabled: true, androidCli: '/opt/android', privacy: 'verified-disabled', adbPath: '/opt/adb',
    emulatorPath: '/opt/emulator', avdmanagerPath: '/opt/avdmanager',
  } }))
  const exec = { agent: { id: 'caller', session: { header: { cwd: ROOT } } }, signal: new AbortController().signal }
  const run = (tool, args) => tools[`satellite_android_${tool}`].execute(args, exec)
  return { state, calls, services, run }
}

const cases = [
  ['project', { action: 'discover-build' }],
  ...['build', 'test'].map((action) => ['build', { action, module: ':app', variant: 'debug' }]),
  ['device', { action: 'discover', serial: SERIAL }],
  ['device', { action: 'install', serial: SERIAL, artifact: 'app.apk' }],
  ...['launch', 'foreground'].map((action) => ['device', { action, serial: SERIAL, applicationId: APP }]),
  ['emulator', { action: 'list' }],
  ['emulator', { action: 'start', avd: 'Pixel', startupTimeoutMs: 10000 }],
  ['emulator', { action: 'stop', serial: SERIAL }],
  ['emulator', { action: 'delete', avd: 'Pixel' }],
  ['emulator', { action: 'create', avd: 'Pixel', installedSystemImage: 'system-images;android-34;google_apis;x86_64', deviceProfile: 'pixel_6' }],
  ...[
    { action: 'tap', x: 1, y: 1 }, { action: 'text', text: 'hello' },
    { action: 'key', key: 'KEYCODE_BACK' }, { action: 'wait', ms: 1 },
    { action: 'assert-foreground', package: APP }, { action: 'assert-ui-text', text: 'hello' },
    { action: 'screenshot', output: 'screen.png' },
  ].map((step) => ['journey', { serial: SERIAL, applicationId: APP, steps: [step] }]),
  ...['logcat', 'record', 'perfetto', 'memory'].map((action) => ['capture', {
    action, serial: SERIAL, durationSeconds: 1, output: `capture-${action}.dat`,
    ...(action === 'memory' ? { applicationId: APP } : {}),
    ...(action === 'perfetto' ? { configPath: 'trace.cfg' } : {}),
  }]),
]

for (const target of ['windows', 'linux', 'unknown']) {
  for (const duringApproval of [false, true]) {
    for (const [tool, input] of cases) {
      const label = input.action ?? input.steps[0].action
      test(`${tool}.${label}: ${target} ${duringApproval ? 'during approval' : 'before approval'} blocks without any new spawn`, async () => {
        const h = fixture()
        const args = { ...input }
        if (tool === 'build') {
          const observed = await h.run('project', { action: 'discover-build' })
          assert.equal(observed.status, 'succeeded', JSON.stringify(observed))
          args.observationId = observed.observationId
        } else if (['journey', 'capture'].includes(tool) || (tool === 'device' && input.action !== 'discover')) {
          const observed = await h.run('device', { action: 'discover', serial: SERIAL })
          assert.equal(observed.status, 'succeeded', JSON.stringify(observed))
          args.observationId = observed.observationId
        }
        h.calls.spawn.length = 0
        h.calls.approvals.length = 0
        if (duringApproval) h.state.onApproval = () => { h.state.platform = target }
        else h.state.platform = target
        const value = await h.run(tool, args)
        assert.equal(value.status, 'blocked', JSON.stringify(value))
        assert.equal(value.error.code, 'CAPABILITY_UNAVAILABLE', JSON.stringify(value))
        assert.match(value.error.message, /supported host platform/, JSON.stringify(value))
        assert.equal(h.calls.spawn.length, 0)
        assert.equal(h.calls.approvals.length, duringApproval ? 1 : 0)
        if (duringApproval) assert.match(h.calls.approvals[0].reason, /Host platform: apple/)
      })
    }
  }
}

test('covered build discovery rechecks platform again before running the CLI', async () => {
  const h = fixture()
  const observed = await h.run('project', { action: 'discover-build' })
  assert.equal(observed.status, 'succeeded')
  h.calls.spawn.length = 0
  h.calls.approvals.length = 0
  // Flip only after the immediate post-approval platform check: policy recheck is next.
  let approved = false
  h.state.onApproval = () => { approved = true }
  const policy = h.services.sandboxPolicy.resolve
  h.services.sandboxPolicy.resolve = () => {
    const result = policy()
    if (approved) h.state.platform = 'linux'
    return result
  }
  const value = await h.run('build', { action: 'build', module: ':app', variant: 'debug', observationId: observed.observationId })
  assert.equal(value.status, 'blocked')
  assert.match(value.error.message, /re-verification failed.*supported host platform/)
  assert.equal(h.calls.approvals.length, 1)
  assert.equal(h.calls.spawn.length, 0)
})

for (const root of ['C:\\work', '\\\\server\\share\\project']) {
  test(`static inspect accepts absolute host syntax without enabling execution: ${root}`, async () => {
    const h = fixture()
    h.state.platform = 'windows'
    const resolutions = []
    const resolve = h.services.fs.resolve
    const stat = h.services.fs.stat
    h.services.fs.resolve = async (path, options = {}) => {
      resolutions.push({ path, cwd: options.cwd })
      if (path === root) return { targetKey: root }
      if (options.cwd === root) return { targetKey: `${root}\\${path}` }
      return resolve(path, options)
    }
    h.services.fs.stat = async (target) => {
      if (target.targetKey === root) return { type: 'directory' }
      if (target.targetKey === `${root}\\gradlew.bat`) return { type: 'file' }
      return stat(target)
    }
    const value = await h.run('project', { action: 'inspect', project: root })
    assert.equal(value.status, 'succeeded', JSON.stringify(value))
    assert.equal(value.facts.projectRoot, root)
    assert.equal(value.facts.leads.find((lead) => lead.kind === 'wrapper').path, `${root}\\gradlew.bat`)
    assert.equal(resolutions.find((entry) => entry.path === root).cwd, undefined, 'absolute input must not resolve relative to session')
    assert.equal(h.calls.approvals.length, 0)
    assert.equal(h.calls.spawn.length, 0)
  })
}
