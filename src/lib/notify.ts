/**
 * 极小的订阅集合：插槽声明变化时通知领域组件。
 *
 * 不属于 Cordis 事件总线：插槽服务是唯一发布者，订阅者作用域无关，
 * 因此用服务自身的回调即可，避免依赖事件的冒泡范围。
 */

export interface Notifier {
  /** 订阅；返回退订函数。 */
  subscribe(listener: () => void): () => void
  /** 通知全部订阅者；单个订阅者抛错不影响其他订阅者与发布者本身。 */
  notify(): void
  readonly size: number
}

export function createNotifier(): Notifier {
  const listeners = new Set<() => void>()
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    notify() {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          // 单个订阅者失败不影响其他订阅者与发布者本身。
        }
      }
    },
    get size() {
      return listeners.size
    },
  }
}
