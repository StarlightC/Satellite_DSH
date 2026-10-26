/**
 * Android 只读专项扩展：在公共节点的 before/after 边界补充领域方法。
 *
 * 纯定义模块，不导入 Cordis：能力检查与角色执行由节点工具在调用时注入。
 * 这些扩展只让**只读**的 `android-context` 角色按不同方法技能做专项调查，
 * 不新增角色、不产生机器事实、不启动设备或执行副作用。
 *
 * 状态规则（与剩余规格一致）：
 * - `match`：先看自己的 required 开关（只认布尔 true），再看平台与必需来源字段；
 *   缺字段返回 unknown 并列出字段名，不猜、不在缺字段时启动子会话。
 * - `ready`：只检查本专项真实使用的方法技能与执行能力。
 * - `run`：先做纯结构校验，非法结构在任何模型调用之前返回 blocked。
 * - 文本结论按原文交回；`completed` 只表示拿到了报告，不表示业务通过。
 */

import type { Match, Readiness, SlotExtension, SlotFacts } from '../../lib/contracts.js'
import { PROJECT_KIND, PROJECT_KIND_FACT, ROLE } from './extension.js'

export { ROLE } from './extension.js'

/** 结构校验失败的错误码前缀：调用方按统一词表报告，不解析正文。 */
export const ARGUMENT_INVALID = 'ARGUMENT_INVALID'

export type StructureResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** 校验通过的规范化值（可直接放进子会话任务文本）。 */
export interface SourceRef {
  readonly kind: 'file' | 'configured-tool'
  readonly location: string
  readonly revision: string
}

export interface ReviewScope {
  readonly files: readonly SourceRef[]
  readonly checks: readonly string[]
}

export interface EvidenceTarget {
  readonly project: string
  readonly revision: string
  readonly module?: string
  readonly variant?: string
  readonly serial?: string
}

export interface EvidenceRequirement {
  readonly kind: string
  readonly target: EvidenceTarget
  readonly sources: readonly SourceRef[]
}

export interface EvidenceClaim extends EvidenceRequirement {
  readonly reportedResult: 'passed' | 'failed' | 'not-run'
}

const SOURCE_KINDS = ['file', 'configured-tool'] as const
const CHECK_NAMES = ['api', 'lifecycle', 'resources', 'security', 'ui'] as const
const EVIDENCE_KINDS = ['build', 'unit-test', 'device', 'ui', 'performance', 'memory'] as const
const CLAIM_RESULTS = ['passed', 'failed', 'not-run'] as const

const MAX_SOURCES_PER_ENTRY = 8
const MAX_REQUIREMENTS = 8
const MAX_CLAIMS = 16
const MAX_SCOPE_FILES = 100

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 未知字段一律拒绝：schema 漂移必须显式失败，不能被静默忽略。 */
function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key))
  return extra.length > 0 ? `unknown field(s): ${extra.join(', ')}` : undefined
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length === 0 || value.length > max) return undefined
  return value
}

function parseSourceRef(value: unknown, where: string): StructureResult<SourceRef> {
  if (!isPlainRecord(value)) return { ok: false, error: `${where} must be an object` }
  const extra = unknownKeys(value, ['kind', 'location', 'revision'])
  if (extra) return { ok: false, error: `${where}: ${extra}` }
  if (typeof value.kind !== 'string' || !SOURCE_KINDS.includes(value.kind as (typeof SOURCE_KINDS)[number])) {
    return { ok: false, error: `${where}.kind must be one of ${SOURCE_KINDS.join('/')}` }
  }
  const location = boundedString(value.location, 2048)
  if (location === undefined) return { ok: false, error: `${where}.location must be a non-empty string of at most 2048 characters` }
  const revision = boundedString(value.revision, 128)
  if (revision === undefined) return { ok: false, error: `${where}.revision must be a non-empty string of at most 128 characters` }
  return { ok: true, value: { kind: value.kind as SourceRef['kind'], location, revision } }
}

function parseSourceList(value: unknown, where: string, max: number): StructureResult<readonly SourceRef[]> {
  if (!Array.isArray(value)) return { ok: false, error: `${where} must be an array` }
  if (value.length > max) return { ok: false, error: `${where} has more than ${max} entries` }
  const sources: SourceRef[] = []
  for (const [index, entry] of value.entries()) {
    const parsed = parseSourceRef(entry, `${where}[${index}]`)
    if (!parsed.ok) return parsed
    sources.push(parsed.value)
  }
  return { ok: true, value: sources }
}

