/**
 * Windows 宿主：明确未实现，不提供任何回落。
 */

import type { UnsupportedPlatform } from './contracts.ts'

export const WINDOWS_UNSUPPORTED_REASON =
  'Windows host execution is not implemented; only the Apple (macOS) host route is supported'

export function windowsPlatform(): UnsupportedPlatform {
  const platform: UnsupportedPlatform = {
    id: 'windows',
    supported: false,
    unsupportedReason: WINDOWS_UNSUPPORTED_REASON,
  }
  return Object.freeze(platform)
}
