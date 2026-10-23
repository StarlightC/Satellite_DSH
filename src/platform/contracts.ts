/**
 * 宿主执行世界的平台契约。
 *
 * 平台检测**不是授权**：它只回答"本次调用作用域的宿主是哪个世界"，不证明任何
 * 世界身份，也不引入认证。检测只用调用作用域的 `fs` 正向系统标记与
 * `terminalEnvironment`，从不读宿主的 `process.platform` 去猜远程执行世界。
 */

export type HostPlatformId = 'apple' | 'linux' | 'windows' | 'unknown'

/** 解析器 stdin-v1 的组装输入：可执行文件必须已经解析为宿主侧绝对路径。 */
export interface SkillScriptInvocation {
  readonly environmentExecutable?: string
  readonly runtimeExecutable: string
  readonly runtime: 'node' | 'python'
  readonly args: readonly string[]
}

/** 消费者只依赖能力契约；增加平台无需将调用链中的 Apple 类型逐个替换。 */
export interface SupportedPlatform {
  readonly id: Exclude<HostPlatformId, 'unknown'>
  readonly supported: true
  readonly gradleWrapperName: string
  readonly pathSeparator: string
  readonly parserEnvironmentExecutableName?: string
  readonly parserEnvironmentDescription: string
  readonly parserEnvironment: Readonly<Record<string, string>>
  parserRuntimeName(runtime: SkillScriptInvocation['runtime']): string
  gradleWrapperPath(root: string): string
  /** 解析出的可执行文件必须是宿主侧绝对路径。 */
  isAbsoluteHostPath(path: string): boolean
  /** 构造本平台的受限 stdin 解析器命令；批准和执行仍由消费者负责。 */
  skillScriptCommand(input: SkillScriptInvocation): string
}

/** 未实现或无法判定的宿主：一律失败关闭，不回落。 */
export interface UnsupportedPlatform {
  readonly id: HostPlatformId
  readonly supported: false
  readonly unsupportedReason: string
}

export type HostPlatform = SupportedPlatform | UnsupportedPlatform

/** 平台检测需要的最小 fs 面（调用作用域）。 */
export interface PlatformFs {
  resolve(path: string, options: { signal: AbortSignal }): Promise<unknown>
  stat(target: unknown, signal: AbortSignal): Promise<{ type: string } | undefined>
}

export interface TerminalEnvironmentLike {
  readonly platform: 'posix' | 'windows'
}
