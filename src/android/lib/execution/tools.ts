/**
 * Android 本地执行工具：项目事实、构建/测试。
 *
 * 装配形态与既有工具一致：一个注册函数、按调用作用域取服务、真实宿主批准、
 * 批准后重读策略与目标。这里只暴露结构化动作，不提供任意 shell 入口。
 *
 * 边界（与剩余规格 §4–§5 一致，也是用户已接受的范围）：
 * - 设备/模拟器/UI 采集在后续单元注册；本模块不假装它们已经可用；
 * - 不提供跨进程设备排他，也不承诺宿主崩溃后的恢复；
 * - 进程内资源由当前会话/组件作用域持有，并在卸载时等待清理。
 */

import { createHash, randomUUID } from 'node:crypto'

import { defineTool } from '@deepseek-ai/dsh-tools'

import type {
  ApprovalLike, PolicyLike, SandboxLike, ScopedExecution, ServiceScope, SubprocessLike,
} from './contracts.js'
import {
  ArgumentError, blocked, cancelled, effectUnknown, failed, outcome, policyKey, rejectUnknownKeys,
  requireBoolean, requireEnum, requireRelativePath, requireText, resolvePolicy, scopedServices,
} from './contracts.js'
import type { ExecutionErrorCode, OperationEvidence, OperationOutcome, SandboxMode } from './contracts.js'
import { runBounded } from './process.js'
import type { BoundedRunResult, BoundedRunOutcome } from './process.js'
import {
  CLI_VERSION_POLICY, createObservationStore, digestDynamicFacts, inspectStaticProject,
  parseAndroidCliDescribe, parseAndroidCliVersion,
} from './project.js'
import type { DynamicProjectFacts, ObservationStore, StaticProjectFacts } from './project.js'
import {
  DEVICE_TOOL, adbRun, createDeviceLock, createDeviceObservationStore, describeDevicePlan,
  identityDigest, observeDevice, parseDeviceRequest, parseForegroundPackage, prepareObservedTarget,
} from './device.js'
import type { DeviceDeps, DeviceIdentity } from './device.js'

import {
  EMULATOR_TOOL, createOwnedResources, describeEmulatorPlan, parseEmulatorRequest,
  runBoundedEmulatorAction, startEmulator,
} from './emulator.js'
import type { EmulatorDeps } from './emulator.js'
import { describeCapturePlan, parseCaptureRequest, runCapture } from './capture.js'
import type { CaptureDeps } from './capture.js'
import { JOURNEY_KEYS, describeJourneyPlan, parseJourneyRequest, runJourney } from './journey.js'
import type { JourneyDeps } from './journey.js'

export const JOURNEY_TOOL = 'satellite_android_journey'
export const CAPTURE_TOOL = 'satellite_android_capture'

export { DEVICE_TOOL, EMULATOR_TOOL }

export const PROJECT_TOOL = 'satellite_android_project'
export const BUILD_TOOL = 'satellite_android_build'

const SERVICE_NAMES = ['fs', 'sandbox', 'subprocess', 'sandboxPolicy', 'approval'] as const

/** 默认上限：单操作 10 分钟、每流 256KiB。 */
export const DEFAULT_OPERATION_TIMEOUT_MS = 10 * 60 * 1000
export const DEFAULT_OUTPUT_MAX_BYTES = 256 * 1024
const DISCOVERY_TIMEOUT_MS = 120_000
const VERSION_TIMEOUT_MS = 15_000

export interface AndroidExecutionConfig {
  readonly enabled: boolean
  readonly androidCli?: string
  readonly privacy?: 'verified-disabled' | 'explicit-user-opt-in'
  readonly javaHome?: string
  readonly adbPath?: string
  readonly emulatorPath?: string
  readonly avdmanagerPath?: string
  readonly serverEndpoint?: string
  readonly operationTimeoutMs: number
  readonly outputMaxBytes: number
  /** 模拟器 boot 轮询间隔（默认 2s），仅影响等待粒度，不改变语义。 */
  readonly bootPollIntervalMs?: number
}

export interface AndroidToolContext extends ServiceScope {
  readonly tools: { register(tool: unknown): () => void }
  effect(callback: () => (() => void | Promise<void>) | undefined): unknown
}

