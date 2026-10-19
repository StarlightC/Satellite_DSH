import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createReuseIndex, REUSE_INDEX_PATH, REUSE_OVERRIDES_PATH, REUSE_LIMITS } from '../src/node/lib/reuse-index.ts'
import { extractAndroidReuseSource, ANDROID_REUSE_SOURCE_REVISION } from '../src/android/lib/reuse-source.ts'

// In-memory DSH filesystem port: no real project is scanned or initialized by these tests.
class MemoryFs {
  files = new Map()
  links = new Map()
  directories = new Set(['/project', '/other'])
  writes = []
  reads = []
  sequence = 0
  beforeWrite
  put(name, content) { this.files.set(name, { content, version: `v${++this.sequence}` }) }
  async resolve(value, opts = {}) {
    let name = path.posix.resolve(opts.cwd ?? '/project', value)
    for (const [alias, target] of this.links) if (name === alias || name.startsWith(`${alias}/`)) name = target + name.slice(alias.length)
    return { targetKey: name, displayPath: name }
  }
  processPath(target) { return target.targetKey }
  contains(root, target) { return target.targetKey === root.targetKey || target.targetKey.startsWith(`${root.targetKey}/`) }
  async stat(target, signal) {
    signal?.throwIfAborted()
    const file = this.files.get(target.targetKey)
    return file ? { type: 'file', version: file.version, size: Buffer.byteLength(file.content) }
      : this.directories.has(target.targetKey) ? { type: 'directory', version: 'directory' } : undefined
  }
  async readBytes(target, signal, maxBytes) {
    signal?.throwIfAborted()
    this.reads.push(target.targetKey)
    const content = Buffer.from(this.files.get(target.targetKey).content)
    if (content.length > maxBytes) throw new Error('FS_TOO_LARGE')
    return content
  }
  async writeText(target, content, expected, signal, policy) {
    signal?.throwIfAborted()
    await this.beforeWrite?.()
    const current = this.files.get(target.targetKey)
    if (expected.kind === 'createIfAbsent' ? current !== undefined : current?.version !== expected.version) throw new Error('FS_STALE_VERSION')
    assert.notEqual(policy.mode, 'read-only')
    this.writes.push({ target: target.targetKey, expected, policy })
    this.put(target.targetKey, content)
  }
}
const signal = () => new AbortController().signal
const SOURCE = 'app/src/main/java/example/Shared.kt'
const SECOND = 'app/src/main/java/example/Other.kt'
const INDEX = `/project/${REUSE_INDEX_PATH}`
const OVERRIDES = `/project/${REUSE_OVERRIDES_PATH}`
const source = name => `package example\n@Composable\nfun ${name}() = Unit\n`
function fixture(options = {}) {
  const fs = options.fs ?? new MemoryFs(), plans = []
  fs.put(`/project/${SOURCE}`, source('SharedCard'))
  const deps = { fs, backendId: 'memory-world', projectRoot: '/project', sourceRevision: ANDROID_REUSE_SOURCE_REVISION,
    extract: extractAndroidReuseSource, approve: async plan => { plans.push(plan); return 'allowed-once' },
    policy: () => ({ mode: 'workspace-write', workspaceRoot: '/project', sessionId: 'test-session' }), ...options }
  return { fs, plans, deps, api: createReuseIndex(deps) }
}
async function baseline(f) { return f.api.maintain({ action: 'initialize', paths: [SOURCE] }, signal()) }

test('Android recognizer preserves concrete reuse consumers and excludes ordinary code', () => {
  const result = extractAndroidReuseSource(SOURCE, `package example
@Composable
fun SharedCard() = Unit
@Composable
fun HomeScreen() = Unit
@Preview
@Composable
fun PreviewCard() = Unit
private class HiddenRepository
class AppRepository
fun ordinaryFunction() = Unit
/* @Composable
fun FakeCard() = Unit */
val text = """
@Composable
fun StringCard() = Unit
"""
`)
  assert.deepEqual(result.map(e => e.symbol), ['SharedCard', 'AppRepository'])
  assert.equal(extractAndroidReuseSource('app/src/main/res/layout/view.xml', '<View />').length, 0)
  assert.equal(extractAndroidReuseSource('app/build/generated/src/main/Thing.kt', 'class DataRepository').length, 0)
  assert.equal(extractAndroidReuseSource('app/src/main/java/example/Widget.java', 'public class ChoiceView extends android.view.View {}')[0].kind, 'ui-component')
})

