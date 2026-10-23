/**
 * Android 项目事实：静态线索与经批准的动态发现。
 *
 * 两条路径分开，不能互相冒充：
 * - **静态 inspect**：只读工作区内的构建文件，给出"线索"（来源 static-text，`verified: false`），
 *   不启动任何进程，也不声称 Gradle 任务真实存在。
 * - **动态 discover-build**：经真实批准调用用户配置的 Android CLI，
 *   把它的 1.0.x 报告解析成模块/变体/产物事实；版本不支持或报告形状不符即拒绝。
 *
 * 解析器只固定"已观测到的报告形状 + 版本门"，不猜其他版本；实现为本项目原创代码，
 * 不复制旧仓库源码（旧包授权依据仍在待决项 D3）。
 */

import type { SandboxMode } from './contracts.js'

/** 静态线索：有来源、可核对，但不是可执行的构建事实。 */
export interface ProjectLead {
  readonly kind: 'wrapper' | 'settings' | 'build-file' | 'module-dir'
  readonly path: string
  readonly detail: string
}

export interface StaticProjectFacts {
  readonly projectRoot: string
  readonly leads: readonly ProjectLead[]
  readonly missing: readonly string[]
  readonly provenance: 'static-text'
  readonly verified: false
}

export interface AndroidArtifactFact {
  readonly kind: 'apk'
  readonly path: string
}

export interface AndroidVariantFact {
  readonly name: string
  readonly artifacts: readonly AndroidArtifactFact[]
}

export interface AndroidModuleFact {
  readonly path: string
  readonly variants: readonly AndroidVariantFact[]
}

/** 动态事实：由 Android CLI 报告解析而来，带 CLI 版本与观测时间。 */
export interface DynamicProjectFacts {
  readonly projectRoot: string
  readonly gradleWrapper: string
  readonly cliVersion: string
  readonly observedAt: string
  readonly modules: readonly AndroidModuleFact[]
  readonly provenance: 'android-cli-describe'
  readonly cliPath: string
  readonly inputDigests: Readonly<Record<string, string>>
}

export const STATIC_LEAD_LIMIT = 50
export const CLI_VERSION_POLICY = 'android-cli-1.0.x'
/** 观测有效期：过期必须重新发现，不能把旧模型套到新批准上。 */
export const OBSERVATION_TTL_MS = 5 * 60 * 1000

/** `android --version` 的支持线；只接受 1.0.x 的稳定数字版本。 */
export function parseAndroidCliVersion(output: string): string | undefined {
  const text = output.trim()
  return /^1\.0\.\d+$/u.test(text) ? text : undefined
}

/**
 * 解析 Android CLI 1.0.x `describe` 报告。
 *
 * 报告是行式的：锚点行 + 缩进的 Task/Variant/APK 三级结构。
 * 任何锚点缺失、重复、路径非绝对或形状不符都抛错——宁可不可用，不猜。
 */
