/**
 * Android 模拟器：明确 AVD 的有界生命周期与**会话所有权**。
 *
 * 只有 `start` 会保留一个长寿命进程，并且必须完成一次原子的所有权转移：
 * 转移前资源属于本次调用（失败/取消都要在本调用内终止并等待）；
 * 转移后资源属于当前 Agent 作用域，直到显式 stop、owner 退出或组件卸载。
 *
 * 与规格一致的边界：
 * - 不使用 AVD 名称当作运行实例身份，也不按名称接管别人的进程；
 * - 首版不提供跨 Host 重启恢复，也不承诺宿主崩溃后的清理；
 * - `stop` 的 owned 分支只认本组件发过的不透明 id；external 分支必须重新观测并单独批准。
 */

import { randomUUID } from 'node:crypto'

import type {
  ApprovalLike, OperationOutcome, PolicyLike, SandboxLike, ScopedExecution, SubprocessLike,
} from './contracts.js'
import { ArgumentError, blocked, cancelled, failed, outcome, rejectUnknownKeys, requireEnum, requireInteger, requireText } from './contracts.js'
import { runBounded, terminateBounded } from './process.js'
import type { BoundedRunOutcome } from './process.js'

export const EMULATOR_TOOL = 'satellite_android_emulator'
export const DEFAULT_STARTUP_TIMEOUT_MS = 5 * 60 * 1000
export const BOOT_POLL_INTERVAL_MS = 2000

export interface OwnedResource {
  readonly id: string
  readonly ownerId: string
  readonly avd: string
  readonly serial: string
  readonly handle: { terminate(): void; waitForExit(signal?: AbortSignal): Promise<boolean> }
  readonly ownerController: AbortController
  closePromise?: Promise<'completed' | 'failed'>
}

export interface EmulatorRequest {
  readonly action: 'list' | 'start' | 'stop' | 'delete' | 'create'
  readonly avd?: string
  readonly ownedResourceId?: string
  readonly serial?: string
  readonly installedSystemImage?: string
  readonly deviceProfile?: string
  readonly startupTimeoutMs?: number
}

const AVD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

export function parseEmulatorRequest(args: Record<string, unknown>): EmulatorRequest {
  rejectUnknownKeys(args, [
    'action', 'avd', 'ownedResourceId', 'serial', 'installedSystemImage', 'deviceProfile', 'startupTimeoutMs',
  ])
  const action = requireEnum(args.action, 'action', ['list', 'start', 'stop', 'delete', 'create'] as const)
  const startupTimeoutMs = args.startupTimeoutMs === undefined
    ? undefined
    : requireInteger(args.startupTimeoutMs, 'startupTimeoutMs', 10_000, 30 * 60 * 1000)
  if (action === 'list') {
    if (args.avd !== undefined || args.ownedResourceId !== undefined || args.serial !== undefined
      || args.installedSystemImage !== undefined || args.deviceProfile !== undefined || startupTimeoutMs !== undefined) {
      throw new ArgumentError('list takes no other arguments')
    }
    return { action }
  }
  if (action === 'stop') {
    const ownedResourceId = args.ownedResourceId === undefined ? undefined : requireText(args.ownedResourceId, 'ownedResourceId', 128)
    const serial = args.serial === undefined ? undefined : requireText(args.serial, 'serial', 128)
    if ((ownedResourceId === undefined) === (serial === undefined)) {
      throw new ArgumentError('stop requires exactly one of ownedResourceId or serial')
    }
    if (args.avd !== undefined || args.installedSystemImage !== undefined || args.deviceProfile !== undefined) {
      throw new ArgumentError('stop takes neither avd nor system image')
    }
    return { action, ...(ownedResourceId ? { ownedResourceId } : {}), ...(serial ? { serial } : {}) }
  }
  if (action === 'create') {
    const avd = requireAvd(args.avd)
    const installedSystemImage = requireText(args.installedSystemImage, 'installedSystemImage', 255)
    const deviceProfile = requireText(args.deviceProfile, 'deviceProfile', 128)
    if (!/^[A-Za-z0-9._;+-]+$/u.test(installedSystemImage)) {
      throw new ArgumentError('installedSystemImage must be an already installed SDK package id')
    }
    return { action, avd, installedSystemImage, deviceProfile }
  }
  const avd = requireAvd(args.avd)
  if (args.ownedResourceId !== undefined || args.serial !== undefined
    || args.installedSystemImage !== undefined || args.deviceProfile !== undefined) {
    throw new ArgumentError(`${action} takes only avd`)
  }
  return { action, avd, ...(startupTimeoutMs !== undefined ? { startupTimeoutMs } : {}) }
}