test('missing query is read-only and initialize records explicit partial coverage', async () => {
  const f = fixture()
  assert.equal((await f.api.query({ terms: ['card'] }, signal())).status, 'missing')
  assert.equal(f.fs.writes.length, 0)
  const done = await baseline(f)
  assert.equal(done.coverage, 'explicit-files')
  assert.equal(done.indexedFiles, 1)
  assert.equal(f.plans.length, 1)
  assert.deepEqual(f.plans[0].paths, [SOURCE])
  assert.equal(f.plans[0].destination, INDEX)
  assert.equal(f.fs.writes[0].expected.kind, 'createIfAbsent')
  assert.equal(f.fs.writes[0].policy.sessionId, 'test-session')
  const query = await f.api.query({ terms: ['card'], limit: 1 }, signal())
  assert.equal(query.status, 'available')
  assert.equal(query.matches[0].symbol, 'SharedCard')
  assert.equal(query.matches[0].freshness, 'current')
  assert.equal(query.coverage, 'explicit-files')
})

test('all mutation modes require actual single-use host approval outcome', async () => {
  for (const outcome of ['rejected', 'unavailable', 'cancelled', true, 'allow']) {
    const f = fixture({ approve: async () => outcome })
    await assert.rejects(baseline(f), /REUSE_APPROVAL_DENIED/)
    assert.equal(f.fs.writes.length, 0)
    assert.equal(f.fs.reads.includes(`/project/${SOURCE}`), false)
  }
  const f = fixture(); await baseline(f)
  const blocked = createReuseIndex({ ...f.deps, approve: async () => 'rejected' })
  await assert.rejects(blocked.maintain({ action: 'update', paths: [SOURCE] }, signal()), /APPROVAL_DENIED/)
  await assert.rejects(blocked.maintain({ action: 'rebuild', paths: [SOURCE] }, signal()), /APPROVAL_DENIED/)
  assert.equal(f.fs.writes.length, 1)
})

test('update cannot create baseline and initialize cannot replace existing baseline', async () => {
  const f = fixture()
  await assert.rejects(f.api.maintain({ action: 'update', paths: [SOURCE] }, signal()), /BASELINE_REQUIRED/)
  await baseline(f)
  await assert.rejects(baseline(f), /BASELINE_EXISTS/)
})

test('changed file updates preserve unrelated records and user overrides always win without writes', async () => {
  const f = fixture(); f.fs.put(`/project/${SECOND}`, source('OtherCard'))
  await f.api.maintain({ action: 'initialize', paths: [SOURCE, SECOND] }, signal())
  const initial = await f.api.query({ terms: ['shared'] }, signal()), id = initial.matches[0].id
  f.fs.put(OVERRIDES, JSON.stringify({ schemaVersion: 1, entries: { [id]: { status: 'preferred', notes: ['User choice'] } } }))
  const beforeOverride = f.fs.files.get(OVERRIDES)
  f.fs.reads = []
  await f.api.maintain({ action: 'update', paths: [SOURCE], adjustments: [{ entryId: id, value: { status: 'compatible', notes: ['Agent choice'] } }] }, signal())
  assert.equal(f.fs.reads.includes(`/project/${SECOND}`), false)
  assert.equal(f.fs.files.get(OVERRIDES), beforeOverride)
  assert.deepEqual(f.fs.writes.map(w => w.target), [INDEX, INDEX])
  const match = (await f.api.query({ terms: ['shared'] }, signal())).matches[0]
  assert.equal(match.status, 'preferred'); assert.deepEqual(match.notes, ['User choice'])
  assert.equal((await f.api.query({ terms: ['other'] }, signal())).matches[0].symbol, 'OtherCard')
})

