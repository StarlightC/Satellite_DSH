/** 有效角色配置与已注册扩展的纯数据投影；不执行扩展，也不改变模型路由。 */
import type { SlotExtension } from '../../lib/contracts.js'
import { effectiveSandboxMode } from './config.js'
import type { NormalizedConfig, SandboxMode } from './config.js'

export interface RoleBinding {
  readonly node: string
  readonly phase: 'base' | 'before' | 'after'
  readonly extension?: string
  readonly skill?: string
  readonly objective?: string
  readonly condition: string
}

export interface RoleInfo {
  readonly role: string
  readonly label: string
  readonly description: string
  readonly skill?: string
  readonly sandbox: SandboxMode
  readonly bindings: readonly RoleBinding[]
}

export interface RoleCatalog {
  readonly version: 1
  readonly roles: readonly RoleInfo[]
}

/**
 * 调用方传入 normalizeConfig 的有效结果与 slots.snapshot()。
 * 没有角色定义的旧路由不构造角色；没有 role 元数据的扩展不猜测角色。
 * 目录描述已部署的挂载，不声称当前任务已匹配、就绪或获准。
 */
export function buildRoleCatalog(
  config: NormalizedConfig,
  extensions: readonly SlotExtension[],
): RoleCatalog {
  const bindings = new Map<string, RoleBinding[]>(Object.keys(config.roles).map((role) => [role, []]))
  for (const [node, entry] of Object.entries(config.nodes)) {
    const conditions = new Map<string, string[]>([[entry.role, ['省略 tier']]])
    for (const [tier, role] of Object.entries(entry.tierRoles ?? {})) {
      conditions.set(role, [...(conditions.get(role) ?? []), `tier=${tier}`])
    }
    for (const [name, choices] of conditions) {
      if (!Object.hasOwn(config.roles, name)) continue
      const role = config.roles[name]!
      bindings.get(name)?.push({
        node,
        phase: 'base',
        ...(role.skill !== undefined ? { skill: role.skill } : {}),
        ...(role.objective !== undefined ? { objective: role.objective } : {}),
        condition: `调用 ${node} 节点且${choices.join(' 或 ')}时执行基础阶段。`,
      })
    }
  }
  for (const extension of extensions) {
    const metadata = extension.role
    if (!metadata) continue
    const target = bindings.get(metadata.name)
    if (!target) continue
    const slot = /^([a-z][a-z0-9-]*)\.(before|after)$/.exec(extension.slot)
    if (!slot) continue
    target.push({
      node: slot[1]!,
      phase: slot[2] as 'before' | 'after',
      extension: extension.id,
      skill: metadata.skill,
      objective: metadata.objective,
      condition: metadata.condition,
    })
  }
  return {
    version: 1,
    roles: Object.entries(config.roles).map(([role, entry]) => ({
      role,
      label: entry.label || role,
      description: entry.objective ?? '',
      ...(entry.skill !== undefined ? { skill: entry.skill } : {}),
      sandbox: effectiveSandboxMode(entry).mode,
      bindings: bindings.get(role)!,
    })),
  }
}
