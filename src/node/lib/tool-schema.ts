/**
 * `satellite_node` 的作者 DSL 规格与本地校验。
 *
 * `defineTool` 的 parameters / output.schema 使用 dsh-tools 的作者 DSL，
 * 不是原始 JSON Schema：required 是每个属性上的布尔值，object 必须显式声明
 * additionalProperties，且只允许固定的键集合。这里实现同一套规则，
 * 让规格错误在单元测试阶段暴露，而不是等到插件激活失败。
 */

import type { ParameterPropertySpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { NODE_TIERS } from './config.js'

const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples']
const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean', 'null']

/** 作者 DSL 的值节点在本地校验里按松散记录处理，由 lintValueSchema 负责收窄。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface LintValueSchemaOptions {
  readonly allowRequired?: boolean
}

/**
 * 校验一个作者 DSL 值节点。
 * @returns 违规列表；空数组表示合法
 */
export function lintValueSchema(
  spec: unknown,
  path = 'schema',
  options: LintValueSchemaOptions = {},
): string[] {
  const allowRequired = options.allowRequired === true
  if (!isRecord(spec)) return [`${path} must be a value schema object`]
  const allowed = [...ANNOTATION_KEYS, ...(allowRequired ? ['required'] : [])]
  const keys = Object.keys(spec)

  if (allowRequired && 'required' in spec && spec.required !== true) {
    return [`${path}.required must be true when present`]
  }

  const problems: string[] = []
  for (const key of keys) {
    if (['oneOf', 'type', 'properties', 'additionalProperties', 'items', 'enum', 'const'].includes(key)) continue
    if (!allowed.includes(key)) problems.push(`${path}.${key} is not supported by the value schema DSL`)
  }
  if (problems.length > 0) return problems

  if ('oneOf' in spec) {
    if ('type' in spec) problems.push(`${path} cannot declare both type and oneOf`)
    const branches = spec.oneOf
    if (!Array.isArray(branches) || branches.length < 2) {
      problems.push(`${path}.oneOf must be an array of at least two value schemas`)
    } else {
      const list: readonly unknown[] = branches
      list.forEach((branch, index) => {
        problems.push(...lintValueSchema(branch, `${path}.oneOf[${index}]`))
      })
    }
    return problems
  }

  const type = spec.type
  if (type === 'json') return problems

  if (type === 'object') {
    if (typeof spec.additionalProperties !== 'boolean') {
      problems.push(`${path}.additionalProperties must be explicitly true or false`)
    }
    if ('properties' in spec) {
      if (!isRecord(spec.properties)) {
        problems.push(`${path}.properties must be an object of value schemas`)
      } else {
        for (const [key, property] of Object.entries(spec.properties)) {
          problems.push(...lintValueSchema(property, `${path}.properties.${key}`, { allowRequired: true }))
        }
      }
    }
    return problems
  }

  if (type === 'array') {
    if ('items' in spec) problems.push(...lintValueSchema(spec.items, `${path}.items`))
    return problems
  }

  if (typeof type === 'string' && SCALAR_TYPES.includes(type)) {
    if ('enum' in spec && (!Array.isArray(spec.enum) || spec.enum.length === 0)) {
      problems.push(`${path}.enum must be a non-empty array of scalar values`)
    }
    return problems
  }

  problems.push(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`)
  return problems
}

/** parameters 是隐式属性映射：顶层直接是 名称 -> 值节点。 */
export function lintParameterSchema(spec: unknown, path = 'parameters'): string[] {
  if (!isRecord(spec)) return [`${path} must be an object of value schemas`]
  const problems: string[] = []
  for (const [key, property] of Object.entries(spec)) {
    problems.push(...lintValueSchema(property, `${path}.${key}`, { allowRequired: true }))
  }
  return problems
}

export const PARAMETERS_SCHEMA = Object.freeze({
  node: { type: 'string', required: true, description: '要运行的基础节点标识' },
  task: { type: 'string', required: true, description: '本次节点的有界任务，包含范围与停止条件' },
  unit: { type: 'string', description: '实施单元标识；同一节点的不同单元互不串用记录' },
  tier: {
    type: 'string', enum: NODE_TIERS,
    description: '节点角色档，与任务执行难度独立；默认只用于 solution/implement/review。省略用节点默认，显式档须有映射。resume 省略继承原选择，改档须新建调用并携带证据。',
  },
  facts: {
    type: 'json',
    description:
      '本次任务已有的语义事实（例如 projectKind），只作为方法判断，不是授权凭证。' +
      '事实名是扁平键，点号是键名的一部分，不解析嵌套对象。' +
      '例如 {"acceptance.required":true}（作为 facts 的值）：默认启用的处理决定扩展会在 after 阶段暂停；' +
      '用返回的 token 作为 resume 并提交 decision 继续，base 不重跑。' +
      '嵌套写法 {"acceptance":{"required":true}} 不会触发该暂停。',
  },
  resume: { type: 'string', description: '暂停时返回的 token，用于恢复同一节点调用' },
  decision: { type: 'string', description: '恢复时提交的业务决定；不能代替宿主批准' },
} as const satisfies Record<string, ParameterPropertySpec>)

export const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  description: '本次节点调用的结果；暂停时返回 token 供恢复同一调用。',
  properties: {
    kind: { type: 'string', required: true, description: 'completed | failed | suspended | cancelled | blocked' },
    node: { type: 'string', required: true },
    token: { type: 'string', description: '暂停时用于恢复同一节点调用' },
    stage: { type: 'string', description: '暂停发生在 before 还是 after' },
    reason: { type: 'string' },
    missing: { type: 'array', items: { type: 'string' } },
    conflicts: { type: 'array', items: { type: 'string' } },
    blocked: { type: 'array', items: { type: 'string' } },
    ran: { type: 'array', items: { type: 'string' } },
    extensions: {
      type: 'array',
      description: '已运行扩展的原始结果与错误，含暂停前已有证据；不是授权凭证',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          slot: { type: 'string', required: true },
          status: { type: 'string', enum: ['completed', 'failed', 'blocked', 'needs_decision'], required: true },
          note: { type: 'string' },
          error: { type: 'string' },
        },
      },
    },
    sandbox: {
      type: 'array',
      items: { type: 'string' },
      description: '已在创建边界核验的角色沙箱模式；不能验证权限时拒绝启动',
    },
    selection: {
      type: 'object', additionalProperties: false,
      description: '本次调用冻结的基础角色选择；不代表已执行。',
      properties: {
        role: { type: 'string', required: true },
        tier: { type: 'string', enum: NODE_TIERS },
      },
    },
    execution: {
      type: 'object', additionalProperties: false,
      description: '已确认启动的基础角色及其显式请求路由（非子会话模型读回）；恢复时保留原记录，不代表重新启动或业务通过。',
      properties: {
        role: { type: 'string', required: true },
        provider: { type: 'string' },
        model: { type: 'string' },
      },
    },
    result: { type: 'string', description: '基础节点的实际结果摘要' },
  },
} as const satisfies ValueSchemaSpec)
