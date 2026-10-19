/**
 * Android 设备：身份观测、进程内互斥与部署。
 *
 * 能力边界（用户已选择的本地路线，如实声明）：
 * - 身份来自**一次快照**（`adb devices -l` + 设备属性）加"每个变更动作之前的立即复核"；
 *   本轮**没有**实现长期 `track-devices` 观察进程，因此空闲期间设备被换掉不会主动告警，
 *   只能在下一个变更动作被拒时发现。这一点已记录在剩余规格里。
 * - 互斥只保证**当前 Android 执行实例内**同一目标串行；不提供跨进程/跨 Host 排他。
 * - 只操作明确指定的 serial；绝不退回"默认第一台设备"。
 */

import type {
  ApprovalLike, OperationOutcome, PolicyLike, SandboxLike, ScopedExecution, SubprocessLike,
} from './contracts.js'
import {
  ArgumentError, blocked, cancelled, failed, outcome, policyKey, rejectUnknownKeys, requireEnum,
  requireInteger, requireText, resolvePolicy,
} from './contracts.js'
import type { SandboxMode } from './contracts.js'
import { runBounded, terminateBounded } from './process.js'
import type { BoundedRunOutcome } from './process.js'

export const DEVICE_TOOL = 'satellite_android_device'
export const OBSERVATION_TTL_MS = 5 * 60 * 1000

export interface DeviceIdentity {
  readonly world: 'host-shared-v1'
  readonly adbPath: string
  readonly serverEndpoint: string
  /** 本次快照的随机标识；不是外部 server epoch/lease。 */
  readonly generation: string
  readonly serial: string
  readonly transportId: string
  readonly state: 'device' | 'offline' | 'unauthorized' | 'unknown'
  readonly bootSerial?: string
  readonly buildFingerprint?: string
  readonly product?: string
  readonly model?: string
}

export interface DeviceObservation {
  readonly id: string
  readonly ownerId: string
  readonly identity: DeviceIdentity
  readonly observedAt: string
  readonly expiresAt: number
  readonly digest: string
}

export type IdentityCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/** `adb devices -l` 的解析：只认真正有意义的行，其他如实忽略。 */
export function parseAdbDevicesL(text: string): readonly {
  serial: string
  state: string
  transportId?: string
  product?: string
  model?: string
  device?: string
}[] {
  const devices: { serial: string; state: string; transportId?: string; product?: string; model?: string; device?: string }[] = []
  for (const raw of text.replaceAll('\r\n', '\n').split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    if (line.startsWith('List of devices attached')) continue
    const [serial, state, ...rest] = line.split(/\s+/u)
    if (!serial || !state) continue
    const extra: Record<string, string> = {}
    for (const entry of rest) {
      const index = entry.indexOf(':')
      if (index <= 0) continue
      extra[entry.slice(0, index)] = entry.slice(index + 1)
    }
    devices.push({
      serial,
      state,
      ...(extra.transport_id ? { transportId: extra.transport_id } : {}),
      ...(extra.product ? { product: extra.product } : {}),
      ...(extra.model ? { model: extra.model } : {}),
      ...(extra.device ? { device: extra.device } : {}),
    })
  }
  return devices
}

/** `adb shell getprop` 的 `[name]: [value]` 行解析。 */
export function parseGetprop(text: string): Readonly<Record<string, string>> {
  const props: Record<string, string> = {}
  for (const raw of text.replaceAll('\r\n', '\n').split('\n')) {
    const match = /^\[([^\]]+)\]: \[(.*)\]$/u.exec(raw.trim())
    if (match === null) continue
    props[match[1] as string] = match[2] as string
  }
  return props
}

/** 身份摘要：固定字段顺序，含 server endpoint 与 transport，避免"serial 相同即同一台"。 */
export function identityDigest(sha256: (text: string) => string, identity: DeviceIdentity): string {
  return sha256(JSON.stringify([
    identity.world, identity.adbPath, identity.serverEndpoint, identity.serial, identity.transportId,
    identity.state, identity.bootSerial ?? null, identity.buildFingerprint ?? null,
  ]))
}

