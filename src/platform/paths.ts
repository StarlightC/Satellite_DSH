/**
 * Pure host-path syntax used by platform-independent/static inputs.
 * Recognising Windows syntax does not enable Windows execution; dynamic execution
 * still requires a supported adapter and canonical filesystem containment.
 */
import { posix, win32 } from 'node:path'

export function isAbsoluteHostPathSyntax(path: string): boolean {
  return posix.isAbsolute(path) || win32.isAbsolute(path)
}
