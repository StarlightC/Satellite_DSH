/** Structural host contracts shared by bounded argv execution. No global service lookup. */
export interface SandboxLike {
  confine(
    argv: readonly string[],
    policy: { mode: 'read-only' | 'workspace-write' | 'danger-full-access'; workspaceRoot: string; sessionId?: string },
    signal?: AbortSignal,
  ): Promise<{ argv: string[]; enforcement: 'full' | 'partial'; denialSignatures: readonly string[] }>
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

