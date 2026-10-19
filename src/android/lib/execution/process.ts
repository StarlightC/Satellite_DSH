/**
 * 有界的受限进程执行：解析可执行文件 → 原生 confinement → 受管 spawn → 限额/取消。
 *
 * 与受控技能脚本共用同一套原生能力（`ctx.sandbox` / `ctx.subprocess`），但直接传 argv：
 * Android 工具的参数是结构化的，不再经过 shell 字符串拼接。
 *
 * 不变量：
 * - confinement 不是 `full` 就不执行；不把"部分强制"当成完整边界；
 * - spawn 前重读有效策略，策略在批准后变化即拒绝；
 * - 取消/超时都走 terminate + 有界 waitForExit，输出独立限额并显式标注截断；
 * - 不向调用方返回 spill 路径（本工具的返回只带自己的有界文本）。
 */

import type { SandboxLike, SubprocessLike } from './contracts.ts'

export interface BoundedRunRequest {
  /** 已解析的可执行文件（绝对路径）。 */
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly workspaceRoot: string
  readonly sessionId?: string
  readonly timeoutMs: number
  readonly outputMaxBytes: number
  readonly env?: Record<string, string | undefined>
  readonly stdin?: string
  /** 终止后的宽限期，默认 2000ms。 */
  readonly graceMs?: number
  /** 资源成功转移后由调用方接管时使用：独立 owner 控制器。 */
  readonly ownerSignal?: AbortSignal
}

export interface BoundedRunResult {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly stdout: { readonly text: string; readonly truncated: boolean }
  readonly stderr: { readonly text: string; readonly truncated: boolean }
  readonly enforcement: 'full'
  readonly cleanup: 'completed' | 'failed'
  /** 本次调用在宿主批准下未受文件围栏约束（danger-full-access）。 */
  readonly unconfined?: boolean
  /** 进程没有按契约收敛时的原始说明；调用方据此判定效果是否已知。 */
  readonly failureDetail?: string
}

export const DEFAULT_GRACE_MS = 2000
/** 清理阶段的硬上限：不允许用没有截止时间的清理挂住卸载。 */
export const CLEANUP_TIMEOUT_MS = 30_000

export type BoundedRunFailure =
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'cancelled' }

export type BoundedRunOutcome =
  | { readonly ok: true; readonly result: BoundedRunResult }
  | { readonly ok: false; readonly failure: BoundedRunFailure }

/** 只读取收集模式的前 N 字节，按原始字节截断而不是先解码再截断。 */
function collect(reader: { readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean } } | undefined, maxBytes: number): { text: string; truncated: boolean } {
  if (!reader) return { text: '', truncated: false }
  const read = reader.readFrom(0)
  const bytes = Buffer.from(read.text, 'utf8')
  if (bytes.byteLength <= maxBytes) return { text: read.text, truncated: read.lossy }
  return { text: bytes.subarray(0, maxBytes).toString('utf8'), truncated: true }
}

/** 合并调用信号、期限与 owner 控制器；三者都由调用方拥有生命周期。 */
function linkSignals(parent: AbortSignal, timeoutMs: number, owner?: AbortSignal): {
  signal: AbortSignal
  timedOut: () => boolean
  aborted: () => boolean
  dispose: () => void
} {
  const controller = new AbortController()
  let timeoutHit = false
  const timer = setTimeout(() => {
    timeoutHit = true
    controller.abort()
  }, timeoutMs)
  const onParent = () => controller.abort()
  const onOwner = () => controller.abort()
  parent.addEventListener('abort', onParent, { once: true })
  owner?.addEventListener('abort', onOwner, { once: true })
  if (parent.aborted || owner?.aborted) controller.abort()
  return {
    signal: controller.signal,
    timedOut: () => timeoutHit,
    aborted: () => parent.aborted || owner?.aborted === true,
    dispose: () => {
      clearTimeout(timer)
      parent.removeEventListener('abort', onParent)
      owner?.removeEventListener('abort', onOwner)
    },
  }
}

/**
 * 执行一次有界命令。
 * `sandbox`/`subprocess` 由调用方从其作用域取得，本函数不访问全局。
 */
