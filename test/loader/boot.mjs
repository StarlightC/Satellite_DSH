// Boot the real DSH 0.2.2-alpha.3 headless profile composition from the
// target DSH source checkout (default ../deepseek-harness at 8bd0733, read
// only; override with DSH_SOURCE) through the public @deepseek-ai/dsh-app-boot
// Loader path. The Satellite bundle is installed into an isolated temporary
// profile the way a profile install projects it: the packed files under
// profile/node_modules/satellite and its four peer dependencies linked to the
// installation's own copies, so Cordis and every DSH service is one instance.
// Adapted from DSH's repository-only loader-smoke
// `tests/fixtures/production-profile.ts`.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { isInside, worldLayout } from './world-layout.mjs'

export const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const DSH_SOURCE = resolve(process.env.DSH_SOURCE ?? join(PACKAGE_ROOT, '..', 'deepseek-harness'))
/** The DSH app package; its package.json is the installation anchor. */
export const INSTALL_ANCHOR = join(DSH_SOURCE, 'apps', 'cli', 'package.json')
export const OVERLAY = fileURLToPath(new URL('./fixtures/satellite-headless.patch.yml', import.meta.url))
const BIN = 'satellite-loader-test'
const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'satellite']
const PEERS = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/schemastery']
/** Workspace anchors whose declared dependencies expose the public packages the test needs. */
const ANCHORS = [
  INSTALL_ANCHOR,
  join(DSH_SOURCE, 'packages', 'test-support', 'loader-smoke', 'package.json'),
  // A shipped base-bundle row that declares the typert protocol package.
  join(DSH_SOURCE, 'packages', 'api', 'gateway', 'package.json'),
]

if (!existsSync(INSTALL_ANCHOR)) throw new Error(`DSH source checkout not found: ${INSTALL_ANCHOR} (set DSH_SOURCE)`)

/** Package directory of a DSH package as the installation resolves it. */
export function dshPackageDir(name) {
  for (const anchor of ANCHORS) {
    let entry
    try { entry = realpathSync(createRequire(anchor).resolve(name)) } catch { continue }
    for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir)) {
      const manifest = join(dir, 'package.json')
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) return dir
    }
  }
  throw new Error(`cannot resolve ${name} from the DSH installation`)
}

/** Import a public DSH package entry exactly as the installation resolves it. */
export async function importDsh(name) {
  for (const anchor of ANCHORS) {
    let path
    try { path = createRequire(anchor).resolve(name) } catch { continue }
    return import(pathToFileURL(path).href)
  }
  throw new Error(`cannot import ${name} from the DSH installation`)
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim()
}

/** Temporary world: DSH home (with its session root), a profile with the packed Satellite bundle, and a fresh git repo as cwd. */
export function createWorld() {
  const { root, home, sessions, profileDir, repo } = worldLayout(realpathSync(mkdtempSync(join(tmpdir(), 'satellite-loader-'))))
  if (isInside(repo, sessions)) throw new Error(`session root ${sessions} must lie outside the repo ${repo}`)
  const modules = join(profileDir, 'node_modules')
  const staged = join(modules, 'satellite')
  mkdirSync(join(modules, '@deepseek-ai'), { recursive: true })
  mkdirSync(repo, { recursive: true })
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  // The published file set (package.json `files`), without the dev node_modules.
  for (const entry of ['package.json', 'lib', 'icon.svg', 'locale', 'cordis.patch.yml', 'slots', 'node', 'android']) {
    cpSync(join(PACKAGE_ROOT, entry), join(staged, entry), { recursive: true })
  }
  for (const peer of PEERS) symlinkSync(dshPackageDir(peer), join(modules, peer), 'dir')
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'satellite-test-profile', private: true,
    dependencies: { satellite: pkg.version },
    dsh: { profile: { bundles: BUNDLES } },
  }, null, 2)}\n`)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'loader@test.invalid')
  git(repo, 'config', 'user.name', 'Loader Test')
  writeFileSync(join(repo, 'README.md'), 'seed\n')
  git(repo, 'add', 'README.md')
  git(repo, 'commit', '-q', '-m', 'seed')
  return { root, home, sessions, profileDir, staged, repo, git: (...args) => git(repo, ...args) }
}

/** Boot the composed tree; resolves to the settled Loader root context. */
export async function bootSatellite(world) {
  const { boot, createRuntimeResolution, loadOverlayPatches, loadProfileDirectory, PluginPackages } = await importDsh('@deepseek-ai/dsh-app-boot')
  process.env.DSH_HOME = world.home
  process.env.DSH_AGENTS_HOME = join(world.home, 'agents')
  process.env.DSH_TELEMETRY_DISABLED = '1'
  delete process.env.DSH_PERMISSION_MODE
  process.chdir(world.repo)
  const profile = loadProfileDirectory(BIN, world.profileDir, INSTALL_ANCHOR, { userLayer: false })
  if (profile.skippedBundles.length > 0) throw new Error(`skipped bundles: ${JSON.stringify(profile.skippedBundles)}`)
  const rootConfig = join(world.profileDir, 'cordis.yml')
  writeFileSync(rootConfig, '[]\n')
  const overlay = loadOverlayPatches(BIN, OVERLAY)
  const resolution = await createRuntimeResolution({ installAnchor: INSTALL_ANCHOR, profile, home: world.home })
  return boot(BIN, rootConfig, [...profile.layers.flatMap((layer) => layer.patches), ...overlay], async (ctx) => {
    ctx.provide('profileContext', {
      name: 'satellite-test', dir: profile.dir, patchPath: profile.patchPath, installAnchor: INSTALL_ANCHOR,
      cwd: world.repo, home: world.home,
      startedBundles: profile.layers.map((layer) => layer.packageName),
      overlays: overlay, telemetryDisabledEnv: '1',
    })
    await ctx.plugin(PluginPackages, { resolution })
  })
}
