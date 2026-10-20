import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
function stableVersion(value) {
  assert.match(value, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  return value.split('.').map(BigInt)
}
function compareVersions(left, right) {
  const a = stableVersion(left), b = stableVersion(right)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
  return 0
}

function validatePackage(contents, version) {
  const pkg = readJson(join(contents, 'package.json'))
  assert.equal(pkg.name, 'satellite', 'Unexpected package name')
  assert.equal(pkg.version, version, 'Package version must match release tag')
  const file = entry => assert.ok(existsSync(join(contents, entry)) && lstatSync(join(contents, entry)).isFile(), `Missing file: ${entry}`)
  for (const entry of ['lib/plugin.js', 'lib/slots/index.js', 'lib/node/index.js', 'lib/android/index.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE']) file(entry)
  for (const prefix of ['', 'slots/', 'node/', 'android/']) {
    file(`${prefix}icon.svg`)
    const locale = join(contents, prefix, 'locale')
    assert.ok(existsSync(locale) && lstatSync(locale).isDirectory(), `Missing directory: ${prefix}locale`)
    file(`${prefix}locale/en.json`)
    file(`${prefix}locale/zh.json`)
  }
  for (const entry of ['node/skills', 'android/skills']) {
    const directory = join(contents, entry)
    const hasSkill = path => readdirSync(path, { withFileTypes: true }).some(child =>
      child.isFile() ? child.name === 'SKILL.md' : child.isDirectory() && hasSkill(join(path, child.name)))
    assert.ok(existsSync(directory) && lstatSync(directory).isDirectory() && hasSkill(directory), `Missing skills: ${entry}`)
  }
  const allowed = ['lib', 'package.json', 'README.md', 'LICENSE', 'cordis.patch.yml', 'icon.svg', 'locale', 'slots', 'node', 'android']
  for (const entry of readdirSync(contents)) assert.ok(allowed.includes(entry), `Unexpected published entry: ${entry}`)
  for (const entry of ['slots', 'node', 'android']) {
    for (const child of readdirSync(join(contents, entry))) {
      assert.ok(['icon.svg', 'locale', ...(entry === 'slots' ? [] : ['skills'])].includes(child), `Unexpected published entry: ${entry}/${child}`)
    }
  }
  function checkTree(directory) {
    for (const entry of readdirSync(directory)) {
      assert.notEqual(entry.toLowerCase(), '.git', 'Package cannot contain Git metadata')
      const path = join(directory, entry), stat = lstatSync(path)
      assert.ok(stat.isFile() || stat.isDirectory(), `Unsupported package entry: ${path}`)
      if (stat.isDirectory()) checkTree(path)
    }
  }
  checkTree(contents)
}

/** Publish the Release tarball as an artifact-only, fast-forward main commit. */
export function publishMain({ cwd = process.cwd(), asset, tag, sourceCommit }) {
  assert.equal(typeof tag, 'string', 'RELEASE_TAG is required')
  // Prereleases never inspect the asset or contact origin.
  if (/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-[0-9A-Za-z.-]+(?:\+[0-9A-Za-z.-]+)?$/.test(tag)) return 'prerelease'
  const version = tag.replace(/^v/, '')
  stableVersion(version)
  assert.equal(tag, `v${version}`)
  assert.match(sourceCommit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
  const git = (args, options = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim()
  const tempParent = realpathSync(tmpdir())
  const temp = mkdtempSync(join(tempParent, 'satellite-publish-'))
  try {
    const archive = resolve(cwd, asset)
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n')
    for (const entry of entries) {
      assert.ok(entry.startsWith('package/') && !entry.split('/').includes('..'), `Unsafe archive entry: ${entry}`)
    }
    execFileSync('tar', ['-xzf', archive, '-C', temp])
    const contents = join(temp, 'package')
    validatePackage(contents, version)
    let parent
    if (git(['ls-remote', '--heads', 'origin', 'refs/heads/main'])) {
      git(['fetch', '--no-tags', 'origin', 'refs/heads/main'])
      parent = git(['rev-parse', 'FETCH_HEAD'])
      if (git(['ls-tree', '--name-only', parent, '--', '.release.json'])) {
        const previous = JSON.parse(git(['show', `${parent}:.release.json`]))
        const order = compareVersions(previous.version, version)
        if (order > 0) return 'older-version'
        if (order === 0) {
          assert.equal(previous.tag, tag)
          assert.equal(previous.sourceCommit, sourceCommit, 'A published version cannot point to another source commit')
          return 'already-published'
        }
      }
    }
    writeFileSync(join(contents, '.release.json'), JSON.stringify({ version, tag, sourceCommit }, null, 2) + '\n')
    // A private index builds a fresh artifact tree without changing HEAD, the user's
    // index or worktree. With no main yet, commit-tree creates an independent root.
    const env = { ...process.env, GIT_INDEX_FILE: join(temp, 'index') }
    const indexGit = args => git(['--git-dir', git(['rev-parse', '--absolute-git-dir']), '--work-tree', contents, ...args], { cwd: contents, env })
    indexGit(['read-tree', '--empty'])
    indexGit(['add', '--force', '--all'])
    const tree = indexGit(['write-tree'])
    const commit = git(['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `release: ${tag}`])
    // No force/lease: a concurrent writer causes rejection, never history loss.
    git(['push', 'origin', `${commit}:refs/heads/main`])
    return 'published'
  } finally {
    // Verify the exact mkdtemp target immediately before recursive deletion.
    assert.equal(dirname(temp), tempParent)
    assert.ok(basename(temp).startsWith('satellite-publish-'))
    assert.equal(realpathSync(temp), temp)
    rmSync(temp, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(publishMain({ asset: process.argv[2], tag: process.env.RELEASE_TAG, sourceCommit: process.env.SOURCE_COMMIT }))
}