interface FsLike {
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>
  stat(target: unknown, signal?: AbortSignal): Promise<{ type: string; size?: number } | undefined>
  listDir(target: unknown, signal?: AbortSignal): Promise<readonly { name: string; type: string }[]>
  processPath(target: unknown): string
  processPathFromHostPath?(hostPath: string): string | undefined
  contains(parent: unknown, child: unknown): boolean
  readBytes(target: unknown, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
  /** 采集文本产物需要原子创建；缺失时对应动作失败关闭，而不是退化成覆盖写。 */
  writeText?(
    target: unknown,
    content: string,
    expected?: { kind: 'createIfAbsent' },
    signal?: AbortSignal,
  ): Promise<unknown>
}

interface Services {
  readonly fs: FsLike
  readonly sandbox: SandboxLike
  readonly subprocess: SubprocessLike
  readonly sandboxPolicy: PolicyLike
  readonly approval: ApprovalLike
}

const toolOutput = {
  schema: { type: 'object', additionalProperties: true, properties: { status: { type: 'string', required: true } } },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

const json = (value: object) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>

function servicesFor(root: ServiceScope, exec: ScopedExecution): Services | OperationOutcome {
  const scoped = scopedServices(root, exec, SERVICE_NAMES)
  if (!scoped.ok) return blocked('services', scoped.code, scoped.message)
  return scoped.services as unknown as Services
}

function isOutcome<T extends object>(value: T | OperationOutcome): value is OperationOutcome {
  return typeof (value as OperationOutcome).status === 'string'
}

interface ProjectBinding {
  readonly root: string
  readonly fs: FsLike
  readonly mode: SandboxMode
  readonly workspaceRoot: string
  readonly sessionId?: string
  /** 工程根是否在会话工作区之外（外部工程）。 */
  readonly external: boolean
}

/**
 * 绑定本次调用的项目根与有效策略。
 * 根来自不可变会话 cwd（不是模型给的路径），且必须能在执行世界里往返映射。
 */
/**
 * 绑定本次调用要操作的工程根。
 *
 * - 缺省：会话的不可变工作目录。
 * - 相对路径：会话工作区内的子目录。
 * - 绝对路径：允许工作区之外的工程；此时 `external: true`，写/执行类动作
 *   必须由调用方逐次取得宿主批准（沙箱没有"额外可写根"这一档，
 *   升级只能是一次性的 danger-full-access）。
 */
async function bindProject(
  services: Services,
  exec: ScopedExecution,
  projectPath?: string,
): Promise<ProjectBinding | OperationOutcome> {
  const session = exec.agent?.session as { header?: { cwd?: string } } | undefined
  const hostRoot = session?.header?.cwd
  if (typeof hostRoot !== 'string' || hostRoot.length === 0) {
    return blocked('project', 'TARGET_REQUIRED', 'session working directory is unavailable')
  }
  const fs = services.fs
  const sessionTarget = await fs.resolve(hostRoot, { signal: exec.signal })
  if ((await fs.stat(sessionTarget, exec.signal))?.type !== 'directory') {
    return blocked('project', 'TARGET_REQUIRED', 'session root is not a readable directory')
  }

  let rootPath = fs.processPath(sessionTarget)
  let external = false
  if (projectPath !== undefined) {
    const absolute = projectPath.startsWith('/')
    if (!absolute && typeof fs.processPathFromHostPath === 'function') {
      const mapped = fs.processPathFromHostPath(hostRoot)
      if (!mapped) return blocked('project', 'CAPABILITY_UNAVAILABLE', 'session root is not visible in this execution world')
      const sessionMapped = await fs.resolve(mapped, { signal: exec.signal })
      if ((await fs.stat(sessionMapped, exec.signal))?.type !== 'directory') {
        return blocked('project', 'TARGET_REQUIRED', 'session root is not a readable directory')
      }
      rootPath = fs.processPath(sessionMapped)
    }
    const target = await fs.resolve(projectPath, absolute ? { signal: exec.signal } : { cwd: rootPath, signal: exec.signal })
    const info = await fs.stat(target, exec.signal)
    if (!info) return blocked('project', 'TARGET_REQUIRED', `project directory not found: ${projectPath}`)
    if (info.type !== 'directory') return blocked('project', 'ARGUMENT_INVALID', `project path is not a directory: ${projectPath}`)
    external = !fs.contains(sessionTarget, target)
    rootPath = fs.processPath(target)
  }

  const policy = resolvePolicy(services.sandboxPolicy, exec.agent?.session)
  if (!policy) return blocked('project', 'CAPABILITY_UNAVAILABLE', 'session sandbox policy is unavailable')
  return {
    root: rootPath,
    fs,
    mode: policy.mode,
    workspaceRoot: policy.workspaceRoot,
    ...(policy.sessionId !== undefined ? { sessionId: policy.sessionId } : {}),
    external,
  }
}

/**
 * 外部工程的逐次升级：沙箱只提供一次性 danger-full-access 这一档，
 * 因此必须由调用方明确要求并说明理由，再逐次向宿主申请批准。
 */
interface Escalation {
  readonly justification: string
}

function escalationGate(
  binding: ProjectBinding,
  action: string,
  request: { sandboxPermissions?: string; justification?: string },
): { ok: true; escalation?: Escalation } | { ok: false; outcome: OperationOutcome } {
  const wants = request.sandboxPermissions !== undefined || request.justification !== undefined
  if (!binding.external) {
    if (wants) {
      return { ok: false, outcome: blocked(action, 'ARGUMENT_INVALID', 'sandboxPermissions is only meaningful for a project outside the session workspace') }
    }
    return { ok: true }
  }
  if (!wants) {
    return {
      ok: false,
      outcome: blocked(action, 'CAPABILITY_UNAVAILABLE',
        `project ${binding.root} is outside the session workspace (${binding.workspaceRoot}); it needs a one-call escalation: `
        + 'retry with sandboxPermissions:"danger-full-access" and a justification. The approval covers this one call only '
        + '(its internal re-verification included); the next call needs its own approval.'),
    }
  }
  if (request.sandboxPermissions !== 'danger-full-access') {
    return { ok: false, outcome: blocked(action, 'ARGUMENT_INVALID', 'sandboxPermissions must be "danger-full-access" (the only wider mode)') }
  }
  const justification = typeof request.justification === 'string'
    // 折叠空白与换行：justification 会原文进入批准理由，不能让模型用它伪造提示结构。
    ? request.justification.replace(/\s+/gu, ' ').trim()
    : ''
  if (justification.length === 0) {
    return { ok: false, outcome: blocked(action, 'ARGUMENT_INVALID', 'a non-empty justification is required with sandboxPermissions') }
  }
  return { ok: true, escalation: { justification: justification.slice(0, 2000) } }
}

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

/** 真实批准：只有 allowed-once 继续；其余结果如实映射到错误码。 */
async function askApproval(
  services: Services,
  exec: ScopedExecution,
  toolName: string,
  reason: string,
): Promise<OperationOutcome | undefined> {
  if (!exec.agent) return blocked(toolName, 'APPROVAL_UNAVAILABLE', 'tool call has no agent to route approval through')
  let granted: Awaited<ReturnType<ApprovalLike['request']>>
  try {
    granted = await services.approval.request({
      agent: exec.agent,
      toolName,
      ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
      reason,
      signal: exec.signal,
    })
  } catch (error) {
    return blocked(toolName, 'APPROVAL_UNAVAILABLE', error instanceof Error ? error.message : String(error))
  }
  if (granted === 'allowed-once') return undefined
  if (granted === 'cancelled') return cancelled(toolName, 'not-needed')
  return blocked(toolName, granted === 'unavailable' ? 'APPROVAL_UNAVAILABLE' : 'APPROVAL_REJECTED', `approval ${granted}`)
}

/** 运行结果到结果码的统一映射；清理失败与效果未知都不伪装成成功。 */
function mapRun(
  action: string,
  run: BoundedRunOutcome,
  evidence: readonly OperationEvidence[],
): OperationOutcome | { result: BoundedRunResult } {
  if (!run.ok) {
    if (run.failure.kind === 'cancelled') return cancelled(action, 'not-needed')
    return blocked(action, 'CAPABILITY_UNAVAILABLE', run.failure.message ?? 'execution unavailable')
  }
  const { result } = run
  const withEvidence = [...evidence, {
    kind: 'process',
    source: action,
    digest: sha256(JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout.text })),
  }]
  if (result.aborted || result.timedOut) {
    const code: ExecutionErrorCode = result.aborted ? 'CANCELLED' : 'TIMEOUT'
    const cleanup = result.cleanup === 'completed' ? 'completed' : 'failed'
    // 超时/取消后进程没有按契约收敛：效果无法确认，不报成"可重试的不可用"。
    if (result.failureDetail !== undefined) {
      return effectUnknown(action, 'EFFECT_UNKNOWN', `${result.failureDetail}; the process was terminated but its effects are unconfirmed`)
    }
    return outcome(result.aborted ? 'cancelled' : 'failed', action, {
      evidence: withEvidence,
      cleanup,
      error: { code, message: result.aborted ? 'operation cancelled' : 'operation exceeded its deadline' },
    })
  }
  return { result }
}

/* ------------------------------------------------------------------ 工具注册 */

/**
 * 注册六个执行工具。
 *
 * 配置按**每次调用**读取（`getConfig`），因为 `execution` 是 volatile 设置：
 * 设置页保存后不重启也应生效。工具是否可见不再依赖机器路径；
 * 未启用或缺路径时每次调用都失败关闭，不会有任何副作用。
 */
