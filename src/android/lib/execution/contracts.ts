/**
 * Android 本地执行路线的公共契约与失败词表。
 *
 * 纯定义/纯校验模块，不导入 Cordis：真实服务由工具注册处按调用作用域注入。
 * 这里固定的是"结果怎么说"和"参数怎么校验"，不含任何后端选择。
 */

/** 统一错误码；调用方按词表报告，不解析自然语言正文。 */
export const EXECUTION_ERROR_CODES = Object.freeze([
  'CAPABILITY_UNAVAILABLE',
  'TARGET_REQUIRED',
  'TARGET_AMBIGUOUS',
  'TARGET_CHANGED',
  'PATH_DENIED',
  'ARGUMENT_INVALID',
  'APPROVAL_REJECTED',
  'APPROVAL_UNAVAILABLE',
  'POLICY_CHANGED',
  'TIMEOUT',
  'CANCELLED',
  'CLEANUP_FAILED',
  'EFFECT_UNKNOWN',
] as const)

export type ExecutionErrorCode = (typeof EXECUTION_ERROR_CODES)[number]

export function isExecutionErrorCode(value: unknown): value is ExecutionErrorCode {
  return typeof value === 'string' && (EXECUTION_ERROR_CODES as readonly string[]).includes(value)
}

/** 一次有界操作的结果；字段语义与规格 §5.1 一致。 */
export type OperationStatus = 'succeeded' | 'failed' | 'cancelled' | 'blocked' | 'effect-unknown'
export type CleanupState = 'not-needed' | 'completed' | 'failed' | 'unknown' | 'retained-owned'

export interface OperationEvidence {
  readonly kind: string
  readonly source: string
  readonly digest?: string
}

export interface OperationOutcome {
  readonly status: OperationStatus
  readonly action: string
  readonly evidence: readonly OperationEvidence[]
  readonly cleanup: CleanupState
  readonly error?: { readonly code: ExecutionErrorCode; readonly message: string }
}

export function outcome(
  status: OperationStatus,
  action: string,
  extra: Partial<Pick<OperationOutcome, 'evidence' | 'cleanup' | 'error'>> = {},
): OperationOutcome {
  return Object.freeze({
    status,
    action,
    evidence: Object.freeze([...(extra.evidence ?? [])]),
    cleanup: extra.cleanup ?? 'not-needed',
    ...(extra.error ? { error: Object.freeze({ ...extra.error }) } : {}),
  })
}

export const blocked = (action: string, code: ExecutionErrorCode, message: string): OperationOutcome =>
  outcome('blocked', action, { error: { code, message } })

export const failed = (action: string, code: ExecutionErrorCode, message: string): OperationOutcome =>
  outcome('failed', action, { error: { code, message } })

export const cancelled = (action: string, cleanup: CleanupState = 'completed'): OperationOutcome =>
  outcome('cancelled', action, { cleanup })

export const effectUnknown = (action: string, code: ExecutionErrorCode, message: string): OperationOutcome =>
  outcome('effect-unknown', action, { cleanup: 'unknown', error: { code, message } })

/* ---------------------------------------------------------------- 参数校验 */

export class ArgumentError extends Error {
  readonly code: ExecutionErrorCode = 'ARGUMENT_INVALID'
  constructor(message: string) {
    super(message)
    this.name = 'ArgumentError'
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 未知字段一律拒绝：模型传来的多余字段不能被静默忽略。 */
export function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], where = 'arguments'): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key))
  if (extra.length > 0) throw new ArgumentError(`${where}: unknown field(s): ${extra.join(', ')}`)
}

export function requireRecord(value: unknown, where: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new ArgumentError(`${where} must be an object`)
  return value
}

/** 有界字符串：非空、无控制字符、不超过上限。 */
export function requireText(value: unknown, where: string, max = 2048): string {
  if (typeof value !== 'string') throw new ArgumentError(`${where} must be a string`)
  if (value.length === 0) throw new ArgumentError(`${where} must not be empty`)
  if (value.length > max) throw new ArgumentError(`${where} must be at most ${max} characters`)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new ArgumentError(`${where} must not contain control characters`)
  }
  return value
}

export function optionalText(value: unknown, where: string, max = 2048): string | undefined {
  if (value === undefined) return undefined
  return requireText(value, where, max)
}

export function requireBoolean(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') throw new ArgumentError(`${where} must be a boolean`)
  return value
}

export function requireInteger(value: unknown, where: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new ArgumentError(`${where} must be an integer`)
  if (value < min || value > max) throw new ArgumentError(`${where} must be between ${min} and ${max}`)
  return value
}