export function parseAndroidCliDescribe(
  stdout: string,
  canonicalProjectRoot: string,
  paths: { gradleWrapperPath(root: string): string; isAbsoluteHostPath(path: string): boolean },
): { gradleWrapper: string; modules: readonly AndroidModuleFact[] } {
  const lines = stdout.replaceAll('\r\n', '\n').split('\n')
  const expectedWrapper = paths.gradleWrapperPath(canonicalProjectRoot)
  if (!paths.isAbsoluteHostPath(expectedWrapper)) throw new TypeError('Gradle wrapper path must be absolute')

  if (!lines.includes(`Target project directory: ${canonicalProjectRoot}`)) {
    throw new TypeError('Android CLI describe target does not match the requested project root')
  }
  if (!lines.includes(`Project directory exists: ${canonicalProjectRoot}`)) {
    throw new TypeError('Android CLI did not confirm the requested project directory')
  }
  if (!lines.includes('Parsed tasks:')) throw new TypeError('Android CLI report is missing its task section')
  if (!lines.includes('gradlew completed successfully.')) {
    throw new TypeError('Android CLI did not complete Gradle description successfully')
  }

  const modules = new Map<string, { path: string; variants: Map<string, AndroidArtifactFact[]> }>()
  let currentModule: { path: string; variants: Map<string, AndroidArtifactFact[]> } | undefined
  let currentVariant: AndroidArtifactFact[] | undefined
  for (const line of lines) {
    const task = /^Task: (:[^\s]+)$/u.exec(line)
    if (task !== null) {
      const path = task[1] as string
      if (modules.has(path)) throw new TypeError(`Android CLI reported duplicate module ${path}`)
      currentModule = { path, variants: new Map() }
      modules.set(path, currentModule)
      currentVariant = undefined
      continue
    }
    const variant = /^ {4}Variant: ([A-Za-z][A-Za-z0-9_]*)$/u.exec(line)
    if (variant !== null) {
      if (currentModule === undefined) throw new TypeError('Android CLI reported a variant before its module')
      const name = variant[1] as string
      if (currentModule.variants.has(name)) {
        throw new TypeError(`Android CLI reported duplicate variant ${currentModule.path}:${name}`)
      }
      currentVariant = []
      currentModule.variants.set(name, currentVariant)
      continue
    }
    const apk = /^ {8}APK: (.+?)(?: \(Exists\))?$/u.exec(line)
    if (apk !== null) {
      if (currentVariant === undefined) throw new TypeError('Android CLI reported an APK before its variant')
      const path = apk[1] as string
      if (!paths.isAbsoluteHostPath(path)) {
        throw new TypeError(`Android CLI reported a non-absolute APK path: ${path}`)
      }
      currentVariant.push({ kind: 'apk', path })
    }
  }
  if (modules.size === 0) throw new TypeError('Android CLI describe report declared no modules')

  return {
    gradleWrapper: expectedWrapper,
    modules: [...modules.values()].map((module) => ({
      path: module.path,
      variants: [...module.variants.entries()].map(([name, artifacts]) => ({ name, artifacts })),
    })),
  }
}

/* --------------------------------------------------------- 观测（有界、只读） */

export interface Observation {
  readonly id: string
  readonly ownerId: string
  readonly facts: DynamicProjectFacts
  readonly expiresAt: number
  readonly modelDigest: string
}

export type ObservationLookup =
  | { readonly ok: true; readonly observation: Observation }
  | { readonly ok: false; readonly code: 'TARGET_REQUIRED' | 'TARGET_CHANGED' | 'CAPABILITY_UNAVAILABLE'; readonly message: string }

export interface ObservationStore {
  put(ownerId: string, facts: DynamicProjectFacts, modelDigest: string): Observation
  get(id: string): ObservationLookup
  getFor(id: string, ownerId: string): ObservationLookup
  size(): number
}

/** 观测只定位事实，不授予执行；id 不透明、按调用方隔离、有寿命。 */
export function createObservationStore(
  now: () => number,
  randomId: () => string,
  ttlMs = OBSERVATION_TTL_MS,
): ObservationStore {
  const entries = new Map<string, Observation>()
  return {
    put(ownerId: string, facts: DynamicProjectFacts, modelDigest: string): Observation {
      const observation: Observation = Object.freeze({
        id: randomId(),
        ownerId,
        facts,
        expiresAt: now() + ttlMs,
        modelDigest,
      })
      entries.set(observation.id, observation)
      return observation
    },
    get(id: string): ObservationLookup {
      const observation = entries.get(id)
      if (!observation) return { ok: false, code: 'TARGET_REQUIRED', message: 'unknown or expired build observation id' }
      if (observation.expiresAt <= now()) {
        entries.delete(id)
        return { ok: false, code: 'TARGET_CHANGED', message: 'build observation expired; discover again' }
      }
      return { ok: true, observation }
    },
    /** 只允许观测所有者消费；跨调用方/跨会话的 id 一律拒绝。 */
    getFor(id: string, ownerId: string): ObservationLookup {
      const found = this.get(id)
      if (!found.ok) return found
      if (found.observation.ownerId !== ownerId) {
        return { ok: false, code: 'TARGET_CHANGED', message: 'build observation belongs to another caller' }
      }
      return found
    },
    size(): number {
      return entries.size
    },
  }
}

