import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
const scripts = [...workflow.matchAll(/node --input-type=module <<'JS'\n([\s\S]*?)\n          JS/g)]
  .map(match => match[1].replace(/^          /gm, '').replace(/^import .*$/gm, ''))

function validateVersion(version, tag = `v${version}`, lockVersion = version, rootVersion = version) {
  vm.runInNewContext(scripts[0], {
    assert,
    process: { env: { RELEASE_TAG: tag } },
    readFileSync: path => JSON.stringify(path === 'package.json'
      ? { version } : { version: lockVersion, packages: { '': { version: rootVersion } } }),
  })
}

test('release workflow validates stable/prerelease SemVer, tag and both lockfile versions', () => {
  assert.equal(scripts.length, 2)
  for (const version of ['0.1.0', '1.2.3-rc.1', '1.2.3-0', '1.2.3-alpha-beta']) validateVersion(version)
  for (const version of ['01.2.3', '1.2', '1.2.3-01', '1.2.3+build', '1.2.3-']) {
    assert.throws(() => validateVersion(version))
  }
  assert.throws(() => validateVersion('1.2.3', 'v1.2.4'))
  assert.throws(() => validateVersion('1.2.3', 'v1.2.3', '1.2.2'))
  assert.throws(() => validateVersion('1.2.3', 'v1.2.3', '1.2.3', '1.2.2'))
})

const files = [
  'lib/plugin.js', 'lib/slots/index.js', 'lib/node/index.js', 'lib/android/index.js',
  'cordis.patch.yml', 'package.json', 'README.md', 'LICENSE',
  ...['', 'slots/', 'node/', 'android/'].flatMap(prefix =>
    ['icon.svg', 'locale/en.json', 'locale/zh.json'].map(path => prefix + path)),
  'node/skills/example/SKILL.md', 'android/skills/example/SKILL.md',
]
function validatePack(paths) {
  const renames = []
  vm.runInNewContext(scripts[1], {
    assert,
    readFileSync: () => JSON.stringify([{ filename: 'satellite-0.1.0.tgz', files: paths.map(path => ({ path })) }]),
    renameSync: (...args) => renames.push(args),
  })
  assert.deepEqual(renames, [['satellite-0.1.0.tgz', 'release.tgz']])
}

test('release workflow requires all entrypoints/resources and excludes source files', () => {
  validatePack(files)
  for (const missing of files) assert.throws(() => validatePack(files.filter(path => path !== missing)), missing)
  assert.throws(() => validatePack([...files, 'src/plugin.ts']))
  assert.throws(() => validatePack([...files, 'test/package.test.mjs']))
})