/** 已声明专项输入的结构校验；只在启动子会话之前调用。 */
export function parseReviewScope(value: unknown): StructureResult<ReviewScope> {
  if (!isPlainRecord(value)) return { ok: false, error: 'review scope must be an object' }
  const extra = unknownKeys(value, ['files', 'checks'])
  if (extra) return { ok: false, error: `review scope: ${extra}` }
  const files = parseSourceList(value.files, 'review scope.files', MAX_SCOPE_FILES)
  if (!files.ok) return files
  if (files.value.length === 0) return { ok: false, error: 'review scope.files must name at least one source' }
  if (!Array.isArray(value.checks) || value.checks.length === 0) {
    return { ok: false, error: 'review scope.checks must be a non-empty array' }
  }
  const checks: string[] = []
  for (const [index, entry] of value.checks.entries()) {
    if (typeof entry !== 'string' || !CHECK_NAMES.includes(entry as (typeof CHECK_NAMES)[number])) {
      return { ok: false, error: `review scope.checks[${index}] must be one of ${CHECK_NAMES.join('/')}` }
    }
    if (checks.includes(entry)) return { ok: false, error: `review scope.checks has a duplicate: ${entry}` }
    checks.push(entry)
  }
  return { ok: true, value: { files: files.value, checks } }
}

function parseTarget(value: unknown, where: string): StructureResult<EvidenceTarget> {
  if (!isPlainRecord(value)) return { ok: false, error: `${where} must be an object` }
  const extra = unknownKeys(value, ['project', 'revision', 'module', 'variant', 'serial'])
  if (extra) return { ok: false, error: `${where}: ${extra}` }
  const project = boundedString(value.project, 2048)
  if (project === undefined) return { ok: false, error: `${where}.project must be a non-empty string of at most 2048 characters` }
  const revision = boundedString(value.revision, 128)
  if (revision === undefined) return { ok: false, error: `${where}.revision must be a non-empty string of at most 128 characters` }
  const optional: { module?: string; variant?: string; serial?: string } = {}
  for (const key of ['module', 'variant', 'serial'] as const) {
    if (value[key] === undefined) continue
    const parsed = boundedString(value[key], 2048)
    if (parsed === undefined) return { ok: false, error: `${where}.${key} must be a non-empty string of at most 2048 characters` }
    optional[key] = parsed
  }
  return { ok: true, value: { project, revision, ...optional } }
}

function parseRequirement(value: unknown, where: string): StructureResult<EvidenceRequirement> {
  if (!isPlainRecord(value)) return { ok: false, error: `${where} must be an object` }
  const extra = unknownKeys(value, ['kind', 'target', 'sources'])
  if (extra) return { ok: false, error: `${where}: ${extra}` }
  if (typeof value.kind !== 'string' || !EVIDENCE_KINDS.includes(value.kind as (typeof EVIDENCE_KINDS)[number])) {
    return { ok: false, error: `${where}.kind must be one of ${EVIDENCE_KINDS.join('/')}` }
  }
  const target = parseTarget(value.target, `${where}.target`)
  if (!target.ok) return target
  const sources = parseSourceList(value.sources, `${where}.sources`, MAX_SOURCES_PER_ENTRY)
  if (!sources.ok) return sources
  return { ok: true, value: { kind: value.kind, target: target.value, sources: sources.value } }
}

function parseRequirementList(value: unknown, max: number, where: string): StructureResult<readonly EvidenceRequirement[]> {
  if (!Array.isArray(value)) return { ok: false, error: `${where} must be an array` }
  if (value.length === 0) return { ok: false, error: `${where} must name at least one requirement` }
  if (value.length > max) return { ok: false, error: `${where} has more than ${max} entries` }
  const requirements: EvidenceRequirement[] = []
  for (const [index, entry] of value.entries()) {
    const parsed = parseRequirement(entry, `${where}[${index}]`)
    if (!parsed.ok) return parsed
    requirements.push(parsed.value)
  }
  return { ok: true, value: requirements }
}

export function parseEvidenceRequirements(value: unknown): StructureResult<readonly EvidenceRequirement[]> {
  return parseRequirementList(value, MAX_REQUIREMENTS, 'validation requirements')
}

export function parseEvidenceClaims(value: unknown): StructureResult<readonly EvidenceClaim[]> {
  if (!Array.isArray(value)) return { ok: false, error: 'acceptance evidence must be an array' }
  if (value.length === 0) return { ok: false, error: 'acceptance evidence must name at least one entry' }
  if (value.length > MAX_CLAIMS) return { ok: false, error: `acceptance evidence has more than ${MAX_CLAIMS} entries` }
  const claims: EvidenceClaim[] = []
  for (const [index, entry] of value.entries()) {
    if (!isPlainRecord(entry)) return { ok: false, error: `acceptance evidence[${index}] must be an object` }
    const extra = unknownKeys(entry, ['kind', 'target', 'sources', 'reportedResult'])
    if (extra) return { ok: false, error: `acceptance evidence[${index}]: ${extra}` }
    if (typeof entry.reportedResult !== 'string'
      || !CLAIM_RESULTS.includes(entry.reportedResult as (typeof CLAIM_RESULTS)[number])) {
      return { ok: false, error: `acceptance evidence[${index}].reportedResult must be one of ${CLAIM_RESULTS.join('/')}` }
    }
    const requirement = parseRequirement(
      { kind: entry.kind, target: entry.target, sources: entry.sources },
      `acceptance evidence[${index}]`,
    )
    if (!requirement.ok) return requirement
    claims.push({ ...requirement.value, reportedResult: entry.reportedResult as EvidenceClaim['reportedResult'] })
  }
  return { ok: true, value: claims }
}