/** 从项目根与文件系统能力构造静态线索；不执行任何进程。 */
export async function inspectStaticProject(params: {
  readonly projectRoot: string
  readonly fs: {
    resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>
    stat(target: unknown, signal?: AbortSignal): Promise<{ type: string } | undefined>
    listDir(target: unknown, signal?: AbortSignal): Promise<readonly { name: string; type: string }[]>
    processPath(target: unknown): string
  }
  readonly signal: AbortSignal
}): Promise<StaticProjectFacts> {
  const { projectRoot, fs, signal } = params
  const rootPath = projectRoot
  const leads: ProjectLead[] = []
  const missing: string[] = []

  const resolveIn = async (relative: string) => fs.resolve(relative, { cwd: rootPath, signal })
  const exists = async (relative: string): Promise<string | undefined> => {
    const target = await resolveIn(relative)
    const info = await fs.stat(target, signal)
    return info ? fs.processPath(target) : undefined
  }

  for (const [kind, relative, detail] of [
    ['wrapper', 'gradlew', 'Gradle wrapper script; not executed by static inspection'],
    ['wrapper', 'gradlew.bat', 'Windows Gradle wrapper script; not executed by static inspection'],
    ['settings', 'settings.gradle', 'Gradle settings file (Groovy)'],
    ['settings', 'settings.gradle.kts', 'Gradle settings file (Kotlin DSL)'],
    ['build-file', 'build.gradle', 'root build file (Groovy)'],
    ['build-file', 'build.gradle.kts', 'root build file (Kotlin DSL)'],
  ] as const) {
    const found = await exists(relative)
    if (found) leads.push({ kind, path: found, detail })
  }
  if (!leads.some((lead) => lead.kind === 'wrapper')) missing.push('gradlew')

  let entries: readonly { name: string; type: string }[] = []
  try {
    entries = await fs.listDir(await resolveIn('.'), signal)
  } catch {
    entries = []
  }
  let inspected = 0
  for (const entry of entries) {
    if (inspected >= STATIC_LEAD_LIMIT) break
    if (entry.type !== 'directory') continue
    if (entry.name.startsWith('.') || entry.name === 'build' || entry.name === 'node_modules') continue
    inspected += 1
    for (const candidate of ['build.gradle', 'build.gradle.kts']) {
      const found = await exists(`${entry.name}/${candidate}`)
      if (!found) continue
      leads.push({
        kind: 'module-dir',
        path: found,
        detail: 'directory contains a Gradle build file; module identity and tasks are NOT verified by static inspection',
      })
      break
    }
  }
  if (!leads.some((lead) => lead.kind === 'module-dir')) missing.push('module build files')

  return Object.freeze({
    projectRoot: rootPath,
    leads: Object.freeze(leads),
    missing: Object.freeze(missing),
    provenance: 'static-text',
    verified: false,
  })
}

/** 动态事实的摘要：批准前后逐字段比较用。 */
export function digestDynamicFacts(sha256: (text: string) => string, facts: Omit<DynamicProjectFacts, 'inputDigests'> | DynamicProjectFacts): string {
  return sha256(JSON.stringify({
    projectRoot: facts.projectRoot,
    gradleWrapper: facts.gradleWrapper,
    cliVersion: facts.cliVersion,
    modules: facts.modules,
  }))
}

/** 一次动态发现需要的执行模式：发现会创建元数据/缓存，按 workspace-write 处理。 */
export const DISCOVERY_MODE: SandboxMode = 'workspace-write'