test('semantic adjustments cannot target unrelated entries', async () => {
  const f = fixture(); f.fs.put(`/project/${SECOND}`, source('OtherCard'))
  await f.api.maintain({ action: 'initialize', paths: [SOURCE, SECOND] }, signal())
  const id = (await f.api.query({ terms: ['other'] }, signal())).matches[0].id
  await assert.rejects(f.api.maintain({ action: 'update', paths: [SOURCE], adjustments: [{ entryId: id, value: { status: 'deprecated' } }] }, signal()), /ADJUSTMENT_OUTSIDE_CHANGE/)
  assert.equal(f.fs.writes.length, 1)
})

test('source edit/deletion is stale; authorized partial update removes deleted entry', async () => {
  const f = fixture(); await baseline(f)
  f.fs.put(`/project/${SOURCE}`, source('ReplacementCard'))
  assert.equal((await f.api.query({ terms: ['card'] }, signal())).matches[0].freshness, 'stale')
  f.fs.files.delete(`/project/${SOURCE}`)
  const missing = await f.api.query({ terms: ['card'] }, signal())
  assert.equal(missing.status, 'stale'); assert.equal(missing.matches[0].freshness, 'missing')
  await f.api.maintain({ action: 'update', paths: [SOURCE] }, signal())
  assert.equal((await f.api.query({ terms: ['card'] }, signal())).matches.length, 0)
})

test('source version drift requires rebuild, which still preserves user overrides', async () => {
  const f = fixture(); await baseline(f)
  const newer = createReuseIndex({ ...f.deps, sourceRevision: 'new-version' })
  assert.equal((await newer.query({ terms: ['card'] }, signal())).status, 'stale')
  await assert.rejects(newer.maintain({ action: 'update', paths: [SOURCE] }, signal()), /REBUILD_REQUIRED/)
  await newer.maintain({ action: 'rebuild', paths: [SOURCE] }, signal())
  assert.equal((await newer.query({ terms: ['card'] }, signal())).status, 'available')
})

test('copied indexes cannot cross project roots or execution backends', async () => {
  const f = fixture(); await baseline(f)
  f.fs.put(`/other/${REUSE_INDEX_PATH}`, f.fs.files.get(INDEX).content)
  for (const deps of [{ ...f.deps, projectRoot: '/other' }, { ...f.deps, backendId: 'other-world' }]) {
    const api = createReuseIndex(deps)
    assert.equal((await api.query({ terms: ['card'] }, signal())).status, 'invalid')
    await assert.rejects(api.maintain({ action: 'update', paths: [SOURCE] }, signal()), /PROJECT_MISMATCH/)
  }
})

test('canonical root aliases retain one project identity', async () => {
  const f = fixture(); await baseline(f)
  f.fs.links.set('/alias', '/project')
  const api = createReuseIndex({ ...f.deps, projectRoot: '/alias' })
  assert.equal((await api.query({ terms: ['card'] }, signal())).status, 'available')
})

test('traversal, source symlinks and destination symlinks cannot escape project', async () => {
  const f = fixture()
  for (const name of ['../outside.kt', '/outside.kt', 'C:/outside.kt', 'app\\outside.kt']) {
    await assert.rejects(f.api.maintain({ action: 'initialize', paths: [name] }, signal()), /PATH_DENIED/)
  }
  f.fs.links.set(`/project/${SOURCE}`, '/other/secret.kt')
  await assert.rejects(baseline(f), /PATH_DENIED/)
  f.fs.links.clear(); f.fs.links.set(INDEX, '/other/index.json')
  await assert.rejects(baseline(f), /PATH_DENIED/)
  assert.equal(f.fs.writes.length, 0)
})

test('approval cannot bind a destination or root switched during the wait', async () => {
  const f = fixture()
  const api = createReuseIndex({ ...f.deps, approve: async () => { f.fs.links.set(INDEX, '/other/index.json'); return 'allowed-once' } })
  await assert.rejects(api.maintain({ action: 'initialize', paths: [SOURCE] }, signal()), /PATH_DENIED/)
  assert.equal(f.fs.writes.length, 0)
})