/** 空 sources 表示"明确要求但未提供证据"：结构合法，但执行前拒绝假装已核对。 */
function requireNonEmptySources(
  entries: readonly { sources: readonly SourceRef[] }[],
  where: string,
): StructureResult<undefined> {
  const empty = entries.findIndex((entry) => entry.sources.length === 0)
  if (empty >= 0) {
    return { ok: false, error: `${where}[${empty}] declares no source to check; collect the evidence first or drop the requirement` }
  }
  return { ok: true, value: undefined }
}

/** 调用作用域提供的能力检查接口（由节点工具注入）。 */
interface CapabilityScope {
  checkRoleAndSkill(role: string, skill: string): Readiness
}

/** 调用作用域提供的角色执行接口（由节点工具注入）。 */
interface RoleScope {
  runConfiguredRole(role: string, task: { skill: string; objective: string }): unknown
}

interface MethodSpec<T> {
  readonly id: string
  readonly slot: string
  /** 只认布尔 true 的开关事实名。 */
  readonly requiredFact: string
  readonly skill: string
  readonly objective: string
  /** 本专项必需的结构化来源字段名。 */
  readonly sourceFacts: readonly string[]
  /** 纯结构校验；在启动任何子会话之前执行。 */
  readonly parse: (facts: SlotFacts) => StructureResult<T>
  /** 已校验输入变成任务文本的一部分。 */
  readonly describe: (value: T) => string
}

function createMethodExtension<T>(spec: MethodSpec<T>): SlotExtension {
  return {
    id: spec.id,
    slot: spec.slot,
    slotVersion: 1,
    role: {
      name: ROLE,
      skill: spec.skill,
      objective: spec.objective,
      condition: `${spec.requiredFact} === true 且 ${PROJECT_KIND_FACT} === '${PROJECT_KIND}'${spec.sourceFacts.length > 0 ? `，已提供 ${spec.sourceFacts.join('、')}；执行前校验输入结构` : ''}；缺少必需字段时等待补充；需角色 ${ROLE} 与技能 ${spec.skill} 可用。`,
    },
    match(facts: SlotFacts): Match {
      // 先看自己的显式要求：未声明就不进入普通任务，避免每次调用都跑全套专项。
      if (facts.values[spec.requiredFact] !== true) return { kind: 'no' }
      const projectKind = facts.values[PROJECT_KIND_FACT]
      if (projectKind === undefined) return { kind: 'unknown', missing: [PROJECT_KIND_FACT] }
      if (projectKind !== PROJECT_KIND) return { kind: 'no' }
      const missing = spec.sourceFacts.filter((name) => facts.values[name] === undefined)
      if (missing.length > 0) return { kind: 'unknown', missing }
      return { kind: 'yes' }
    },
    ready(view: unknown): Readiness {
      if (!view || typeof view !== 'object' || typeof (view as CapabilityScope).checkRoleAndSkill !== 'function') {
        return { ready: false, reason: '调用作用域未提供能力检查接口', missing: ['checkRoleAndSkill'] }
      }
      return (view as CapabilityScope).checkRoleAndSkill(ROLE, spec.skill)
    },
    run(execution: unknown): unknown {
      if (!execution || typeof execution !== 'object') {
        return { status: 'blocked', error: '调用作用域未提供执行上下文' }
      }
      const scope = execution as RoleScope & { facts?: SlotFacts }
      if (typeof scope.runConfiguredRole !== 'function') {
        return { status: 'blocked', error: '调用作用域未提供角色执行接口' }
      }
      if (!scope.facts) return { status: 'blocked', error: `${ARGUMENT_INVALID}: 缺少事实视图` }
      const parsed = spec.parse(scope.facts)
      if (!parsed.ok) return { status: 'blocked', error: `${ARGUMENT_INVALID}: ${parsed.error}` }
      return scope.runConfiguredRole(ROLE, {
        skill: spec.skill,
        objective: `${spec.objective}\n本次专项输入（已按声明结构校验，来源仍需自行读取并核对）：\n${spec.describe(parsed.value)}`,
      })
    },
  }
}

