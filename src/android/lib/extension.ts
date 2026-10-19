/**
 * Android 只读上下文补充扩展：`validate.before` 的第一个真实领域扩展。
 *
 * 纯定义模块，不导入 Cordis。能力检查与角色执行由 core 在调用时传入的
 * view / execution 对象提供，扩展只声明它需要什么。
 */

import type { Match, Readiness, SlotExtension, SlotFacts } from '../../lib/contracts.js'

export const EXTENSION_ID = 'android.validation-context'
export const SLOT = 'validate.before'
export const SLOT_VERSION = 1
/** Optional caller-supplied context; this text-only extension does not produce a verified machine fact. */
export const CONTEXT_FACT = 'validation.context'
export const ROLE = 'android-context'
export const SKILL = 'android-validation-context'
export const OBJECTIVE = '确认当前模块、变体和相关测试入口；不启动设备或运行测试。'

/** 调用作用域提供的能力检查接口（由节点工具注入）。 */
interface CapabilityScope {
  checkRoleAndSkill(role: string, skill: string): Readiness
}

/** 调用作用域提供的角色执行接口（由节点工具注入）。 */
interface RoleScope {
  runConfiguredRole(role: string, task: { skill: string; objective: string }): unknown
}

export function createAndroidValidationContext(): SlotExtension {
  return {
    id: EXTENSION_ID,
    slot: SLOT,
    slotVersion: SLOT_VERSION,
    // Raw evidence travels in the node's extension results, not as a fabricated provides fact.
    match(facts: SlotFacts): Match {
      const projectKind = facts.values['projectKind']
      // 缺事实与不适用必须区分：目录名不能当作平台证据。
      if (projectKind === undefined) return { kind: 'unknown', missing: ['projectKind'] }
      if (projectKind !== 'android') return { kind: 'no' }
      if (facts.values[CONTEXT_FACT] !== undefined) return { kind: 'no' }
      return { kind: 'yes' }
    },
    ready(view: unknown): Readiness {
      if (!view || typeof view !== 'object' || typeof (view as CapabilityScope).checkRoleAndSkill !== 'function') {
        return { ready: false, reason: '调用作用域未提供能力检查接口', missing: ['checkRoleAndSkill'] }
      }
      return (view as CapabilityScope).checkRoleAndSkill(ROLE, SKILL)
    },
    run(execution: unknown): unknown {
      if (
        !execution ||
        typeof execution !== 'object' ||
        typeof (execution as RoleScope).runConfiguredRole !== 'function'
      ) {
        return { status: 'blocked', error: '调用作用域未提供角色执行接口' }
      }
      return (execution as RoleScope).runConfiguredRole(ROLE, { skill: SKILL, objective: OBJECTIVE })
    },
  }
}
