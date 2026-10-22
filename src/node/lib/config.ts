/**
 * 节点工具配置：默认值、按角色深合并。
 *
 * 角色是唯一的配置来源，基础节点与领域扩展共用；合并必须逐角色进行，
 * 否则行配置里只写 skill/objective 会把默认的 persona 与 toolFilter 一起顶掉。
 *
 * 分层原则：**声明式默认值归代码**（本文件的 `DEFAULT_CONFIG` 与由它派生的
 * `BUILTIN_ROLE_NAMES`/`BUILTIN_ROUTES`，作为 schema 默认值），bundle patch 只声明"行"，
 * profile 只保存用户自己的选择。默认值不放进 patch：profile 首次安装会物化 patch 里的
 * config 快照，而 Loader 是**整行替换、不深合并**，旧快照会长期盖住代码里的新默认值。
 */


/** 子 Agent 的角色路由；与 DSH 原生 agentOptions 同形（这里只声明本包用到的字段）。 */
export interface AgentOptions {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly maxTokens?: number
}

/**
 * 文件沙箱模式：与 `@deepseek-ai/dsh-sandbox` 导出的 `SandboxMode` 逐字一致
 * （`read-only | workspace-write | danger-full-access`）。
 *
 * 刻意**不** import 那个类型：`dsh-sandbox` 与 `dsh-sandbox-policy` 在本包里只是
 * devDependency 的**传递**依赖（见 package-lock，未列入 package.json 的
 * dependencies/peerDependencies）。给公共包接一条清单里没有的编译期依赖，比在这里
 * 复述这三个字面量更脆弱；真正施加之处的写入方式与出处见 `wiring.ts`。
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** 由严到宽：索引越小约束越强。用于"拿不准时取最严格"的失败关闭。 */
const SANDBOX_MODE_ORDER: readonly SandboxMode[] = Object.freeze([
  'read-only',
  'workspace-write',
  'danger-full-access',
])

/** 运行时校验来自行配置/活配置的非受信字符串。 */
export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === 'string' && (SANDBOX_MODE_ORDER as readonly string[]).includes(value)
}

/**
 * 取最严格的模式（失败关闭用）：候选为空时回落到 `read-only`，
 * 宁可给更严格的一侧，也不静默放过更宽的一侧。
 */
export function strictestSandboxMode(modes: readonly SandboxMode[]): SandboxMode {
  if (modes.length === 0) return 'read-only'
  return modes.reduce<SandboxMode>(
    (strictest, mode) =>
      SANDBOX_MODE_ORDER.indexOf(mode) < SANDBOX_MODE_ORDER.indexOf(strictest) ? mode : strictest,
    'danger-full-access',
  )
}

/** 一个角色实际生效的沙箱模式，以及它来自哪里（结果里要如实报告来源）。 */
export interface SandboxDecision {
  readonly mode: SandboxMode
  readonly source: 'role' | 'invalid-fallback' | 'missing-fallback'
}

/**
 * 角色实际生效的沙箱模式。缺失或非法一律**失败关闭**到 `read-only`：
 * 只读边界是这条设计的目的，配错时不能退化成"不施加"。
 */
export function effectiveSandboxMode(role: RoleConfig | undefined): SandboxDecision {
  const configured: unknown = role?.sandbox
  if (isSandboxMode(configured)) return { mode: configured, source: 'role' }
  return { mode: 'read-only', source: configured === undefined ? 'missing-fallback' : 'invalid-fallback' }
}

export interface RoleConfig {
  readonly label?: string
  readonly skill?: string
  readonly objective?: string
  readonly persona?: string
  readonly provider?: string
  readonly toolFilter?: { readonly deny?: readonly string[] }
  readonly maxDepth?: number
  readonly agentOptions?: AgentOptions
  /**
   * 该角色子 Agent 的文件沙箱模式（DSH 原生 `sandbox/mode`）：`toolFilter` 只能
   * 拿掉 `edit`/`write` 这类工具，`bash` 仍然可写；这里的模式才是**真实的文件边界**。
   * 缺省/非法都失败关闭到 `read-only`（见 `effectiveSandboxMode`）。
   */
  readonly sandbox?: SandboxMode
  /** 已撤回的旧写范围配置。任何非 undefined 值都拒绝启动，不能静默放宽。 */
  readonly cwd?: unknown
}

