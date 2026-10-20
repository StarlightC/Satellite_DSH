import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { publishMain } from '../scripts/publish-main.mjs'

const resources = {
  'lib/plugin.js': 'export const name = "satellite"',
  'lib/slots/index.js': 'export {}',
  'lib/node/index.js': 'export {}',
  'lib/android/index.js': 'export {}',
  'cordis.patch.yml': '[]',
  'icon.svg': '<svg/>',
  'locale/en.json': '{}',
  'locale/zh.json': '{}',
  'slots/icon.svg': '<svg/>',
  'slots/locale/en.json': '{}',
  'slots/locale/zh.json': '{}',
  'node/icon.svg': '<svg/>',
  'node/locale/en.json': '{}',
  'node/locale/zh.json': '{}',
  'node/skills/example/SKILL.md': '# Node skill',
  'android/icon.svg': '<svg/>',
  'android/locale/en.json': '{}',
  'android/locale/zh.json': '{}',
  'android/skills/example/SKILL.md': '# Android skill',
  'README.md': '# Satellite',
  'LICENSE': 'MIT',
}

function fixture(t, existingMain = false) {
  const parent = realpathSync(tmpdir())
  const root = mkdtempSync(join(parent, 'satellite-release-test-'))
  t.after(() => {
    assert.equal(dirname(root), parent)
    assert.ok(basename(root).startsWith('satellite-release-test-'))
    assert.equal(realpathSync(root), root)
    rmSync(root, { recursive: true, force: true })
  })
  const repo = join(root, 'source checkout'), remote = join(root, 'remote.git')
  mkdirSync(repo)
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(['init', '--bare', remote])
  git(['init', '-b', 'source'])
  git(['config', 'user.name', 'Release Test'])
  git(['config', 'user.email', 'release-test@example.invalid'])
  writeFileSync(join(repo, 'source-only.txt'), 'source')
  writeFileSync(join(repo, '.gitignore'), 'lib/\n')
  const excludes = join(root, 'git-excludes')
  writeFileSync(excludes, 'lib/\n')
  git(['config', 'core.excludesFile', excludes])
  git(['add', '.'])
  git(['commit', '-m', 'initial source'])
  const sourceCommit = git(['rev-parse', 'HEAD'])
  git(['remote', 'add', 'origin', remote])
  if (existingMain) git(['push', 'origin', 'HEAD:refs/heads/main'])
  // Publishing must also leave staged, unstaged and untracked user work alone.
  writeFileSync(join(repo, 'source-only.txt'), 'staged change')
  git(['add', '.'])
  writeFileSync(join(repo, 'source-only.txt'), 'unstaged change')
  writeFileSync(join(repo, 'untracked.txt'), 'untracked')
  const status = git(['status', '--porcelain'])
  const index = readFileSync(join(repo, '.git/index'))
  let counter = 0, asset
  const pack = (version = '0.1.0', { omit = [], name = 'satellite', extra = {} } = {}) => {
    const staging = join(root, `asset-${counter++}`), contents = join(staging, 'package')
    mkdirSync(contents, { recursive: true })
    const files = { ...resources, ...extra, 'package.json': JSON.stringify({ name, version }) }
    for (const [entry, value] of Object.entries(files)) {
      if (omit.some(path => entry === path || entry.startsWith(`${path}/`))) continue
      const target = join(contents, entry)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, value)
    }
    asset = join(staging, 'satellite.tgz')
    execFileSync('tar', ['-czf', asset, '-C', staging, 'package'])
  }
  const publish = (tag = 'v0.1.0', commit = sourceCommit) => publishMain({ cwd: repo, asset, tag, sourceCommit: commit })
  const tip = () => git(['ls-remote', '--heads', 'origin', 'refs/heads/main']).split(/\s/)[0]
  const unchanged = () => {
    assert.equal(git(['branch', '--show-current']), 'source')
    assert.equal(git(['rev-parse', 'HEAD']), sourceCommit)
    assert.equal(git(['status', '--porcelain']), status)
    assert.deepEqual(readFileSync(join(repo, '.git/index')), index)
    assert.equal(readFileSync(join(repo, 'source-only.txt'), 'utf8'), 'unstaged change')
    assert.equal(git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1)
  }
  return { git, pack, publish, tip, unchanged, sourceCommit, repo }
}