function requireAvd(value: unknown): string {
  const avd = requireText(value, 'avd', 64)
  if (!AVD_NAME.test(avd)) throw new ArgumentError('avd must be a plain AVD name')
  return avd
}

/** `emulator -list-avds` 的解析：只保留合法名称，重复项视为歧义。 */
export function parseAvdList(text: string): readonly string[] {
  const names: string[] = []
  for (const raw of text.replaceAll('\r\n', '\n').split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    if (/^(INFO|WARNING|ERROR)\b/u.test(line)) continue
    if (!AVD_NAME.test(line)) continue
    if (!names.includes(line)) names.push(line)
  }
  return names
}

/** `adb devices` 里新出现的 emulator serial。 */
export function newEmulatorSerial(before: readonly string[], after: readonly string[]): string | undefined {
  const fresh = after.filter((serial) => serial.startsWith('emulator-') && !before.includes(serial))
  return fresh.length === 1 ? fresh[0] : undefined
}

export function adbSerials(text: string): readonly string[] {
  const serials: string[] = []
  for (const raw of text.replaceAll('\r\n', '\n').split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('List of devices attached')) continue
    const [serial, state] = line.split(/\s+/u)
    if (!serial || !state) continue
    if (!serials.includes(serial)) serials.push(serial)
  }
  return serials
}

/**
 * 会话拥有的资源表。
 * `close` 是幂等的：并发 stop、owner 退出与组件卸载共享同一个 memoized promise，
 * 不依赖"第二个 disposer 会等第一个"这种假设。
 */
export function createOwnedResources(cleanupTimeoutMs = 30_000) {
  const entries = new Map<string, OwnedResource>()
  const closing = new Map<string, Promise<'completed' | 'failed'>>()
  let accepting = true

  const close = (id: string): Promise<'completed' | 'failed'> => {
    const existing = closing.get(id)
    if (existing) return existing
    const resource = entries.get(id)
    if (!resource) return Promise.resolve('completed')
    const promise = (async (): Promise<'completed' | 'failed'> => {
      // 先停止新消费者，再终止并等待退出；超过清理上限算失败。
      resource.ownerController.abort()
      const result = await terminateBounded(resource.handle, cleanupTimeoutMs)
      if (result === 'completed') entries.delete(id)
      closing.delete(id)
      return result
    })()
    closing.set(id, promise)
    resource.closePromise = promise
    return promise
  }

  return {
    adopt(resource: OwnedResource): void {
      if (!accepting) {
        // 组件正在卸载：不接受新资源，调用方必须在本调用内清理。
        throw new Error('owned resources are closing; refusing to adopt')
      }
      // 同 id 覆盖会孤立先前的 handle（永不终止）：明确拒绝而不是静默替换。
      if (entries.has(resource.id)) throw new Error(`owned resource id already exists: ${resource.id}`)
      entries.set(resource.id, resource)
    },
    get(id: string, ownerId: string): OwnedResource | undefined {
      const resource = entries.get(id)
      if (!resource) return undefined
      return resource.ownerId === ownerId ? resource : undefined
    },
    has(id: string): boolean {
      return entries.has(id)
    },
    close,
    /** Agent 作用域退出：只关闭该 Agent 拥有的资源，并等待完成。 */
    async closeOwner(ownerId: string): Promise<'completed' | 'failed'> {
      const ids = [...entries.values()].filter((resource) => resource.ownerId === ownerId).map((resource) => resource.id)
      const results = await Promise.all(ids.map((id) => close(id)))
      return results.every((value) => value === 'completed') ? 'completed' : 'failed'
    },
    /** 组件卸载：先禁止新转移，再关闭全部；返回是否有失败。 */
    async closeAll(): Promise<'completed' | 'failed'> {
      accepting = false
      const results = await Promise.all([...entries.keys()].map((id) => close(id)))
      return results.every((value) => value === 'completed') ? 'completed' : 'failed'
    },
    size(): number {
      return entries.size
    },
  }
}

