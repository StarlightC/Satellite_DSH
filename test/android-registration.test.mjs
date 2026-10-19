import test from 'node:test'
import assert from 'node:assert/strict'

import { createSlotRegistration } from '../lib/android/lib/registration.js'

function fakeSlots({ declared = false } = {}) {
  const state = { declared, hasSlot: () => state.declared }
  const registered = []
  return {
    state,
    registered,
    hasSlot: (name) => state.hasSlot(name),
    register(extension) {
      registered.push(extension.id)
      return () => registered.splice(registered.indexOf(extension.id), 1)
    },
  }
}

const extension = { id: 'android.validation-context', slot: 'validate.before' }

test('插槽尚未声明时不注册，也不抛错', () => {
  const slots = fakeSlots()
  const registration = createSlotRegistration({ slots, extension })
  registration.sync()
  assert.equal(registration.registered, false)
  assert.deepEqual(slots.registered, [])
})

test('插槽出现后同步注册，重复 sync 幂等', () => {
  const slots = fakeSlots()
  const registration = createSlotRegistration({ slots, extension })
  slots.state.declared = true
  registration.sync()
  registration.sync()
  assert.deepEqual(slots.registered, [extension.id])
  assert.equal(registration.registered, true)
})

test('插槽撤销后注销，恢复声明后可再次注册', () => {
  const slots = fakeSlots({ declared: true })
  const registration = createSlotRegistration({ slots, extension })
  registration.sync()
  assert.deepEqual(slots.registered, [extension.id])

  slots.state.declared = false
  registration.sync()
  assert.deepEqual(slots.registered, [])
  assert.equal(registration.registered, false)

  slots.state.declared = true
  registration.sync()
  assert.deepEqual(slots.registered, [extension.id])
})

test('插件卸载时释放注册', () => {
  const slots = fakeSlots({ declared: true })
  const registration = createSlotRegistration({ slots, extension })
  registration.sync()
  registration.dispose()
  assert.deepEqual(slots.registered, [])
})
