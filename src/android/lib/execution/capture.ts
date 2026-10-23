/**
 * 有界采集（A3.4）：logcat / 录屏 / perfetto / 内存快照。
 *
 * 每次调用都是**一条**完整的有界流程：启动 → 有限时窗 → 停止 → 拉取 → 核验 → 清理，
 * 超时与取消走同一个 finally。持久化产物必须真正落地到工作区并核对摘要；
 * 文本产物在写回后读回校验，二进制产物只核对存在与摘要，绝不经 stdout 当文本解码。
 *
 * 批准由接线方在调用前用真实 `approval.request` 完成；本模块只暴露
 * `describeCapturePlan()` 供批准理由使用，并负责执行与结果映射。
 *
 * 与 journey 共用设备临时目录约定（同一个常量，避免两处漂移）。
 */

import { createHash, randomUUID } from 'node:crypto'
import { isAbsoluteHostPathSyntax } from '../../../platform/paths.ts'

import type { OperationEvidence, OperationOutcome, SandboxMode, ScopedExecution, SandboxLike, SubprocessLike } from './contracts.ts'
import {
  ArgumentError, blocked, requireEnum, requireInteger, requireRelativePath, requireText, rejectUnknownKeys,
} from './contracts.ts'
import { DEVICE_TMP_DIR } from './journey.ts'
import { runBounded } from './process.ts'
import type { BoundedRunOutcome } from './process.ts'

export const CAPTURE_ACTIONS = Object.freeze(['logcat', 'record', 'perfetto', 'memory'] as const)
export type CaptureAction = (typeof CAPTURE_ACTIONS)[number]

export const MIN_DURATION_SECONDS = 1
export const MAX_DURATION_SECONDS = 120
/** logcat dump 模式的固定尾部行数：不给调用方任意 `-t` 的自由度。 */
export const LOG_DUMP_LINES = 2000
/** perfetto 配置文件的读入上限。 */
export const PERFETTO_CONFIG_MAX_BYTES = 256 * 1024
/** 文本产物写回后的读回校验上限。 */
export const TEXT_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024
/** 二进制产物摘要的限量读取上限：只对前缀取摘要并在证据里写明范围。 */
export const ARTIFACT_DIGEST_MAX_BYTES = 16 * 1024 * 1024
/** 采集结束后拉取与停止的额外预算。 */
export const CAPTURE_SETTLE_MS = 30_000
/** 设备临时文件删除的硬上限。 */
export const CAPTURE_CLEANUP_TIMEOUT_MS = 5000

export interface CaptureRequest {
  readonly action: CaptureAction
  readonly serial: string
  readonly applicationId?: string
  readonly durationSeconds: number
  readonly output: string
  /** 仅 perfetto：工作区内已存在的文本配置路径。 */
  readonly configPath?: string
}

export type CaptureOutcome = OperationOutcome & { readonly artifacts: readonly OperationEvidence[] }

export interface CaptureDeps {
  readonly fs: CaptureFs
  readonly sandbox: SandboxLike
  readonly subprocess: SubprocessLike
  readonly binding: {
    readonly root: string
    readonly mode: SandboxMode
    readonly workspaceRoot: string
    readonly sessionId?: string
  }
  readonly exec: ScopedExecution
  /** 已解析的绝对 adb 路径。 */
  readonly adbPath: string
  readonly operationTimeoutMs: number
  readonly outputMaxBytes: number
  /** 收尾预算；默认 `CAPTURE_SETTLE_MS`，部署/测试可收窄，不能放大超过会话预算。 */
  readonly settleMs?: number
}