/** 逐字段比较：serial 相同但 transport/属性变化视为不同实例。 */
export function sameInstance(a: DeviceIdentity, b: DeviceIdentity): IdentityCheck {
  if (a.serial !== b.serial) return { ok: false, reason: `serial changed: ${a.serial} → ${b.serial}` }
  if (a.transportId !== b.transportId) return { ok: false, reason: `transport changed: ${a.transportId} → ${b.transportId}` }
  if (a.serverEndpoint !== b.serverEndpoint) return { ok: false, reason: 'adb server endpoint changed' }
  if ((a.bootSerial ?? '') !== (b.bootSerial ?? '')) return { ok: false, reason: 'boot serial changed' }
  if ((a.buildFingerprint ?? '') !== (b.buildFingerprint ?? '')) return { ok: false, reason: 'build fingerprint changed' }
  if (b.state !== 'device') return { ok: false, reason: `device state is ${b.state}` }
  return { ok: true }
}

/** `dumpsys activity activities` 里的前台包名；解析不出来就是不知道，不猜。 */
export function parseForegroundPackage(text: string): string | undefined {
  const patterns = [
    /mResumedActivity: ActivityRecord\{[^}]*\bu\d+\s+([A-Za-z0-9_.]+)\//u,
    /topResumedActivity=ActivityRecord\{[^}]*\bu\d+\s+([A-Za-z0-9_.]+)\//u,
    /mFocusedApp=AppWindowToken\{[^}]*\s([A-Za-z0-9_.]+)\//u,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match?.[1]) return match[1]
  }
  return undefined
}

/** 组件实例内的互斥：busy 立即拒绝，不排队。 */
export function createDeviceLock() {
  const held = new Set<string>()
  return {
    tryAcquire(key: string): boolean {
      if (held.has(key)) return false
      held.add(key)
      return true
    },
    release(key: string): void {
      held.delete(key)
    },
    held(key: string): boolean {
      return held.has(key)
    },
    size(): number {
      return held.size
    },
  }
}

export function lockKey(identity: DeviceIdentity): string {
  return [identity.world, identity.adbPath, identity.serverEndpoint, identity.serial].join('|')
}

/** 观测表：与构建观测同一套语义（不透明 id、按调用方隔离、会过期）。 */
export function createDeviceObservationStore(
  now: () => number,
  randomId: () => string,
  ttlMs = OBSERVATION_TTL_MS,
) {
  const entries = new Map<string, DeviceObservation>()
  const lookup = (id: string): { ok: true; observation: DeviceObservation } | { ok: false; code: 'TARGET_REQUIRED' | 'TARGET_CHANGED'; message: string } => {
    const observation = entries.get(id)
    if (!observation) return { ok: false, code: 'TARGET_REQUIRED', message: 'unknown device observation id' }
    if (observation.expiresAt <= now()) {
      entries.delete(id)
      return { ok: false, code: 'TARGET_CHANGED', message: 'device observation expired; discover again' }
    }
    return { ok: true, observation }
  }
  return {
    put(ownerId: string, identity: DeviceIdentity, digest: string): DeviceObservation {
      const observation: DeviceObservation = Object.freeze({
        id: randomId(), ownerId, identity, observedAt: new Date(now()).toISOString(),
        expiresAt: now() + ttlMs, digest,
      })
      entries.set(observation.id, observation)
      return observation
    },
    get: lookup,
    getFor(id: string, ownerId: string) {
      const found = lookup(id)
      if (!found.ok) return found
      if (found.observation.ownerId !== ownerId) {
        return { ok: false as const, code: 'TARGET_CHANGED' as const, message: 'device observation belongs to another caller' }
      }
      return found
    },
    size(): number {
      return entries.size
    },
  }
}

/* --------------------------------------------------------------- adb 调用 */

export interface DeviceDeps {
  readonly services: {
    readonly sandbox: SandboxLike
    readonly subprocess: SubprocessLike
    readonly approval: ApprovalLike
    readonly sandboxPolicy: PolicyLike
  }
  readonly binding: { readonly root: string; readonly mode: SandboxMode; readonly workspaceRoot: string; readonly sessionId?: string }
  readonly exec: ScopedExecution
  readonly config: {
    readonly adbPath: string
    readonly serverEndpoint?: string
    readonly operationTimeoutMs: number
    readonly outputMaxBytes: number
  }
}

