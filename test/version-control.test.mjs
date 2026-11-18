import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, realpath, lstat, mkdir, writeFile, readFile, rm, symlink, link, unlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, relative, isAbsolute } from 'node:path'
import { createLocalVersionControl } from '../lib/node/lib/version-control.js'

test('real vscode branch config and normal Git syntax/attrs stage and commit without executing disabled entries', async t => {
  const f = await fixture(t), h = host(f)
  const base = await readFile(join(f.root, '.git/config'), 'utf8')
  const config = '[branch "next"] # comment\n vscode-merge-base = origin/next\n' +
    '[Branch "page_create"]\n vscode-merge-base = "origin/page_create" ; comment\n' +
    '[branch.parallel]\n vscode-merge-base = origin/parallel\n' +
    '[tooling "quoted\\"sub\\\\section"]\n enabled\n value = "space ; # quote\\" slash\\\\ tab\\t"\n value = continued\\\n  value\n' +
    '[lfs]\n repositoryformatversion = 0\n url = https://example.invalid\n' +
    '[core]\n repositoryformatversion = +0\n hooksPath = ./hooks\n fsmonitor = ./sentinel\n attributesFile = /nonexistent/attrs\n pager = ./sentinel\n editor = ./sentinel\n' +
    '[gpg]\n program = ./sentinel\n[commit]\n gpgSign = true\n' +
    '[diff]\n external = ./sentinel\n[diff "evil"]\n textconv = ./sentinel\n command = ./sentinel\n' +
    '[filter "smudge-only"]\n smudge = ./sentinel\n[merge "evil"]\n driver = ./sentinel\n' +
    '[gc]\n auto = 1\n[maintenance]\n auto = true\n'
  await f.put('.git/config', base + config)
  // Git itself independently accepts this grammar (fixture config command, not production parsing).
  assert.match(f.git(['config', '--local', '--no-includes', '--list']), /branch\.next\.vscode-merge-base=origin\/next/)
  assert.equal((await h.exec({ action: 'status' })).status, 'succeeded')
  await f.put('sentinel', '#!/bin/sh\nprintf invoked > MARKER\n'); await chmod(await f.target('sentinel', { existing: true }), 0o755)
  await f.put('.gitattributes', '[attr]normal text=auto merge=union linguist-generated\n*.txt normal diff=evil filter=smudge-only\n')
  await f.put('x.txt', 'normal text\n')
  assert.equal((await stage(h, ['.gitattributes', 'x.txt'])).status, 'succeeded')
  assert.equal((await h.exec({ action: 'diff', target: 'staged' })).status, 'succeeded')
  assert.equal((await h.exec({ action: 'commit', message: 'safe config', expectedSnapshot: await h.snapshot() })).status, 'succeeded')
  await assert.rejects(lstat(join(f.root, 'MARKER')), { code: 'ENOENT' })
})