export function registerAndroidExecutionTools(
  ctx: AndroidToolContext,
  getConfig: () => AndroidExecutionConfig,
): () => void {
  // 观测表与互斥锁属于这一行插件实例：卸载即失效，不跨组件复用，也不放模块级单例。
  const observations = createObservationStore(() => Date.now(), () => randomUUID())
  const deviceObservations = createDeviceObservationStore(() => Date.now(), () => randomUUID())
  const deviceLock = createDeviceLock()
  const ownedResources = createOwnedResources()
  const ownerScopes = new Set<string>()
  // 必须经 defineTool：它把作者 DSL 的 `required: true` 归一成 JSON Schema 的
  // `required: [...]`。直接把带 DSL 的 spec 交给 tools.register 会被宿主拒绝
  // （JsonSchemaError: required is not supported on type "string"），行随即加载失败。
  // 规格对象用的是作者 DSL（宽类型）：通过宽松别名调用 defineTool，
  // 既保留运行时的 DSL 归一化，又不触发泛型深度展开的类型错误。
  const authorTool = defineTool as unknown as (spec: object) => unknown
  const register = (spec: object): () => void => ctx.tools.register(authorTool(spec))
  const disposers = [
    register(createProjectTool(ctx, getConfig, observations)),
    register(createBuildTool(ctx, getConfig, observations)),
    register(createDeviceTool(ctx, getConfig, deviceObservations, deviceLock)),
    register(createEmulatorTool(ctx, getConfig, ownedResources, ownerScopes)),
    register(createJourneyTool(ctx, getConfig, deviceObservations, deviceLock)),
    register(createCaptureTool(ctx, getConfig, deviceObservations, deviceLock)),
  ]
  // 组件卸载必须等待所有仍被本组件拥有的模拟器实例关闭（异步 disposer 会被 await）。
  ctx.effect(() => async () => {
    await ownedResources.closeAll()
  })
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

/**
 * 工程路径：相对路径按会话工作区解析；绝对路径允许工作区之外的工程
 * （其写/执行动作另需逐次升级批准）。
 */
function requireProjectPath(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new ArgumentError(`${where} must be a non-empty string`)
  if (value.length > 2048) throw new ArgumentError(`${where} must be at most 2048 characters`)
  if (value.startsWith('/')) return value
  return requireRelativePath(value, where)
}

/** 追加而不是覆盖：使用者自己的 GRADLE_OPTS 必须保留。 */
function withDaemonDisabled(existing: string | undefined): string {
  const base = typeof existing === 'string' ? existing.trim() : ''
  return base.length === 0 ? '-Dorg.gradle.daemon=false' : `${base} -Dorg.gradle.daemon=false`
}

/** 统一的执行门：未启用或缺所需路径时给出可行动的失败，而不是静默跳过。 */
function executionGate(
  config: AndroidExecutionConfig,
  action: string,
  needs: 'cli' | 'adb' | 'emulator',
): OperationOutcome | undefined {
  if (!config.enabled) {
    return blocked(action, 'CAPABILITY_UNAVAILABLE',
      'Android execution is not enabled for this row: set execution.enabled in the Satellite Android settings')
  }
  if (needs === 'cli' && !config.androidCli) {
    return blocked(action, 'CAPABILITY_UNAVAILABLE', 'androidCli is not configured: set the Android CLI path in the Satellite Android settings')
  }
  if (needs === 'adb' && !config.adbPath) {
    return blocked(action, 'CAPABILITY_UNAVAILABLE', 'adbPath is not configured: set the adb path in the Satellite Android settings')
  }
  if (needs === 'emulator' && !config.emulatorPath) {
    return blocked(action, 'CAPABILITY_UNAVAILABLE', 'emulatorPath is not configured: set the emulator path in the Satellite Android settings')
  }
  return undefined
}

function ensureOwnerScope(
  ctx: AndroidToolContext,
  exec: ScopedExecution,
  ownedResources: ReturnType<typeof createOwnedResources>,
  ownerScopes: Set<string>,
): { ok: true } | { ok: false; message: string } {
  const ownerId = exec.agent?.id ?? 'unknown'
  if (ownerScopes.has(ownerId)) return { ok: true }
  const scope = (exec.agent?.ctx ?? ctx) as unknown as {
    effect?: (callback: () => (() => void | Promise<void>) | undefined) => unknown
  }
  if (typeof scope.effect !== 'function') {
    return { ok: false, message: 'no registerable effect on the caller scope; refusing to start a retained process' }
  }
  try {
    scope.effect(() => async () => {
      // 异步清理：Cordis 的卸载会 await 这个 Promise。
      await ownedResources.closeOwner(ownerId)
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  ownerScopes.add(ownerId)
  return { ok: true }
}

function createEmulatorTool(
  ctx: AndroidToolContext,
  getConfig: () => AndroidExecutionConfig,
  ownedResources: ReturnType<typeof createOwnedResources>,
  ownerScopes: Set<string>,
) {
  return {
    name: EMULATOR_TOOL,
    description: 'Manage one explicitly named Android emulator (AVD). list, start, stop, delete and create each require host approval. Only start keeps a process running: it becomes owned by this agent scope and is stopped on explicit stop, agent exit or plugin unload. Nothing is downloaded.',
    parameters: {
      action: { type: 'string', enum: ['list', 'start', 'stop', 'delete', 'create'], required: true, description: 'list: configured AVD names. start: boot one AVD and transfer it to this session. stop: stop an owned instance or, with serial, an observed one. delete: remove an AVD. create: create from an already installed system image.' },
      avd: { type: 'string', description: 'AVD name for start/delete/create.' },
      ownedResourceId: { type: 'string', description: 'stop only: id returned by start in this session.' },
      serial: { type: 'string', description: 'stop only: exact emulator serial; this branch does not claim ownership.' },
      installedSystemImage: { type: 'string', description: 'create only: already installed SDK package id, for example "system-images;android-34;google_apis;x86_64".' },
      deviceProfile: { type: 'string', description: 'create only: device profile id, for example "pixel_6".' },
      startupTimeoutMs: { type: 'integer', description: 'start only: boot deadline in milliseconds (10000-1800000).' },
    },
    output: toolOutput,
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, nativeExec: unknown) {
      const exec = nativeExec as ScopedExecution
      try {
        const config = getConfig()
        const gate = executionGate(config, 'emulator', 'emulator')
        if (gate) return json(gate)
        const request = parseEmulatorRequest(args)
        const services = servicesFor(ctx, exec)
        if (isOutcome(services)) return json(services)
        const binding = await bindProject(services, exec)
        if (isOutcome(binding)) return json(binding)
        if (!config.adbPath) return json(blocked('emulator', 'CAPABILITY_UNAVAILABLE', 'adbPath is not configured: set the adb path in the Satellite Android settings'))
        const deps: EmulatorDeps = {
          services: { sandbox: services.sandbox, subprocess: services.subprocess, approval: services.approval },
          binding: {
            root: binding.root, mode: binding.mode, workspaceRoot: binding.workspaceRoot,
            ...(binding.sessionId !== undefined ? { sessionId: binding.sessionId } : {}),
          },
          exec,
          config: {
            emulatorPath: config.emulatorPath as string,
            ...(config.avdmanagerPath !== undefined ? { avdmanagerPath: config.avdmanagerPath } : {}),
            adbPath: config.adbPath,
            operationTimeoutMs: config.operationTimeoutMs,
            outputMaxBytes: config.outputMaxBytes,
            ...(config.bootPollIntervalMs !== undefined ? { bootPollIntervalMs: config.bootPollIntervalMs } : {}),
          },
        }

        const approved = await askApproval(services, exec, EMULATOR_TOOL, describeEmulatorPlan(request))
        if (approved) return json(approved)
        const after = resolvePolicy(services.sandboxPolicy, exec.agent?.session)
        if (!after || policyKey(after) !== policyKey(binding)) {
          return json(blocked(`emulator.${request.action}`, 'POLICY_CHANGED', 'session policy changed after approval; retry required'))
        }

        if (request.action === 'stop' && request.ownedResourceId !== undefined) {
          const owned = ownedResources.get(request.ownedResourceId, exec.agent?.id ?? 'unknown')
          if (!owned) {
            return json(blocked('emulator.stop', 'TARGET_REQUIRED', 'no such owned emulator instance in this session; an external instance needs the serial branch and its own approval'))
          }
          const cleanup = await ownedResources.close(owned.id)
          return json({
            status: cleanup === 'completed' ? 'succeeded' : 'failed',
            action: 'emulator.stop',
            evidence: [{ kind: 'avd', source: `${owned.avd} (${owned.serial})` }],
            cleanup,
            ...(cleanup === 'completed' ? {} : { error: { code: 'CLEANUP_FAILED', message: 'the emulator did not report exit before the cleanup deadline' } }),
          })
        }

        if (request.action === 'start') {
          const ownerScope = ensureOwnerScope(ctx, exec, ownedResources, ownerScopes)
          if (!ownerScope.ok) return json(blocked('emulator.start', 'CAPABILITY_UNAVAILABLE', ownerScope.message))
          const started = await startEmulator(deps, request, ownedResources, (resource) => ownedResources.adopt(resource))
          if (!started.ok) return json(started.outcome)
          return json({
            status: 'succeeded',
            action: 'emulator.start',
            evidence: [{ kind: 'avd', source: `${started.result.avd} (${started.result.serial})` }],
            cleanup: 'retained-owned',
            ownedResourceId: started.result.ownedResourceId,
            serial: started.result.serial,
          })
        }

        return json(await runBoundedEmulatorAction(deps, request))
      } catch (error) {
        if (error instanceof ArgumentError) return json(blocked('emulator', 'ARGUMENT_INVALID', error.message))
        throw error
      }
    },
  }
}

function deviceDepsFor(
  services: Services,
  binding: ProjectBinding,
  exec: ScopedExecution,
  config: AndroidExecutionConfig,
): DeviceDeps | OperationOutcome {
  return deviceDeps(services, binding, exec, config)
}

function deviceDeps(
  services: Services,
  binding: ProjectBinding,
  exec: ScopedExecution,
  config: AndroidExecutionConfig,
): DeviceDeps | OperationOutcome {
  if (!config.adbPath) return blocked('device', 'CAPABILITY_UNAVAILABLE', 'adb executable is not configured (adbPath)')
  return {
    services: {
      sandbox: services.sandbox,
      subprocess: services.subprocess,
      approval: services.approval,
      sandboxPolicy: services.sandboxPolicy,
    },
    binding: {
      root: binding.root,
      mode: binding.mode,
      workspaceRoot: binding.workspaceRoot,
      ...(binding.sessionId !== undefined ? { sessionId: binding.sessionId } : {}),
    },
    exec,
    config: {
      adbPath: config.adbPath,
      ...(config.serverEndpoint !== undefined ? { serverEndpoint: config.serverEndpoint } : {}),
      operationTimeoutMs: config.operationTimeoutMs,
      outputMaxBytes: config.outputMaxBytes,
    },
  }
}

function createDeviceTool(
  ctx: AndroidToolContext,
  getConfig: () => AndroidExecutionConfig,
  observations: ReturnType<typeof createDeviceObservationStore>,
  lock: ReturnType<typeof createDeviceLock>,
) {
  return {
    name: DEVICE_TOOL,
    description: 'Observe and operate one explicitly named Android device over adb. discover is read-only; install, launch and foreground change or read device state and require host approval. It never falls back to a default device and never provides arbitrary adb arguments.',
    parameters: {
      action: { type: 'string', enum: ['discover', 'install', 'launch', 'foreground'], required: true, description: 'discover: observe one serial and return an observation id. install: install a workspace APK. launch: start the app launcher. foreground: read the current foreground package.' },
      serial: { type: 'string', description: 'Exact device serial, required for discover and every other action.' },
      observationId: { type: 'string', description: 'Required for install/launch/foreground; must come from discover in this session.' },
      artifact: { type: 'string', description: 'install only: APK path relative to the session workspace.' },
      applicationId: { type: 'string', description: 'launch/foreground only: reverse-DNS package name.' },
    },
    output: toolOutput,
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, nativeExec: unknown) {
      const exec = nativeExec as ScopedExecution
      try {
        const config = getConfig()
        const gate = executionGate(config, 'device', 'adb')
        if (gate) return json(gate)
        const request = parseDeviceRequest(args)
        const services = servicesFor(ctx, exec)
        if (isOutcome(services)) return json(services)
        const binding = await bindProject(services, exec)
        if (isOutcome(binding)) return json(binding)
        const deps = deviceDeps(services, binding, exec, config)
        if (isOutcome(deps)) return json(deps)

        if (request.action === 'discover') {
          if (request.serial === undefined) return json(blocked('device.discover', 'TARGET_REQUIRED', 'serial is required'))
          const approved = await askApproval(services, exec, DEVICE_TOOL, describeDevicePlan(request))
          if (approved) return json(approved)
          const after = resolvePolicy(services.sandboxPolicy, exec.agent?.session)
          if (!after || policyKey(after) !== policyKey(binding)) {
            return json(blocked('device.discover', 'POLICY_CHANGED', 'session policy changed after approval; retry required'))
          }
          const observed = await observeDevice(deps, request.serial, randomUUID())
          if (!observed.ok) return json(observed.outcome)
          const observation = observations.put(
            exec.agent?.id ?? 'unknown',
            observed.identity,
            identityDigest(sha256, observed.identity),
          )
          return json({
            status: 'succeeded',
            action: 'device.discover',
            evidence: [{ kind: 'device', source: observed.identity.serial, digest: observation.digest }],
            cleanup: 'not-needed',
            observationId: observation.id,
            expiresAt: new Date(observation.expiresAt).toISOString(),
            identity: observed.identity,
          })
        }

        // 批准理由必须引用**已核对**的目标：先解析观测，观测无效就不请求批准。
        const peeked = observations.getFor(request.observationId ?? '', exec.agent?.id ?? 'unknown')
        if (!peeked.ok) return json(blocked(request.action, peeked.code, peeked.message))
        if (request.serial !== undefined && request.serial !== peeked.observation.identity.serial) {
          return json(blocked(request.action, 'TARGET_CHANGED', 'request serial does not match the observation'))
        }
        const approved = await askApproval(services, exec, DEVICE_TOOL, describeDevicePlan(request, peeked.observation.identity))
        if (approved) return json(approved)
        const prepared = await prepareObservedTarget(deps, lock, observations, request, binding)
        if (!prepared.ok) return json(prepared.outcome)
        try {
          if (request.action === 'install') return json(await runInstall(deps, binding, prepared.identity, request.artifact as string, exec))
          if (request.action === 'launch') return json(await runLaunch(deps, prepared.identity, request.applicationId as string))
          return json(await runForeground(deps, prepared.identity, request.applicationId as string))
        } finally {
          prepared.release()
        }
      } catch (error) {
        if (error instanceof ArgumentError) return json(blocked('device', 'ARGUMENT_INVALID', error.message))
        throw error
      }
    },
  }
}

const ARTIFACT_DIGEST_LIMIT = 64 * 1024 * 1024

async function runInstall(
  deps: DeviceDeps,
  binding: ProjectBinding,
  identity: DeviceIdentity,
  artifact: string,
  exec: ScopedExecution,
) {
  const target = await binding.fs.resolve(artifact, { cwd: binding.root, signal: exec.signal })
  const info = await binding.fs.stat(target, exec.signal)
  if (!info || info.type !== 'file') {
    return blocked('install', 'TARGET_REQUIRED', `artifact is not a readable file in this execution world: ${artifact}`)
  }
  const path = binding.fs.processPath(target)
  const evidence: { kind: string; source: string; digest?: string }[] = [{ kind: 'artifact', source: artifact }]
  if (typeof info.size === 'number' && info.size <= ARTIFACT_DIGEST_LIMIT) {
    const bytes = await binding.fs.readBytes(target, exec.signal, ARTIFACT_DIGEST_LIMIT)
    evidence[0] = { kind: 'artifact', source: artifact, digest: sha256(bytes) }
  }
  const installed = await adbRun(deps, ['install', '-r', path], 'install', { serial: identity.serial })
  if (!installed.ok) return installed.outcome
  const succeeded = installed.exitCode === 0 && /Success/iu.test(installed.text)
  return {
    status: succeeded ? 'succeeded' : 'failed',
    action: 'install',
    evidence,
    cleanup: 'not-needed',
    deviceOutput: installed.text.slice(0, 4096),
    ...(succeeded ? {} : { error: { code: 'CAPABILITY_UNAVAILABLE', message: `adb install exited with ${installed.exitCode}` } }),
  }
}

async function runLaunch(deps: DeviceDeps, identity: DeviceIdentity, applicationId: string) {
  const launched = await adbRun(deps, [
    'shell', 'monkey', '-p', applicationId, '-c', 'android.intent.category.LAUNCHER', '1',
  ], 'launch', { serial: identity.serial })
  if (!launched.ok) return launched.outcome
  // monkey 的退出码不保证反映启动成功；只有输出里的失败标记才算失败。
  const failedLaunch = /No activities found|monkey aborted|Exception/iu.test(launched.text)
  return {
    status: failedLaunch ? 'failed' : 'succeeded',
    action: 'launch',
    evidence: [{ kind: 'launch', source: applicationId }],
    cleanup: 'not-needed',
    deviceOutput: launched.text.slice(0, 4096),
    ...(failedLaunch ? { error: { code: 'CAPABILITY_UNAVAILABLE', message: 'monkey reported that no launcher activity could be started' } } : {}),
  }
}

async function runForeground(deps: DeviceDeps, identity: DeviceIdentity, applicationId: string) {
  const dump = await adbRun(deps, ['shell', 'dumpsys', 'activity', 'activities'], 'foreground', { serial: identity.serial })
  if (!dump.ok) return dump.outcome
  const foreground = parseForegroundPackage(dump.text)
  if (foreground === undefined) {
    return blocked('foreground', 'CAPABILITY_UNAVAILABLE', 'the device output did not expose a foreground package; not guessing')
  }
  return {
    status: foreground === applicationId ? 'succeeded' : 'failed',
    action: 'foreground',
    evidence: [{ kind: 'foreground-package', source: foreground }],
    cleanup: 'not-needed',
    foreground,
    ...(foreground === applicationId
      ? {}
      : { error: { code: 'CAPABILITY_UNAVAILABLE' as const, message: `${applicationId} is not the foreground package` } }),
  }
}

function createProjectTool(ctx: AndroidToolContext, getConfig: () => AndroidExecutionConfig, observations: ObservationStore) {
  return {
    name: PROJECT_TOOL,
    description: 'Inspect an Android project in this session workspace. "inspect" is a read-only static lead list and does not verify Gradle tasks. "discover-build" runs the configured Android CLI after host approval and returns verified module/variant facts with an id that the build tool requires.',
    parameters: {
      action: { type: 'string', enum: ['inspect', 'discover-build'], required: true, description: 'inspect: static leads only. discover-build: approved dynamic facts.' },
      project: { type: 'string', description: 'Project directory: relative to the session workspace, or an absolute path for a project outside it. Defaults to the workspace root.' },
      sandboxPermissions: { type: 'string', enum: ['danger-full-access'], description: 'Only for a project outside the session workspace: request a one-call unconfined run. Requires justification.' },
      justification: { type: 'string', description: 'Required with sandboxPermissions: why this external project must be written/executed in this call.' },
    },
    output: toolOutput,
    // discover-build 会调 CLI/Gradle 写项目元数据与缓存：只有纯静态 inspect 可以并行。
    isConcurrencySafe: (args?: { action?: unknown }) => args?.action === 'inspect',
    async execute(args: Record<string, unknown>, nativeExec: unknown) {
      const exec = nativeExec as ScopedExecution
      try {
        rejectUnknownKeys(args, ['action', 'project', 'sandboxPermissions', 'justification'])
        const config = getConfig()
        const action = requireEnum(args.action, 'action', ['inspect', 'discover-build'] as const)
        const gate = executionGate(config, action === 'inspect' ? 'project.inspect' : 'project.discover-build',
          action === 'inspect' ? 'cli' : 'cli')
        // 静态 inspect 不需要任何外部可执行文件，只有 discover-build 需要。
        if (action === 'discover-build' && gate) return json(gate)
        const project = args.project === undefined ? undefined : requireProjectPath(args.project, 'project')
        const services = servicesFor(ctx, exec)
        if (isOutcome(services)) return json(services)
        const binding = await bindProject(services, exec, project)
        if (isOutcome(binding)) return json(binding)
        if (action === 'inspect') return json(await runStaticInspect(binding, exec))
        const gated = escalationGate(binding, 'project.discover-build', {
          ...(args.sandboxPermissions !== undefined ? { sandboxPermissions: String(args.sandboxPermissions) } : {}),
          ...(args.justification !== undefined ? { justification: String(args.justification) } : {}),
        })
        if (!gated.ok) return json(gated.outcome)
        const discovered = await discoverBuildFacts(
          { services, binding, exec, config, ...(gated.escalation ? { escalation: gated.escalation } : {}) },
          new Date().toISOString(),
        )
        if (!discovered.ok) return json(discovered.outcome)
        const observation = observations.put(
          exec.agent?.id ?? 'unknown',
          discovered.facts,
          digestDynamicFacts(sha256, discovered.facts),
        )
        return json({
          status: 'succeeded',
          action: 'project.discover-build',
          evidence: [
            { kind: 'android-cli', source: discovered.facts.cliPath, digest: sha256(discovered.facts.cliVersion) },
            ...discovered.facts.modules.map((module) => ({ kind: 'module', source: `${module.path} (${module.variants.length} variants)` })),
          ],
          cleanup: 'not-needed',
          observationId: observation.id,
          expiresAt: new Date(observation.expiresAt).toISOString(),
          facts: discovered.facts,
          // 升级是这次调用的事实，不能只写在批准弹窗里：结果与证据链都要能审计到。
          ...(gated.escalation !== undefined
            ? { escalation: { mode: 'danger-full-access' as const, justification: gated.escalation.justification } }
            : {}),
        })
      } catch (error) {
        if (error instanceof ArgumentError) return json(blocked('project', 'ARGUMENT_INVALID', error.message))
        throw error
      }
    },
  }
}

async function runStaticInspect(binding: ProjectBinding, exec: ScopedExecution) {
  const facts: StaticProjectFacts = await inspectStaticProject({
    projectRoot: binding.root,
    fs: binding.fs as unknown as Parameters<typeof inspectStaticProject>[0]['fs'],
    signal: exec.signal,
  })
  return {
    status: 'succeeded' as const,
    action: 'project.inspect',
    evidence: facts.leads.map((lead) => ({ kind: lead.kind, source: lead.path })),
    cleanup: 'not-needed' as const,
    facts,
  }
}

interface DiscoveryDeps {
  readonly services: Services
  readonly binding: ProjectBinding
  readonly exec: ScopedExecution
  readonly config: AndroidExecutionConfig
  /**
   * `required` 表示本次发现必须自己取得宿主批准；
   * `covered` 表示调用方（例如 build）的批准计划已经明确覆盖这次复核，
   * 因此不再发第二次批准请求。两种模式的其他门（CLI/隐私/只读/POSIX）完全相同。
   */
  readonly approvalMode?: 'required' | 'covered'
  /** 外部工程的一次性升级；缺省表示工程在会话工作区内。 */
  readonly escalation?: Escalation
}

/** 经批准运行 CLI 并把报告解析成动态事实；任何一步不符即不可用。 */
export async function discoverBuildFacts(
  deps: DiscoveryDeps,
  observedAt: string,
): Promise<{ ok: true; facts: DynamicProjectFacts } | { ok: false; outcome: OperationOutcome }> {
  const { services, binding, exec, config } = deps
  if (!config.androidCli) {
    return { ok: false, outcome: blocked('project.discover-build', 'CAPABILITY_UNAVAILABLE', 'Android CLI executable is not configured (androidCli.executable)') }
  }
  if (config.privacy === undefined) {
    return { ok: false, outcome: blocked('project.discover-build', 'CAPABILITY_UNAVAILABLE', 'Android CLI usage-collection privacy is not configured: verified-disabled or explicit-user-opt-in') }
  }
  if (binding.external && deps.escalation === undefined) {
    return { ok: false, outcome: blocked('project.discover-build', 'CAPABILITY_UNAVAILABLE', 'an external project requires sandboxPermissions:"danger-full-access" plus a justification') }
  }
  // 未围栏运行必须**同时**满足"工作区外"与"已有一次性升级"：只看 external 的话，
  // 任何绕过 gate 的调用路径都会静默变成未围栏（审查指出的可疑点，这里结构上消除）。
  const effectiveMode: SandboxMode = binding.external && deps.escalation !== undefined
    ? 'danger-full-access'
    : binding.mode
  if (effectiveMode === 'read-only') {
    // 发现会写 AGP 元数据；只读会话里失败关闭，而不是半途被沙箱拒绝。
    return { ok: false, outcome: blocked('project.discover-build', 'CAPABILITY_UNAVAILABLE', 'discovery writes project metadata and requires a workspace-write (or wider) session policy') }
  }
  if ((await services.subprocess.terminalEnvironment(exec.signal)).platform !== 'posix') {
    return { ok: false, outcome: blocked('project.discover-build', 'CAPABILITY_UNAVAILABLE', 'the local Android route currently requires a POSIX execution world') }
  }
  let cliPath: string
  try {
    cliPath = await services.subprocess.resolveExecutable(config.androidCli, undefined, exec.signal)
  } catch (error) {
    return { ok: false, outcome: blocked('project.discover-build', 'CAPABILITY_UNAVAILABLE', error instanceof Error ? error.message : String(error)) }
  }
  if (!cliPath.startsWith('/')) {
    return { ok: false, outcome: blocked('project.discover-build', 'CAPABILITY_UNAVAILABLE', 'Android CLI did not resolve to an absolute path') }
  }

  const describeArgs = ['describe', `--project_dir=${binding.root}`]
  if (deps.approvalMode !== 'covered') {
    const externality = binding.external
      ? ` The project is OUTSIDE the session workspace (${binding.workspaceRoot}): this call runs UNCONFINED (danger-full-access) and Gradle may write anywhere the tooling writes. Justification: ${deps.escalation?.justification ?? '(missing)'}.`
      : ` Session sandbox: ${binding.mode} at ${binding.workspaceRoot}.`
    const approved = await askApproval(services, exec, PROJECT_TOOL,
      `Run the configured Android CLI in ${binding.root}: "${cliPath} --version" then "${cliPath} ${describeArgs.join(' ')}". `
      + `It invokes Gradle and writes AGP metadata/caches inside the project; usage collection is ${config.privacy}.`
      + externality
      + ` Network and device effects are not confined by the file sandbox; the approved wrapper is pinned by path and the report is version-gated to ${CLI_VERSION_POLICY}.`)
    if (approved) return { ok: false, outcome: approved }
  }

  const after = resolvePolicy(services.sandboxPolicy, exec.agent?.session)
  if (!after || policyKey(after) !== policyKey(binding)) {
    return { ok: false, outcome: blocked('project.discover-build', 'POLICY_CHANGED', 'session policy changed after approval; retry required') }
  }

  // Android CLI 会在 $ANDROID_USER_HOME 下解包自身安装并写缓存；默认的 ~/.android
  // 在 workspace-write 会话里不可写（实测 `Failed to open .../.android/cli/bundles/lock`）。
  // 因此把它定向到会话工作区内，既能在受限会话里工作，也不污染用户项目。
  const androidUserHome = `${binding.workspaceRoot}/.satellite/android-user-home`
  const runOptions = {
    cwd: binding.root,
    mode: effectiveMode,
    workspaceRoot: binding.workspaceRoot,
    ...(binding.sessionId !== undefined ? { sessionId: binding.sessionId } : {}),
    env: {
      ANDROID_USER_HOME: androidUserHome,
      // 外部工程是一次性未围栏运行：不能让更早的受限进程留下的 Gradle daemon
      // 继续执行（它带着旧的文件围栏，会在工程内 .gradle 上 EPERM）。
      // 保留使用者已有的 GRADLE_OPTS，只在其后追加开关（覆盖式会静默丢掉他们的设置）。
      ...(binding.external ? { GRADLE_OPTS: withDaemonDisabled(process.env.GRADLE_OPTS) } : {}),
    },
  }
  const version = await runBounded(services, {
    executable: cliPath, args: ['--version'], ...runOptions,
    timeoutMs: VERSION_TIMEOUT_MS, outputMaxBytes: 64 * 1024,
  }, exec.signal)
  const versionMapped = mapRun('project.discover-build', version, [])
  if ('status' in versionMapped) return { ok: false, outcome: versionMapped }
  const cliVersion = parseAndroidCliVersion(versionMapped.result.stdout.text)
  if (!cliVersion) {
    return { ok: false, outcome: blocked('project.discover-build', 'CAPABILITY_UNAVAILABLE', `Android CLI version is not ${CLI_VERSION_POLICY}: ${versionMapped.result.stdout.text.trim() || 'unknown'}`) }
  }

  const describe = await runBounded(services, {
    executable: cliPath, args: describeArgs, ...runOptions,
    timeoutMs: DISCOVERY_TIMEOUT_MS, outputMaxBytes: 1024 * 1024,
  }, exec.signal)
  const describeMapped = mapRun('project.discover-build', describe, [])
  if ('status' in describeMapped) return { ok: false, outcome: describeMapped }
  if (describeMapped.result.exitCode !== 0) {
    return { ok: false, outcome: failed('project.discover-build', 'CAPABILITY_UNAVAILABLE', 'Android CLI describe did not complete successfully') }
  }
  let parsed: { gradleWrapper: string; modules: DynamicProjectFacts['modules'] }
  try {
    parsed = parseAndroidCliDescribe(describeMapped.result.stdout.text, binding.root)
  } catch (error) {
    // 实测：CLI 在 Gradle 失败时仍以 exit 0 结束，只在 stderr 打印 FAILURE。
    // 把有界的 stderr 末尾带上，否则使用者只看到"报告缺某一行"而不知真因。
    const reason = error instanceof Error ? error.message : String(error)
    const stderrTail = describeMapped.result.stderr.text.trim().split('\n').slice(-6).join(' | ').slice(0, 800)
    return {
      ok: false,
      outcome: failed('project.discover-build', 'CAPABILITY_UNAVAILABLE',
        stderrTail.length > 0 ? `${reason} (CLI stderr tail: ${stderrTail})` : reason),
    }
  }
  const wrapper = await binding.fs.resolve(parsed.gradleWrapper, { signal: exec.signal })
  if ((await binding.fs.stat(wrapper, exec.signal))?.type !== 'file') {
    return { ok: false, outcome: blocked('project.discover-build', 'CAPABILITY_UNAVAILABLE', 'Gradle wrapper declared by the CLI report is not readable') }
  }
  const wrapperBytes = await binding.fs.readBytes(wrapper, exec.signal, 1024 * 1024)
  return {
    ok: true,
    facts: {
      projectRoot: binding.root,
      gradleWrapper: binding.fs.processPath(wrapper),
      cliVersion,
      observedAt,
      modules: parsed.modules,
      provenance: 'android-cli-describe',
      cliPath,
      inputDigests: { gradlew: sha256(wrapperBytes), cli: sha256(cliPath) },
    },
  }
}

/* -------------------------------------------------------------------- 构建 */

function createBuildTool(ctx: AndroidToolContext, getConfig: () => AndroidExecutionConfig, observations: ObservationStore) {
  return {
    name: BUILD_TOOL,
    description: 'Run one exact Gradle build or test task for facts discovered by satellite_android_project, after host approval. No arbitrary flags, no additional tasks, no device interaction.',
    parameters: {
      action: { type: 'string', enum: ['build', 'test'], required: true, description: 'build: assemble the selected variant. test: run the selected variant unit-test task.' },
      observationId: { type: 'string', required: true, description: 'Id from satellite_android_project discover-build; it expires after a few minutes.' },
      project: { type: 'string', description: 'Project directory: relative to the session workspace, or an absolute path outside it; must match the observation. Defaults to the workspace root.' },
      sandboxPermissions: { type: 'string', enum: ['danger-full-access'], description: 'Only for a project outside the session workspace: request a one-call unconfined run. Requires justification.' },
      justification: { type: 'string', description: 'Required with sandboxPermissions: why this external project must be built in this call.' },
      module: { type: 'string', required: true, description: 'Gradle module path exactly as reported, for example ":app".' },
      variant: { type: 'string', required: true, description: 'Variant name exactly as reported, for example "debug".' },
      clean: { type: 'boolean', description: 'Run "clean" before the selected task; defaults to false.' },
      offline: { type: 'boolean', description: 'Pass --offline; defaults to false.' },
      rerunTasks: { type: 'boolean', description: 'Pass --rerun-tasks; defaults to false.' },
    },
    output: toolOutput,
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, nativeExec: unknown) {
      const exec = nativeExec as ScopedExecution
      try {
        rejectUnknownKeys(args, ['action', 'observationId', 'project', 'module', 'variant', 'clean', 'offline', 'rerunTasks', 'sandboxPermissions', 'justification'])
        const config = getConfig()
        const action = requireEnum(args.action, 'action', ['build', 'test'] as const)
        const gate = executionGate(config, action, 'cli')
        if (gate) return json(gate)
        const observationId = requireText(args.observationId, 'observationId', 128)
        const modulePath = requireText(args.module, 'module', 512)
        const variant = requireText(args.variant, 'variant', 128)
        const clean = args.clean === undefined ? false : requireBoolean(args.clean, 'clean')
        const offline = args.offline === undefined ? false : requireBoolean(args.offline, 'offline')
        const rerunTasks = args.rerunTasks === undefined ? false : requireBoolean(args.rerunTasks, 'rerunTasks')

        const project = args.project === undefined ? undefined : requireProjectPath(args.project, 'project')
        const services = servicesFor(ctx, exec)
        if (isOutcome(services)) return json(services)
        // 与 discover-build 使用同一个项目根解析路径，子项目观测才能被构建消费。
        const binding = await bindProject(services, exec, project)
        if (isOutcome(binding)) return json(binding)

        const gated = escalationGate(binding, action, {
          ...(args.sandboxPermissions !== undefined ? { sandboxPermissions: String(args.sandboxPermissions) } : {}),
          ...(args.justification !== undefined ? { justification: String(args.justification) } : {}),
        })
        if (!gated.ok) return json(gated.outcome)
        const found = observations.getFor(observationId, exec.agent?.id ?? 'unknown')
        if (!found.ok) return json(blocked(action, found.code, found.message))
        const facts = found.observation.facts
        if (facts.projectRoot !== binding.root) {
          return json(blocked(action, 'TARGET_CHANGED', 'build observation belongs to a different project root'))
        }
        if (binding.mode === 'read-only') {
          return json(blocked(action, 'CAPABILITY_UNAVAILABLE', 'Gradle writes outputs and requires a workspace-write (or wider) session policy'))
        }

        const module = facts.modules.find((entry) => entry.path === modulePath)
        if (!module) return json(blocked(action, 'TARGET_REQUIRED', `module is not declared by the build observation: ${modulePath}`))
        if (!module.variants.some((entry) => entry.name === variant)) {
          return json(blocked(action, 'TARGET_REQUIRED', `variant is not declared for ${modulePath}: ${variant}`))
        }

        const suffix = `${variant.charAt(0).toUpperCase()}${variant.slice(1)}`
        const gradleTask = action === 'build' ? `${modulePath}:assemble${suffix}` : `${modulePath}:test${suffix}UnitTest`
        const taskNames = [...(clean ? ['clean'] : []), gradleTask]
        const flags = [
          '--console=plain',
          ...(offline ? ['--offline'] : []),
          ...(rerunTasks ? ['--rerun-tasks'] : []),
          // 同上：升级运行在本进程内执行，不复用可能残留的受限 daemon。
          ...(binding.external ? ['--no-daemon'] : []),
        ]
        const argv = [...taskNames, ...flags]
        // Gradle 默认写 ~/.gradle；在 workspace-write 会话里同样不可写，定向到工作区。
        const env = {
          GRADLE_USER_HOME: `${binding.workspaceRoot}/.satellite/gradle-user-home`,
          ...(config.javaHome ? { JAVA_HOME: config.javaHome } : {}),
        }

        const approved = await askApproval(services, exec, BUILD_TOOL,
          `Run "${facts.gradleWrapper} ${argv.join(' ')}" in ${binding.root} (module ${modulePath}, variant ${variant}). `
          + `It writes build outputs and caches under the workspace and may download dependencies. Session sandbox: ${binding.mode} at ${binding.workspaceRoot}. `
          + `Device effects: none. Before the build starts, the Android CLI is run again to re-check the approved project facts.`
          + (binding.external
            ? ` NOTE: the project is outside the session workspace (${binding.workspaceRoot}); this call runs UNCONFINED (danger-full-access). Justification: ${gated.escalation?.justification ?? '(missing)'}.`
            : ''))
        if (approved) return json(approved)

        const after = resolvePolicy(services.sandboxPolicy, exec.agent?.session)
        if (!after || policyKey(after) !== policyKey(binding)) {
          return json(blocked(action, 'POLICY_CHANGED', 'session policy changed after approval; retry required'))
        }

        // 批准后重新发现：项目模型或选择变化时不执行构建。
        const reverified = await discoverBuildFacts(
          { services, binding, exec, config, approvalMode: 'covered', ...(gated.escalation ? { escalation: gated.escalation } : {}) },
          new Date().toISOString(),
        )
        if (!reverified.ok) {
          return json(blocked(action, 'TARGET_CHANGED', `re-verification failed before building: ${reverified.outcome.error?.message ?? reverified.outcome.status}`))
        }
        if (digestDynamicFacts(sha256, reverified.facts) !== found.observation.modelDigest) {
          return json(blocked(action, 'TARGET_CHANGED', 'project build facts changed after the observation; discover again before building'))
        }
        if (!reverified.facts.modules.find((entry) => entry.path === modulePath)?.variants.some((entry) => entry.name === variant)) {
          return json(blocked(action, 'TARGET_CHANGED', 'the selected module/variant is no longer declared'))
        }

        const run = await runBounded(services, {
          executable: facts.gradleWrapper, args: argv, cwd: binding.root,
          mode: binding.external && gated.escalation !== undefined ? 'danger-full-access' : binding.mode,
          workspaceRoot: binding.external && gated.escalation !== undefined ? binding.root : binding.workspaceRoot,
          ...(binding.sessionId !== undefined ? { sessionId: binding.sessionId } : {}),
          timeoutMs: config.operationTimeoutMs, outputMaxBytes: config.outputMaxBytes,
          ...(env ? { env } : {}),
        }, exec.signal)
        const mapped = mapRun(action, run, [
          { kind: 'gradle-task', source: argv.join(' '), digest: sha256(`${modulePath}:${variant}`) },
        ])
        if ('status' in mapped) {
          if (mapped.status === 'failed' && mapped.error?.code === 'TIMEOUT') {
            return json(effectUnknown(action, 'EFFECT_UNKNOWN', 'Gradle did not finish before its deadline; build outputs may be partial'))
          }
          return json(mapped)
        }
        const result = mapped.result
        const failedBuild = result.exitCode !== 0
        // 退出码 0 不等于产物存在：核对 CLI 报告里该变体声明的产物路径。
        const expectedArtifacts = action === 'build'
          ? (facts.modules.find((entry) => entry.path === modulePath)?.variants
              .find((entry) => entry.name === variant)?.artifacts ?? [])
          : []
        const artifactEvidence: OperationEvidence[] = []
        const missingArtifacts: string[] = []
        for (const artifact of expectedArtifacts) {
          const target = await binding.fs.resolve(artifact.path, { signal: exec.signal })
          const info = await binding.fs.stat(target, exec.signal)
          if (!info || info.type !== 'file') {
            missingArtifacts.push(artifact.path)
            continue
          }
          const entry: { kind: string; source: string; digest?: string } = { kind: 'artifact', source: artifact.path }
          if (typeof info.size === 'number' && info.size <= ARTIFACT_DIGEST_LIMIT) {
            entry.digest = sha256(await binding.fs.readBytes(target, exec.signal, ARTIFACT_DIGEST_LIMIT))
          }
          artifactEvidence.push(entry)
        }
        const artifactProblem = !failedBuild && expectedArtifacts.length > 0 && missingArtifacts.length > 0
        return json({
          status: failedBuild || artifactProblem ? 'failed' : 'succeeded',
          action,
          evidence: [
            { kind: 'gradle-task', source: argv.join(' '), digest: sha256(`${modulePath}:${variant}`) },
            ...artifactEvidence,
            { kind: 'stdout', source: 'bounded process output', digest: sha256(result.stdout.text) },
          ],
          cleanup: result.cleanup === 'completed' ? 'not-needed' : 'failed',
          stdout: result.stdout.text,
          stderr: result.stderr.text,
          truncated: result.stdout.truncated || result.stderr.truncated,
          ...(expectedArtifacts.length > 0
            ? { artifacts: { expected: expectedArtifacts.length, verified: artifactEvidence.length, missing: missingArtifacts } }
            : {}),
          // 外部工程的升级也是这次构建的事实：结果里必须写清楚它是未围栏运行的。
          ...(binding.external && gated.escalation !== undefined
            ? { escalation: { mode: 'danger-full-access' as const, justification: gated.escalation.justification } }
            : {}),
          ...(run.ok && run.result.unconfined ? { unconfined: true } : {}),
          ...(failedBuild
            ? { error: { code: 'CAPABILITY_UNAVAILABLE', message: `Gradle exited with ${result.exitCode}` } }
            : artifactProblem
              ? { error: { code: 'EFFECT_UNKNOWN', message: `Gradle exited 0 but these declared artifacts are missing: ${missingArtifacts.join(', ')}` } }
              : {}),
        })
      } catch (error) {
        if (error instanceof ArgumentError) return json(blocked('build', 'ARGUMENT_INVALID', error.message))
        throw error
      }
    },
  }
}

/* ------------------------------------------------------- UI 旅程与采集 */

/**
 * 旅程与采集共用同一份"adb 已解析、项目已绑定"的依赖对象。
 * 两个模块都只执行固定 argv；批准由本层在调用前完成。
 */
function deviceLikeDeps(
  services: Services,
  binding: ProjectBinding,
  exec: ScopedExecution,
  config: AndroidExecutionConfig,
): JourneyDeps & CaptureDeps {
  return {
    // JourneyFs 是 CaptureFs 的子集；这里给出完整适配器，两个模块共用一份。
    fs: binding.fs as unknown as CaptureDeps['fs'],
    sandbox: services.sandbox,
    subprocess: services.subprocess,
    binding: {
      root: binding.root, mode: binding.mode, workspaceRoot: binding.workspaceRoot,
      ...(binding.sessionId !== undefined ? { sessionId: binding.sessionId } : {}),
    },
    exec,
    adbPath: config.adbPath as string,
    operationTimeoutMs: config.operationTimeoutMs,
    outputMaxBytes: config.outputMaxBytes,
  }
}

function createJourneyTool(
  ctx: AndroidToolContext,
  getConfig: () => AndroidExecutionConfig,
  observations: ReturnType<typeof createDeviceObservationStore>,
  lock: ReturnType<typeof createDeviceLock>,
) {
  return {
    name: JOURNEY_TOOL,
    description: 'Run one bounded UI journey on an explicitly named device: a fixed list of tap/text/key/wait/assert steps with screenshot capture. Each step maps to one exact adb command; asserts that cannot be evaluated fail instead of passing. Requires host approval.',
    parameters: {
      serial: { type: 'string', required: true, description: 'Exact device serial; must match the observation.' },
      observationId: { type: 'string', required: true, description: 'Id from satellite_android_device discover. The device is re-verified and locked before the first step.' },
      applicationId: { type: 'string', required: true, description: 'Reverse-DNS package under test.' },
      steps: {
        type: 'array', required: true, items: {
          // `items` 是值 schema：DSL 不允许在这里写 required（必填性由解析器强制）。
          type: 'object', additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['tap', 'text', 'key', 'wait', 'assert-foreground', 'assert-ui-text', 'screenshot'], description: 'Exact action of this step; supply only the fields listed for it.' },
            x: { type: 'integer', description: 'tap only: x coordinate, 0–100000.' },
            y: { type: 'integer', description: 'tap only: y coordinate, 0–100000.' },
            text: { type: 'string', description: 'text only (max 1024 chars, charset A–Z a–z 0–9 space . , _ @ / : + = -) or assert-ui-text only (max 512 chars).' },
            // 枚举直接取解析器的键表：描述与解析器不允许再各写一份。
            key: { type: 'string', enum: [...JOURNEY_KEYS], description: 'key only: one of the listed key codes, exactly as spelled.' },
            ms: { type: 'integer', description: 'wait only: 1–30000 milliseconds.' },
            package: { type: 'string', description: 'assert-foreground only: the reverse-DNS package that must be in the foreground.' },
            output: { type: 'string', description: 'screenshot only: workspace-relative path for the PNG; new files only.' },
          },
        },
        description: 'At most 30 steps, executed in order; the first failed step stops the rest. Unknown fields are rejected before any device command runs.',
      },
    },
    output: toolOutput,
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, nativeExec: unknown) {
      const exec = nativeExec as ScopedExecution
      try {
        const config = getConfig()
        const gate = executionGate(config, 'journey', 'adb')
        if (gate) return json(gate)
        // observationId 属于工具层的目标绑定，不属于旅程本身；解析前剥离。
        const { observationId: journeyObservation, ...journeyArgs } = args
        const request = parseJourneyRequest(journeyArgs)
        const services = servicesFor(ctx, exec)
        if (isOutcome(services)) return json(services)
        const binding = await bindProject(services, exec)
        if (isOutcome(binding)) return json(binding)
        if (!config.adbPath) return json(blocked('journey', 'CAPABILITY_UNAVAILABLE', 'adb executable is not configured (adbPath)'))
        // 先核对观测再请求批准：拒绝理由里不能出现未经核对的目标。
        const peeked = observations.getFor(journeyObservation as string | undefined ?? '', exec.agent?.id ?? 'unknown')
        if (!peeked.ok) return json(blocked('journey', peeked.code, peeked.message))
        if (peeked.observation.identity.serial !== request.serial) {
          return json(blocked('journey', 'TARGET_CHANGED', 'request serial does not match the observation'))
        }
        const approved = await askApproval(services, exec, JOURNEY_TOOL,
          `${describeJourneyPlan(request)} Verified target: ${peeked.observation.identity.serial} (transport ${peeked.observation.identity.transportId}).`)
        if (approved) return json(approved)
        const after = resolvePolicy(services.sandboxPolicy, exec.agent?.session)
        if (!after || policyKey(after) !== policyKey(binding)) {
          return json(blocked('journey', 'POLICY_CHANGED', 'session policy changed after approval; retry required'))
        }
        const deps = deviceLikeDeps(services, binding, exec, config)
        const deviceDeps = deviceDepsFor(services, binding, exec, config)
        if (isOutcome(deviceDeps)) return json(deviceDeps)
        const prepared = await prepareObservedTarget(deviceDeps, lock, observations, {
          action: 'journey', serial: request.serial, observationId: journeyObservation as string | undefined,
        }, binding)
        if (!prepared.ok) return json(prepared.outcome)
        try {
          return json(await runJourney(deps, request, Date.now()))
        } finally {
          prepared.release()
        }
      } catch (error) {
        if (error instanceof ArgumentError) return json(blocked('journey', 'ARGUMENT_INVALID', error.message))
        throw error
      }
    },
  }
}