/** 固定 adb 前缀：server endpoint 与目标选择都由已核对的观测提供。 */
export function adbArgv(config: DeviceDeps['config'], target?: { serial?: string; transportId?: string }): string[] {
  const argv = [config.adbPath]
  if (config.serverEndpoint) argv.push('-L', config.serverEndpoint)
  if (target?.serial) argv.push('-s', target.serial)
  return argv
}

async function approvalOutcome(
  deps: DeviceDeps,
  action: string,
  reason: string,
): Promise<OperationOutcome | undefined> {
  const { services, exec } = deps
  if (!exec.agent) return blocked(action, 'APPROVAL_UNAVAILABLE', 'tool call has no agent to route approval through')
  let granted: Awaited<ReturnType<ApprovalLike['request']>>
  try {
    granted = await services.approval.request({
      agent: exec.agent,
      toolName: DEVICE_TOOL,
      ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
      reason,
      signal: exec.signal,
    })
  } catch (error) {
    return blocked(action, 'APPROVAL_UNAVAILABLE', error instanceof Error ? error.message : String(error))
  }
  if (granted === 'allowed-once') return undefined
  if (granted === 'cancelled') return cancelled(action, 'not-needed')
  return blocked(action, granted === 'unavailable' ? 'APPROVAL_UNAVAILABLE' : 'APPROVAL_REJECTED', `approval ${granted}`)
}

function runFailure(action: string, run: BoundedRunOutcome): OperationOutcome | undefined {
  if (run.ok) return undefined
  if (run.failure.kind === 'cancelled') return cancelled(action, 'not-needed')
  return blocked(action, 'CAPABILITY_UNAVAILABLE', run.failure.message ?? 'execution unavailable')
}

/** 执行一次 adb 调用；argv 由调用方给出，且只允许固定的子命令形状。 */
export async function adbRun(
  deps: DeviceDeps,
  args: readonly string[],
  action: string,
  target?: { serial?: string; transportId?: string },
): Promise<{ ok: true; text: string; exitCode: number | null } | { ok: false; outcome: OperationOutcome }> {
  const { services, binding, exec, config } = deps
  const run = await runBounded(services, {
    executable: config.adbPath,
    args: [...adbArgv(config, target).slice(1), ...args],
    cwd: binding.root,
    mode: binding.mode,
    workspaceRoot: binding.workspaceRoot,
    ...(binding.sessionId !== undefined ? { sessionId: binding.sessionId } : {}),
    timeoutMs: config.operationTimeoutMs,
    outputMaxBytes: config.outputMaxBytes,
  }, exec.signal)
  const failure = runFailure(action, run)
  if (failure) return { ok: false, outcome: failure }
  if (!run.ok) return { ok: false, outcome: blocked(action, 'CAPABILITY_UNAVAILABLE', 'execution unavailable') }
  if (run.result.aborted || run.result.timedOut) {
    return {
      ok: false,
      outcome: run.result.aborted
        ? cancelled(action, run.result.cleanup === 'completed' ? 'completed' : 'failed')
        : failed(action, 'TIMEOUT', 'adb did not finish before its deadline'),
    }
  }
  return { ok: true, text: run.result.stdout.text, exitCode: run.result.exitCode }
}

/** 解析设备属性；`ro.boot.serialno`/`ro.serialno` 都没有时身份不可用。 */
export function identityFromProbe(params: {
  adbPath: string
  serverEndpoint: string
  generation: string
  serial: string
  transportId?: string
  state: string
  props: Readonly<Record<string, string>>
  product?: string
  model?: string
}): DeviceIdentity | string {
  const bootSerial = params.props['ro.boot.serialno'] || params.props['ro.serialno']
  if (!bootSerial) return 'device reported neither ro.boot.serialno nor ro.serialno'
  const state = ['device', 'offline', 'unauthorized'].includes(params.state)
    ? (params.state as DeviceIdentity['state'])
    : 'unknown'
  return Object.freeze({
    world: 'host-shared-v1',
    adbPath: params.adbPath,
    serverEndpoint: params.serverEndpoint,
    generation: params.generation,
    serial: params.serial,
    transportId: params.transportId ?? params.serial,
    state,
    bootSerial,
    ...(params.props['ro.build.fingerprint'] ? { buildFingerprint: params.props['ro.build.fingerprint'] } : {}),
    ...(params.product ? { product: params.product } : {}),
    ...(params.model ? { model: params.model } : {}),
  })
}