export const UNSUPPORTED_ROLE_CWD =
  '不支持 role.cwd 收窄写范围：原生 request.cwd 只改变工作目录，不改变继承的沙箱根；请移除旧配置并重新确认父会话授权范围'

export const NODE_TIERS = ['light', 'standard', 'senior'] as const
export type NodeTier = typeof NODE_TIERS[number]

export interface NodeEntry {
  readonly role: string
  /** 显式档位的完整映射；不与默认图深合并。省略 tier 始终使用 role。 */
  readonly tierRoles?: Readonly<Partial<Record<NodeTier, string>>>
}

export interface NodeRoleSelection {
  readonly role: string
  readonly tier?: NodeTier
}

/** Only declared node mappings select roles; caller facts never grant a role. */
export function selectNodeRole(
  entry: NodeEntry,
  roles: Readonly<Record<string, RoleConfig>>,
  tier: unknown,
  previous?: NodeRoleSelection,
): NodeRoleSelection {
  if (tier !== undefined && !NODE_TIERS.includes(tier as NodeTier)) {
    throw new Error('tier 必须为 light、standard 或 senior（不是执行风险等级）')
  }
  if (previous) {
    if (tier !== undefined && tier !== previous.tier) {
      throw new Error('resume 不能改变已选 tier；省略 tier 可继续原调用，升降档请新建节点调用')
    }
    return previous
  }
  const role = tier === undefined ? entry.role : entry.tierRoles?.[tier as NodeTier]
  if (!role) throw new Error(`节点未配置 ${String(tier)} 档角色；请配置映射、转专项或请求用户决定`)
  if (!Object.hasOwn(roles, role)) throw new Error(`未配置角色：${role}`)
  return Object.freeze({ role, ...(tier === undefined ? {} : { tier: tier as NodeTier }) })
}

/** 核心自带扩展的开关：逐字段合并，缺省走默认值。 */
export interface BuiltinExtensionsConfig {
  /** `after` 阶段的验收决定扩展（`core.acceptance-decision.<node>`）。 */
  readonly acceptanceDecision: boolean
}

/** 归一化后的行配置：默认值已按角色合并，volatile 字段不在其中（每次调用现读）。 */
export interface NormalizedConfig {
  readonly provider: string
  readonly skills: readonly string[]
  readonly nodes: Readonly<Record<string, NodeEntry>>
  readonly roles: Readonly<Record<string, RoleConfig>>
  readonly builtinExtensions: BuiltinExtensionsConfig
}

/** 执行子 Agent 不继承节点入口，避免递归包裹正式节点。 */
export const EXECUTOR_TOOL_FILTER: Readonly<{ deny: readonly string[] }> = Object.freeze({
  deny: ['satellite_node'],
})

/**
 * 工具过滤仅减少专用写入口并避免节点递归，保留 bash 等调查工具。
 * 受限文件操作由原生 sandbox 强制；不承诺网络、设备或其他非文件效果只读。
 */
export const READ_ONLY_REVIEW_TOOL_FILTER: Readonly<{ deny: readonly string[] }> = Object.freeze({
  deny: ['satellite_node', 'edit', 'write'],
})

/**
 * 实施角色（`implementation`）的工具过滤：拒绝节点入口（禁止递归包裹正式节点），
 * 保留 `edit`/`write`；validation 为测试/构建也需要文件写权限。
 * 文件权限由父会话原生沙箱根与收窄后的模式决定；旧 `RoleConfig.cwd` 一律拒绝。
 */