/** 本模块实际使用的文件系统能力（与 DSH fs 服务的对应方法一致）。 */
export interface CaptureFs {
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>
  stat(target: unknown, signal?: AbortSignal): Promise<{ type: string; size?: number } | undefined>
  processPath(target: unknown): string
  readBytes(target: unknown, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
  /**
   * 写入必须带 per-call 沙箱策略：沙箱后端按它围栏，省略时后端用自己的默认值
   * （实测省略会被拒：`file access denied under workspace-write mode`）。
   */
  writeText(
    target: unknown,
    content: string,
    expected?: { kind: 'createIfAbsent' },
    signal?: AbortSignal,
    sandboxPolicy?: { mode: string; workspaceRoot: string; sessionId?: string },
  ): Promise<unknown>
}

/* --------------------------------------------------------------- 参数校验 */

function parseSerial(value: unknown): string {
  const serial = requireText(value, 'serial', 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(serial)) {
    throw new ArgumentError('serial must match [A-Za-z0-9][A-Za-z0-9._:-]* (no spaces, leading "-" or shell characters)')
  }
  return serial
}

function parsePackageName(value: unknown, where: string): string {
  const name = requireText(value, where, 255)
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u.test(name)) {
    throw new ArgumentError(`${where} must be a dotted package name`)
  }
  return name
}

/** 严格解析：未知字段、未知动作与越界时长都在启动任何进程之前拒绝。 */
export function parseCaptureRequest(args: unknown): CaptureRequest {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new ArgumentError('capture arguments must be an object')
  }
  const record = args as Record<string, unknown>
  rejectUnknownKeys(record, ['action', 'serial', 'applicationId', 'durationSeconds', 'output', 'configPath'])
  const action = requireEnum(record.action, 'action', CAPTURE_ACTIONS)
  const serial = parseSerial(record.serial)
  const applicationId = record.applicationId === undefined
    ? undefined
    : parsePackageName(record.applicationId, 'applicationId')
  const durationSeconds = requireInteger(record.durationSeconds, 'durationSeconds', MIN_DURATION_SECONDS, MAX_DURATION_SECONDS)
  const output = requireRelativePath(record.output, 'output')
  if (action === 'perfetto') {
    if (record.configPath === undefined) {
      throw new ArgumentError('configPath is required for perfetto (a workspace-relative text config that already exists)')
    }
    return Object.freeze({
      action, serial, durationSeconds, output,
      ...(applicationId !== undefined ? { applicationId } : {}),
      configPath: requireRelativePath(record.configPath, 'configPath'),
    })
  }
  if (record.configPath !== undefined) {
    throw new ArgumentError(`configPath is only valid for perfetto, not for ${action}`)
  }
  return Object.freeze({
    action, serial, durationSeconds, output,
    ...(applicationId !== undefined ? { applicationId } : {}),
  })
}

const actionDetail: Record<CaptureAction, string> = {
  logcat: `dump the last ${LOG_DUMP_LINES} logcat lines (-d) and write them to the workspace`,
  record: 'record the device screen with screenrecord and pull the video into the workspace',
  perfetto: 'run perfetto with the given text config from stdin and pull the trace into the workspace',
  memory: 'dump dumpsys meminfo for the application and write it to the workspace',
}

/** 供批准理由使用的计划描述：设备端副作用与工作区落点都必须出现。 */
export function describeCapturePlan(request: CaptureRequest): string {
  const deviceWrites = request.action === 'record' || request.action === 'perfetto'
  return [
    // logcat/memory 是 dump 模式：durationSeconds 是进程预算，不是采集时窗；措辞不能含糊。
    request.action === 'logcat' || request.action === 'memory'
      ? `Capture "${request.action}" on device "${request.serial}" as a single bounded dump (process budget ${request.durationSeconds}s): ${actionDetail[request.action]}.`
      : `Capture "${request.action}" on device "${request.serial}" for at most ${request.durationSeconds}s: ${actionDetail[request.action]}.`,
    request.applicationId !== undefined ? `Target application: ${request.applicationId}.` : 'No application filter.',
    `Workspace output: ${request.output}.`,
    request.configPath !== undefined ? `Perfetto config read from the workspace: ${request.configPath}.` : '',
    deviceWrites
      ? `A temporary trace file is written on the device under ${PERFETTO_DEVICE_DIR} (perfetto cannot write ${DEVICE_TMP_DIR} on this platform), then pulled into the workspace and deleted from the device.`
      : 'No device files are written; output is transferred as bounded text.',
    'The capture window is bounded by the given duration plus a fixed settle budget; on-device effects are not confined by the file sandbox.',
  ].filter((line) => line.length > 0).join(' ')
}