/**
 * 观测一台明确指定的设备。
 * `serial` 必须由调用方给出：本函数不会替调用方挑第一台设备。
 */
export async function observeDevice(
  deps: DeviceDeps,
  serial: string,
  generation: string,
): Promise<{ ok: true; identity: DeviceIdentity } | { ok: false; outcome: OperationOutcome }> {
  const list = await adbRun(deps, ['devices', '-l'], 'device.discover')
  if (!list.ok) return { ok: false, outcome: list.outcome }
  const devices = parseAdbDevicesL(list.text)
  if (devices.length === 0) {
    return { ok: false, outcome: blocked('device.discover', 'TARGET_REQUIRED', 'no devices are attached to this adb server') }
  }
  const matches = devices.filter((entry) => entry.serial === serial)
  if (matches.length === 0) {
    return { ok: false, outcome: blocked('device.discover', 'TARGET_REQUIRED', `device is not attached: ${serial}`) }
  }
  if (matches.length > 1) {
    return { ok: false, outcome: blocked('device.discover', 'TARGET_AMBIGUOUS', `adb reported ${matches.length} entries for ${serial}`) }
  }
  const entry = matches[0] as (typeof matches)[number]
  if (entry.state !== 'device') {
    return { ok: false, outcome: blocked('device.discover', 'TARGET_REQUIRED', `device ${serial} is ${entry.state}`) }
  }
  const props = await adbRun(deps, ['shell', 'getprop'], 'device.discover', { serial })
  if (!props.ok) return { ok: false, outcome: props.outcome }
  const identity = identityFromProbe({
    adbPath: deps.config.adbPath,
    serverEndpoint: deps.config.serverEndpoint ?? 'default',
    generation,
    serial: entry.serial,
    ...(entry.transportId !== undefined ? { transportId: entry.transportId } : {}),
    state: entry.state,
    props: parseGetprop(props.text),
    ...(entry.product !== undefined ? { product: entry.product } : {}),
    ...(entry.model !== undefined ? { model: entry.model } : {}),
  })
  if (typeof identity === 'string') {
    return { ok: false, outcome: blocked('device.discover', 'CAPABILITY_UNAVAILABLE', identity) }
  }
  return { ok: true, identity }
}

/** 变更动作之前的立即复核：任何字段变化都要求新的观测与批准。 */
export async function verifyDevice(deps: DeviceDeps, expected: DeviceIdentity): Promise<IdentityCheck> {
  const probe = await observeDevice(deps, expected.serial, expected.generation)
  if (!probe.ok) return { ok: false, reason: probe.outcome.error?.message ?? 'device re-probe failed' }
  return sameInstance(expected, probe.identity)
}

/* ------------------------------------------------------------------ 部署 */

export interface DeviceRequest {
  readonly action: 'discover' | 'install' | 'launch' | 'foreground'
  readonly serial?: string
  readonly observationId?: string
  readonly artifact?: string
  readonly applicationId?: string
}

export function parseDeviceRequest(args: Record<string, unknown>): DeviceRequest {
  rejectUnknownKeys(args, ['action', 'serial', 'observationId', 'artifact', 'applicationId'])
  const action = requireEnum(args.action, 'action', ['discover', 'install', 'launch', 'foreground'] as const)
  // discover 也必须点名一台设备：本工具永不替调用方挑"第一台"。
  const serial = requireText(args.serial, 'serial', 128)
  if (action === 'discover') {
    if (args.observationId !== undefined || args.artifact !== undefined || args.applicationId !== undefined) {
      throw new ArgumentError('discover does not take observationId, artifact or applicationId')
    }
    return { action, serial }
  }
  const observationId = requireText(args.observationId, 'observationId', 128)
  if (action === 'install') {
    const artifact = requireText(args.artifact, 'artifact', 1024)
    return { action, serial, observationId, artifact: requireArtifactPath(artifact) }
  }
  const applicationId = requireText(args.applicationId, 'applicationId', 255)
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/u.test(applicationId)) {
    throw new ArgumentError('applicationId must be a reverse-DNS package name')
  }
  return { action, serial, observationId, applicationId }
}