export const IMPLEMENT_TOOL_FILTER: Readonly<{ deny: readonly string[] }> = Object.freeze({
  deny: ['satellite_node'],
})

const BASE_CONFIG: NormalizedConfig = Object.freeze({
  provider: 'spawn',
  // 只登记本包自带的技能；领域技能由对应组件自己注册，core 不读别的组件的文件。
  skills: Object.freeze([
    'satellite-base-flow',
    'satellite-validation',
    'satellite-change-review',
    'satellite-investigation',
    'satellite-solution',
    'satellite-acceptance',
    'satellite-implementation',
  ]),
  // 顺序按流程的步骤序号：context（第一步）→ solution（第二步）→ implement（第三步）→ validate → review → signoff。
  nodes: Object.freeze({
    context: Object.freeze({ role: 'investigation' }),
    solution: Object.freeze({ role: 'solution-design' }),
    implement: Object.freeze({ role: 'implementation' }),
    validate: Object.freeze({ role: 'validation' }),
    review: Object.freeze({ role: 'change-review' }),
    signoff: Object.freeze({ role: 'acceptance' }),
  }),
  roles: Object.freeze({
    // 流程第一步（`context` 节点）：只读的有界调查，调查同样不许写。
    investigation: Object.freeze({
      label: '有界调查',
      skill: 'satellite-investigation',
      objective: '先写下本次调查的范围与停止条件，再定向读取决定性的来源；产出事实与状态所有者、可复用候选、对直接影响面的影响与仍未解缺口；只读，不改文件。',
      persona: '区分读到的事实与自己的推断，事实附上确切位置；缺口如实保留为缺口，不用猜测补齐。',
      toolFilter: READ_ONLY_REVIEW_TOOL_FILTER,
      sandbox: 'read-only',
      agentOptions: Object.freeze({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
    }),
    // 带连字符的键在对象字面量里必须加引号：不加引号会被当成减法表达式（本项目已踩过）。
    // 流程第二步（`solution` 节点）：把有界事实转成可评审的选项，到此为止，不实施。
    'solution-design': Object.freeze({
      label: '方案设计',
      skill: 'satellite-solution',
      objective: '把有界事实转成可评审的选项，逐条列出需要谁做什么决定；不实施、不扩大目标，提交方案后停下等待决定。',
      persona: '区分事实与推断，选项所依据的事实附上确切位置；判断不了的选项如实说明，不编造信心。',
      toolFilter: READ_ONLY_REVIEW_TOOL_FILTER,
      sandbox: 'read-only',
      agentOptions: Object.freeze({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
    }),
    // 流程第三步（`implement` 节点）：负责源代码实施；validation 也可写入构建/测试产物。
    // 它拿 `workspace-write` 沙箱 + `IMPLEMENT_TOOL_FILTER`（不拒绝 edit/write），
    // 不支持以工作目录收窄写边界；旧 cwd 配置失败关闭。
    implementation: Object.freeze({
      label: '代码实施',
      skill: 'satellite-implementation',
      objective: '只改已同意的基线，一次一个单元：动手前用一小段写明改什么、范围与不在范围内、验证方式，以及仍缺的决定（缺决定就停在这里）；改动取满足单元的最小面，复用既有约定，不顺手重构、不扩大目标、不提交不发布；完成后跑该范围需要的编译/类型检查并如实报告（完整验证归 validate）。',
      persona: '区分"已同意的基线"与自己的发挥：没有同意的改动停手，把决定交回而不是替用户决定；失败证据一并保留，不把部分检查说成验证；环境或权限阻塞如实报告为阻塞。',
      toolFilter: IMPLEMENT_TOOL_FILTER,
      sandbox: 'workspace-write',
      agentOptions: Object.freeze({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
    }),
    validation: Object.freeze({
      label: '项目验证',
      skill: 'satellite-validation',
      objective: '执行项目实际适用的验证命令；返回真实执行结果、证据位置与未测范围。',
      persona: '只报告实际执行过的验证与真实结果；不把未运行的检查说成通过。',
      toolFilter: EXECUTOR_TOOL_FILTER,
      // 验证角色要跑测试/构建，会真实产生文件，因此是可写工作区的角色之一（继承父会话沙箱根）。
      sandbox: 'workspace-write',
      agentOptions: Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    }),
    // 带连字符的键在对象字面量里必须加引号：不加引号会被当成减法表达式（本项目已踩过）。
    'change-review': Object.freeze({
      label: '独立审查',
      skill: 'satellite-change-review',
      objective: '锁定当前差异与其消费者，独立审查实际改动与相关源码，给出结论与限制；不修改任何文件，不自动修复，不提交。',
      persona: '只依据实际差异与相关源码下结论；区分已证实的问题与未验证的怀疑，读不到的内容明确报告为未验证。',
      toolFilter: READ_ONLY_REVIEW_TOOL_FILTER,
      sandbox: 'read-only',
      // 独立审查刻意**不用** validation 的 flash：独立性的一半就是与验证角色不同的模型。
      agentOptions: Object.freeze({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
    }),
    // 流程末步（`signoff` 节点）：只按证据声明接受与否与剩余限制，不提交、不发布、不自动修复。
    acceptance: Object.freeze({
      label: '证据验收',
      skill: 'satellite-acceptance',
      objective: '按实际证据逐条声明接受与否，给出证据位置与仍未验证的剩余限制；不提交、不发布、不自动修复，需要用户决定的接受交回用户。',
      persona: '只按证据下结论；缺失证据列为未验证而不是默认通过，完成运行本身不当作业务验收。',
      toolFilter: READ_ONLY_REVIEW_TOOL_FILTER,
      sandbox: 'read-only',
      agentOptions: Object.freeze({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
    }),
    'android-context': Object.freeze({
      label: 'Android 专项调查',
      skill: 'android-validation-context',
      objective: '确认当前模块、变体和相关测试入口；不启动设备或运行测试。',
      toolFilter: EXECUTOR_TOOL_FILTER,
      sandbox: 'read-only',
      agentOptions: Object.freeze({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
    }),
  }),
  builtinExtensions: Object.freeze({
    acceptanceDecision: true,
  }),
})

/** Tier variants reuse the corresponding method and safety defaults, not a new model ladder. */
export const DEFAULT_CONFIG: NormalizedConfig = Object.freeze({
  ...BASE_CONFIG,
  nodes: Object.freeze({
    ...BASE_CONFIG.nodes,
    implement: Object.freeze({ role: 'implementation', tierRoles: Object.freeze({
      light: 'implementation-light', standard: 'implementation', senior: 'implementation-senior',
    }) }),
    review: Object.freeze({ role: 'change-review', tierRoles: Object.freeze({
      light: 'change-review-light', standard: 'change-review',
    }) }),
    validate: Object.freeze({ role: 'validation', tierRoles: Object.freeze({
      light: 'validation-light', standard: 'validation',
    }) }),
  }),
  roles: Object.freeze({
    ...BASE_CONFIG.roles,
    'implementation-light': Object.freeze({
      ...BASE_CONFIG.roles.implementation,
      label: '局部低风险实施',
      objective: `${BASE_CONFIG.roles.implementation!.objective} 仅承担边界清楚、局部低风险且易回退的单元；超出该范围或出现未解风险时停止并交回，不降低任务整体审查要求。`,
    }),
    'implementation-senior': Object.freeze({
      ...BASE_CONFIG.roles.implementation,
      label: '复杂边界实施',
      objective: `${BASE_CONFIG.roles.implementation!.objective} 处理无法安全拆成独立轻量单元的耦合边界；先核对已有失败历史与当前改动，不通过重派清零同档预算、不重复被证据否定的方法；仍无法解决时交回专项或用户，不无限重试。`,
    }),
    'change-review-light': Object.freeze({
      ...BASE_CONFIG.roles['change-review'],
      label: '局部低风险审查',
      objective: `${BASE_CONFIG.roles['change-review']!.objective} 只审查局部低风险、直接消费者明确的改动；证据超出局部范围或返工后仍未解决时交回常规审查或专项，不把局部结论当整体通过。`,
    }),
    'validation-light': Object.freeze({
      ...BASE_CONFIG.roles.validation,
      label: '局部验证',
      objective: `${BASE_CONFIG.roles.validation!.objective} 仅执行范围明确的局部检查，明确标注局部证据与未测范围；重复同因失败或需要更广验证时交回，不以局部通过替代整体验证。`,
    }),
  }),
})

/**
 * 由代码计算的角色清单，供 schema 默认值使用（`src/node/index.ts` 的 `declaredRoles`）。
 * 顺序与 `DEFAULT_CONFIG.roles` 的声明顺序一致。
 */
export const BUILTIN_ROLE_NAMES: readonly string[] = Object.freeze(Object.keys(DEFAULT_CONFIG.roles))

/** 一个内置角色的默认路由条目；provider/model 缺一不列入 `BUILTIN_ROUTES`。 */
export interface BuiltinRoute {
  readonly role: string
  readonly provider: string
  readonly model: string
}

/**
 * 由每个角色的 `agentOptions` 投影出的默认路由，供 schema 默认值使用
 * （`src/node/index.ts` 的 `routes`）。默认在代码里，所以插件升级后设置页立即看到新默认值；
 * 只有**用户保存的覆盖**才会落到 profile。
 */
export const BUILTIN_ROUTES: readonly BuiltinRoute[] = Object.freeze(
  Object.entries(DEFAULT_CONFIG.roles).flatMap(([role, entry]): BuiltinRoute[] => {
    const options = entry.agentOptions
    if (!options?.provider || !options.model) return []
    return [{ role, provider: options.provider, model: options.model }]
  }),
)

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/**
 * 把行配置归一化成默认值 + 覆盖。
 * 输入按未类型化的行配置处理（Host 侧校验由 DSH 的 Config schema 负责）。
 */
export function normalizeConfig(config?: unknown): NormalizedConfig {
  const incoming = asRecord(config)
  const nodes: Record<string, NodeEntry> = { ...DEFAULT_CONFIG.nodes }
  for (const [nodeId, entry] of Object.entries(asRecord(incoming.nodes))) {
    const override = asRecord(entry)
    const merged = { ...(DEFAULT_CONFIG.nodes[nodeId] ?? {}), ...override } as NodeEntry
    // An explicit role override owns routing; never retain hidden builtin tier bindings.
    const { tierRoles: _tiers, ...withoutTiers } = merged
    if (Object.hasOwn(override, 'tierRoles')) {
      const value = override.tierRoles
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`nodes.${nodeId}.tierRoles 必须是档位到角色的映射`)
      }
      const tierRoles: Partial<Record<NodeTier, string>> = {}
      for (const [tier, role] of Object.entries(value)) {
        if (!NODE_TIERS.includes(tier as NodeTier) || typeof role !== 'string' || !role.trim()) {
          throw new Error(`nodes.${nodeId}.tierRoles.${tier} 必须使用合法档位和非空角色名`)
        }
        tierRoles[tier as NodeTier] = role
      }
      nodes[nodeId] = { ...withoutTiers, tierRoles: Object.freeze(tierRoles) }
    } else {
      nodes[nodeId] = Object.hasOwn(override, 'role') ? withoutTiers : merged
    }
  }
  // 逐字段合并：行配置只写 objective 时，默认的 persona/toolFilter/sandbox 都要保留
  // （把 `sandbox` 改成整体替换会让只读角色静默变宽）。
  const roles: Record<string, RoleConfig> = { ...DEFAULT_CONFIG.roles }
  for (const [roleName, entry] of Object.entries(asRecord(incoming.roles))) {
    const override = asRecord(entry)
    if (Object.hasOwn(DEFAULT_CONFIG.roles, roleName) && Object.hasOwn(override, 'agentOptions')) {
      // Built-in routing has one user-facing source: routes. Hidden role defaults
      // would otherwise change when a sparse routes array replaces schema defaults.
      // Accept only an exact old snapshot; partial/invalid/extra options must migrate.
      const supplied = override.agentOptions
      const expected = DEFAULT_CONFIG.roles[roleName]?.agentOptions ?? {}
      const fields = Object.keys(expected)
      const candidate = asRecord(supplied)
      const identical = supplied !== null && typeof supplied === 'object' && !Array.isArray(supplied)
        && Object.keys(candidate).length === fields.length
        && fields.every((key) => Object.hasOwn(candidate, key)
          && candidate[key] === expected[key as keyof AgentOptions])
      if (!identical) {
        throw new Error(`内置角色 ${roleName} 的 roles.${roleName}.agentOptions 不能覆盖代码默认；请将 provider/model/reasoningEffort/maxTokens 迁移到 routes 中该角色的条目`)
      }
    }
    roles[roleName] = { ...(DEFAULT_CONFIG.roles[roleName] ?? {}), ...override } as RoleConfig
  }
  const incomingSkills = Array.isArray(incoming.skills) ? (incoming.skills as string[]) : []
  const skills = [...new Set([...DEFAULT_CONFIG.skills, ...incomingSkills])]
  // 逐字段合并：行配置只写一个开关时，另一个开关保持默认，不被整体顶掉。
  const incomingBuiltins = asRecord(incoming.builtinExtensions)
  const builtinExtensions: BuiltinExtensionsConfig = {
    acceptanceDecision:
      typeof incomingBuiltins.acceptanceDecision === 'boolean'
        ? incomingBuiltins.acceptanceDecision
        : DEFAULT_CONFIG.builtinExtensions.acceptanceDecision,
  }
  return {
    provider: typeof incoming.provider === 'string' ? incoming.provider : DEFAULT_CONFIG.provider,
    skills,
    nodes,
    roles,
    builtinExtensions,
  }
}

/**
 * 读取活配置字段。`.volatile()` 字段在插件里是引用对象（用 `.get()` 读当前值）；
 * 普通配置或测试里的普通对象则原样返回。两种形态都支持，避免把形态当成契约。
 */
export function readLiveConfigValue<T>(field: unknown, fallback: T): T {
  if (field && typeof field === 'object' && 'get' in field) {
    const getter = (field as { get?: unknown }).get
    if (typeof getter === 'function') {
      const value = (getter as () => unknown).call(field)
      return value === undefined || value === null ? fallback : (value as T)
    }
  }
  return field === undefined || field === null ? fallback : (field as T)
}

/**
 * 一个角色的实际生效路由：活配置 `routes`（按 role 匹配的条目）优先，
 * 否则回落到该角色的 `agentOptions`（内置角色为代码默认；自定义角色为部署默认）。
 */
export function effectiveAgentOptions(params: {
  role: RoleConfig | undefined
  roleName: string
  routes: unknown
}): AgentOptions | undefined {
  const { role, roleName, routes } = params
  const base = role?.agentOptions
  if (Array.isArray(routes)) {
    const seen = new Set<string>()
    for (const entry of routes as readonly { role?: unknown }[]) {
      if (typeof entry?.role !== 'string') continue
      if (seen.has(entry.role)) throw new Error(`角色路由重复：${entry.role}`)
      seen.add(entry.role)
    }
  }
  const live = Array.isArray(routes)
    ? (routes as readonly { role?: string }[]).find((entry) => entry?.role === roleName)
    : undefined
  if (!live) return base
  const { role: _role, ...route } = live as AgentOptions & { role?: string }
  return { ...(base ?? {}), ...route }
}