/** Android 只读专项扩展的声明清单；`android.validation-*` 沿用既有静态上下文扩展。 */
export function createAndroidProjectContext(): SlotExtension {
  return createMethodExtension<undefined>({
    id: 'android.project-context',
    slot: 'context.before',
    requiredFact: 'android.context.required',
    skill: 'android-validation-context',
    objective: '按当前任务指定的工程范围补充模块、变体与入口事实；只读，不启动设备或构建。',
    sourceFacts: [],
    parse: () => ({ ok: true, value: undefined }),
    describe: () => '（来源由节点任务指定：当前任务的工程文件与变更范围）',
  })
}

export function createAndroidDesignContext(): SlotExtension {
  return createMethodExtension<SourceRef>({
    id: 'android.design-context',
    slot: 'solution.before',
    requiredFact: 'android.design.required',
    skill: 'android-design-handoff',
    objective: '固定设计来源与修订，交付设计事实与代码复用候选；来源不可达就明确阻塞，不补画设计。',
    sourceFacts: ['android.design.source'],
    parse: (facts) => {
      const parsed = parseSourceRef(facts.values['android.design.source'], 'android.design.source')
      if (!parsed.ok) return parsed
      return { ok: true, value: parsed.value }
    },
    describe: (value) => JSON.stringify(value, null, 2),
  })
}

export function createAndroidPlatformReview(): SlotExtension {
  return createMethodExtension<ReviewScope>({
    id: 'android.platform-review',
    slot: 'review.after',
    requiredFact: 'android.review.required',
    skill: 'android-change-review',
    objective: '按指定检查面对当前变更做平台专项审查；只读，不修改文件，不自动修复。',
    sourceFacts: ['android.review.scope'],
    parse: (facts) => parseReviewScope(facts.values['android.review.scope']),
    describe: (value) => JSON.stringify(value, null, 2),
  })
}

export function createAndroidValidationEvidence(): SlotExtension {
  return createMethodExtension<readonly EvidenceRequirement[]>({
    id: 'android.validation-evidence',
    slot: 'validate.after',
    requiredFact: 'android.validation.required',
    skill: 'android-validation-evidence',
    objective: '核对声明的领域证据来源与修订，判定齐备、失配或缺失；不伪造运行结果，不代替基础节点验收。',
    sourceFacts: ['android.validation.requirements'],
    parse: (facts) => {
      const parsed = parseEvidenceRequirements(facts.values['android.validation.requirements'])
      if (!parsed.ok) return parsed
      const nonEmpty = requireNonEmptySources(parsed.value, 'validation requirements')
      if (!nonEmpty.ok) return nonEmpty
      return { ok: true, value: parsed.value }
    },
    describe: (value) => JSON.stringify(value, null, 2),
  })
}

export function createAndroidAcceptanceEvidence(): SlotExtension {
  return createMethodExtension<readonly EvidenceClaim[]>({
    id: 'android.acceptance-evidence',
    slot: 'signoff.before',
    requiredFact: 'android.acceptance.required',
    skill: 'android-acceptance-evidence',
    objective: '汇总已有测试、设计与设备证据的位置、修订与遗漏，供基础验收判断；不替基础验收作最终接受，不触发发布。',
    sourceFacts: ['android.acceptance.evidence'],
    parse: (facts) => {
      const parsed = parseEvidenceClaims(facts.values['android.acceptance.evidence'])
      if (!parsed.ok) return parsed
      const nonEmpty = requireNonEmptySources(parsed.value.map((claim) => ({ sources: claim.sources })), 'acceptance evidence')
      if (!nonEmpty.ok) return nonEmpty
      return { ok: true, value: parsed.value }
    },
    describe: (value) => JSON.stringify(value, null, 2),
  })
}

/** 本组件注册的全部专项扩展（既有静态上下文扩展单独保留在 extension.ts）。 */
export function createAndroidNodeExtensions(): readonly SlotExtension[] {
  return [
    createAndroidProjectContext(),
    createAndroidDesignContext(),
    createAndroidPlatformReview(),
    createAndroidValidationEvidence(),
    createAndroidAcceptanceEvidence(),
  ]
}

/** 本组件注册的全部技能名，供入口逐个加载。 */
export const ANDROID_SKILL_NAMES: readonly string[] = Object.freeze([
  'android-validation-context',
  'android-design-handoff',
  'android-change-review',
  'android-validation-evidence',
  'android-acceptance-evidence',
  'android-compose-performance',
  'android-anr-diagnostics',
  'android-permissions-security',
  'android-kotlin-concurrency',
  'android-compose-state-effects',
  'android-compose-ui-testing',
  'android-performance-analysis',
])