/** 产物只接受工作区内的相对路径；绝对路径与上跳一律拒绝。 */
function requireArtifactPath(value: string): string {
  if (value.startsWith('/') || value.includes('\\')) throw new ArgumentError('artifact must be a workspace-relative path')
  const segments = value.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new ArgumentError('artifact must not contain empty, "." or ".." segments')
  }
  return value
}

/** 无需批准的动作只有 discover（只读查询）；其余都要真实批准。 */
export function describeDevicePlan(request: DeviceRequest, identity?: DeviceIdentity): string {
  switch (request.action) {
    case 'discover':
      return 'Run "adb devices -l" and "adb -s <serial> shell getprop" to observe the attached devices. This may start the adb server on this host. No device data is modified.'
    case 'install':
      return `Install ${request.artifact} on ${identity?.serial ?? request.serial} with "adb -s <serial> install -r <artifact>". It replaces the installed app with the same application id and writes the APK to the device.`
    case 'launch':
      return `Launch ${request.applicationId} on ${identity?.serial ?? request.serial} with a launcher-category monkey start. It changes the device's foreground application.`
    case 'foreground':
      return `Read the current foreground activity on ${identity?.serial ?? request.serial} with "dumpsys activity activities". Read-only on the device.`
  }
}

export function deviceTimeout(value: unknown, fallback: number, max = 30 * 60 * 1000): number {
  if (value === undefined) return fallback
  return requireInteger(value, 'timeoutMs', 1000, max)
}

/**
 * 目标绑定与互斥的统一前置（§5.1/§5.3）。
 *
 * 任何会在设备上产生效果的动作——安装、启动、UI 旅程、录屏/采集——
 * 都必须走这里：策略重读 → 观测所有权 → 进程内互斥 → 批准后设备复核。
 * 只接受裸 serial 就直接执行会绕过批准后的目标复核，因此不提供这种入口。
 */
export async function prepareObservedTarget(
  deps: DeviceDeps,
  lock: ReturnType<typeof createDeviceLock>,
  observations: ReturnType<typeof createDeviceObservationStore>,
  request: { action: string; serial?: string; observationId?: string },
  observedPolicy: { mode: SandboxMode; workspaceRoot: string; sessionId?: string },
): Promise<{ ok: true; identity: DeviceIdentity; release: () => void } | { ok: false; outcome: OperationOutcome }> {
  const action = request.action
  if (request.observationId === undefined) {
    return { ok: false, outcome: blocked(action, 'TARGET_REQUIRED', 'a device observation id is required for any action that touches the device; run discover first') }
  }
  const found = observations.getFor(request.observationId, deps.exec.agent?.id ?? 'unknown')
  if (!found.ok) return { ok: false, outcome: blocked(action, found.code, found.message) }
  const identity = found.observation.identity
  if (request.serial !== undefined && request.serial !== identity.serial) {
    return { ok: false, outcome: blocked(action, 'TARGET_CHANGED', 'request serial does not match the observation') }
  }
  const after = resolvePolicy(deps.services.sandboxPolicy, deps.exec.agent?.session)
  if (!after || policyKey(after) !== policyKey(observedPolicy)) {
    return { ok: false, outcome: blocked(action, 'POLICY_CHANGED', 'session policy changed after approval; retry required') }
  }
  const key = lockKey(identity)
  if (!lock.tryAcquire(key)) {
    return { ok: false, outcome: blocked(action, 'TARGET_CHANGED', `another operation is already using ${identity.serial}`) }
  }
  let released = false
  const release = () => {
    if (released) return
    released = true
    lock.release(key)
  }
  const check = await verifyDevice(deps, identity)
  if (!check.ok) {
    release()
    return { ok: false, outcome: blocked(action, 'TARGET_CHANGED', `device changed before execution: ${check.reason}`) }
  }
  return { ok: true, identity, release }
}

/** 设备工具自己的请求形态适配到统一前置。 */
export const prepareDeviceAction = (
  deps: DeviceDeps,
  lock: ReturnType<typeof createDeviceLock>,
  observations: ReturnType<typeof createDeviceObservationStore>,
  request: DeviceRequest,
  observedPolicy: { mode: SandboxMode; workspaceRoot: string; sessionId?: string },
) => prepareObservedTarget(deps, lock, observations, request, observedPolicy)
