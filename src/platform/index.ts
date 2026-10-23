/**
 * Execution-world selection, not authorization or world-identity attestation.
 * The terminal family alone cannot distinguish macOS from Linux. Use the caller's
 * filesystem for positive markers; denied/unavailable probes are not absence.
 * No process is started and unsupported/unknown worlds never fall back to Apple.
 */
import type { HostPlatform, PlatformFs, TerminalEnvironmentLike, UnsupportedPlatform } from './contracts.ts'
import { createApplePlatform } from './apple.ts'
import { linuxPlatform } from './linux.ts'
import { windowsPlatform } from './windows.ts'

export * from './contracts.ts'
export { isAbsoluteHostPathSyntax } from './paths.ts'
export { createApplePlatform } from './apple.ts'
export { linuxPlatform, LINUX_UNSUPPORTED_REASON } from './linux.ts'
export { windowsPlatform, WINDOWS_UNSUPPORTED_REASON } from './windows.ts'

const APPLE_MARKERS = ['/System/Library/CoreServices/SystemVersion.plist', '/usr/bin/sw_vers'] as const
const LINUX_MARKERS = ['/etc/os-release', '/proc/version'] as const

type Marker = 'present' | 'missing' | 'unavailable'
function probeError(error: unknown, signal: AbortSignal): Marker {
  signal.throwIfAborted()
  if (error instanceof Error && error.name === 'AbortError') throw error
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unavailable'
}

async function markerPresent(fs: PlatformFs, path: string, signal: AbortSignal): Promise<Marker> {
  signal.throwIfAborted()
  try {
    const target = await fs.resolve(path, { signal })
    signal.throwIfAborted()
    const info = await fs.stat(target, signal)
    signal.throwIfAborted()
    return info === undefined ? 'missing' : info.type === 'file' ? 'present' : 'unavailable'
  } catch (error) {
    return probeError(error, signal)
  }
}

function unknownPlatform(reason: string): UnsupportedPlatform {
  return Object.freeze({ id: 'unknown', supported: false, unsupportedReason: reason })
}

export interface DetectHostPlatformParams {
  readonly fs: PlatformFs
  terminalEnvironment(signal: AbortSignal): Promise<TerminalEnvironmentLike>
  readonly signal: AbortSignal
}

export async function detectHostPlatform(params: DetectHostPlatformParams): Promise<HostPlatform> {
  const { fs, signal } = params
  signal.throwIfAborted()
  const terminal = await params.terminalEnvironment(signal)
  signal.throwIfAborted()
  if (terminal.platform === 'windows') return windowsPlatform()
  if (terminal.platform !== 'posix') return unknownPlatform('unknown terminal family; refusing to guess')

  const apple = await Promise.all(APPLE_MARKERS.map(path => markerPresent(fs, path, signal)))
  const linux = await Promise.all(LINUX_MARKERS.map(path => markerPresent(fs, path, signal)))
  signal.throwIfAborted()
  if ([...apple, ...linux].includes('unavailable')) {
    return unknownPlatform('host marker probe unavailable or invalid; refusing to infer absence')
  }
  const applePresent = apple.every(marker => marker === 'present')
  const linuxPresent = linux.some(marker => marker === 'present')
  if (applePresent && linuxPresent) return unknownPlatform('host markers conflict (Apple and Linux markers both present); refusing to guess')
  if (applePresent) return createApplePlatform()
  if (linuxPresent) return linuxPlatform()
  return unknownPlatform('no supported host marker matched; only the Apple (macOS) host route is supported')
}