const signal = () => new AbortController().signal
const within = (root, p) => p !== root && !relative(root, p).startsWith('..') && !isAbsolute(relative(root, p))
async function fixture(t) {
  const parent = await realpath(tmpdir())
  const root = await mkdtemp(join(parent, 'satellite-local-git-'))
  assert.equal(await realpath(root), root)
  // Every fixture write/delete checks its resolved absolute target and parents first.
  async function target(path, { existing = false } = {}) {
    const abs = resolve(root, path)
    assert.equal(abs, join(root, path)); assert.ok(within(root, abs), abs)
    let cursor = dirname(abs)
    while (cursor !== root) {
      try { assert.equal((await lstat(cursor)).isSymbolicLink(), false, cursor) }
      catch (e) { if (e.code !== 'ENOENT') throw e }
      cursor = dirname(cursor)
    }
    if (existing) assert.equal((await lstat(abs)).isSymbolicLink(), false, abs)
    return abs
  }
  async function put(path, content) {
    const abs = await target(path)
    try { assert.equal((await lstat(abs)).isSymbolicLink(), false, abs) }
    catch (e) { if (e.code !== 'ENOENT') throw e }
    await mkdir(dirname(abs), { recursive: true }); await writeFile(abs, content)
  }
  async function remove(path) { await unlink(await target(path, { existing: true })) }
  const env = { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: '', LC_ALL: 'C' }
  function git(args) {
    assert.ok(isAbsolute(root) && root.startsWith(join(parent, 'satellite-local-git-')))
    // All fixture Git writes (including commits) are confined by this exact temp cwd.
    return execFileSync('/usr/bin/git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  }
  git(['init', '--quiet']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid'])
  t.after(async () => {
    assert.ok(isAbsolute(root) && dirname(root) === parent && root.startsWith(join(parent, 'satellite-local-git-')))
    assert.equal(await realpath(root), root)
    await rm(root, { recursive: true, force: true })
  })
  return { root, put, remove, target, git }
}
function host(f, options = {}) {
  const calls = { spawn: [], confine: [], approval: [], write: 0 }
  const state = { mode: 'workspace-write', workspaceRoot: f.root, sessionId: 'session', ...options.policy }
  const deps = {
    workspaceRoot: f.root, agent: { id: 'agent', session: {} }, sessionId: 'session', policy: () => state,
    sandbox: { async confine(argv, policy) {
      calls.confine.push({ argv, policy })
      return { argv: [...argv], enforcement: policy.mode === 'workspace-write' ? (options.writeEnforcement ?? 'full') : (options.enforcement ?? 'full'), denialSignatures: [] }
    } },
    subprocess: {
      spawn(spec) {
        calls.spawn.push(spec)
        const writing = spec.argv.includes('add') || spec.argv.includes('commit')
        if (writing) { calls.write++; options.onWrite?.(spec) }
        if (writing && options.spawnThrows) throw new Error('provider lost write launch result')
        const child = spawn(spec.argv[0], spec.argv.slice(1), {
          cwd: spec.cwd,
          // Deliberately MERGE hostile inherited env: env -i, not provider replacement, must stop it.
          env: { ...process.env, ...options.injectEnv, ...spec.env }, stdio: ['ignore', 'pipe', 'pipe'],
        })
        const buffers = { stdout: [], stderr: [] }
        const limits = { stdout: spec.stdio.stdout.maxBytes, stderr: spec.stdio.stderr.maxBytes }
        const size = { stdout: 0, stderr: 0 }
        for (const name of ['stdout', 'stderr']) child[name].on('data', bytes => {
          const remaining = limits[name] - size[name]
          if (remaining > 0) buffers[name].push(bytes.subarray(0, remaining))
          size[name] += bytes.length
        })
        const abort = () => child.kill('SIGTERM')
        spec.signal?.addEventListener('abort', abort, { once: true })
        if (spec.signal?.aborted) abort()
        const done = new Promise((resolve, reject) => {
          child.once('error', reject)
          child.once('close', (exitCode, sig) => { spec.signal?.removeEventListener('abort', abort); resolve({ exitCode, signal: sig }) })
        })
        if (writing) options.afterWriteSpawn?.(child)
        return {
          done, terminate: () => { child.kill('SIGTERM') }, waitForExit: async () => { await done; return true },
          collected: Object.fromEntries(['stdout', 'stderr'].map(name => [name, { readFrom() {
            const bytes = Buffer.concat(buffers[name])
            return { text: bytes.toString('utf8'), nextOffset: bytes.length, lossy: size[name] > limits[name] }
          } }])),
        }
      },
    },
    approval: options.noApproval ? undefined : { async request(input) {
      calls.approval.push(input)
      if (options.approve) return options.approve(input)
      return 'allowed-once'
    } },
  }
  const kernel = createLocalVersionControl(deps)
  const exec = (value, s = signal()) => kernel.execute({ repo: '.', ...value }, s)
  const snapshot = async () => {
    const result = await exec({ action: 'status' })
    assert.equal(result.status, 'succeeded', JSON.stringify(result))
    assert.match(result.expectedSnapshot, /^[a-f0-9]{64}$/)
    return result.expectedSnapshot
  }
  return { deps, calls, state, kernel, exec, snapshot }
}
async function stage(h, paths) { return h.exec({ action: 'stage', paths, expectedSnapshot: await h.snapshot() }) }

// These simulate the host services. They prove kernel gates/argv, NOT native host confinement.
test('literal argv, clean inherited env, normal remote, five actions and initial whole-index commit', async t => {
  const f = await fixture(t)
  const name = 'space ; $(sentinel).txt'
  await f.put(name, 'first\n'); await f.put('other.txt', 'already staged\n')
  f.git(['remote', 'add', 'origin', 'https://example.invalid/repo.git'])
  f.git(['add', '--', 'other.txt'])
  const h = host(f, { injectEnv: {
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true',
    GIT_DIR: '/nonexistent', GIT_WORK_TREE: '/nonexistent', GIT_INDEX_FILE: '/nonexistent',
    GIT_OBJECT_DIRECTORY: '/nonexistent', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/nonexistent',
    GIT_CONFIG_PARAMETERS: "'core.bare=true'", GIT_SSH_COMMAND: 'false', GIT_EXTERNAL_DIFF: 'false',
  } })
  const initial = await h.exec({ action: 'status' })
  assert.equal(initial.status, 'succeeded', JSON.stringify(initial)); assert.equal(initial.snapshot.head, null)
  assert.equal((await stage(h, [name])).status, 'succeeded')
  assert.equal((await h.exec({ action: 'diff', target: 'staged', paths: [name] })).status, 'succeeded')
  const result = await h.exec({ action: 'commit', message: 'fixture initial', expectedSnapshot: await h.snapshot() })
  assert.equal(result.status, 'succeeded', JSON.stringify(result))
  const approval = JSON.parse(h.calls.approval.at(-1).reason.split('\n').slice(1).join('\n'))
  assert.deepEqual(approval.entireIndex.map(e => e.path).sort(), [name, 'other.txt'].sort())
  assert.equal(approval.head, null); assert.ok(approval.indexPatch.includes('already staged'))
  assert.equal(f.git(['show', 'HEAD:other.txt']), 'already staged\n')
  assert.match((await h.exec({ action: 'log', count: 1 })).stdout, /fixture initial/)
  for (const spec of h.calls.spawn) {
    assert.deepEqual(spec.argv.slice(0, 2), ['/usr/bin/env', '-i'])
    assert.equal(spec.env, undefined); assert.equal(spec.cwd, f.root)
    assert.ok(spec.argv.includes('/usr/bin/git')); assert.ok(spec.argv.includes('GIT_ALLOW_PROTOCOL='))
    assert.ok(spec.argv.includes('GIT_NO_LAZY_FETCH=1'))
  }
  const add = h.calls.spawn.find(s => s.argv.includes('add'))
  assert.deepEqual(add.argv.slice(add.argv.indexOf('add')), ['add', '--', name])
  assert.ok(h.calls.confine.every(c => ['read-only', 'workspace-write'].includes(c.policy.mode)))
})

test('more than 100 explicit stage paths and more than 50 log entries remain bounded by actual output', async t => {
  const f = await fixture(t), h = host(f), paths = Array.from({ length: 101 }, (_, i) => `source-${i}.txt`)
  for (const path of paths) await f.put(path, 'source\n')
  assert.equal((await stage(h, paths)).status, 'succeeded')
  f.git(['commit', '--quiet', '-m', 'seed 101 files'])
  for (let i = 0; i < 50; i++) f.git(['commit', '--quiet', '--allow-empty', '-m', `history ${i}`])
  const result = await h.exec({ action: 'log', count: 51 })
  assert.equal(result.status, 'succeeded', JSON.stringify(result)); assert.equal((result.stdout.match(/^commit /gm) ?? []).length, 51)
})

test('normal large whole-index patch is approved completely above old 64KiB/128KiB gates', async t => {
  const f = await fixture(t), h = host(f), failures = []
  for (const size of [70 * 1024, 160 * 1024]) {
    const content = Array.from({ length: Math.ceil(size / 80) }, (_, i) => `${String(i).padStart(8, '0')} ${'normal text '.repeat(6)}\n`).join('')
    const path = `large-${size}.txt`
    await f.put(path, content); f.git(['add', '--', path])
    const patch = f.git(['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--'])
    const result = await h.exec({ action: 'commit', message: `normal patch ${size}`, expectedSnapshot: await h.snapshot() })
    t.diagnostic(`content=${Buffer.byteLength(content)} patch=${Buffer.byteLength(patch)} status=${result.status} gate=${result.message?.includes('approval plan too large') ? '64KiB reason' : result.message?.includes('read failed') ? '128KiB internal read' : 'none'}`)
    if (result.status !== 'succeeded') { failures.push(`patch=${Buffer.byteLength(patch)}: ${result.message?.slice(0, 80)}`); continue }
    const reason = h.calls.approval.at(-1).reason, plan = JSON.parse(reason.split('\n').slice(1).join('\n'))
    assert.equal(plan.indexPatch, patch); assert.ok(Buffer.byteLength(reason) > 64 * 1024)
    assert.equal(f.git(['show', `HEAD:${path}`]), content)
  }
  assert.deepEqual(failures, [])
})

test('status reads staged raw data above the display budget completely before creating a snapshot', async t => {
  const f = await fixture(t), h = host(f)
  await f.put('seed', 'seed'); f.git(['add', '--', 'seed']); f.git(['commit', '--quiet', '-m', 'seed'])
  const paths = Array.from({ length: 1400 }, (_, i) => `staged-${String(i).padStart(4, '0')}`)
  await Promise.all(paths.map(path => f.put(path, 'staged\n')))
  f.git(['add', '--', ...paths])
  const raw = f.git(['diff', '--cached', '--raw', '--no-abbrev', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--'])
  assert.ok(Buffer.byteLength(raw) > 128 * 1024)
  const observed = await h.exec({ action: 'status' })
  assert.equal(observed.status, 'succeeded', JSON.stringify(observed))
  assert.equal(observed.stdout.split('\0').filter(Boolean).length, paths.length)
  assert.ok(h.kernel.take(observed.expectedSnapshot))
  const spec = h.calls.spawn.find(s => s.argv.includes('--raw'))
  assert.equal(spec.stdio.stdout.maxBytes, 16 * 1024 * 1024)
})

test('normal commit records the whole actual index but leaves unrelated unstaged contents untouched', async t => {
  const f = await fixture(t)
  await f.put('x', 'old x'); await f.put('y', 'old y'); f.git(['add', '--', 'x', 'y']); f.git(['commit', '--quiet', '-m', 'fixture seed'])
  await f.put('x', 'staged x'); await f.put('y', 'unstaged y'); f.git(['add', '--', 'x'])
  const h = host(f)
  const result = await h.exec({ action: 'commit', message: 'actual index only', expectedSnapshot: await h.snapshot() })
  assert.equal(result.status, 'succeeded', JSON.stringify(result))
  assert.equal(f.git(['show', 'HEAD:x']), 'staged x'); assert.equal(f.git(['show', 'HEAD:y']), 'old y')
  assert.equal(await readFile(join(f.root, 'y'), 'utf8'), 'unstaged y')
  const plan = JSON.parse(h.calls.approval[0].reason.split('\n').slice(1).join('\n'))
  assert.ok(plan.head); assert.deepEqual(plan.entireIndex.map(e => e.path), ['x', 'y'])
  assert.ok(!plan.indexPatch.includes('unstaged y'))
})

test('closed schema rejects arbitrary commands/flags/revs/unknown keys before any subprocess', async t => {
  const f = await fixture(t), h = host(f)
  for (const input of [
    {}, { action: 'push' }, { action: 'tag' }, { action: 'status', command: 'pwd' },
    { action: 'log', count: 0 }, { action: 'log', count: 1.5 }, { action: 'log', count: 1, rev: 'other' },
    { action: 'diff', target: 'HEAD~1' }, { action: 'stage', paths: [], expectedSnapshot: 'x' },
    { action: 'stage', paths: ['x'], expectedSnapshot: 'x', runner: {} },
    { action: 'commit', message: 'x\ny', expectedSnapshot: 'x' },
    { action: 'status', repo: '../escape' }, { action: 'status', repo: '/tmp' },
  ]) assert.equal((await h.exec(input)).status, 'blocked', JSON.stringify(input))
  assert.equal(h.calls.spawn.length, 0); assert.equal(h.calls.approval.length, 0)
})

test('paths require exact files, reject directories/controls/git/escapes; tracked explicit deletion works', async t => {
  const f = await fixture(t); await f.put('dir/file', 'value'); const h = host(f)
  for (const path of ['dir', '*', 'dir/*', ':(literal)dir/file', '../x', '/etc/passwd', '.git/config', 'dir/../file', 'dir\\file', 'a\n', 'a\t', 'a\0', 'no-such', 'dir/']) {
    assert.equal((await h.exec({ action: 'stage', paths: [path], expectedSnapshot: await h.snapshot() })).status, 'blocked', path)
  }
  assert.equal(h.calls.write, 0)
  assert.equal((await stage(h, ['dir/file'])).status, 'succeeded')
  f.git(['commit', '--quiet', '-m', 'fixture seed'])
  await f.remove('dir/file')
  assert.equal((await stage(h, ['dir/file'])).status, 'succeeded')
  assert.match(f.git(['diff', '--cached', '--name-status']), /^D\s+dir\/file/)
  const deletion = await h.exec({ action: 'diff', target: 'staged', paths: ['dir/file'] })
  assert.equal(deletion.status, 'succeeded', JSON.stringify(deletion)); assert.match(deletion.stdout, /deleted file mode/)
})

test('ordinary symlink/index mode, ignored dependency links, hardlinks and POSIX literal filenames work; snapshots bind their content', async t => {
  const f = await fixture(t); await f.put('Nextpages/[id].tsx', 'page\n'); await f.put('.gitignore', 'dependencies/\n')
  await f.put('dependencies/original', 'hardlink content\n')
  await link(await f.target('dependencies/original'), await f.target('dependencies/hardlink'))
  await symlink('/nonexistent/outside', await f.target('dependencies/external'))
  await symlink('.', await f.target('dependencies/directory'))
  await symlink('Nextpages/[id].tsx', await f.target('page-link'))
  // Git does not follow .gitattributes symlinks in its worktree or index.
  await symlink('/nonexistent/attributes', await f.target('.gitattributes'))
  const names = ['literal:*?[]\\name', 'Nextpages/[id].tsx', 'page-link', '.gitattributes']
  await f.put(names[0], 'literal filename\n')
  const h = host(f)
  assert.equal((await stage(h, names)).status, 'succeeded')
  const plan = JSON.parse(h.calls.approval.at(-1).reason.split('\n').slice(1).join('\n'))
  assert.equal(plan.targets.find(e => e.path === 'page-link').linkTextBase64, Buffer.from('Nextpages/[id].tsx').toString('base64'))
  assert.equal((await h.exec({ action: 'commit', message: 'links and literal names', expectedSnapshot: await h.snapshot() })).status, 'succeeded')
  assert.match(f.git(['ls-files', '--stage']), /120000 .*\tpage-link/)
  assert.equal((await h.exec({ action: 'diff', target: 'staged', paths: ['Nextpages/[id].tsx'] })).status, 'succeeded')
  const token = await h.snapshot()
  await f.put('dependencies/hardlink', 'changed through alias\n')
  assert.equal((await h.exec({ action: 'stage', paths: ['Nextpages/[id].tsx'], expectedSnapshot: token })).status, 'blocked')
  const linkToken = await h.snapshot(), path = await f.target('page-link')
  assert.equal((await lstat(path)).isSymbolicLink(), true); await unlink(path); await symlink('different', path)
  assert.equal((await h.exec({ action: 'stage', paths: ['page-link'], expectedSnapshot: linkToken })).status, 'blocked')
  assert.equal((await stage(h, ['dependencies/directory/Nextpages/[id].tsx'])).status, 'blocked')
})

test('include, executable filter and unobserved layout configs fail before Git; sentinels untouched', async t => {
  for (const entry of [
    '[include]\n path = /tmp/elsewhere\n', '[includeIf "gitdir:*"]\n path = /tmp/elsewhere\n',
    '[filter "evil"]\n clean = ./sentinel\n', '[filter "evil"]\n process = ./sentinel\n',
    '[core]\n worktree = /tmp\n', '[core]\n repositoryformatversion = 1\n', '[extensions]\n partialClone = origin\n', '[remote "origin"]\n promisor = true\n',
  ]) {
    await t.test(entry.split('\n').slice(0, 2).join(' '), async t => {
      const f = await fixture(t)
      await f.put('sentinel', '#!/bin/sh\nprintf invoked > MARKER\n'); await chmod(await f.target('sentinel', { existing: true }), 0o755)
      await f.put('.git/config', (await readFile(join(f.root, '.git/config'), 'utf8')) + entry)
      const h = host(f), result = await h.exec({ action: 'status' })
      assert.equal(result.status, 'blocked', JSON.stringify(result)); assert.equal(h.calls.spawn.length, 0)
      await assert.rejects(lstat(join(f.root, 'MARKER')), { code: 'ENOENT' })
    })
  }
})

test('real hooks cannot run; worktree/info/index filter attrs without executable definitions are inert', async t => {
  const f = await fixture(t); await f.put('x', 'x')
  for (const hook of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'post-index-change', 'reference-transaction']) {
    await f.put(`.git/hooks/${hook}`, '#!/bin/sh\nprintf invoked > MARKER\nexit 1\n')
    await chmod(await f.target(`.git/hooks/${hook}`, { existing: true }), 0o755)
  }
  await f.put('.gitattributes', '*.txt text eol=lf\n')
  const h = host(f); assert.equal((await stage(h, ['x'])).status, 'succeeded')
  assert.equal((await h.exec({ action: 'commit', message: 'no hooks', expectedSnapshot: await h.snapshot() })).status, 'succeeded')
  await assert.rejects(lstat(join(f.root, 'MARKER')), { code: 'ENOENT' })
  for (const path of ['.gitattributes', '.git/info/attributes']) {
    await f.put(path, '* filter=evil\n')
    assert.equal((await h.exec({ action: 'status' })).status, 'succeeded')
    await f.put(path, '')
  }
  await f.put('.gitattributes', '* filter=evil\n'); f.git(['add', '--', '.gitattributes']); await f.remove('.gitattributes')
  assert.equal((await h.exec({ action: 'status' })).status, 'succeeded')
})

test('unsafe repository layouts/metadata fail before any Git', async t => {
  for (const path of ['.git/commondir', '.git/gitdir', '.git/objects/info/alternates', '.git/objects/info/http-alternates', '.git/info/grafts', '.git/objects/pack/a.promisor', '.git/sharedindex.x', '.git/config.worktree', '.git/objects/info/Alternates']) {
    await t.test(path, async t => {
      const f = await fixture(t); await f.put(path, 'unsafe\n')
      const h = host(f); assert.equal((await h.exec({ action: 'status' })).status, 'blocked'); assert.equal(h.calls.spawn.length, 0)
    })
  }
  await t.test('gitfile', async t => {
    const f = await fixture(t)
    const metadata = await f.target('.git', { existing: true })
    assert.ok(metadata === join(f.root, '.git') && within(f.root, metadata)); await rm(metadata, { recursive: true })
    await f.put('.git', 'gitdir: /tmp/other\n')
    const h = host(f); assert.equal((await h.exec({ action: 'status' })).status, 'blocked'); assert.equal(h.calls.spawn.length, 0)
  })
  await t.test('bare', async t => {
    const f = await fixture(t); f.git(['config', 'core.bare', 'true'])
    const h = host(f); assert.equal((await h.exec({ action: 'status' })).status, 'blocked'); assert.equal(h.calls.spawn.length, 0)
  })
})

test('a real shallow clone supports observation and local writes without fetch', async t => {
  const f = await fixture(t); await f.put('x', 'seed'); f.git(['add', '--', 'x']); f.git(['commit', '--quiet', '-m', 'seed'])
  const clone = await f.target('shallow')
  execFileSync('/usr/bin/git', ['clone', '--quiet', '--depth=1', `file://${f.root}`, clone], { cwd: f.root, env: { PATH: '/usr/bin:/bin', HOME: f.root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file' } })
  f.git(['-C', clone, 'config', 'user.name', 'Fixture']); f.git(['-C', clone, 'config', 'user.email', 'fixture@example.invalid'])
  await f.put('shallow/x', 'changed')
  const h = host(f), observed = await h.exec({ action: 'status', repo: 'shallow' })
  assert.equal(observed.status, 'succeeded', JSON.stringify(observed))
  assert.equal((await h.exec({ action: 'stage', repo: 'shallow', paths: ['x'], expectedSnapshot: observed.expectedSnapshot })).status, 'succeeded')
  const fresh = await h.exec({ action: 'status', repo: 'shallow' })
  assert.equal((await h.exec({ action: 'commit', repo: 'shallow', message: 'local shallow commit', expectedSnapshot: fresh.expectedSnapshot })).status, 'succeeded')
  assert.ok(h.calls.spawn.every(s => !s.argv.includes('fetch')))
})

test('gitlinks are observed and fully approved without reading external submodule metadata; critical metadata links fail closed', async t => {
  await t.test('gitlink', async t => {
    const f = await fixture(t); await f.put('x', 'x'); f.git(['add', '--', 'x']); f.git(['commit', '--quiet', '-m', 'fixture seed'])
    const old = f.git(['rev-parse', 'HEAD']).trim()
    f.git(['update-index', '--add', '--cacheinfo', `160000,${old},sub`]); f.git(['commit', '--quiet', '-m', 'seed gitlink'])
    await f.put('x', 'new'); f.git(['add', '--', 'x']); f.git(['commit', '--quiet', '-m', 'new object'])
    const next = f.git(['rev-parse', 'HEAD']).trim()
    await f.put('.gitmodules', '[submodule "sub"]\n path = sub\n url = https://example.invalid/sub\n')
    await f.put('sub/.git', 'gitdir: /nonexistent/external-submodule-metadata\n')
    f.git(['update-index', '--cacheinfo', `160000,${next},sub`])
    const h = host(f), observed = await h.exec({ action: 'status' })
    assert.equal(observed.status, 'succeeded', JSON.stringify(observed)); assert.ok(observed.stagedGitlinks.includes(old)); assert.ok(observed.stagedGitlinks.includes(next))
    assert.equal((await stage(h, ['sub'])).status, 'blocked'); assert.equal(h.calls.write, 0)
    assert.equal((await stage(h, ['.gitmodules'])).status, 'succeeded')
    const diff = await h.exec({ action: 'diff', target: 'staged', paths: ['sub'] })
    assert.equal(diff.status, 'succeeded', JSON.stringify(diff)); assert.ok(diff.stdout.includes(old)); assert.ok(diff.stdout.includes(next))
    const committed = await h.exec({ action: 'commit', message: 'approve gitlink OIDs', expectedSnapshot: await h.snapshot() })
    assert.equal(committed.status, 'succeeded', JSON.stringify(committed))
    const plan = JSON.parse(h.calls.approval.at(-1).reason.split('\n').slice(1).join('\n'))
    assert.ok(plan.indexPatch.includes(`-Subproject commit ${old}`)); assert.ok(plan.indexPatch.includes(`+Subproject commit ${next}`))
    assert.equal(plan.entireIndex.find(e => e.path === 'sub').mode, '160000')
  })
  await t.test('metadata symlink', async t => {
    const f = await fixture(t); await f.put('outside-config', await readFile(join(f.root, '.git/config'), 'utf8'))
    await f.remove('.git/config'); await symlink('../outside-config', await f.target('.git/config'))
    const h = host(f); assert.equal((await h.exec({ action: 'status' })).status, 'blocked'); assert.equal(h.calls.spawn.length, 0)
  })
  await t.test('workspace ancestor symlink', async t => {
    const f = await fixture(t); await symlink('.', await f.target('alias'))
    const h = host(f); h.deps.workspaceRoot = join(f.root, 'alias'); h.state.workspaceRoot = h.deps.workspaceRoot
    assert.equal((await h.exec({ action: 'status' })).status, 'blocked'); assert.equal(h.calls.spawn.length, 0)
  })
})

test('snapshots cannot be forged, crossed between instances or reused; pre-approval content changes fail', async t => {
  const f = await fixture(t); await f.put('x', 'x'); const h = host(f), other = host(f)
  assert.equal((await h.exec({ action: 'stage', paths: ['x'], expectedSnapshot: 'forged' })).status, 'blocked')
  const token = await h.snapshot()
  assert.equal((await other.exec({ action: 'stage', paths: ['x'], expectedSnapshot: token })).status, 'blocked')
  await f.put('x', 'changed')
  assert.equal((await h.exec({ action: 'stage', paths: ['x'], expectedSnapshot: token })).status, 'blocked')
  assert.equal(h.calls.approval.length, 0)
  const fresh = await h.snapshot()
  assert.equal((await h.exec({ action: 'stage', paths: ['x'], expectedSnapshot: fresh })).status, 'succeeded')
  assert.equal((await h.exec({ action: 'stage', paths: ['x'], expectedSnapshot: fresh })).status, 'blocked')
})

test('approval-time tree/index/HEAD/config/attributes/policy changes are denied without write retry', async t => {
  for (const kind of ['tree', 'index', 'HEAD', 'config', 'attributes', 'policy']) {
    await t.test(kind, async t => {
      const f = await fixture(t); await f.put('x', 'x')
      let h
      h = host(f, { approve: async () => {
        if (kind === 'tree') await f.put('x', 'changed')
        if (kind === 'index') f.git(['add', '--', 'x'])
        if (kind === 'HEAD') await f.put('.git/HEAD', 'ref: refs/heads/other\n')
        if (kind === 'config') await f.put('.git/config', (await readFile(join(f.root, '.git/config'), 'utf8')) + '[user]\n name = Changed\n')
        if (kind === 'attributes') await f.put('.gitattributes', '* -text\n')
        if (kind === 'policy') h.state.mode = 'read-only'
        return 'allowed-once'
      } })
      const result = await stage(h, ['x'])
      assert.equal(result.status, 'blocked', JSON.stringify(result)); assert.equal(h.calls.write, 0); assert.equal(h.calls.approval.length, 1)
    })
  }
})

test('approval absent/exception/rejection/cancel/unavailable/permanent grant all fail closed', async t => {
  for (const outcome of ['absent', 'exception', 'rejected', 'cancelled', 'unavailable', 'allowed-always']) {
    await t.test(outcome, async t => {
      const f = await fixture(t); await f.put('x', 'x')
      const h = host(f, { noApproval: outcome === 'absent', approve: async () => {
        if (outcome === 'exception') throw new Error('service down')
        return outcome
      } })
      assert.equal((await stage(h, ['x'])).status, 'blocked'); assert.equal(h.calls.write, 0)
    })
  }
})

test('parent read-only and partial native enforcement never write or ask approval', async t => {
  for (const options of [{ policy: { mode: 'read-only' } }, { writeEnforcement: 'partial' }, { enforcement: 'partial' }]) {
    const f = await fixture(t); await f.put('x', 'x'); const h = host(f, options)
    const observed = await h.exec({ action: 'status' })
    const result = await h.exec({ action: 'stage', paths: ['x'], expectedSnapshot: observed.expectedSnapshot ?? 'none' })
    assert.equal(result.status, 'blocked'); assert.equal(h.calls.write, 0); assert.equal(h.calls.approval.length, 0)
  }
})

test('empty/no-change/conflicted index rejected; existing locks respected and never removed', async t => {
  const f = await fixture(t), h = host(f)
  assert.equal((await h.exec({ action: 'commit', message: 'empty', expectedSnapshot: await h.snapshot() })).status, 'blocked')
  await f.put('x', 'x'); assert.equal((await stage(h, ['x'])).status, 'succeeded')
  f.git(['commit', '--quiet', '-m', 'fixture seed'])
  assert.equal((await h.exec({ action: 'commit', message: 'unchanged', expectedSnapshot: await h.snapshot() })).status, 'blocked')
  await f.put('.git/index.lock', 'owner lock')
  assert.equal((await stage(h, ['x'])).status, 'blocked')
  assert.equal(await readFile(join(f.root, '.git/index.lock'), 'utf8'), 'owner lock')
  await f.remove('.git/index.lock')
  const oid = f.git(['rev-parse', 'HEAD:x']).trim()
  f.git(['update-index', '--force-remove', '--', 'x'])
  // Explicit temp index conflict via a fixture-only command, not a kernel escape hatch.
  assert.equal(await realpath(f.root), f.root)
  await f.target('.git/index', { existing: true })
  execFileSync('/usr/bin/git', ['update-index', '--index-info'], { cwd: f.root, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, input: `100644 ${oid} 1\tx\n100644 ${oid} 2\tx\n` })
  assert.equal((await h.exec({ action: 'status' })).status, 'blocked')
})

test('lost provider write launch is effect-unknown, never a retryable blocked write', async t => {
  const f = await fixture(t); await f.put('x', 'x')
  const h = host(f, { spawnThrows: true })
  const result = await stage(h, ['x'])
  assert.equal(result.status, 'effect-unknown', JSON.stringify(result)); assert.equal(h.calls.write, 1)
})

test('snapshot lifetime and calling session are enforced independently of prompt facts', async t => {
  const f = await fixture(t); await f.put('x', 'x'); const h = host(f)
  const token = await h.snapshot(), now = Date.now
  try {
    Date.now = () => now() + 6 * 60_000
    assert.equal((await h.exec({ action: 'stage', paths: ['x'], expectedSnapshot: token })).status, 'blocked')
  } finally { Date.now = now }
  const fresh = await h.snapshot()
  h.deps.agent.session = { otherSession: true }
  assert.equal((await h.exec({ action: 'stage', paths: ['x'], expectedSnapshot: fresh })).status, 'blocked')
  assert.equal(h.calls.write, 0); assert.equal(h.calls.approval.length, 0)
})

test('snapshot expiry during approval cannot authorize a later write', async t => {
  const f = await fixture(t); await f.put('x', 'x'); const now = Date.now
  const h = host(f, { approve: async () => { Date.now = () => now() + 6 * 60_000; return 'allowed-once' } })
  try {
    const result = await stage(h, ['x'])
    assert.equal(result.status, 'blocked', JSON.stringify(result)); assert.equal(h.calls.write, 0)
  } finally { Date.now = now }
})

test('same repo is serialized across kernel instances; second request observes first write', async t => {
  const f = await fixture(t); await f.put('x', 'x')
  let entered, release
  const atApproval = new Promise(resolve => { entered = resolve })
  const held = new Promise(resolve => { release = resolve })
  const first = host(f, { approve: async () => { entered(); await held; return 'allowed-once' } }), second = host(f)
  const token = await first.snapshot()
  const writing = first.exec({ action: 'stage', paths: ['x'], expectedSnapshot: token })
  await atApproval
  const observing = second.exec({ action: 'status' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(second.calls.spawn.length, 0)
  release()
  assert.equal((await writing).status, 'succeeded')
  const result = await observing
  assert.equal(result.status, 'succeeded', JSON.stringify(result)); assert.match(result.stdout, /^A  x/)
})

test('lock acquired during approval is preserved and prevents writes', async t => {
  const f = await fixture(t); await f.put('x', 'x')
  const h = host(f, { approve: async () => { await f.put('.git/index.lock', 'concurrent owner'); return 'allowed-once' } })
  assert.equal((await stage(h, ['x'])).status, 'blocked'); assert.equal(h.calls.write, 0)
  assert.equal(await readFile(join(f.root, '.git/index.lock'), 'utf8'), 'concurrent owner')
})

test('cancellation during write returns effect-unknown and does not retry', async t => {
  const f = await fixture(t); await f.put('x', 'x'); const controller = new AbortController()
  const h = host(f, { afterWriteSpawn: () => controller.abort() })
  const result = await h.exec({ action: 'stage', paths: ['x'], expectedSnapshot: await h.snapshot() }, controller.signal)
  assert.equal(result.status, 'effect-unknown', JSON.stringify(result)); assert.equal(h.calls.write, 1)
  assert.equal((await h.exec({ action: 'status' })).status, 'succeeded')
})

test('no artificial repository quota: >64 MiB total, >8 MiB file and >20k entries observe and bind changes', async t => {
  const f = await fixture(t), h = host(f), started = Date.now()
  const big = Buffer.alloc(9 * 1024 * 1024, 0x61)
  await f.put('.gitignore', 'cache/\n')
  for (let i = 0; i < 8; i++) await f.put(`cache/big-${i}.bin`, big) // 72 MiB total, each 9 MiB
  await mkdir(await f.target('cache/many'), { recursive: true })
  for (let i = 0; i < 20_050; i += 500) await Promise.all(Array.from({ length: Math.min(500, 20_050 - i) }, (_, j) => writeFile(join(f.root, 'cache/many', `f${i + j}`), '')))
  const setup = Date.now()
  // expectedSnapshot is a random token; take() exposes the observed tree so the real full-content digest can be checked.
  const before = await h.exec({ action: 'status' })
  assert.equal(before.status, 'succeeded', JSON.stringify(before))
  const observed = Date.now()
  const first = h.kernel.take(before.expectedSnapshot)
  assert.ok(first, 'status snapshot must be retrievable through take()')
  assert.equal(first.state.files.size, 20_059) // .gitignore + 8 big files + 20,050 entries
  assert.equal(first.state.files.get('cache/many/f20049'), createHash('sha256').update('').digest('hex'))
  const firstDigest = createHash('sha256').update(big).digest('hex')
  assert.equal(first.state.files.get('cache/big-7.bin'), firstDigest)
  big[big.length - 1] = 0x62
  await f.put('cache/big-7.bin', big) // same size, last byte differs: full-content hash must change
  const after = await h.exec({ action: 'status' })
  assert.equal(after.status, 'succeeded', JSON.stringify(after))
  const second = h.kernel.take(after.expectedSnapshot)
  assert.ok(second, 'status snapshot must be retrievable through take()')
  assert.equal(second.state.files.size, 20_059)
  const secondDigest = createHash('sha256').update(big).digest('hex')
  assert.notEqual(firstDigest, secondDigest) // independent whole-buffer hashes, not tree digests (mtime/ctime)
  assert.equal(second.state.files.get('cache/big-7.bin'), secondDigest)
  t.diagnostic(`setup ${setup - started}ms, observe ${observed - setup}ms, re-observe ${Date.now() - observed}ms`)
})