export interface EmulatorDeps {
  readonly services: {
    readonly sandbox: SandboxLike
    readonly subprocess: SubprocessLike
    readonly approval: ApprovalLike
  }
  readonly binding: { readonly root: string; readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access'; readonly workspaceRoot: string; readonly sessionId?: string }
  readonly exec: ScopedExecution
  readonly config: {
    readonly emulatorPath: string
    readonly avdmanagerPath?: string
    readonly adbPath: string
    readonly operationTimeoutMs: number
    readonly outputMaxBytes: number
    /** 轮询间隔；默认 2s，可调小以便测试，不改变语义。 */
    readonly bootPollIntervalMs?: number
  }
}

export function describeEmulatorPlan(request: EmulatorRequest): string {
  switch (request.action) {
    case 'list':
      return 'Run "emulator -list-avds" to read the configured AVD names. It does not start a VM and does not modify AVD data.'
    case 'start':
      return `Start AVD ${request.avd} with "emulator -avd ${request.avd}". The emulator keeps running after this call until it is stopped explicitly, the agent scope exits, or the plugin unloads; it consumes CPU, memory and a console/ADB port.`
    case 'stop':
      return request.ownedResourceId
        ? `Stop the emulator instance this component started (owned id ${request.ownedResourceId}) and wait for it to exit.`
        : `Stop the emulator attached as ${request.serial} with "adb -s ${request.serial} emu kill". This does NOT claim ownership: any instance with that serial is stopped.`
    case 'delete':
      return `Delete AVD ${request.avd} with "avdmanager delete avd -n ${request.avd}". It removes the AVD definition and its data from disk.`
    case 'create':
      return `Create AVD ${request.avd} from the already installed system image ${request.installedSystemImage} and device profile ${request.deviceProfile} with "avdmanager create avd". Nothing is downloaded.`
  }
}

async function adbText(
  deps: EmulatorDeps,
  args: readonly string[],
): Promise<{ ok: true; text: string; exitCode: number | null } | { ok: false; outcome: OperationOutcome }> {
  const run = await runBounded(deps.services, {
    executable: deps.config.adbPath,
    args,
    cwd: deps.binding.root,
    mode: deps.binding.mode,
    workspaceRoot: deps.binding.workspaceRoot,
    ...(deps.binding.sessionId !== undefined ? { sessionId: deps.binding.sessionId } : {}),
    timeoutMs: deps.config.operationTimeoutMs,
    outputMaxBytes: deps.config.outputMaxBytes,
  }, deps.exec.signal)
  return mapEmulatorRun(run)
}

function mapEmulatorRun(run: BoundedRunOutcome): { ok: true; text: string; exitCode: number | null } | { ok: false; outcome: OperationOutcome } {
  if (!run.ok) {
    if (run.failure.kind === 'cancelled') return { ok: false, outcome: cancelled('emulator', 'not-needed') }
    return { ok: false, outcome: blocked('emulator', 'CAPABILITY_UNAVAILABLE', run.failure.message ?? 'execution unavailable') }
  }
  if (run.result.aborted || run.result.timedOut) {
    return {
      ok: false,
      outcome: run.result.aborted
        ? cancelled('emulator', run.result.cleanup === 'completed' ? 'completed' : 'failed')
        : failed('emulator', 'TIMEOUT', 'the emulator command did not finish before its deadline'),
    }
  }
  return { ok: true, text: run.result.stdout.text, exitCode: run.result.exitCode }
}

/** 近似睡眠，可被调用信号取消；不占用进程。 */
async function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(true) }, ms)
    const onAbort = () => { cleanup(); resolve(false) }
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export interface StartResult {
  readonly ownedResourceId: string
  readonly serial: string
  readonly avd: string
}

/**
 * 启动一个 AVD 并在 boot-ready 时把资源原子转移给调用方。
 * 失败、取消或未观测到实例时都在本调用内终止并等待。
 */
