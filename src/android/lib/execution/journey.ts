/**
 * 有界 UI 旅程（A3.3）：把一组判别类型步骤映射成**精确的 adb argv**。
 *
 * 不变量：
 * - 没有任意命令、没有 shell 字符串、没有无限循环：每一步只对应一条固定的 argv；
 * - 所有参数在启动任何进程之前完成严格校验（未知字段/未知步骤/越界值直接拒绝）；
 * - 断言失败立即停止后续步骤，并如实标记 failed，不把"没断言"当成通过；
 * - 截图走 `screencap -p <设备路径>` + `adb pull`，**不**把二进制当文本从 stdout 解码；
 *   拉回后必须用文件系统核对存在与摘要；
 * - UI 文本断言走 `uiautomator dump` + `exec-out cat` 读取**有界文本**；
 *   输出被截断或解析不出节点时报告 failed/unavailable，绝不当作通过；
 * - 设备临时文件在 finally 中清理，清理失败单列，不用成功掩盖。
 *
 * 批准（真实 `approval.request`）由接线方在调用前完成；本模块只暴露
 * `describeJourneyPlan()` 供批准理由使用，并负责执行与结果映射。
 */

import { createHash, randomUUID } from 'node:crypto'

import type { OperationEvidence, OperationOutcome, SandboxMode, ScopedExecution, SandboxLike, SubprocessLike } from './contracts.ts'
import {
  ArgumentError, blocked, requireEnum, requireInteger, requireRelativePath, requireText, rejectUnknownKeys,
} from './contracts.ts'
import { runBounded } from './process.ts'
import type { BoundedRunOutcome } from './process.ts'

/** 设备上的临时目录：所有中间产物都写在这里，并在 finally 清理。 */
export const DEVICE_TMP_DIR = '/data/local/tmp'

export const MAX_JOURNEY_STEPS = 30
export const MAX_TEXT_LENGTH = 1024
export const MAX_ASSERT_TEXT_LENGTH = 512
export const MIN_WAIT_MS = 1
export const MAX_WAIT_MS = 30_000
/** 单步上限：与规格"每步 ≤30 秒"一致。 */
export const STEP_TIMEOUT_MS = 30_000
/** 一次 UI dump 的文本上限。 */
export const UI_DUMP_MAX_BYTES = 4 * 1024 * 1024
export const SCREENSHOT_DIGEST_MAX_BYTES = 16 * 1024 * 1024

/** 允许的按键白名单（`input keyevent` 的 KEYCODE_* 名）。 */
export const JOURNEY_KEYS = Object.freeze([
  'KEYCODE_HOME', 'KEYCODE_BACK', 'KEYCODE_ENTER', 'KEYCODE_DEL', 'KEYCODE_TAB',
  'KEYCODE_ESCAPE', 'KEYCODE_MENU', 'KEYCODE_APP_SWITCH',
  'KEYCODE_DPAD_UP', 'KEYCODE_DPAD_DOWN', 'KEYCODE_DPAD_LEFT', 'KEYCODE_DPAD_RIGHT',
  'KEYCODE_DPAD_CENTER', 'KEYCODE_MOVE_HOME', 'KEYCODE_MOVE_END', 'KEYCODE_PAGE_UP', 'KEYCODE_PAGE_DOWN',
] as const)

export type JourneyKey = (typeof JOURNEY_KEYS)[number]

export type JourneyStep =
  | { readonly action: 'tap'; readonly x: number; readonly y: number }
  | { readonly action: 'text'; readonly text: string }
  | { readonly action: 'key'; readonly key: JourneyKey }
  | { readonly action: 'wait'; readonly ms: number }
  | { readonly action: 'assert-foreground'; readonly packageName: string }
  | { readonly action: 'assert-ui-text'; readonly text: string }
  | { readonly action: 'screenshot'; readonly output: string }

export interface JourneyRequest {
  readonly serial: string
  readonly applicationId: string
  readonly steps: readonly JourneyStep[]
}

export interface JourneyStepResult {
  readonly index: number
  readonly action: JourneyStep['action']
  readonly status: 'succeeded' | 'failed' | 'skipped'
  readonly detail?: string
  readonly evidence: readonly OperationEvidence[]
}

