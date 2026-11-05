// Git-free checks of the Loader test world layout and its persistence overlay.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isInside, worldLayout } from './loader/world-layout.mjs'

const OVERLAY = new URL('./loader/fixtures/satellite-headless.patch.yml', import.meta.url)

test('loader world: session root is under the temporary DSH home, outside the Git repo', () => {
  const layout = worldLayout(join(tmpdir(), 'satellite-loader-x'))
  assert.equal(layout.sessions, join(layout.home, 'sessions'))
  assert.ok(isInside(layout.home, layout.sessions))
  assert.ok(!isInside(layout.repo, layout.sessions))
  assert.ok(!isInside(layout.repo, layout.home))
  assert.ok(!isInside(layout.repo, layout.profileDir))
  assert.throws(() => worldLayout('relative/root'))
})

test('loader overlay: JSONL persistence uses the production dshHomePath root, never a cwd-relative one', () => {
  const text = readFileSync(OVERLAY, 'utf8')
  const row = /- id: session-persistence-jsonl\n((?:[ ]{2,}.*\n)+)/.exec(text)?.[1] ?? ''
  assert.match(row, /root: !!js dshHomePath\('sessions'\)/)
  assert.doesNotMatch(text, /root:\s*'?\.\//)
})