export async function startEmulator(
  deps: EmulatorDeps,
  request: EmulatorRequest,
  resources: ReturnType<typeof createOwnedResources>,
  adopt: (resource: OwnedResource) => void,
): Promise<{ ok: true; result: StartResult } | { ok: false; outcome: OperationOutcome }> {
  const avd = request.avd as string
  const before = await adbText(deps, ['devices'])
  if (!before.ok) return { ok: false, outcome: before.outcome }
  const beforeSerials = adbSerials(before.text)

  // 保留进程用独立 owner 控制器：调用取消只影响启动阶段。
  const ownerController = new AbortController()
  const startupController = new AbortController()
  const bridge = () => startupController.abort()
  deps.exec.signal.addEventListener('abort', bridge, { once: true })
  const startupTimeout = setTimeout(
    () => startupController.abort(),
    request.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
  )

  let handle: ReturnType<SubprocessLike['spawn']> | undefined
  let transferred = false
  // 清理只做一次：失败路径与 finally 都要用它，重复终止会让结论失真。
  let cleaned: 'completed' | 'failed' | undefined
  const cleanupOnce = async (): Promise<'completed' | 'failed'> => {
    if (cleaned !== undefined) return cleaned
    cleaned = handle === undefined ? 'completed' : await closeHandle(handle)
    return cleaned
  }
  try {
    try {
      handle = deps.services.subprocess.spawn({
        argv: [deps.config.emulatorPath, '-avd', avd],
        cwd: deps.binding.root,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', control: undefined },
        graceMs: 5000,
        signal: ownerController.signal,
      })
    } catch (error) {
      return { ok: false, outcome: blocked('emulator.start', 'CAPABILITY_UNAVAILABLE', error instanceof Error ? error.message : String(error)) }
    }

    const deadline = Date.now() + (request.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)
    let serial: string | undefined
    let booted = false
    // 失败不在这里 return：清理结论必须由 closeHandle 决定，不能丢掉。
    let probeFailure: OperationOutcome | undefined
    while (Date.now() < deadline) {
      if (startupController.signal.aborted) break
      const listed = await adbText(deps, ['devices'])
      if (!listed.ok) { probeFailure = listed.outcome; break }
      serial ??= newEmulatorSerial(beforeSerials, adbSerials(listed.text))
      if (serial) {
        const boot = await adbText(deps, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'])
        if (!boot.ok) { probeFailure = boot.outcome; break }
        if (boot.text.trim() === '1') { booted = true; break }
      }
      if (!(await delay(deps.config.bootPollIntervalMs ?? BOOT_POLL_INTERVAL_MS, startupController.signal))) break
    }

    if (probeFailure !== undefined || !booted || !serial || startupController.signal.aborted) {
      // 失败路径：终止并等待，清理结论如实并入结果（进程确实被启动过）。
      const cleanup = await cleanupOnce()
      if (probeFailure !== undefined) {
        return {
          ok: false,
          outcome: {
            ...probeFailure,
            action: 'emulator.start',
            cleanup,
            ...(cleanup === 'failed'
              ? { error: { code: 'CLEANUP_FAILED' as const, message: `emulator.start failed (${probeFailure.error?.message ?? probeFailure.status}) and the started process did not report exit` } }
              : {}),
          },
        }
      }
      const outcome = startupController.signal.aborted && !deps.exec.signal.aborted
        ? failed('emulator.start', 'TIMEOUT', `AVD ${avd} did not reach boot-complete before its deadline`)
        : deps.exec.signal.aborted
          ? cancelled('emulator.start', cleanup)
          : failed('emulator.start', 'EFFECT_UNKNOWN', `AVD ${avd} started but no boot-complete emulator serial was observed`)
      return {
        ok: false,
        outcome: cleanup === 'failed' && outcome.status !== 'cancelled'
          ? { ...outcome, cleanup: 'failed', error: { code: 'CLEANUP_FAILED', message: `${outcome.error?.message ?? 'start failed'}; the started process did not report exit` } }
          : { ...outcome, cleanup },
      }
    }

    // 转移：同一同步区段内撤掉启动桥、清掉启动计时器、登记所有权。
    deps.exec.signal.removeEventListener('abort', bridge)
    clearTimeout(startupTimeout)
    const resource: OwnedResource = {
      // 不透明 id：不泄漏 AVD 名/serial，也不能被调用方预测。
      id: `owned-${randomUUID()}`,
      ownerId: deps.exec.agent?.id ?? 'unknown',
      avd,
      serial,
      handle: { terminate: () => handle?.terminate(), waitForExit: (signal) => handle?.waitForExit(signal) ?? Promise.resolve(true) },
      ownerController,
    }
    try {
      adopt(resource)
    } catch (error) {
      const cleanup = await cleanupOnce()
      return {
        ok: false,
        outcome: blocked('emulator.start', 'CAPABILITY_UNAVAILABLE',
          `${error instanceof Error ? error.message : String(error)} (cleanup: ${cleanup})`),
      }
    }
    transferred = true
    return { ok: true, result: { ownedResourceId: resource.id, serial, avd } }
  } finally {
    deps.exec.signal.removeEventListener('abort', bridge)
    clearTimeout(startupTimeout)
    if (!transferred && handle !== undefined) {
      await cleanupOnce()
    }
  }
}

const closeHandle = (handle: { terminate(): void; waitForExit(signal?: AbortSignal): Promise<boolean> }) =>
  terminateBounded(handle, 30_000)

/** list / create / delete / external stop：都是有界的一次进程。 */
export async function runBoundedEmulatorAction(
  deps: EmulatorDeps,
  request: EmulatorRequest,
): Promise<OperationOutcome> {
  const run = (executable: string, args: readonly string[], action: string) =>
    runBounded(deps.services, {
      executable, args, cwd: deps.binding.root,
      mode: deps.binding.mode, workspaceRoot: deps.binding.workspaceRoot,
      ...(deps.binding.sessionId !== undefined ? { sessionId: deps.binding.sessionId } : {}),
      timeoutMs: deps.config.operationTimeoutMs, outputMaxBytes: deps.config.outputMaxBytes,
    }, deps.exec.signal).then((outcome) => ({ outcome, action }))

  if (request.action === 'list') {
    const { outcome: run1, action } = await run(deps.config.emulatorPath, ['-list-avds'], 'emulator.list')
    const mapped = mapEmulatorRun(run1)
    if (!mapped.ok) return mapped.outcome
    return outcome('succeeded', action, { evidence: parseAvdList(mapped.text).map((avd) => ({ kind: 'avd', source: avd })) })
  }
  if (request.action === 'delete' || request.action === 'create') {
    if (!deps.config.avdmanagerPath) {
      return blocked(`emulator.${request.action}`, 'CAPABILITY_UNAVAILABLE', 'avdmanager executable is not configured (avdmanagerPath)')
    }
    const args = request.action === 'delete'
      ? ['delete', 'avd', '-n', request.avd as string]
      : ['create', 'avd', '-n', request.avd as string, '-k', request.installedSystemImage as string, '--device', request.deviceProfile as string]
    const { outcome: run1, action } = await run(deps.config.avdmanagerPath, args, `emulator.${request.action}`)
    const mapped = mapEmulatorRun(run1)
    if (!mapped.ok) return mapped.outcome
    const ok = mapped.exitCode === 0
    return outcome(ok ? 'succeeded' : 'failed', action, {
      evidence: [{ kind: 'avd', source: request.avd as string }],
      ...(ok ? {} : { error: { code: 'CAPABILITY_UNAVAILABLE' as const, message: `avdmanager exited with ${mapped.exitCode}` } }),
    })
  }
  // external stop：不认所有权，只作用于明确 serial。
  const serial = request.serial as string
  const { outcome: run1, action } = await run(deps.config.adbPath, ['-s', serial, 'emu', 'kill'], 'emulator.stop')
  const mapped = mapEmulatorRun(run1)
  if (!mapped.ok) return mapped.outcome
  const ok = mapped.exitCode === 0
  return outcome(ok ? 'succeeded' : 'failed', action, {
    evidence: [{ kind: 'device', source: serial }],
    cleanup: 'not-needed',
    ...(ok ? {} : { error: { code: 'CAPABILITY_UNAVAILABLE' as const, message: `adb emu kill exited with ${mapped.exitCode}` } }),
  })
}
