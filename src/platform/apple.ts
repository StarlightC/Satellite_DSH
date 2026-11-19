/**
 * Apple (macOS) 宿主策略：本包当前唯一受支持的执行世界。
 *
 * 这里只放宿主侧路径/命令策略，不依赖 Cordis、不执行进程：
 * - 宿主侧绝对路径校验；
 * - 宿主侧 Gradle wrapper 文件名；
 * - 受限 stdin 解析器的 `env -i <runtime> … - <argv>` 命令组装与引用。
 */

import type { SupportedPlatform, SkillScriptInvocation } from './contracts.ts'

/** POSIX shell 引用：每个参数都作为单引号字符串；内层单引号用 `'\''` 闭合。 */
function quote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`
}

/** 组装受约束的解析器命令：stdin-v1 为 `env -i <runtime> … - <argv>`，path-entry 为 `env -i <runtime> … <script> <argv>`。 */
function skillScriptCommand(input: SkillScriptInvocation): string {
  if (!input.environmentExecutable) throw new Error('Apple parser invocation requires an environment executable')
  // Path-entry scripts are opened by path so their relative imports and file
  // identity survive. Python omits -I/-P here: isolated/no-safe-path mode would
  // drop the script directory from sys.path and break sibling imports.
  const entry = input.entryPath
    ? input.runtime === 'node' ? [input.entryPath] : ['-E', '-s', input.entryPath]
    : input.runtime === 'node' ? ['--input-type=module', '-'] : ['-I', '-']
  const invocation = [
    input.environmentExecutable,
    '-i',
    input.runtimeExecutable,
    ...entry,
    ...input.args,
  ]
  return invocation.map(quote).join(' ')
}

export function createApplePlatform(): SupportedPlatform {
  const platform: SupportedPlatform = {
    id: 'apple',
    supported: true,
    gradleWrapperName: 'gradlew',
    pathSeparator: '/',
    parserEnvironmentExecutableName: 'env',
    parserEnvironmentDescription: 'empty (env -i)',
    parserEnvironment: Object.freeze({ NODE_OPTIONS: '', PYTHONPATH: '', PYTHONSTARTUP: '' }),
    parserRuntimeName: (runtime) => runtime === 'node' ? 'node' : 'python3',
    gradleWrapperPath: (root) => `${root}${root.endsWith('/') ? '' : '/'}gradlew`,
    isAbsoluteHostPath: (path: string) => path.startsWith('/'),
    skillScriptCommand,
  }
  return Object.freeze(platform)
}