/** 项目内相对路径：不接受绝对路径、`.`/`..` 段、反斜杠或控制字符。 */
export function requireRelativePath(value: unknown, where: string, max = 1024): string {
  const text = requireText(value, where, max)
  if (text.startsWith('/') || /^[a-zA-Z]:/.test(text)) throw new ArgumentError(`${where} must be project-relative`)
  if (text.includes('\\')) throw new ArgumentError(`${where} must use forward slashes`)
  const segments = text.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new ArgumentError(`${where} must not contain empty, "." or ".." segments`)
  }
  return text
}

export function requireEnum<T extends string>(value: unknown, where: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ArgumentError(`${where} must be one of ${allowed.join('/')}`)
  }
  return value as T
}

/* ------------------------------------------------------- 调用作用域的服务 */

/** 只声明真正读取的部分；全部按调用方 Agent 的作用域取，不回落注册根。 */
export interface SandboxLike {
  confine(
    argv: readonly string[],
    policy: { mode: 'read-only' | 'workspace-write' | 'danger-full-access'; workspaceRoot: string; sessionId?: string },
    signal?: AbortSignal,
  ): Promise<{ argv: string[]; enforcement: 'full' | 'partial'; denialSignatures: readonly string[] }>
}

export interface PolicyLike {
  resolve(request: { session: unknown }): { mode?: string; workspaceRoot?: string; sessionId?: string } | undefined
}

export interface SubprocessLike {
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>
  terminalEnvironment(signal?: AbortSignal): Promise<{ platform: 'posix' | 'windows'; defaultShell?: string }>
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: { stdin: 'ignore' | 'pipe' | { data: string }; stdout: unknown; stderr: unknown; control?: 'pipe' }
    graceMs: number
    signal?: AbortSignal
    env?: Record<string, string | undefined>
  }): {
    readonly done: Promise<{ exitCode: number | null; signal: string | null }>
    terminate(): void
    waitForExit(signal?: AbortSignal): Promise<boolean>
    readonly collected: {
      readonly stdout?: { readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string } }
      readonly stderr?: { readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string } }
    }
  }
}

export interface ApprovalLike {
  request(request: {
    agent: unknown
    toolName: string
    callId?: string
    reason: string
    signal: AbortSignal
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

export interface ServiceScope {
  get(name: string): unknown
}

export interface ScopedExecution {
  readonly agent?: { readonly id: string; readonly session?: unknown; readonly ctx?: ServiceScope }
  readonly callId?: string
  readonly signal: AbortSignal
}

/**
 * 取本次调用真正使用的服务。
 * 调用方 Agent 有作用域时只在该作用域取：缺服务就是不可用，不回落到注册根。
 */
export function scopedServices(
  root: ServiceScope,
  exec: ScopedExecution,
  names: readonly string[],
): { ok: true; services: Record<string, unknown> } | { ok: false; code: ExecutionErrorCode; message: string } {
  const scope = exec.agent?.ctx ?? root
  const services: Record<string, unknown> = {}
  for (const name of names) {
    const value = typeof scope.get === 'function' ? scope.get(name) : undefined
    if (!value) return { ok: false, code: 'CAPABILITY_UNAVAILABLE', message: `required service unavailable: ${name}` }
    services[name] = value
  }
  return { ok: true, services }
}

export const SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'] as const)
export type SandboxMode = (typeof SANDBOX_MODES)[number]

export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === 'string' && (SANDBOX_MODES as readonly string[]).includes(value)
}

/** 读当前有效沙箱策略；读不到或形状非法一律不可用，不猜默认值。 */
export function resolvePolicy(
  policy: PolicyLike,
  session: unknown,
): { mode: SandboxMode; workspaceRoot: string; sessionId?: string } | undefined {
  let resolved: { mode?: string; workspaceRoot?: string; sessionId?: string } | undefined
  try {
    resolved = policy.resolve({ session })
  } catch {
    return undefined
  }
  if (!resolved || !isSandboxMode(resolved.mode)) return undefined
  if (typeof resolved.workspaceRoot !== 'string' || resolved.workspaceRoot.length === 0) return undefined
  return {
    mode: resolved.mode,
    workspaceRoot: resolved.workspaceRoot,
    ...(typeof resolved.sessionId === 'string' ? { sessionId: resolved.sessionId } : {}),
  }
}

/** 同一策略的身份比较：批准前后必须逐字段一致。 */
export function policyKey(policy: { mode: string; workspaceRoot: string; sessionId?: string }): string {
  return JSON.stringify([policy.mode, policy.workspaceRoot, policy.sessionId ?? null])
}