/* ------------------------------------------------------------------ 执行 */

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

interface RunContext {
  readonly deps: CaptureDeps
  readonly request: CaptureRequest
  readonly token: string
  readonly devicePaths: Set<string>
  readonly settleMs: number
}

function frozen(status: OperationOutcome['status'], extra: {
  evidence?: readonly OperationEvidence[]
  cleanup?: OperationOutcome['cleanup']
  error?: { code: NonNullable<OperationOutcome['error']>['code']; message: string }
  artifacts?: readonly OperationEvidence[]
}): CaptureOutcome {
  return Object.freeze({
    status,
    action: 'capture',
    evidence: Object.freeze([...(extra.evidence ?? [])]),
    cleanup: extra.cleanup ?? 'not-needed',
    ...(extra.error ? { error: Object.freeze({ ...extra.error }) } : {}),
    artifacts: Object.freeze([...(extra.artifacts ?? [])]),
  })
}

/** 同 journey：可执行文件由 `runBounded` 前置，这里只给 adb 之后的参数。 */
// 目标用 -s <serial>（与设备/模拟器工具一致）。transport/属性在动作前已复核，
// 这里不再退回默认设备，也不用 transport_id——它随连接变化，不是稳定身份。
const adb = (_deps: CaptureDeps, serial: string, args: readonly string[]): string[] => ['-s', serial, ...args]

/**
 * 录屏产物放共享临时目录；perfetto 产物必须落在 `/data/misc/perfetto-traces`：
 * 真机 perfetto 往 `/data/local/tmp` 写时被拒（errno 13 / Permission denied），
 * 只有 perfetto 自己的 traces 目录可写（实测）。
 */
const PERFETTO_DEVICE_DIR = '/data/misc/perfetto-traces'

function devicePath(token: string, suffix: string): string {
  const dir = suffix === 'perfetto-trace' ? PERFETTO_DEVICE_DIR : DEVICE_TMP_DIR
  return `${dir}/satellite-${token}.${suffix}`
}

interface CommandResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
}

type CommandOutcome =
  | { readonly ok: true; readonly result: CommandResult }
  | { readonly ok: false; readonly status: 'failed' | 'cancelled' | 'blocked'; readonly code?: NonNullable<OperationOutcome['error']>['code']; readonly detail: string }

async function runCommand(
  context: RunContext,
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly stdin?: string; readonly outputMaxBytes?: number },
): Promise<CommandOutcome> {
  const { deps } = context
  if (deps.exec.signal.aborted) return { ok: false, status: 'cancelled', code: 'CANCELLED', detail: 'cancelled before the command started' }
  const run: BoundedRunOutcome = await runBounded(
    { sandbox: deps.sandbox, subprocess: deps.subprocess },
    {
      executable: deps.adbPath,
      args,
      cwd: deps.binding.root,
      mode: deps.binding.mode,
      workspaceRoot: deps.binding.workspaceRoot,
      ...(deps.binding.sessionId !== undefined ? { sessionId: deps.binding.sessionId } : {}),
      timeoutMs: Math.min(options.timeoutMs, deps.operationTimeoutMs),
      outputMaxBytes: options.outputMaxBytes ?? Math.min(deps.outputMaxBytes, 1024 * 1024),
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    },
    deps.exec.signal,
  )
  if (!run.ok) {
    return run.failure.kind === 'cancelled'
      ? { ok: false, status: 'cancelled', code: 'CANCELLED', detail: 'cancelled' }
      : { ok: false, status: 'blocked', detail: run.failure.message }
  }
  if (run.result.aborted) return { ok: false, status: 'cancelled', code: 'CANCELLED', detail: 'cancelled while the device command ran' }
  if (run.result.timedOut) return { ok: false, status: 'failed', code: 'TIMEOUT', detail: `device command exceeded ${options.timeoutMs}ms` }
  if (run.result.cleanup === 'failed') {
    return { ok: false, status: 'failed', code: 'CLEANUP_FAILED', detail: 'device command could not be confirmed terminated' }
  }
  return {
    ok: true,
    result: {
      exitCode: run.result.exitCode,
      stdout: run.result.stdout.text,
      stderr: run.result.stderr.text,
      truncated: run.result.stdout.truncated || run.result.stderr.truncated,
    },
  }
}