test('corrupt index and invalid user overrides are explicit invalid states, not missing', async () => {
  const f = fixture(); f.fs.put(INDEX, '{broken')
  assert.equal((await f.api.query({}, signal())).status, 'invalid')
  f.fs.files.delete(INDEX); await baseline(f)
  f.fs.put(OVERRIDES, JSON.stringify({ schemaVersion: 1, entries: { notAnId: { location: '/outside' } } }))
  assert.equal((await f.api.query({}, signal())).status, 'invalid')
})

test('query caps, source byte budgets and cancellation fail closed without partial publication', async () => {
  const f = fixture()
  await assert.rejects(f.api.query({ limit: 9 }, signal()), /QUERY_INVALID/)
  await assert.rejects(f.api.query({ terms: Array(21).fill('card') }, signal()), /QUERY_INVALID/)
  await assert.rejects(f.api.maintain({ action: 'initialize', paths: Array(101).fill(SOURCE) }, signal()), /MAINTENANCE_INVALID/)
  f.fs.put(`/project/${SOURCE}`, 'x'.repeat(REUSE_LIMITS.fileBytes + 1))
  await assert.rejects(baseline(f), /FS_TOO_LARGE/)
  assert.equal(f.fs.writes.length, 0)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(f.api.query({}, abort.signal), /abort/i)
  await assert.rejects(f.api.maintain({ action: 'initialize', paths: [SOURCE] }, abort.signal), /abort/i)
})

test('cancellation during approval does not proceed; read-only policy cannot write', async () => {
  const f = fixture(), controller = new AbortController()
  const cancelled = createReuseIndex({ ...f.deps, approve: async () => { controller.abort(); return 'allowed-once' } })
  await assert.rejects(cancelled.maintain({ action: 'initialize', paths: [SOURCE] }, controller.signal), /abort/i)
  const readOnly = createReuseIndex({ ...f.deps, policy: () => ({ mode: 'read-only', workspaceRoot: '/project' }) })
  await assert.rejects(readOnly.maintain({ action: 'initialize', paths: [SOURCE] }, signal()), /WRITE_DENIED/)
  assert.equal(f.fs.writes.length, 0)
})

test('atomic version guard prevents concurrent replacement from being overwritten', async () => {
  const f = fixture(); await baseline(f)
  f.fs.beforeWrite = () => f.fs.put(INDEX, 'concurrent content')
  await assert.rejects(f.api.maintain({ action: 'update', paths: [SOURCE] }, signal()), /FS_STALE_VERSION/)
  assert.equal(f.fs.files.get(INDEX).content, 'concurrent content')
})

test('generic query needs no extractor and reports recognition uncertainty separately', async () => {
  const f = fixture(); await baseline(f)
  const api = createReuseIndex({ ...f.deps, extract: undefined, sourceRevision: undefined })
  const result = await api.query({ terms: ['card'] }, signal())
  assert.equal(result.status, 'available')
  assert.equal(result.recognitionStatus, 'unverified')
  assert.equal(result.matches[0].freshness, 'current')
  await assert.rejects(api.maintain({ action: 'update', paths: [SOURCE] }, signal()), /EXTRACTOR_UNAVAILABLE/)
})

test('module fences writes even if an FS backend ignores the passed sandbox policy', async () => {
  const f = fixture({ policy: () => ({ mode: 'workspace-write', workspaceRoot: '/other' }) })
  await assert.rejects(baseline(f), /WRITE_ROOT_DENIED/)
  assert.equal(f.fs.writes.length, 0)
})

test('source change during extraction prevents stale evidence from being published', async () => {
  const f = fixture()
  const api = createReuseIndex({ ...f.deps, extract: (name, content) => {
    f.fs.put(`/project/${name}`, source('DifferentCard'))
    return extractAndroidReuseSource(name, content)
  } })
  await assert.rejects(api.maintain({ action: 'initialize', paths: [SOURCE] }, signal()), /SOURCE_CHANGED/)
  assert.equal(f.fs.writes.length, 0)
})