export type JourneyOutcome = OperationOutcome & { readonly steps: readonly JourneyStepResult[] }

/** 注入的执行依赖：接线方提供已解析的 adb 路径与本次调用的绑定。 */
export interface JourneyDeps {
  readonly fs: JourneyFs
  readonly sandbox: SandboxLike
  readonly subprocess: SubprocessLike
  readonly binding: {
    readonly root: string
    readonly mode: SandboxMode
    readonly workspaceRoot: string
    readonly sessionId?: string
  }
  readonly exec: ScopedExecution
  /** 已解析的绝对 adb 路径；本模块不发起到处找 adb 的猜测。 */
  readonly adbPath: string
  readonly operationTimeoutMs: number
  readonly outputMaxBytes: number
}

/** 本模块实际使用的文件系统能力（与 DSH fs 服务的对应方法一致）。 */
export interface JourneyFs {
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>
  stat(target: unknown, signal?: AbortSignal): Promise<{ type: string; size?: number } | undefined>
  processPath(target: unknown): string
  readBytes(target: unknown, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
}

/* --------------------------------------------------------------- 参数校验 */

/** adb serial：不接受空值、选项形状或 shell/argv 危险字符。 */
function parseSerial(value: unknown): string {
  const serial = requireText(value, 'serial', 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(serial)) {
    throw new ArgumentError('serial must match [A-Za-z0-9][A-Za-z0-9._:-]* (no spaces, leading "-" or shell characters)')
  }
  return serial
}

/** 应用包名：只允许点分标识符，避免把任意串拼进设备 shell。 */
function parsePackageName(value: unknown, where: string): string {
  const name = requireText(value, where, 255)
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u.test(name)) {
    throw new ArgumentError(`${where} must be a dotted package name`)
  }
  return name
}

/**
 * `input text` 的字符集收窄。
 *
 * adb 会把 argv 重新拼成远程 shell 命令，因此**任何**shell 元字符都不能放行；
 * 这里只接受字母数字与少量安全标点，空格按 `input text` 的要求编码成 `%s`。
 * 这不是"方便"的选择，而是把注入面直接去掉。
 */
export const INPUT_TEXT_PATTERN = /^[A-Za-z0-9 .,_@/:+=_-]+$/u

export function encodeInputText(value: unknown): string {
  if (typeof value !== 'string') throw new ArgumentError('text must be a string')
  requireText(value, 'text', MAX_TEXT_LENGTH)
  if (!INPUT_TEXT_PATTERN.test(value)) {
    throw new ArgumentError('text may only contain letters, digits, space and . , _ @ / : + = - (shell metacharacters are not accepted)')
  }
  if (value.startsWith('-')) throw new ArgumentError('text must not start with "-"')
  return value.replaceAll(' ', '%s')
}

function parseStep(value: unknown, index: number): JourneyStep {
  const where = `steps[${index}]`
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ArgumentError(`${where} must be an object`)
  }
  const step = value as Record<string, unknown>
  const action = requireEnum(step.action, `${where}.action`, [
    'tap', 'text', 'key', 'wait', 'assert-foreground', 'assert-ui-text', 'screenshot',
  ] as const)
  switch (action) {
    case 'tap': {
      rejectUnknownKeys(step, ['action', 'x', 'y'], where)
      return {
        action,
        x: requireInteger(step.x, `${where}.x`, 0, 100_000),
        y: requireInteger(step.y, `${where}.y`, 0, 100_000),
      }
    }
    case 'text': {
      rejectUnknownKeys(step, ['action', 'text'], where)
      const text = requireText(step.text, `${where}.text`, MAX_TEXT_LENGTH)
      // 字符集在解析期就核对：不能等前面几步已经改过设备 UI 才拒绝。
      encodeInputText(text)
      return { action, text }
    }
    case 'key': {
      rejectUnknownKeys(step, ['action', 'key'], where)
      return { action, key: requireEnum(step.key, `${where}.key`, JOURNEY_KEYS) }
    }
    case 'wait': {
      rejectUnknownKeys(step, ['action', 'ms'], where)
      return { action, ms: requireInteger(step.ms, `${where}.ms`, MIN_WAIT_MS, MAX_WAIT_MS) }
    }
    case 'assert-foreground': {
      rejectUnknownKeys(step, ['action', 'package'], where)
      return { action, packageName: parsePackageName(step.package, `${where}.package`) }
    }
    case 'assert-ui-text': {
      rejectUnknownKeys(step, ['action', 'text'], where)
      return { action, text: requireText(step.text, `${where}.text`, MAX_ASSERT_TEXT_LENGTH) }
    }
    case 'screenshot': {
      rejectUnknownKeys(step, ['action', 'output'], where)
      return { action, output: requireRelativePath(step.output, `${where}.output`) }
    }
  }
}