export async function runBounded(
  services: { readonly sandbox: SandboxLike; readonly subprocess: SubprocessLike },
  request: BoundedRunRequest,
  signal: AbortSignal,
): Promise<BoundedRunOutcome> {
  if (signal.aborted) return { ok: false, failure: { kind: 'cancelled' } }
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1) {
    return { ok: false, failure: { kind: 'unavailable', message: 'invalid timeout' } }
  }
  if (!Number.isInteger(request.outputMaxBytes) || request.outputMaxBytes < 1) {
    return { ok: false, failure: { kind: 'unavailable', message: 'invalid output limit' } }
  }

  // danger-full-access 只允许在**逐次获得宿主批准**后使用（调用方负责），
  // 且沙箱服务的 confine 不接受这个模式（ConfinedSandboxMode 排除它）：
  // 这里直接放行 argv，并在结果里标出 unconfined，让上层如实记录。
  const unconfined = request.mode === 'danger-full-access'
  let confined: Awaited<ReturnType<SandboxLike['confine']>>
  try {
    confined = unconfined
      ? { argv: [request.executable, ...request.args], enforcement: 'full' as const, denialSignatures: [] }
      : await services.sandbox.confine(
        [request.executable, ...request.args],
        {
          mode: request.mode,
          workspaceRoot: request.workspaceRoot,
          ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
        },
        signal,
      )
  } catch (error) {
    return { ok: false, failure: { kind: 'unavailable', message: error instanceof Error ? error.message : String(error) } }
  }
  signal.throwIfAborted()
  if (!confined || !Array.isArray(confined.argv) || confined.argv.length === 0) {
    return { ok: false, failure: { kind: 'unavailable', message: 'sandbox confinement returned no argv' } }
  }
  // 部分强制不等于边界：调用方必须在批准前就核对，这里再挡一层。
  if (confined.enforcement !== 'full') {
    return { ok: false, failure: { kind: 'unavailable', message: `sandbox confinement is ${confined.enforcement}, refusing to run` } }
  }

  const linked = linkSignals(signal, request.timeoutMs, request.ownerSignal)
  let execution: ReturnType<SubprocessLike['spawn']> | undefined
  let cleanup: 'completed' | 'failed' = 'completed'
  try {
    try {
      execution = services.subprocess.spawn({
        argv: confined.argv,
        cwd: request.cwd,
        stdio: {
          stdin: request.stdin === undefined ? 'ignore' : { data: request.stdin },
          stdout: { maxBytes: request.outputMaxBytes },
          stderr: { maxBytes: request.outputMaxBytes },
        },
        graceMs: request.graceMs ?? DEFAULT_GRACE_MS,
        signal: linked.signal,
        ...(request.env !== undefined ? { env: request.env } : {}),
      })
    } catch (error) {
      return { ok: false, failure: { kind: 'unavailable', message: error instanceof Error ? error.message : String(error) } }
    }

    // 看门狗：provider 不守 signal 时不能让调用永久挂起。
    // 中止/超时后留一段宽限期，仍未结束就强制终止并如实报告。
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const aborted = new Promise<'aborted'>((resolve) => {
      const onAbort = () => {
        watchdog = setTimeout(() => resolve('aborted'), Math.min((request.graceMs ?? DEFAULT_GRACE_MS) + 250, 5000))
      }
      if (linked.signal.aborted) onAbort()
      else linked.signal.addEventListener('abort', onAbort, { once: true })
    })

    let settled: { exitCode: number | null; signal: string | null } | undefined
    let doneError: unknown
    const raced = await Promise.race([
      execution.done.then((value) => ({ kind: 'settled' as const, value })).catch((error) => ({ kind: 'failed' as const, error })),
      aborted.then(() => ({ kind: 'watchdog' as const })),
    ])
    if (raced.kind === 'settled') settled = raced.value
    else if (raced.kind === 'failed') doneError = raced.error

    const timedOut = linked.timedOut()
    const wasAborted = linked.aborted()
    if (settled === undefined) {
      // 进程没有按 provider 契约结束：必须终止并等待，清理结论照实写。
      cleanup = await terminate(execution)
      if (raced.kind === 'failed') {
        // provider 报了错但句柄已收敛：按超时/取消分类，让调用方得到 effect-unknown 而不是"可重试的不可用"。
        return {
          ok: true,
          result: {
            exitCode: null, signal: null, timedOut, aborted: wasAborted,
            stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false },
            enforcement: 'full', cleanup,
            failureDetail: doneError instanceof Error ? doneError.message : String(doneError),
          },
        }
      }
      return {
        ok: true,
        result: {
          exitCode: null, signal: null, timedOut: timedOut || !wasAborted, aborted: wasAborted,
          stdout: collect(execution.collected.stdout, request.outputMaxBytes),
          stderr: collect(execution.collected.stderr, request.outputMaxBytes),
          enforcement: 'full', cleanup,
          failureDetail: 'the provider did not report process exit after cancellation',
        },
      }
    }
    clearTimeout(watchdog)
    if (timedOut || wasAborted) {
      // done 只说明 provider 报了退出事实；取消/超时路径仍按契约做一次
      // 幂等的 terminate + 有界 waitForExit，用真实静默结果决定清理结论。
      cleanup = await terminate(execution)
    }
    return {
      ok: true,
      result: {
        exitCode: settled.exitCode,
        signal: settled.signal,
        timedOut,
        aborted: wasAborted,
        stdout: collect(execution.collected.stdout, request.outputMaxBytes),
        stderr: collect(execution.collected.stderr, request.outputMaxBytes),
        enforcement: 'full',
        cleanup,
        ...(unconfined ? { unconfined: true } : {}),
      },
    }
  } finally {
    linked.dispose()
  }
}

/**
 * 终止并等待退出；超过清理上限算清理失败。
 *
 * 必须自己带硬截止：`waitForExit` 是 provider 的承诺，不守承诺时
 * 无限 await 会把插件卸载挂死。这里用 race 保证一定返回。
 */
export async function terminateBounded(
  handle: { terminate(): void; waitForExit(signal?: AbortSignal): Promise<boolean> },
  timeoutMs = CLEANUP_TIMEOUT_MS,
): Promise<'completed' | 'failed'> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve('timeout')
    }, timeoutMs)
  })
  try {
    handle.terminate()
    const exited = Promise.resolve()
      .then(() => handle.waitForExit(controller.signal))
      .then((value) => (value ? ('completed' as const) : ('failed' as const)))
      .catch(() => 'failed' as const)
    const raced = await Promise.race([exited, deadline])
    return raced === 'timeout' ? 'failed' : raced
  } catch {
    return 'failed'
  } finally {
    clearTimeout(timer)
  }
}

const terminate = (execution: ReturnType<SubprocessLike['spawn']>) => terminateBounded(execution)