test('rebuild alone can recover invalid baselines with precise approval and version protection', async () => {
  for (const invalid of ['{broken', JSON.stringify({ schemaVersion: 999 })]) {
    const f = fixture(); f.fs.put(INDEX, invalid)
    const originalVersion = f.fs.files.get(INDEX).version
    await assert.rejects(baseline(f))
    await assert.rejects(f.api.maintain({ action: 'update', paths: [SOURCE] }, signal()))
    assert.equal(f.fs.writes.length, 0)
    await f.api.maintain({ action: 'rebuild', paths: [SOURCE] }, signal())
    assert.equal(f.plans[0].replacingInvalidBaseline.version, originalVersion)
    assert.match(f.plans[0].replacingInvalidBaseline.digest, /^[a-f0-9]{64}$/)
    assert.ok(f.plans[0].replacingInvalidBaseline.reason)
    assert.deepEqual(f.fs.writes[0].expected, { kind: 'replaceIfVersion', version: originalVersion })
  }
  const f = fixture(); await baseline(f)
  const other = createReuseIndex({ ...f.deps, backendId: 'different-world' })
  await assert.rejects(other.maintain({ action: 'rebuild', paths: [SOURCE] }, signal()), /PROJECT_MISMATCH/)
})

test('non-UTF8 baseline rebuild approves exact raw bytes and remains version-guarded', async () => {
  const raw = Buffer.from([0xff, 0xfe]), f = fixture()
  f.fs.put(INDEX, raw)
  const version = f.fs.files.get(INDEX).version
  assert.equal((await f.api.query({}, signal())).status, 'invalid')
  await assert.rejects(baseline(f))
  await assert.rejects(f.api.maintain({ action: 'update', paths: [SOURCE] }, signal()))
  const denied = createReuseIndex({ ...f.deps, approve: async () => 'rejected' })
  await assert.rejects(denied.maintain({ action: 'rebuild', paths: [SOURCE] }, signal()), /APPROVAL_DENIED/)
  assert.equal(f.fs.files.get(INDEX).content, raw)
  await f.api.maintain({ action: 'rebuild', paths: [SOURCE] }, signal())
  assert.match(f.plans[0].replacingInvalidBaseline.reason, /utf-?8/i)
  assert.equal(f.plans[0].replacingInvalidBaseline.version, version)
  assert.equal(f.plans[0].replacingInvalidBaseline.digest, createHash('sha256').update(raw).digest('hex'))
  assert.deepEqual(f.fs.writes[0].expected, { kind: 'replaceIfVersion', version })
  assert.equal((await f.api.query({ terms: ['card'] }, signal())).status, 'available')
  f.fs.put(INDEX, raw)
  f.fs.beforeWrite = () => f.fs.put(INDEX, 'concurrent replacement')
  await assert.rejects(f.api.maintain({ action: 'rebuild', paths: [SOURCE] }, signal()), /FS_STALE_VERSION/)
  assert.equal(f.fs.files.get(INDEX).content, 'concurrent replacement')
})

test('rebuild recovery does not swallow nonregular, oversized or changing baseline failures', async () => {
  const f = fixture()
  f.fs.directories.add(INDEX)
  await assert.rejects(f.api.maintain({ action: 'rebuild', paths: [SOURCE] }, signal()), /NOT_FILE/)
  f.fs.directories.delete(INDEX)
  f.fs.put(INDEX, Buffer.alloc(REUSE_LIMITS.indexBytes + 1, 0xff))
  await assert.rejects(f.api.maintain({ action: 'rebuild', paths: [SOURCE] }, signal()), /FS_TOO_LARGE/)
  f.fs.put(INDEX, Buffer.from([0xff]))
  const read = f.fs.readBytes.bind(f.fs)
  f.fs.readBytes = async (target, sig, max) => {
    const bytes = await read(target, sig, max)
    if (target.targetKey === INDEX) f.fs.put(INDEX, 'changed')
    return bytes
  }
  await assert.rejects(f.api.maintain({ action: 'rebuild', paths: [SOURCE] }, signal()), /SOURCE_CHANGED/)
  assert.equal(f.plans.length, 0); assert.equal(f.fs.writes.length, 0)
})