/** 严格解析：未知字段、未知动作、越界值与超长文本都在启动前拒绝。 */
export function parseJourneyRequest(args: unknown): JourneyRequest {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new ArgumentError('journey arguments must be an object')
  }
  const record = args as Record<string, unknown>
  rejectUnknownKeys(record, ['serial', 'applicationId', 'steps'])
  const serial = parseSerial(record.serial)
  const applicationId = parsePackageName(record.applicationId, 'applicationId')
  if (!Array.isArray(record.steps)) throw new ArgumentError('steps must be an array')
  if (record.steps.length === 0) throw new ArgumentError('steps must not be empty')
  if (record.steps.length > MAX_JOURNEY_STEPS) {
    throw new ArgumentError(`steps must contain at most ${MAX_JOURNEY_STEPS} entries`)
  }
  return Object.freeze({
    serial,
    applicationId,
    steps: Object.freeze(record.steps.map((step, index) => Object.freeze(parseStep(step, index)))),
  })
}

/** 供批准理由使用的计划描述：写哪些设备临时文件、拉回哪些工作区路径都要出现。 */
export function describeJourneyPlan(request: JourneyRequest): string {
  const shots = request.steps.filter((step): step is Extract<JourneyStep, { action: 'screenshot' }> => step.action === 'screenshot')
  const asserts = request.steps.filter((step) => step.action === 'assert-ui-text' || step.action === 'assert-foreground').length
  return [
    `Run a bounded UI journey of ${request.steps.length} steps (max ${MAX_JOURNEY_STEPS}) on device "${request.serial}" for ${request.applicationId}.`,
    'Every step is one fixed adb command; no shell strings and no arbitrary commands are accepted.',
    'Taps, text input and key events change real device UI state.',
    shots.length > 0
      ? `Screenshots are captured on the device under ${DEVICE_TMP_DIR} and pulled into the workspace at: ${shots.map((step) => step.output).join(', ')}; device copies are deleted afterwards.`
      : 'No screenshots are captured.',
    asserts > 0
      ? 'UI assertions dump the on-device view hierarchy to a device temporary file, read it back as bounded text, and delete the device copy afterwards.'
      : 'No UI assertions run.',
    'On-device effects happen outside the file sandbox; the session sandbox only covers workspace writes.',
  ].join(' ')
}

/* ------------------------------------------------------------ 设备命令构造 */

/**
 * 只构造 adb 之后的参数：可执行文件由 `runBounded` 通过 `executable` 统一前置，
 * 两处都加会把 adb 拼两次。
 */
// 目标用 -s <serial>（与设备/模拟器工具一致）。transport/属性在动作前已复核，
// 这里不再退回默认设备，也不用 transport_id——它随连接变化，不是稳定身份。
const adb = (_deps: JourneyDeps, serial: string, args: readonly string[]): string[] => ['-s', serial, ...args]

/** 设备临时路径：只由本模块生成，不接受调用方提供。 */
export function deviceTempPath(suffix: string, token: string): string {
  const safe = suffix.replace(/[^A-Za-z0-9._-]/gu, '')
  return `${DEVICE_TMP_DIR}/satellite-${token}${safe ? `.${safe}` : ''}`
}

/** 从 `dumpsys activity activities` 文本里读出前台包名；读不出返回 undefined。 */
export function parseForegroundPackage(text: string): string | undefined {
  for (const line of text.split('\n')) {
    if (!/(mResumedActivity|topResumedActivity|ResumedActivity)/u.test(line)) continue
    const match = /\s([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)\//u.exec(line)
    if (match?.[1]) return match[1]
  }
  return undefined
}

/** 从 uiautomator dump 的 XML 文本里取出全部节点 text 属性（已解转义）。 */
export function parseUiTexts(xml: string): string[] {
  const texts: string[] = []
  const pattern = /\stext="([^"]*)"/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml)) !== null) {
    texts.push(unescapeXml(match[1] ?? ''))
  }
  return texts
}

function unescapeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

/* ------------------------------------------------------------------ 执行 */

interface RunContext {
  readonly deps: JourneyDeps
  readonly request: JourneyRequest
  readonly token: string
  readonly deadline: number
  readonly cleanupPaths: Set<string>
}

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

function frozen(status: OperationOutcome['status'], action: string, extra: {
  evidence?: readonly OperationEvidence[]
  cleanup?: OperationOutcome['cleanup']
  error?: { code: NonNullable<OperationOutcome['error']>['code']; message: string }
  steps: readonly JourneyStepResult[]
}): JourneyOutcome {
  return Object.freeze({
    status,
    action,
    evidence: Object.freeze([...(extra.evidence ?? [])]),
    cleanup: extra.cleanup ?? 'not-needed',
    ...(extra.error ? { error: Object.freeze({ ...extra.error }) } : {}),
    steps: Object.freeze([...extra.steps]),
  })
}

interface StepOutcome {
  readonly ok: boolean
  readonly status?: 'failed' | 'cancelled' | 'blocked'
  readonly detail?: string
  readonly code?: NonNullable<OperationOutcome['error']>['code']
  readonly evidence?: readonly OperationEvidence[]
}

/** 跑一条固定 argv；返回结果或"运行层面失败"。 */
async function runCommand(
  context: RunContext,
  args: readonly string[],
  options: { readonly timeoutMs?: number; readonly stdin?: string; readonly outputMaxBytes?: number } = {},
): Promise<{ ok: true; stdout: string; stderr: string; truncated: boolean } | { ok: false; outcome: StepOutcome }> {
  const { deps, request } = context
  if (deps.exec.signal.aborted) {
    return { ok: false, outcome: { ok: false, status: 'cancelled', code: 'CANCELLED', detail: 'cancelled before the next step' } }
  }
  const remaining = context.deadline - Date.now()
  if (remaining <= 0) {
    return { ok: false, outcome: { ok: false, status: 'failed', code: 'TIMEOUT', detail: 'journey deadline exceeded before the next step' } }
  }
  const timeoutMs = Math.min(options.timeoutMs ?? STEP_TIMEOUT_MS, remaining)
  const run: BoundedRunOutcome = await runBounded(
    { sandbox: deps.sandbox, subprocess: deps.subprocess },
    {
      executable: deps.adbPath,
      args,
      cwd: deps.binding.root,
      mode: deps.binding.mode,
      workspaceRoot: deps.binding.workspaceRoot,
      ...(deps.binding.sessionId !== undefined ? { sessionId: deps.binding.sessionId } : {}),
      timeoutMs,
      outputMaxBytes: options.outputMaxBytes ?? Math.min(deps.outputMaxBytes, 1024 * 1024),
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    },
    deps.exec.signal,
  )
  if (!run.ok) {
    return run.failure.kind === 'cancelled'
      ? { ok: false, outcome: { ok: false, status: 'cancelled', code: 'CANCELLED', detail: 'cancelled' } }
      : { ok: false, outcome: { ok: false, status: 'blocked', detail: run.failure.message } }
  }
  if (run.result.aborted) {
    return { ok: false, outcome: { ok: false, status: 'cancelled', code: 'CANCELLED', detail: 'cancelled while running the device command' } }
  }
  if (run.result.timedOut) {
    return { ok: false, outcome: { ok: false, status: 'failed', code: 'TIMEOUT', detail: `device command exceeded ${timeoutMs}ms` } }
  }
  if (run.result.cleanup === 'failed') {
    // 真实命令已经结束，但进程树没有被确认清理；不继续下一步。
    return { ok: false, outcome: { ok: false, status: 'failed', code: 'CLEANUP_FAILED', detail: 'device command could not be confirmed terminated' } }
  }
  return { ok: true, stdout: run.result.stdout.text, stderr: run.result.stderr.text, truncated: run.result.stdout.truncated }
}

