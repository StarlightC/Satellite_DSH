import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, realpath, lstat, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { createLocalVersionControl } from '../lib/node/lib/version-control.js'
import { runBounded } from '../lib/android/lib/execution/process.js'

// Real temporary Git repositories + a real linked worktree. Host services are simulated:
// this proves kernel layout gates/argv/policy shape, NOT native confinement of the extra root.
const signal = () => new AbortController().signal
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const env = home => ({ PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: '', LC_ALL: 'C' })

async function layout(t) {
  const parent = await realpath(tmpdir())
  const base = await mkdtemp(join(parent, 'satellite-worktree-'))
  assert.equal(await realpath(base), base)
  const main = join(base, 'main'), wt = join(base, 'wt')
  const inBase = p => isAbsolute(p) && !relative(base, p).startsWith('..') && relative(base, p) !== ''
  await mkdir(main)
  // Fixture Git writes only touch this exact temp directory (never the project repository).
  const git = (cwd, ...args) => { assert.ok(inBase(cwd), cwd); return execFileSync('/usr/bin/git', args, { cwd, env: env(base), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  async function put(path, content) { assert.ok(inBase(path), path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, content) }
  git(main, 'init', '--quiet'); git(main, 'config', 'user.name', 'Fixture'); git(main, 'config', 'user.email', 'fixture@example.invalid')
  await put(join(main, 'shared.txt'), 'seed\n'); await put(join(main, 'main-only.txt'), 'main dirty\n')
  git(main, 'add', '--', 'shared.txt'); git(main, 'commit', '--quiet', '-m', 'seed')
  git(main, 'worktree', 'add', '--quiet', '-b', 'feature', wt)
  t.after(async () => {
    assert.ok(dirname(base) === parent && base.startsWith(join(parent, 'satellite-worktree-')))
    await rm(base, { recursive: true, force: true })
  })
  return { base, main, wt, commonDir: join(main, '.git'), gitDir: join(main, '.git/worktrees/wt'), git, put }
}

function host(workspaceRoot, options = {}) {
  const calls = { spawn: [], confine: [], approval: [], verify: [], write: 0 }
  const state = { mode: 'workspace-write', workspaceRoot, sessionId: 'session' }
  const deps = {
    workspaceRoot, agent: { id: 'agent', session: {} }, sessionId: 'session', policy: () => state,
    sandbox: { async confine(argv, policy) {
      calls.confine.push({ argv, policy })
      await options.onConfine?.(policy)
      return { argv: [...argv], enforcement: 'full', denialSignatures: [] }
    } },
    subprocess: { spawn(spec) {
      calls.spawn.push(spec)
      const writing = spec.argv.includes('add') || spec.argv.includes('commit')
      if (writing) calls.write++
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: ['ignore', 'pipe', 'pipe'] })
      const buffers = { stdout: [], stderr: [] }
      for (const name of ['stdout', 'stderr']) child[name].on('data', b => buffers[name].push(b))
      const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, sig) => resolve({ exitCode, signal: sig })) })
      return { done, terminate: () => child.kill('SIGTERM'), waitForExit: async () => { await done; return true },
        collected: Object.fromEntries(['stdout', 'stderr'].map(n => [n, { readFrom() { const b = Buffer.concat(buffers[n]); return { text: b.toString('utf8'), nextOffset: b.length, lossy: false } } }])) }
    } },
    approval: { async request(input) { calls.approval.push(input); return (await options.approve?.(input)) ?? 'allowed-once' } },
    ...(options.noVerify ? {} : { async verifyHostPaths(paths) { calls.verify.push([...paths]); if (options.verifyFails || options.verifyNow?.()) throw new Error('LOCAL_GIT: unmapped') } }),
  }
  const kernel = createLocalVersionControl(deps)
  const exec = (value, s = signal()) => kernel.execute({ repo: '.', ...value }, s)
  const snapshot = async (repo = '.') => { const r = await exec({ action: 'status', repo }); assert.equal(r.status, 'succeeded', JSON.stringify(r)); return r.expectedSnapshot }
  return { calls, state, exec, snapshot }
}
const writeConfines = h => h.calls.confine.filter(c => c.policy.mode === 'workspace-write')

