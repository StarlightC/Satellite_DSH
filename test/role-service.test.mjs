import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods, isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol'
import { SatelliteRoles } from '../lib/node/lib/role-service.js'
import { buildRoleCatalog } from '../lib/node/lib/role-catalog.js'
import { normalizeConfig } from '../lib/node/lib/config.js'
import { createAndroidValidationContext } from '../lib/android/lib/extension.js'

test('native Remote exposes only read-only describe and follows the service lifecycle', async () => {
  const ctx = new Context()
  const config = normalizeConfig({ roles: { validation: { objective: 'Actual deployed responsibility' } } })
  let extensions = []
  let reads = 0
  const fiber = await ctx.plugin(SatelliteRoles, {
    describe() { reads += 1; return buildRoleCatalog(config, extensions) },
  })
  const service = ctx.get('satelliteRoles')
  assert.ok(service)
  assert.equal(service.typertRemote.serviceKey, 'satelliteRoles')
  assert.equal(service.typertRemote.namespace, 'satelliteRoles')
  assert.deepEqual(remoteMethods(service), [{ method: 'describe', invocation: { kind: 'direct' } }])
  const first = service.describe()
  assert.equal(isRemoteJsonValue(first), true)
  assert.equal(first.roles.find((role) => role.role === 'validation').description, 'Actual deployed responsibility')
  extensions = [createAndroidValidationContext()]
  assert.equal(service.describe().roles.find((role) => role.role === 'android-context').bindings.length, 1)
  assert.equal(reads, 2)
  await fiber.dispose()
  assert.equal(ctx.get('satelliteRoles'), undefined)
})