test('policy tightening during final async root check cannot publish with stale permission', async () => {
  const policy = { mode: 'workspace-write', workspaceRoot: '/project', sessionId: 'test-session' }
  const f = fixture({ policy: () => policy })
  const originalStat = f.fs.stat.bind(f.fs)
  let rootStats = 0
  f.fs.stat = async (target, sig) => {
    const result = await originalStat(target, sig)
    if (target.targetKey === '/project' && ++rootStats === 3) policy.mode = 'read-only'
    return result
  }
  await assert.rejects(baseline(f), /POLICY_CHANGED/)
  assert.equal(f.fs.writes.length, 0)
})

test('read-only is rejected before asking approval or reading source files', async () => {
  const f = fixture({ policy: () => ({ mode: 'read-only', workspaceRoot: '/project' }) })
  await assert.rejects(baseline(f), /WRITE_DENIED/)
  assert.equal(f.plans.length, 0)
  assert.equal(f.fs.reads.length, 0)
})

test('multiline Preview arguments retain exclusion until the following declaration', () => {
  assert.deepEqual(extractAndroidReuseSource(SOURCE, `@Preview(\n name = "sample",\n widthDp = 100\n)\n@Composable\nfun SampleCard() = Unit\n@Composable\nfun ActualCard() = Unit\n`).map(e => e.symbol), ['ActualCard'])
})

test('nested Kotlin comments and split private modifiers do not create reusable candidates', () => {
  const content = `/* outer\n /* inner */\n@Composable\nfun FakeCard() = Unit\n*/\nprivate\n@Composable\nfun SecretCard() = Unit\nprivate\nclass SecretRepository\n@Composable\nfun VisibleCard() = Unit\n`
  assert.deepEqual(extractAndroidReuseSource(SOURCE, content).map(e => e.symbol), ['VisibleCard'])
})

test('failed reads consume reserved query budget rather than retrying unbounded bytes', async () => {
  const f = fixture(), paths = []
  for (let i = 0; i < 40; i++) {
    const p = `app/src/main/java/example/Item${i}.kt`
    paths.push(p); f.fs.put(`/project/${p}`, source(`Item${i}Card`))
  }
  await f.api.maintain({ action: 'initialize', paths }, signal())
  const originalStat = f.fs.stat.bind(f.fs), originalRead = f.fs.readBytes.bind(f.fs)
  let attemptedBytes = 0, attemptedFiles = 0
  f.fs.stat = async (target, sig) => {
    const value = await originalStat(target, sig)
    return paths.some(p => target.targetKey === `/project/${p}`) ? { ...value, size: undefined } : value
  }
  f.fs.readBytes = async (target, sig, max) => {
    if (paths.some(p => target.targetKey === `/project/${p}`)) {
      attemptedBytes += max; attemptedFiles++
      // Invalid UTF-8 occurs after bytes have already been transferred.
      return Uint8Array.from([0xff])
    }
    return originalRead(target, sig, max)
  }
  const result = await f.api.query({ terms: ['card'] }, signal())
  assert.equal(result.status, 'stale')
  assert.equal(attemptedFiles, REUSE_LIMITS.totalBytes / REUSE_LIMITS.fileBytes)
  assert.ok(attemptedBytes <= REUSE_LIMITS.totalBytes)
  assert.equal(result.checkedFiles, 0)
})

test('bounded results flag omissions and do not serialize the complete catalog', async () => {
  const f = fixture()
  f.fs.put(`/project/${SOURCE}`, Array.from({ length: 12 }, (_, i) => source(`Choice${i}Card`)).join('\n'))
  await baseline(f)
  const query = await f.api.query({ terms: ['card'], limit: 2 }, signal())
  assert.equal(query.matches.length, 2); assert.equal(query.truncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(query)) <= REUSE_LIMITS.outputBytes)
})