/** 删除设备临时文件；用独立信号，调用被取消时仍然尝试。 */
async function removeDeviceFile(context: RunContext, path: string): Promise<boolean> {
  const { deps, request } = context
  const run = await runBounded(
    { sandbox: deps.sandbox, subprocess: deps.subprocess },
    {
      executable: deps.adbPath,
      args: adb(deps, request.serial, ['shell', 'rm', '-f', path]),
      cwd: deps.binding.root,
      mode: deps.binding.mode,
      workspaceRoot: deps.binding.workspaceRoot,
      ...(deps.binding.sessionId !== undefined ? { sessionId: deps.binding.sessionId } : {}),
      timeoutMs: CAPTURE_CLEANUP_TIMEOUT_MS,
      outputMaxBytes: 16 * 1024,
    },
    new AbortController().signal,
  )
  return run.ok && run.result.exitCode === 0 && !run.result.aborted && !run.result.timedOut
}

async function resolveInWorkspace(context: RunContext, relative: string): Promise<unknown> {
  return context.deps.fs.resolve(relative, { cwd: context.deps.binding.root, signal: context.deps.exec.signal })
}

/** 输出的父目录必须已存在：不替调用方建目录，也不让 adb pull 半途失败。 */
async function requireParentDirectory(context: RunContext, relative: string): Promise<string | undefined> {
  const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '.'
  const info = await context.deps.fs.stat(await resolveInWorkspace(context, parent), context.deps.exec.signal)
  if (!info || info.type !== 'directory') return `output directory does not exist in the workspace: ${parent}`
  return undefined
}