test('linked worktree: status → stage → new status → commit; only the exact external commondir is granted', async t => {
  const l = await layout(t)
  const mainIndex = sha(await readFile(join(l.commonDir, 'index')))
  await l.put(join(l.wt, 'shared.txt'), 'changed in worktree\n')
  const h = host(l.wt)
  const staged = await h.exec({ action: 'stage', paths: ['shared.txt'], expectedSnapshot: await h.snapshot() })
  assert.equal(staged.status, 'succeeded', JSON.stringify(staged))
  const committed = await h.exec({ action: 'commit', message: 'worktree change', expectedSnapshot: await h.snapshot() })
  assert.equal(committed.status, 'succeeded', JSON.stringify(committed))
  assert.equal(h.calls.write, 2)
  assert.equal(l.git(l.wt, 'log', '-1', '--format=%s', 'feature').trim(), 'worktree change')
  assert.equal(l.git(l.wt, 'show', 'HEAD:shared.txt'), 'changed in worktree\n')
  // Main tree: private index, branch, worktree files unchanged; registration still usable.
  assert.equal(sha(await readFile(join(l.commonDir, 'index'))), mainIndex)
  assert.equal(await readFile(join(l.main, 'shared.txt'), 'utf8'), 'seed\n')
  assert.equal(await readFile(join(l.main, 'main-only.txt'), 'utf8'), 'main dirty\n')
  assert.equal(l.git(l.main, 'log', '-1', '--format=%s').trim(), 'seed')
  assert.match(l.git(l.main, 'worktree', 'list', '--porcelain'), new RegExp(`worktree ${l.wt}\n`))
  assert.equal(l.git(l.main, 'status', '--porcelain'), '?? main-only.txt\n')
  // Policy shape: reads carry no extra root; approval probe and real run carry exactly [commonDir].
  for (const c of h.calls.confine.filter(c => c.policy.mode === 'read-only')) assert.equal('additionalWritableRoots' in c.policy, false)
  const writes = writeConfines(h)
  assert.equal(writes.length, 4) // probe + run, for stage and commit
  for (const c of writes) assert.deepEqual(c.policy.additionalWritableRoots, [l.commonDir])
  assert.deepEqual(writes[0].policy, writes[1].policy); assert.deepEqual(writes[2].policy, writes[3].policy)
  const plan = JSON.parse(h.calls.approval[0].reason.split('\n').slice(1).join('\n'))
  assert.deepEqual(plan.additionalWritableRoots, [l.commonDir])
  assert.deepEqual(plan.layout, { kind: 'linked', worktreeRoot: l.wt, gitDir: l.gitDir, commonDir: l.commonDir })
  assert.match(h.calls.approval[0].reason.split('\n')[0], /shared Git directory/)
  assert.ok(h.calls.verify.length > 0 && h.calls.verify.every(p => p[0] === l.gitDir && p[1] === l.commonDir))
})

test('linked worktree with a valid Unicode path still works', async t => {
  const l = await layout(t)
  const wt = join(l.base, 'wt-é漢字'); l.git(l.main, 'worktree', 'add', '--quiet', '-b', 'uni', wt)
  const h = host(wt)
  assert.equal((await h.exec({ action: 'status' })).status, 'succeeded')
})

test('main tree with a registered worktree works and gets no extra writable root', async t => {
  const l = await layout(t)
  const h = host(l.main)
  const r = await h.exec({ action: 'stage', paths: ['main-only.txt'], expectedSnapshot: await h.snapshot() })
  assert.equal(r.status, 'succeeded', JSON.stringify(r))
  for (const c of h.calls.confine) assert.equal('additionalWritableRoots' in c.policy, false)
  assert.equal(h.calls.verify.length, 0)
  assert.equal(await readFile(join(l.wt, 'shared.txt'), 'utf8'), 'seed\n')
})

test('linked worktree whose commondir is inside the workspace: no extra root; snapshots never cross trees', async t => {
  const l = await layout(t)
  const h = host(l.base)
  const token = await h.snapshot('main')
  const crossed = await h.exec({ action: 'stage', repo: 'wt', paths: ['shared.txt'], expectedSnapshot: token })
  assert.equal(crossed.status, 'blocked'); assert.equal(h.calls.write, 0)
  await l.put(join(l.wt, 'shared.txt'), 'x\n')
  const ok = await h.exec({ action: 'stage', repo: 'wt', paths: ['shared.txt'], expectedSnapshot: await h.snapshot('wt') })
  assert.equal(ok.status, 'succeeded', JSON.stringify(ok))
  for (const c of h.calls.confine) assert.equal('additionalWritableRoots' in c.policy, false)
})