/** 删除一个设备临时文件；失败只记清理状态，不掩盖主结果。 */
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
      timeoutMs: 5000,
      outputMaxBytes: 16 * 1024,
    },
    // 清理使用独立信号：调用被取消时仍然要尝试删掉设备临时文件。
    new AbortController().signal,
  )
  if (!run.ok) return false
  return run.result.exitCode === 0 && !run.result.aborted && !run.result.timedOut
}

/** 拉回产物并用文件系统核对存在与摘要；核对不了就不算成功。 */
async function verifyArtifact(
  context: RunContext,
  relativePath: string,
): Promise<{ ok: true; evidence: OperationEvidence } | { ok: false; detail: string }> {
  const target = await context.deps.fs.resolve(relativePath, { cwd: context.deps.binding.root, signal: context.deps.exec.signal })
  const info = await context.deps.fs.stat(target, context.deps.exec.signal)
  if (!info || info.type !== 'file') return { ok: false, detail: `pulled artifact is missing or not a regular file: ${relativePath}` }
  if ((info.size ?? 0) <= 0) return { ok: false, detail: `pulled artifact is empty: ${relativePath}` }
  let digest: string
  try {
    const bytes = await context.deps.fs.readBytes(target, context.deps.exec.signal, SCREENSHOT_DIGEST_MAX_BYTES)
    digest = sha256(bytes)
  } catch (error) {
    return { ok: false, detail: `pulled artifact could not be read back for verification: ${error instanceof Error ? error.message : String(error)}` }
  }
  return {
    ok: true,
    evidence: {
      kind: 'artifact',
      source: context.deps.fs.processPath(target),
      digest,
    },
  }
}

/** 父目录必须先存在：`adb pull` 不会替调用方建目录，缺目录要提前说清。 */
async function requireParentDirectory(context: RunContext, relativePath: string): Promise<string | undefined> {
  const parent = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '.'
  const target = await context.deps.fs.resolve(parent, { cwd: context.deps.binding.root, signal: context.deps.exec.signal })
  const info = await context.deps.fs.stat(target, context.deps.exec.signal)
  if (!info || info.type !== 'directory') {
    return `output directory does not exist in the workspace: ${parent === '.' ? '.' : parent}`
  }
  return undefined
}

async function runScreenshot(context: RunContext, step: Extract<JourneyStep, { action: 'screenshot' }>): Promise<StepOutcome> {
  const missingParent = await requireParentDirectory(context, step.output)
  if (missingParent) return { ok: false, status: 'blocked', code: 'TARGET_REQUIRED', detail: missingParent }

  const devicePath = deviceTempPath('png', context.token)
  context.cleanupPaths.add(devicePath)
  const capture = await runCommand(context, adb(context.deps, context.request.serial, ['shell', 'screencap', '-p', devicePath]))
  if (!capture.ok) return capture.outcome
  if (capture.truncated) {
    // screencap 到设备文件不应产生大量 stdout；被截断说明形状不符，不能当作成功。
    return { ok: false, status: 'failed', detail: 'screencap produced unexpected truncated output; the device file was not confirmed' }
  }

  const pull = await runCommand(context, adb(context.deps, context.request.serial, ['pull', devicePath, step.output]))
  if (!pull.ok) return pull.outcome
  const verified = await verifyArtifact(context, step.output)
  if (!verified.ok) return { ok: false, status: 'failed', detail: verified.detail }
  return { ok: true, evidence: [verified.evidence] }
}

async function runAssertForeground(context: RunContext, step: Extract<JourneyStep, { action: 'assert-foreground' }>): Promise<StepOutcome> {
  const dump = await runCommand(
    context,
    adb(context.deps, context.request.serial, ['shell', 'dumpsys', 'activity', 'activities']),
    { outputMaxBytes: Math.min(context.deps.outputMaxBytes, 2 * 1024 * 1024) },
  )
  if (!dump.ok) return dump.outcome
  if (dump.truncated) {
    // 截断的转储可能恰好丢掉前台行：不能据此判定通过。
    return { ok: false, status: 'failed', detail: 'activity dump was truncated, so the foreground activity could not be judged' }
  }
  const foreground = parseForegroundPackage(dump.stdout)
  if (foreground === undefined) {
    return { ok: false, status: 'failed', detail: 'could not read a foreground activity from the device dump' }
  }
  if (foreground !== step.packageName) {
    return { ok: false, status: 'failed', detail: `expected foreground ${step.packageName} but the device reports ${foreground}` }
  }
  return { ok: true, evidence: [{ kind: 'assertion', source: `foreground=${foreground}` }] }
}