for (const existingMain of [false, true]) {
  test(existingMain ? 'existing main advances without rewriting history' : 'first release creates an independent artifact main', t => {
    const f = fixture(t, existingMain)
    f.pack()
    assert.equal(f.publish(), 'published')
    const first = f.tip()
    assert.equal(f.git(['show', '-s', '--format=%P', first]), existingMain ? f.sourceCommit : '')
    assert.deepEqual(f.git(['ls-tree', '-r', '--name-only', first]).split('\n').sort(), [...Object.keys(resources), 'package.json', '.release.json'].sort())
    assert.deepEqual(JSON.parse(f.git(['show', `${first}:.release.json`])), { version: '0.1.0', tag: 'v0.1.0', sourceCommit: f.sourceCommit })
    assert.equal(f.publish(), 'already-published')
    assert.equal(f.tip(), first)
    assert.throws(() => f.publish('v0.1.0', 'a'.repeat(40)), /another source commit/)
    assert.equal(f.tip(), first)
    f.pack('0.2.0')
    assert.equal(f.publish('v0.2.0'), 'published')
    const second = f.tip()
    assert.equal(f.git(['show', '-s', '--format=%P', second]), first)
    assert.equal(f.git(['merge-base', first, second]), first)
    f.pack('0.1.0')
    assert.equal(f.publish(), 'older-version')
    assert.equal(f.tip(), second)
    f.unchanged()
  })
}

test('invalid package entries, name and version are rejected without creating main', t => {
  const f = fixture(t)
  for (const missing of [...Object.keys(resources), 'locale', 'slots/locale', 'node/skills', 'android/skills']) {
    f.pack('0.1.0', { omit: [missing] })
    assert.throws(() => f.publish(), /Missing/)
    assert.equal(f.tip(), '')
  }
  for (const prefix of ['node', 'android']) {
    f.pack('0.1.0', { omit: [`${prefix}/skills/example/SKILL.md`], extra: { [`${prefix}/skills/placeholder.txt`]: 'not a skill' } })
    assert.throws(() => f.publish(), /Missing skills/)
  }
  f.pack('0.1.0', { name: 'dsh-oauth' })
  assert.throws(() => f.publish(), /Unexpected package name/)
  f.pack('0.2.0')
  assert.throws(() => f.publish(), /Package version must match/)
  for (const extra of [{ 'src/index.ts': 'source' }, { 'node/index.ts': 'source' }]) {
    f.pack('0.1.0', { extra })
    assert.throws(() => f.publish(), /Unexpected published entry/)
  }
  assert.equal(f.tip(), '')
  f.unchanged()
})

test('invalid release inputs are rejected', t => {
  const f = fixture(t)
  f.pack()
  for (const tag of ['0.1.0', 'v01.1.0', 'v0.1', 'garbage-beta', 'v0.1.0+build']) assert.throws(() => f.publish(tag))
  for (const commit of ['bad', 'a'.repeat(41)]) assert.throws(() => f.publish('v0.1.0', commit))
  assert.equal(f.tip(), '')
  f.unchanged()
})

test('prereleases skip without an asset, repository or remote access', () => {
  assert.equal(publishMain({ cwd: '/nonexistent/satellite-publish-test', tag: 'v0.2.0-beta.1' }), 'prerelease')
})

test('prerelease leaves existing main and the source worktree untouched', t => {
  const f = fixture(t, true)
  const previous = f.tip()
  assert.equal(f.publish('v0.2.0-rc.1'), 'prerelease')
  assert.equal(f.tip(), previous)
  f.unchanged()
})