test('malicious/changed layouts, config.worktree, worktreeConfig and external repos fail before Git', async t => {
  const cases = {
    'gitfile redirected to another gitdir': async l => { await mkdir(join(l.base, 'evil')); await l.put(join(l.wt, '.git'), `gitdir: ${join(l.base, 'evil')}\n`) },
    'relative gitfile': async l => l.put(join(l.wt, '.git'), 'gitdir: ../main/.git/worktrees/wt\n'),
    'gitfile with extra content': async l => l.put(join(l.wt, '.git'), `gitdir: ${l.gitDir}\ninclude = x\n`),
    'backlink mismatch': async l => l.put(join(l.gitDir, 'gitdir'), `${join(l.base, 'other/.git')}\n`),
    'commondir changed': async l => { await mkdir(join(l.base, 'fake/.git'), { recursive: true }); await l.put(join(l.gitDir, 'commondir'), '../../../../fake/.git\n') },
    // Physical counterexample: lexically this names main/.git, but Git follows link→e/child
    // and then `..` to e/main/.git. Must be rejected, not lexically collapsed.
    ...Object.fromEntries(['absolute', 'relative'].map(kind => [`commondir through symlink then .. (${kind})`, async l => {
      await mkdir(join(l.base, 'e/child'), { recursive: true }); await mkdir(join(l.base, 'e/main/.git'), { recursive: true })
      await symlink(join(l.base, 'e/child'), join(l.base, 'link'))
      await l.put(join(l.gitDir, 'commondir'), kind === 'absolute' ? `${join(l.base, 'link')}/../main/.git\n` : '../../../../link/../main/.git\n')
    }])),
    'commondir non-default relative spelling': async l => l.put(join(l.gitDir, 'commondir'), '../../../.git\n'),
    'config.worktree': async l => l.put(join(l.gitDir, 'config.worktree'), '[core]\n'),
    'extensions.worktreeConfig': async l => { l.git(l.main, 'config', 'extensions.worktreeConfig', 'true') },
    'hooks/include in common config': async l => { l.git(l.main, 'config', 'include.path', '/dev/null') },
  }
  for (const [name, mutate] of Object.entries(cases)) {
    await t.test(name, async t => {
      const l = await layout(t); await mutate(l)
      const h = host(l.wt)
      assert.equal((await h.exec({ action: 'status' })).status, 'blocked'); assert.equal(h.calls.spawn.length, 0)
    })
  }
  // Raw non-UTF-8 pointer bytes: Git reads bytes, so a lossy U+FFFD decode could observe a
  // different path. APFS may refuse such filenames, so this asserts the decode-level rejection.
  const bad = Buffer.from([0xff, 0xfe])
  const rawCases = {
    'gitfile': l => [join(l.wt, '.git'), Buffer.concat([Buffer.from(`gitdir: ${l.gitDir}`), bad, Buffer.from('\n')])],
    'absolute commondir': l => [join(l.gitDir, 'commondir'), Buffer.concat([Buffer.from(l.commonDir), bad, Buffer.from('\n')])],
    'backlink': l => [join(l.gitDir, 'gitdir'), Buffer.concat([Buffer.from(join(l.wt, '.git')), bad, Buffer.from('\n')])],
  }
  for (const [name, make] of Object.entries(rawCases)) {
    await t.test(`non-UTF-8 ${name} pointer`, async t => {
      const l = await layout(t); const [path, bytes] = make(l); await l.put(path, bytes)
      const h = host(l.wt); const r = await h.exec({ action: 'status' })
      assert.equal(r.status, 'blocked'); assert.match(JSON.stringify(r), /not valid UTF-8/); assert.equal(h.calls.spawn.length, 0)
    })
  }
  await t.test('repository outside the workspace', async t => {
    const l = await layout(t); const h = host(l.wt)
    assert.equal((await h.exec({ action: 'status', repo: '../main' })).status, 'blocked'); assert.equal(h.calls.spawn.length, 0)
  })
  await t.test('external commondir without a proven host mapping', async t => {
    for (const options of [{ noVerify: true }, { verifyFails: true }]) {
      const l = await layout(t); const h = host(l.wt, options)
      assert.equal((await h.exec({ action: 'status' })).status, 'blocked'); assert.equal(h.calls.spawn.length, 0)
    }
  })
})

test('linked worktree writes deny lock, pointer, config and permission changes; nothing is written', async t => {
  const changes = {
    'private index lock': async l => l.put(join(l.gitDir, 'index.lock'), ''),
    'commondir pointer': async l => l.put(join(l.gitDir, 'commondir'), `${l.commonDir}\n`),
    'common config': async l => { l.git(l.main, 'config', 'user.name', 'changed') },
    'policy to read-only': async (l, h) => { h.state.mode = 'read-only' },
  }
  for (const [name, mutate] of Object.entries(changes)) {
    await t.test(name, async t => {
      const l = await layout(t)
      await l.put(join(l.wt, 'shared.txt'), 'y\n')
      let h
      h = host(l.wt, { approve: async () => { await mutate(l, h) } })
      const token = await h.snapshot()
      const r = await h.exec({ action: 'stage', paths: ['shared.txt'], expectedSnapshot: token })
      assert.equal(r.status, 'blocked', JSON.stringify(r)); assert.equal(h.calls.write, 0)
      assert.equal(l.git(l.main, 'diff', '--cached', '--name-only'), '')
    })
  }
})