/** 二进制产物：核对存在、非空与内容摘要；不做任何文本解码。 */
async function verifyBinaryArtifact(
  context: RunContext,
  relative: string,
): Promise<{ ok: true; evidence: OperationEvidence } | { ok: false; detail: string }> {
  const target = await resolveInWorkspace(context, relative)
  const info = await context.deps.fs.stat(target, context.deps.exec.signal)
  if (!info || info.type !== 'file') return { ok: false, detail: `pulled artifact is missing or not a regular file: ${relative}` }
  if ((info.size ?? 0) <= 0) return { ok: false, detail: `pulled artifact is empty: ${relative}` }
  try {
    const bytes = await context.deps.fs.readBytes(target, context.deps.exec.signal, ARTIFACT_DIGEST_MAX_BYTES)
    return {
      ok: true,
      evidence: {
        kind: 'artifact',
        source: context.deps.fs.processPath(target),
        digest: sha256(bytes),
      },
    }
  } catch (error) {
    return { ok: false, detail: `pulled artifact could not be read back for verification: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 文本产物：拒绝覆盖既有文件，写回后读回校验，内容不符即失败。 */
async function persistText(
  context: RunContext,
  relative: string,
  content: string,
): Promise<{ ok: true; evidence: OperationEvidence } | { ok: false; status: 'failed' | 'blocked'; code?: NonNullable<OperationOutcome['error']>['code']; detail: string }> {
  const target = await resolveInWorkspace(context, relative)
  const existing = await context.deps.fs.stat(target, context.deps.exec.signal)
  if (existing) {
    return { ok: false, status: 'blocked', code: 'TARGET_CHANGED', detail: `output already exists; choose a new path: ${relative}` }
  }
  try {
    const { binding, exec } = context.deps
    await context.deps.fs.writeText(
      target,
      content,
      { kind: 'createIfAbsent' },
      exec.signal,
      {
        mode: binding.mode,
        workspaceRoot: binding.workspaceRoot,
        ...(binding.sessionId !== undefined ? { sessionId: binding.sessionId } : {}),
      },
    )
  } catch (error) {
    return { ok: false, status: 'failed', detail: `could not write the capture output: ${error instanceof Error ? error.message : String(error)}` }
  }
  let readBack: string
  try {
    const bytes = await context.deps.fs.readBytes(target, context.deps.exec.signal, TEXT_ARTIFACT_MAX_BYTES)
    readBack = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    return { ok: false, status: 'failed', detail: `capture output could not be read back for verification: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (readBack !== content) {
    return { ok: false, status: 'failed', detail: 'capture output does not match what was written; the artifact is unverified' }
  }
  return {
    ok: true,
    evidence: { kind: 'artifact', source: context.deps.fs.processPath(target), digest: sha256(content) },
  }
}

/** 读入已存在的 perfetto 配置：缺失、不是文件或超限都明确不可用。 */
async function readPerfettoConfig(context: RunContext): Promise<{ ok: true; text: string } | { ok: false; detail: string }> {
  const relative = context.request.configPath
  if (relative === undefined) return { ok: false, detail: 'perfetto requires configPath' }
  const target = await resolveInWorkspace(context, relative)
  const info = await context.deps.fs.stat(target, context.deps.exec.signal)
  if (!info || info.type !== 'file') return { ok: false, detail: `perfetto config is not a readable file: ${relative}` }
  try {
    const bytes = await context.deps.fs.readBytes(target, context.deps.exec.signal, PERFETTO_CONFIG_MAX_BYTES)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    // 设备上的 perfetto 没有 `--time-limit`，时窗只能由配置自己界定；
    // 配置不声明时长就拒绝，避免采集无上界。
    if (!/(^|\n)\s*duration_ms\s*:\s*\d+/.test(text)) {
      return { ok: false, detail: `perfetto config must declare duration_ms (this device's perfetto has no --time-limit): ${relative}` }
    }
    return { ok: true, text }
  } catch (error) {
    return { ok: false, detail: `perfetto config could not be read as bounded UTF-8 text: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 执行一次有界采集。四个动作共享同一套"启动→时窗→停止→拉取→核验→清理"，
 * 取消与超时都在同一 finally 中收敛。
 */
export async function runCapture(deps: CaptureDeps, request: CaptureRequest, now: number | Date): Promise<CaptureOutcome> {
  const startedAt = typeof now === 'number' ? now : now.getTime()
  const settleMs = deps.settleMs ?? CAPTURE_SETTLE_MS
  const context: RunContext = {
    deps,
    request,
    settleMs,
    // 设备临时文件名用随机不透明 token：不接受调用方提供，也不依赖可预测序号。
    token: `${startedAt.toString(36)}-${randomUUID().slice(0, 8)}`,
    devicePaths: new Set<string>(),
  }
  const artifacts: OperationEvidence[] = []

  if (!isAbsoluteHostPathSyntax(deps.adbPath)) {
    return frozen('blocked', {
      error: { code: 'CAPABILITY_UNAVAILABLE', message: 'adb executable was not resolved to an absolute path' },
    })
  }
  // 时窗 + 收尾预算必须装得进本次操作预算：装不进就明确拒绝，而不是录到一半被杀。
  if (request.durationSeconds * 1000 + settleMs > deps.operationTimeoutMs) {
    return frozen('blocked', {
      error: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: `the requested capture window (${request.durationSeconds}s) plus the ${settleMs}ms settle budget does not fit the ${deps.operationTimeoutMs}ms operation budget`,
      },
    })
  }
  const missingParent = await requireParentDirectory(context, request.output)
  if (missingParent) {
    return frozen('blocked', { error: { code: 'TARGET_REQUIRED', message: missingParent } })
  }

  let failure: { status: 'failed' | 'cancelled' | 'blocked'; code?: NonNullable<OperationOutcome['error']>['code']; detail: string } | undefined
  let cleanupFailed = false
  try {
    switch (request.action) {
      case 'logcat':
        failure = await captureLogcat(context, artifacts)
        break
      case 'memory':
        failure = await captureMemory(context, artifacts)
        break
      case 'record':
      case 'perfetto':
        failure = await captureRecording(context, artifacts)
        break
    }
  } finally {
    for (const path of context.devicePaths) {
      if (!(await removeDeviceFile(context, path))) cleanupFailed = true
    }
  }

  const cleanup = cleanupFailed ? ('failed' as const) : ('completed' as const)
  if (!failure && !cleanupFailed) {
    return frozen('succeeded', { evidence: artifacts, artifacts, cleanup })
  }
  if (!failure) {
    // 采集本身完成，但设备临时文件没删掉：不声称成功。
    return frozen('failed', {
      evidence: artifacts,
      artifacts,
      cleanup,
      error: { code: 'CLEANUP_FAILED', message: 'a device temporary file could not be removed' },
    })
  }
  if (failure.status === 'cancelled') return frozen('cancelled', { evidence: artifacts, artifacts, cleanup })
  if (failure.status === 'blocked') {
    return frozen('blocked', {
      evidence: artifacts, artifacts, cleanup,
      error: { code: failure.code ?? 'CAPABILITY_UNAVAILABLE', message: failure.detail },
    })
  }
  return frozen('failed', {
    evidence: artifacts, artifacts, cleanup,
    error: {
      code: cleanupFailed ? 'CLEANUP_FAILED' : (failure.code ?? 'CAPABILITY_UNAVAILABLE'),
      message: failure.detail,
    },
  })
}

async function captureLogcat(
  context: RunContext,
  artifacts: OperationEvidence[],
): Promise<{ status: 'failed' | 'cancelled' | 'blocked'; code?: NonNullable<OperationOutcome['error']>['code']; detail: string } | undefined> {
  const { deps, request } = context
  const filter: string[] = []
  if (request.applicationId !== undefined) {
    const pidof = await runCommand(context, adb(deps, request.serial, ['shell', 'pidof', request.applicationId]), {
      timeoutMs: context.settleMs,
    })
    if (!pidof.ok) return pidof
    if (pidof.result.exitCode !== 0) {
      return { status: 'failed', code: 'TARGET_REQUIRED', detail: `application is not running, so its log has no pid: ${request.applicationId}` }
    }
    const pid = pidof.result.stdout.trim().split(/\s+/u)[0] ?? ''
    if (!/^[0-9]{1,10}$/u.test(pid)) {
      return { status: 'failed', detail: `could not read a valid pid for ${request.applicationId}` }
    }
    filter.push('--pid', pid)
  }
  const run = await runCommand(
    context,
    adb(deps, request.serial, ['logcat', '-d', '-t', String(LOG_DUMP_LINES), ...filter]),
    { timeoutMs: context.settleMs, outputMaxBytes: deps.outputMaxBytes },
  )
  if (!run.ok) return run
  if (run.result.truncated) {
    return { status: 'failed', detail: 'logcat output was truncated by the output limit; the artifact is incomplete and is not reported as captured' }
  }
  const persisted = await persistText(context, request.output, run.result.stdout)
  if (!persisted.ok) return { status: persisted.status, ...(persisted.code !== undefined ? { code: persisted.code } : {}), detail: persisted.detail }
  artifacts.push(persisted.evidence)
  return undefined
}

async function captureMemory(
  context: RunContext,
  artifacts: OperationEvidence[],
): Promise<{ status: 'failed' | 'cancelled' | 'blocked'; code?: NonNullable<OperationOutcome['error']>['code']; detail: string } | undefined> {
  const { deps, request } = context
  if (request.applicationId === undefined) {
    // 无包名的 meminfo 是全量转储，超出有界前提；明确要求目标而不是截断后当成功。
    return { status: 'blocked', code: 'TARGET_REQUIRED', detail: 'memory capture requires applicationId so the dump stays bounded' }
  }
  const run = await runCommand(
    context,
    adb(deps, request.serial, ['shell', 'dumpsys', 'meminfo', request.applicationId]),
    { timeoutMs: context.settleMs, outputMaxBytes: deps.outputMaxBytes },
  )
  if (!run.ok) return run
  if (run.result.truncated) {
    return { status: 'failed', detail: 'meminfo output was truncated by the output limit; the artifact is incomplete' }
  }
  if (run.result.exitCode !== 0) {
    return { status: 'failed', detail: `dumpsys meminfo exited with ${run.result.exitCode}` }
  }
  const persisted = await persistText(context, request.output, run.result.stdout)
  if (!persisted.ok) return { status: persisted.status, ...(persisted.code !== undefined ? { code: persisted.code } : {}), detail: persisted.detail }
  artifacts.push(persisted.evidence)
  return undefined
}

async function captureRecording(
  context: RunContext,
  artifacts: OperationEvidence[],
): Promise<{ status: 'failed' | 'cancelled' | 'blocked'; code?: NonNullable<OperationOutcome['error']>['code']; detail: string } | undefined> {
  const { deps, request } = context
  const isPerfetto = request.action === 'perfetto'
  const suffix = isPerfetto ? 'perfetto-trace' : 'mp4'
  const path = devicePath(context.token, suffix)

  // 先读配置：配置不可用时一个设备文件都还没创建，不应该留下清理动作。
  let stdin: string | undefined
  if (isPerfetto) {
    const config = await readPerfettoConfig(context)
    if (!config.ok) return { status: 'blocked', code: 'TARGET_REQUIRED', detail: config.detail }
    stdin = config.text
  }
  context.devicePaths.add(path)

  // 时窗靠**配置里的 duration_ms**：真机上的 perfetto 不认 `--time-limit`
  // （实测 `perfetto: unrecognized option '--time-limit'`），所以不再传；
  // 进程预算仍是硬上限（时窗 + 收尾），到点由 terminate 收尾。
  const timeoutMs = Math.min(request.durationSeconds * 1000 + context.settleMs, deps.operationTimeoutMs)
  const args = isPerfetto
    ? ['shell', 'perfetto', '-c', '-', '--txt', '-o', path]
    : ['shell', 'screenrecord', '--time-limit', String(request.durationSeconds), path]
  const run = await runCommand(context, adb(deps, request.serial, args), {
    timeoutMs,
    ...(stdin !== undefined ? { stdin } : {}),
    outputMaxBytes: Math.min(deps.outputMaxBytes, 256 * 1024),
  })
  if (!run.ok) return run
  if (run.result.exitCode !== 0) {
    return { status: 'failed', detail: `${isPerfetto ? 'perfetto' : 'screenrecord'} exited with ${run.result.exitCode}: ${run.result.stderr.trim().slice(0, 512)}` }
  }

  const pull = await runCommand(context, adb(deps, request.serial, ['pull', path, request.output]), {
    timeoutMs: context.settleMs,
  })
  if (!pull.ok) return pull
  if (pull.result.exitCode !== 0) {
    return { status: 'failed', detail: `could not pull the capture artifact from the device: ${pull.result.stderr.trim().slice(0, 512)}` }
  }
  const verified = await verifyBinaryArtifact(context, request.output)
  if (!verified.ok) return { status: 'failed', detail: verified.detail }
  artifacts.push(verified.evidence)
  return undefined
}
