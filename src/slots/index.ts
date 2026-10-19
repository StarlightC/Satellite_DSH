/**
 * `satelliteSlots`：本项目自有的 Cordis 服务。
 *
 * 只做三件事：声明稳定节点插槽、注册扩展定义、解析当前槽的候选与顺序。
 * 它不调度 Agent、不持有任务图，也不保存角色运行历史。
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

import { createNodeCatalog } from '../lib/contracts.js'
import type { NodeCatalog, SlotDefinition, SlotExtension, SlotFacts } from '../lib/contracts.js'
import { createNotifier } from '../lib/notify.js'
import type { Notifier } from '../lib/notify.js'
import { createSlotRegistry } from '../lib/registry.js'
import type { Resolution, SlotRegistry } from '../lib/registry.js'

export class SatelliteSlots extends Service {
  readonly catalog: NodeCatalog
  readonly registry: SlotRegistry
  readonly slotNotifier: Notifier

  constructor(ctx: Context, _config: unknown = {}) {
    super(ctx, 'satelliteSlots')
    this.catalog = createNodeCatalog()
    this.registry = createSlotRegistry(this.catalog)
    this.slotNotifier = createNotifier()
  }

  /** 订阅插槽声明变化；返回退订函数。领域组件据此跟随声明，不依赖装配顺序。 */
  onSlotsChanged(listener: () => void): () => void {
    return this.slotNotifier.subscribe(listener)
  }

  notifySlotsChanged(): void {
    this.slotNotifier.notify()
  }

  /** 声明一个基础节点的稳定插槽；返回撤销函数。 */
  defineNode(
    nodeId: string,
    options?: { version?: number; phases?: readonly ('before' | 'after')[] },
  ): () => void {
    const remove = this.catalog.defineNode(nodeId, options)
    this.slotNotifier.notify()
    return () => {
      remove()
      this.slotNotifier.notify()
    }
  }

  /** 注册扩展定义；返回撤销函数。非法定义抛错。 */
  register(extension: SlotExtension): () => void {
    return this.registry.register(extension)
  }

  /** 解析某个插槽当前适用的扩展、顺序与冲突。 */
  resolve(
    slot: string,
    facts: SlotFacts,
    view: unknown,
    definitions?: readonly SlotExtension[],
  ): Resolution {
    return this.registry.resolve(slot, facts, view, definitions)
  }

  /** 取定义快照；一次节点调用开始时固定，运行中新增的扩展不插入本次调用。 */
  snapshot(): readonly SlotExtension[] {
    return this.registry.snapshot()
  }

  hasSlot(name: string): boolean {
    return this.catalog.has(name)
  }

  listSlots(): readonly SlotDefinition[] {
    return this.catalog.list()
  }
}

export default SatelliteSlots
