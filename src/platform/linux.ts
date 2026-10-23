/**
 * Linux 宿主：明确未实现，不提供任何回落。
 */

import type { UnsupportedPlatform } from './contracts.ts'

export const LINUX_UNSUPPORTED_REASON =
  'Linux host execution is not implemented; only the Apple (macOS) host route is supported'

export function linuxPlatform(): UnsupportedPlatform {
  const platform: UnsupportedPlatform = {
    id: 'linux',
    supported: false,
    unsupportedReason: LINUX_UNSUPPORTED_REASON,
  }
  return Object.freeze(platform)
}