function createCaptureTool(
  ctx: AndroidToolContext,
  getConfig: () => AndroidExecutionConfig,
  observations: ReturnType<typeof createDeviceObservationStore>,
  lock: ReturnType<typeof createDeviceLock>,
) {
  return {
    name: CAPTURE_TOOL,
    description: 'Run one bounded capture on an explicitly named device: logcat dump, screen recording, perfetto trace or meminfo. Each action completes start → bounded window → stop → pull → verify → cleanup inside one call, and artifacts are verified on disk. Requires host approval.',
    parameters: {
      action: { type: 'string', enum: ['logcat', 'record', 'perfetto', 'memory'], required: true, description: 'Capture kind. memory requires applicationId; perfetto requires configPath.' },
      serial: { type: 'string', required: true, description: 'Exact device serial; must match the observation.' },
      observationId: { type: 'string', required: true, description: 'Id from satellite_android_device discover. The device is re-verified and locked for the capture.' },
      applicationId: { type: 'string', description: 'Package scope for logcat (--pid) and the subject of memory.' },
      durationSeconds: { type: 'integer', required: true, description: 'Bounded capture window, 1–120 seconds.' },
      output: { type: 'string', required: true, description: 'Workspace-relative artifact path; new files only.' },
      configPath: { type: 'string', description: 'perfetto only: workspace-relative existing trace config file.' },
    },
    output: toolOutput,
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, nativeExec: unknown) {
      const exec = nativeExec as ScopedExecution
      try {
        const config = getConfig()
        const gate = executionGate(config, 'capture', 'adb')
        if (gate) return json(gate)
        const { observationId: captureObservation, ...captureArgs } = args
        const request = parseCaptureRequest(captureArgs)
        const services = servicesFor(ctx, exec)
        if (isOutcome(services)) return json(services)
        const binding = await bindProject(services, exec)
        if (isOutcome(binding)) return json(binding)
        if (!config.adbPath) return json(blocked('capture', 'CAPABILITY_UNAVAILABLE', 'adb executable is not configured (adbPath)'))
        const peeked = observations.getFor(captureObservation as string | undefined ?? '', exec.agent?.id ?? 'unknown')
        if (!peeked.ok) return json(blocked('capture', peeked.code, peeked.message))
        if (peeked.observation.identity.serial !== request.serial) {
          return json(blocked('capture', 'TARGET_CHANGED', 'request serial does not match the observation'))
        }
        const approved = await askApproval(services, exec, CAPTURE_TOOL,
          `${describeCapturePlan(request)} Verified target: ${peeked.observation.identity.serial} (transport ${peeked.observation.identity.transportId}).`)
        if (approved) return json(approved)
        const after = resolvePolicy(services.sandboxPolicy, exec.agent?.session)
        if (!after || policyKey(after) !== policyKey(binding)) {
          return json(blocked('capture', 'POLICY_CHANGED', 'session policy changed after approval; retry required'))
        }
        const deps: CaptureDeps = { ...deviceLikeDeps(services, binding, exec, config) }
        const deviceDeps = deviceDepsFor(services, binding, exec, config)
        if (isOutcome(deviceDeps)) return json(deviceDeps)
        const prepared = await prepareObservedTarget(deviceDeps, lock, observations, {
          action: 'capture', serial: request.serial, observationId: captureObservation as string | undefined,
        }, binding)
        if (!prepared.ok) return json(prepared.outcome)
        try {
          return json(await runCapture(deps, request, Date.now()))
        } finally {
          prepared.release()
        }
      } catch (error) {
        if (error instanceof ArgumentError) return json(blocked('capture', 'ARGUMENT_INVALID', error.message))
        throw error
      }
    },
  }
}