async function runAssertUiText(context: RunContext, step: Extract<JourneyStep, { action: 'assert-ui-text' }>): Promise<StepOutcome> {
  const devicePath = deviceTempPath('xml', context.token)
  context.cleanupPaths.add(devicePath)
  const dump = await runCommand(context, adb(context.deps, context.request.serial, ['shell', 'uiautomator', 'dump', devicePath]))
  if (!dump.ok) return dump.outcome

  const read = await runCommand(
    context,
    adb(context.deps, context.request.serial, ['exec-out', 'cat', devicePath]),
    { outputMaxBytes: Math.min(context.deps.outputMaxBytes, UI_DUMP_MAX_BYTES) },
  )
  if (!read.ok) return read.outcome
  if (read.truncated) {
    return { ok: false, status: 'failed', detail: 'view hierarchy was truncated before it could be parsed; the assertion is unverified' }
  }
  const texts = parseUiTexts(read.stdout)
  if (texts.length === 0) {
    return { ok: false, status: 'failed', detail: 'view hierarchy contained no readable text nodes; the assertion is unverified' }
  }
  if (!texts.includes(step.text)) {
    const sample = texts.filter((text) => text.length > 0).slice(0, 8)
    return { ok: false, status: 'failed', detail: `expected visible text ${JSON.stringify(step.text)} was not found; observed: ${JSON.stringify(sample)}` }
  }
  return { ok: true, evidence: [{ kind: 'assertion', source: `visible text ${JSON.stringify(step.text)}`, digest: sha256(step.text) }] }
}

/**
 * 执行一次有界 UI 旅程。
 * 断言失败即停止；每一步的 argv 都是固定形状，取消/超时都会先终止进程再返回。
 */
export async function runJourney(deps: JourneyDeps, request: JourneyRequest, now: number | Date): Promise<JourneyOutcome> {
  const startedAt = typeof now === 'number' ? now : now.getTime()
  const context: RunContext = {
    deps,
    request,
    // 设备临时文件名用随机不透明 token：不接受调用方提供，也不依赖可预测序号。
    token: `${startedAt.toString(36)}-${randomUUID().slice(0, 8)}`,
    deadline: startedAt + deps.operationTimeoutMs,
    cleanupPaths: new Set<string>(),
  }
  const steps: JourneyStepResult[] = []
  const collected: OperationEvidence[] = []
  let failure: StepOutcome | undefined
  let stoppedIndex = -1

  if (!deps.adbPath.startsWith('/')) {
    return frozen('blocked', 'journey', {
      error: { code: 'CAPABILITY_UNAVAILABLE', message: 'adb executable was not resolved to an absolute path' },
      steps,
    })
  }

  try {
    for (const [index, step] of request.steps.entries()) {
      if (failure) {
        steps.push({ index, action: step.action, status: 'skipped', evidence: [] })
        continue
      }
      const result = await executeStep(context, step)
      if (result.ok) {
        steps.push({ index, action: step.action, status: 'succeeded', evidence: result.evidence ?? [] })
        collected.push(...(result.evidence ?? []))
      } else {
        failure = result
        stoppedIndex = index
        steps.push({
          index,
          action: step.action,
          status: 'failed',
          ...(result.detail !== undefined ? { detail: result.detail } : {}),
          evidence: result.evidence ?? [],
        })
      }
    }
  } finally {
    // 设备临时文件必须清理：集合里**只留下没删成功的**路径，未清空即清理失败。
    for (const path of [...context.cleanupPaths]) {
      if (await removeDeviceFile(context, path)) context.cleanupPaths.delete(path)
    }
  }

  const cleanupFailed = context.cleanupPaths.size > 0
  const cleanup = cleanupFailed ? 'failed' : 'completed'
  if (!failure && !cleanupFailed) {
    return frozen('succeeded', 'journey', { evidence: collected, cleanup, steps })
  }
  if (!failure) {
    // 步骤都跑完了，但设备临时文件没删掉：不声称成功。
    return frozen('failed', 'journey', {
      evidence: collected,
      cleanup,
      steps,
      error: { code: 'CLEANUP_FAILED', message: 'some device temporary files could not be removed' },
    })
  }
  if (failure.status === 'cancelled') return frozen('cancelled', 'journey', { evidence: collected, cleanup, steps })
  const alreadyChangedDevice = steps.some((entry) => entry.status === 'succeeded')
  if (failure.status === 'blocked' && !alreadyChangedDevice) {
    return frozen('blocked', 'journey', {
      evidence: collected,
      cleanup,
      steps,
      error: { code: failure.code ?? 'CAPABILITY_UNAVAILABLE', message: failure.detail ?? 'journey could not start' },
    })
  }
  if (failure.status === 'blocked') {
    // 前面的步骤已经改过设备状态：这时不能再声称"什么都没发生"。
    return frozen('failed', 'journey', {
      evidence: collected,
      cleanup,
      steps,
      error: {
        code: failure.code ?? 'CAPABILITY_UNAVAILABLE',
        message: `${failure.detail ?? 'step could not start'} (earlier steps already changed device state)`,
      },
    })
  }
  return frozen('failed', 'journey', {
    evidence: collected,
    cleanup,
    steps,
    error: {
      code: cleanupFailed ? 'CLEANUP_FAILED' : (failure.code ?? 'CAPABILITY_UNAVAILABLE'),
      message: `${failure.detail ?? 'step failed'}${stoppedIndex >= 0 ? ` (stopped at step ${stoppedIndex}; remaining steps were not executed)` : ''}`,
    },
  })
}

