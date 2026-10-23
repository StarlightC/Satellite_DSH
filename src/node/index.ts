/**
 * `satellite_node`：本项目唯一的正式节点入口。
 *
 * 模型只调用基础节点；before/base/after 由节点工具在**同一次调用内**自动完成，
 * 参数不能跳过插槽，也不导出裸的 base 工具。装配逻辑在 `lib/wiring.js`，
 * 这里只提供 DSH 侧的导出形式与资源目录。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

import { resourceDirFrom } from '../lib/skills.js'
import { BUILTIN_ROLE_NAMES, BUILTIN_ROUTES } from './lib/config.js'
import { createNodeRuntime, registerCoordinatorBoundary } from './lib/wiring.js'
import type { CoordinatorContext } from './lib/wiring.js'
import { SatelliteRoles } from './lib/role-service.js'
import type { NodeRuntimeContext } from './lib/wiring.js'
import { registerReuseQuery } from './lib/reuse-tools.js'
import type { ReuseToolContext } from './lib/reuse-tools.js'
import { registerSkillScriptTool } from './lib/skill-scripts.js'
import type { SkillScriptContext } from './lib/skill-scripts.js'

// skills 是硬依赖：节点工具必须能注册并核对方法技能，不能靠装配顺序碰运气。
export const inject = ['tools', 'satelliteSlots', 'skills', 'agents', 'systemPrompt']

const RouteSchema = z.object({
  role: z.string().min(1).required(),
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
  reasoningEffort: z.string(),
  maxTokens: z.number(),
})

/**
 * 角色→模型路由是 **volatile 设置**：在设置页可改，插件在每次节点调用时读取，
 * 因此改模型既不需要重启，也不需要重新装配这一行。
 *
 * `declaredRoles` 同样是 volatile，但**只读用途**：设置页的表单只暴露 volatile 字段的值，
 * 所以界面要显示"本行声明了哪些角色"就必须能读到它；这些角色在界面上是**固定行**（不可删除）。
 * 其余字段是普通配置（默认值在代码里，部署层/设置页只提供覆盖）。
 *
 * 两个 volatile 字段的**默认值来自代码**（`./lib/config.js` 里的 `BUILTIN_ROLE_NAMES`/
 * `BUILTIN_ROUTES`，后者由每个角色的 `agentOptions` 投影而来）：插件升级时新增的节点/角色/
 * 默认模型会立即在设置页生效，不需要用户改 profile。**只有用户保存过的覆盖**才会落到 profile
 * ——bundle patch 不再预置这份 config，否则 profile 首次安装物化的旧快照会长期盖住新默认值
 * （Loader 是整行替换、不深合并）。
 */
export const Config = z.object({
  provider: z.string().default('spawn'),
  nodes: z.any(),
  roles: z.any(),
  builtinExtensions: z.any(),
  // `[...]` 只是为了剥掉常量的 `readonly`（schema 的 default 参数要求可变数组），
  // 值与顺序仍完全来自代码常量。
  declaredRoles: z.array(z.string()).default([...BUILTIN_ROLE_NAMES]).volatile(),
  routes: z
    .array(RouteSchema)
    .default(BUILTIN_ROUTES.map((route) => ({ ...route })))
    .volatile(),
})

export function apply(ctx: Context, config: unknown): void {
  const runtime = createNodeRuntime({
    // DSH 的原生服务（tools/skills/subagents/llm/...）由各自的原生包声明合并到 Context；
    // 这里按本模块真正读取的能力收窄一次，避免在本包复刻整套 Context 类型。
    ctx: ctx as unknown as NodeRuntimeContext,
    config,
    defineTool,
    // 资源（locale/icon/skills）不参与构建，构建后入口在 lib/node/，资源仍在包根的 node/。
    resourceDir: resourceDirFrom(import.meta.url, 'node'),
  })
  registerCoordinatorBoundary(ctx as unknown as CoordinatorContext)
  // A read-only native Remote service, owned by this node row's lifecycle.
  // Ordinary roles/nodes remain deployment configuration, not editable volatile settings.
  ctx.plugin(SatelliteRoles, { describe: () => runtime.describeRoles() })
  // Register optional operations only after the node configuration has been validated.
  registerReuseQuery(ctx as unknown as ReuseToolContext)
  ctx.effect(() => registerSkillScriptTool(ctx as unknown as SkillScriptContext, defineTool))
}