test('two worktrees sharing one commondir serialize without invalidating unrelated private indexes', async t => {
  const l = await layout(t), wt2 = join(l.base, 'wt2')
  l.git(l.main, 'worktree', 'add', '--quiet', '-b', 'feature2', wt2)
  await l.put(join(l.wt, 'shared.txt'), 'one\n'); await l.put(join(wt2, 'shared.txt'), 'two\n')
  let entered, release
  const atApproval = new Promise(resolve => { entered = resolve }), held = new Promise(resolve => { release = resolve })
  const h1 = host(l.wt, { approve: async () => { entered(); await held } }), h2 = host(wt2)
  const [s1, s2] = await Promise.all([h1.snapshot(), h2.snapshot()])
  const first = h1.exec({ action: 'stage', paths: ['shared.txt'], expectedSnapshot: s1 })
  await atApproval
  const second = h2.exec({ action: 'stage', paths: ['shared.txt'], expectedSnapshot: s2 })
  const before = h2.calls.spawn.length
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h2.calls.spawn.length, before); assert.equal(h2.calls.approval.length, 0)
  release()
  const results = await Promise.all([first, second])
  assert.deepEqual(results.map(r => r.status), ['succeeded', 'succeeded'], JSON.stringify(results))
  for (const wt of [l.wt, wt2]) assert.equal(l.git(wt, 'diff', '--cached', '--name-only'), 'shared.txt\n')
  assert.equal(l.git(l.main, 'diff', '--cached', '--name-only'), '')
  for (const h of [h1, h2]) for (const c of writeConfines(h)) assert.deepEqual(c.policy.additionalWritableRoots, [l.commonDir])
})

test('layout or host mapping change at the final write confine is denied with zero write spawn', async t => {
  const changes = {
    'commondir repointed': async l => l.put(join(l.gitDir, 'commondir'), `${l.commonDir}\n`),
    'backlink changed': async l => l.put(join(l.gitDir, 'gitdir'), `${join(l.base, 'other/.git')}\n`),
    'host mapping lost': async (l, flags) => { flags.unmapped = true },
  }
  for (const [name, mutate] of Object.entries(changes)) {
    await t.test(name, async t => {
      const l = await layout(t)
      await l.put(join(l.wt, 'shared.txt'), 'z\n')
      const flags = {}; let writes = 0
      const h = host(l.wt, { verifyNow: () => flags.unmapped, onConfine: async policy => {
        // 2nd workspace-write confine = the real run (1st is the approval probe).
        if (policy.mode === 'workspace-write' && ++writes === 2) await mutate(l, flags)
      } })
      const r = await h.exec({ action: 'stage', paths: ['shared.txt'], expectedSnapshot: await h.snapshot() })
      assert.equal(r.status, 'blocked', JSON.stringify(r)); assert.equal(h.calls.write, 0); assert.equal(writes, 2)
      assert.equal(l.git(l.main, 'diff', '--cached', '--name-only'), '')
    })
  }
})

test('runBounded: omitted additionalWritableRoots leaves the policy unchanged; non-write modes refuse it', async () => {
  const seen = []
  const services = {
    sandbox: { async confine(argv, policy) { seen.push(policy); return { argv: [...argv], enforcement: 'full', denialSignatures: [] } } },
    subprocess: { spawn: () => ({ done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {}, waitForExit: async () => true, collected: {} }) },
  }
  const base = { executable: '/usr/bin/true', args: [], cwd: '/', mode: 'workspace-write', workspaceRoot: '/w', timeoutMs: 1000, outputMaxBytes: 10 }
  assert.equal((await runBounded(services, base, signal())).ok, true)
  assert.deepEqual(seen[0], { mode: 'workspace-write', workspaceRoot: '/w' })
  assert.equal((await runBounded(services, { ...base, additionalWritableRoots: ['/c'] }, signal())).ok, true)
  assert.deepEqual(seen[1], { mode: 'workspace-write', workspaceRoot: '/w', additionalWritableRoots: ['/c'] })
  const refused = await runBounded(services, { ...base, mode: 'read-only', additionalWritableRoots: ['/c'] }, signal())
  assert.equal(refused.ok, false); assert.equal(seen.length, 2)
})