async function executeStep(context: RunContext, step: JourneyStep): Promise<StepOutcome> {
  const { deps, request } = context
  const signal = deps.exec.signal
  switch (step.action) {
    case 'tap': {
      const run = await runCommand(context, adb(deps, request.serial, ['shell', 'input', 'tap', String(step.x), String(step.y)]))
      if (!run.ok) return run.outcome
      return { ok: true, evidence: [{ kind: 'device-action', source: `tap ${step.x},${step.y}` }] }
    }
    case 'text': {
      const encoded = encodeInputText(step.text)
      const run = await runCommand(context, adb(deps, request.serial, ['shell', 'input', 'text', encoded]))
      if (!run.ok) return run.outcome
      return { ok: true, evidence: [{ kind: 'device-action', source: `input text (${encoded.length} chars)` }] }
    }
    case 'key': {
      const run = await runCommand(context, adb(deps, request.serial, ['shell', 'input', 'keyevent', step.key]))
      if (!run.ok) return run.outcome
      return { ok: true, evidence: [{ kind: 'device-action', source: `keyevent ${step.key}` }] }
    }
    case 'wait': {
      // 等待必须有界：剩余预算不够就明确失败，不静默缩短成"等了但没等够"。
      const remaining = context.deadline - Date.now()
      if (remaining <= 0) return { ok: false, status: 'failed', code: 'TIMEOUT', detail: 'journey deadline exceeded before the wait step' }
      if (step.ms > remaining) {
        return {
          ok: false,
          status: 'failed',
          code: 'TIMEOUT',
          detail: `requested wait of ${step.ms}ms exceeds the remaining journey budget of ${remaining}ms`,
        }
      }
      // 等待必须可被取消打断：不能让 30s 的 sleep 拖住取消/超时。
      const finished = await new Promise<boolean>((resolve) => {
        if (signal.aborted) { resolve(false); return }
        const timer = setTimeout(() => { cleanup(); resolve(true) }, step.ms)
        const onAbort = () => { cleanup(); resolve(false) }
        const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort) }
        signal.addEventListener('abort', onAbort, { once: true })
      })
      if (!finished) return { ok: false, status: 'cancelled', code: 'CANCELLED', detail: 'journey cancelled during a wait step' }
      return { ok: true, evidence: [{ kind: 'device-action', source: `wait ${step.ms}ms` }] }
    }
    case 'assert-foreground':
      return runAssertForeground(context, step)
    case 'assert-ui-text':
      return runAssertUiText(context, step)
    case 'screenshot':
      return runScreenshot(context, step)
  }
}
