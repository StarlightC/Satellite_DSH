import test from 'node:test'
import assert from 'node:assert/strict'

import { preflightRoute } from '../lib/node/lib/routes.js'

const role = (agentOptions) => ({ agentOptions })
const caps = { agentOptions: true }
const llmOk = { async resolveCallConfig() {} }

test('未配置 agentOptions 时不预检（交给后端默认路由）', async () => {
  const result = await preflightRoute({ llm: llmOk, capabilities: caps, role: {}, providerName: 'spawn' })
  assert.deepEqual(result, { ok: true })
})

test('后端不支持 agentOptions 时拒绝', async () => {
  const result = await preflightRoute({
    llm: llmOk,
    capabilities: { agentOptions: false },
    role: role({ provider: 'p', model: 'm' }),
    providerName: 'acp',
  })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'capability')
  assert.match(result.reason, /不支持 agentOptions/)
})

test('provider/model 缺失或为空时按配置错误拒绝', async () => {
  for (const bad of [{ model: 'm' }, { provider: 'p' }, { provider: '', model: 'm' }, { provider: 'p', model: '' }]) {
    const result = await preflightRoute({ llm: llmOk, capabilities: caps, role: role(bad), providerName: 'spawn' })
    assert.equal(result.ok, false, JSON.stringify(bad))
    assert.equal(result.kind, 'config')
  }
})

test('宿主模型选择策略启用时，只允许列表内的精确路由', async () => {
  const selection = { enabled: true, allowedModels: [{ provider: 'deepseek-official', model: 'deepseek-flash' }] }

  const allowed = await preflightRoute({
    llm: llmOk,
    selection,
    capabilities: caps,
    role: role({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    providerName: 'spawn',
  })
  assert.deepEqual(allowed, { ok: true })

  const denied = await preflightRoute({
    llm: llmOk,
    selection,
    capabilities: caps,
    role: role({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
    providerName: 'spawn',
  })
  assert.equal(denied.ok, false)
  assert.equal(denied.kind, 'policy')
  assert.match(denied.reason, /不在宿主允许的模型列表内/)
})

test('策略读取失败（current() 抛错）时拒绝，而不是当作未启用', async () => {
  const result = await preflightRoute({
    llm: llmOk,
    selection: { error: 'enabled subagent model selection requires at least one allowed model' },
    capabilities: caps,
    role: role({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    providerName: 'spawn',
  })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'policy')
  assert.match(result.reason, /模型选择策略不可用/)
})

test('适配器拒绝路由时给出原生原因（未知 provider、不支持的 effort 都在此）', async () => {
  const llm = {
    async resolveCallConfig(config) {
      if (config.provider === 'no-such-provider') throw new Error('DUPLICATE_ADAPTER: unknown provider')
      if (config.reasoningEffort === 'ultra') throw new Error('unsupported reasoning effort "ultra"')
    },
  }

  const unknown = await preflightRoute({
    llm,
    capabilities: caps,
    role: role({ provider: 'no-such-provider', model: 'x' }),
    providerName: 'spawn',
  })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.kind, 'route')
  assert.match(unknown.reason, /unknown provider/)

  const effort = await preflightRoute({
    llm,
    capabilities: caps,
    role: role({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'ultra' }),
    providerName: 'spawn',
  })
  assert.equal(effort.ok, false)
  assert.equal(effort.kind, 'route')
  assert.match(effort.reason, /unsupported reasoning effort/)
})

test('把 reasoningEffort 与 maxTokens 一并交给原生校验', async () => {
  const seen = []
  const llm = { async resolveCallConfig(config) { seen.push(config) } }
  await preflightRoute({
    llm,
    capabilities: caps,
    role: role({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 1024 }),
    providerName: 'spawn',
  })
  assert.deepEqual(seen, [{ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 1024 }])
})

test('没有 llm 服务时不假装已校验，但也不阻止原生创建', async () => {
  const result = await preflightRoute({
    llm: undefined,
    capabilities: caps,
    role: role({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    providerName: 'spawn',
  })
  assert.deepEqual(result, { ok: true })
})
