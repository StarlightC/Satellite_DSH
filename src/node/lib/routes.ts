/**
 * 路由预检：在创建子 Agent **之前**核对角色配置的模型路由。
 *
 * 复用原生来源，不新建路由层：
 * - provider 的能力声明（是否支持 agentOptions）
 * - Host 的 `subagentModelSelection.current()` 策略（已启用时的允许路由）
 * - `ctx.llm.resolveCallConfig` 对精确 provider/model/effort 的校验
 *
 * 通过的判定是"原生来源没有拒绝"；未知但被 provider 放行的 model 仍按原生语义通过
 * （目录条目是建议性的，不控制核心路由）。
 */

import type { AgentOptions } from './config.js'

export interface AllowedRoute {
  readonly provider: string
  readonly model: string
}

/** 宿主模型选择策略的当前状态；读取失败时以 `{ error }` 表达，不当作未启用。 */
export type SelectionState =
  | { readonly enabled?: boolean; readonly allowedModels?: readonly AllowedRoute[] }
  | { readonly error: string }

export interface LlmLike {
  resolveCallConfig?(config: {
    provider: string
    model: string
    reasoningEffort?: string
    maxTokens?: number
  }): unknown
}

export interface RouteCapabilities {
  readonly agentOptions?: boolean
}

export type RouteCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: 'capability' | 'config' | 'policy' | 'route'; readonly reason: string }

export interface PreflightInput {
  readonly llm?: LlmLike | undefined
  readonly selection?: SelectionState | undefined
  readonly capabilities?: RouteCapabilities | undefined
  readonly role?: { readonly agentOptions?: AgentOptions } | undefined
  readonly providerName: string
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function preflightRoute(input: PreflightInput): Promise<RouteCheck> {
  const { llm, selection, capabilities, role, providerName } = input
  const options = role?.agentOptions
  if (!options) return { ok: true }

  if (!capabilities?.agentOptions) {
    return {
      ok: false,
      kind: 'capability',
      reason: `后端 ${providerName} 不支持 agentOptions 角色路由，不能按角色绑定模型`,
    }
  }

  const { provider, model, reasoningEffort, maxTokens } = options
  if (typeof provider !== 'string' || provider.length === 0) {
    return { ok: false, kind: 'config', reason: 'agentOptions.provider 必须是非空字符串' }
  }
  if (typeof model !== 'string' || model.length === 0) {
    return { ok: false, kind: 'config', reason: 'agentOptions.model 必须是非空字符串' }
  }

  if (selection && typeof selection === 'object' && 'error' in selection) {
    return { ok: false, kind: 'policy', reason: `模型选择策略不可用：${selection.error}` }
  }
  if (selection?.enabled) {
    const allowed = Array.isArray(selection.allowedModels) ? selection.allowedModels : []
    const permitted = allowed.some((route) => route?.provider === provider && route?.model === model)
    if (!permitted) {
      return {
        ok: false,
        kind: 'policy',
        reason: `路由 ${provider}/${model} 不在宿主允许的模型列表内（模型选择策略已启用）`,
      }
    }
  }

  if (llm && typeof llm.resolveCallConfig === 'function') {
    try {
      await llm.resolveCallConfig({
        provider,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
      })
    } catch (error) {
      return {
        ok: false,
        kind: 'route',
        reason: `模型适配器拒绝路由 ${provider}/${model}：${messageOf(error)}`,
      }
    }
  }

  return { ok: true }
}
