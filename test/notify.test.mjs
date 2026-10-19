import test from 'node:test'
import assert from 'node:assert/strict'

import { createNotifier } from '../lib/notify.js'

test('订阅者在每次通知时被调用，退订后不再收到', () => {
  const notifier = createNotifier()
  let calls = 0
  const off = notifier.subscribe(() => {
    calls += 1
  })
  notifier.notify()
  notifier.notify()
  assert.equal(calls, 2)
  off()
  notifier.notify()
  assert.equal(calls, 2)
  assert.equal(notifier.size, 0)
})

test('单个订阅者抛错不影响其他订阅者', () => {
  const notifier = createNotifier()
  let second = 0
  notifier.subscribe(() => {
    throw new Error('boom')
  })
  notifier.subscribe(() => {
    second += 1
  })
  assert.doesNotThrow(() => notifier.notify())
  assert.equal(second, 1)
})

test('通知过程中退订不会跳过后续订阅者', () => {
  const notifier = createNotifier()
  const seen = []
  const off = notifier.subscribe(() => {
    seen.push('first')
    off()
  })
  notifier.subscribe(() => seen.push('second'))
  notifier.notify()
  assert.deepEqual(seen, ['first', 'second'])
})
