/**
 * 扩展注册跟随插槽声明，而不是依赖插件装配顺序。
 *
 * 领域组件只声明它使用哪个公开插槽：插槽出现时注册，插槽撤销时一并撤销。
 * 与 Cordis 的 `satellite/slots-changed` 事件配合，`sync()` 是幂等的。
 */

import type { SlotExtension } from '../../lib/contracts.js'

/** 插槽服务在本模块里用到的部分。 */
export interface SlotRegistrar {
  hasSlot(name: string): boolean
  register(extension: SlotExtension): () => void
}

export interface SlotRegistration {
  sync(): void
  dispose(): void
  readonly registered: boolean
}

export function createSlotRegistration(params: {
  slots: SlotRegistrar
  /** 单个扩展（保留原有调用形态）。 */
  extension?: SlotExtension
  /** 同一组件要注册的多个扩展：各自跟随自己的插槽声明。 */
  extensions?: readonly SlotExtension[]
}): SlotRegistration {
  const { slots } = params
  const wanted = params.extensions ?? (params.extension ? [params.extension] : [])
  if (wanted.length === 0) throw new TypeError('createSlotRegistration requires at least one extension')
  const disposers = new Map<string, () => void>()

  return {
    sync() {
      for (const extension of wanted) {
        const declared = slots.hasSlot(extension.slot)
        const dispose = disposers.get(extension.id)
        if (declared && !dispose) {
          disposers.set(extension.id, slots.register(extension))
        } else if (!declared && dispose) {
          dispose()
          disposers.delete(extension.id)
        }
      }
    },
    dispose() {
      for (const dispose of [...disposers.values()].reverse()) dispose()
      disposers.clear()
    },
    get registered() {
      return disposers.size > 0
    },
  }
}
