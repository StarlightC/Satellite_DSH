/**
 * Android 领域组件：只读专项扩展、方法技能，以及**显式启用后**才注册的本地执行工具。
 *
 * - 扩展注册跟随插槽声明（core 的节点行先声明时立即注册，后声明时由服务回调补齐）。
 * - 技能由本入口自己注册；公共入口不读领域技能文件，也不会因缺少领域技能而整体失效。
 * - 执行工具默认关闭：启用领域行只带来只读扩展；本地执行是第二次显式选择。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import type { SlotExtension } from '../lib/contracts.js'
import { loadSkill, resourceDirFrom } from '../lib/skills.js'
import type { BundledSkill } from '../lib/skills.js'
import { createAndroidValidationContext } from './lib/extension.js'
import { ANDROID_SKILL_NAMES, createAndroidNodeExtensions } from './lib/node-extensions.js'
import { createSlotRegistration } from './lib/registration.js'
import {
  DEFAULT_OPERATION_TIMEOUT_MS, DEFAULT_OUTPUT_MAX_BYTES, registerAndroidExecutionTools,
} from './lib/execution/tools.js'
import type { AndroidExecutionConfig, AndroidToolContext } from './lib/execution/tools.js'
import { readLiveConfigValue } from '../node/lib/config.js'
import { registerReuseMaintenance } from '../node/lib/reuse-tools.js'
import type { ReuseToolContext } from '../node/lib/reuse-tools.js'
import { extractAndroidReuseSource, ANDROID_REUSE_SOURCE_REVISION } from './lib/reuse-source.js'

// `tools` 必须是**声明的**依赖：Cordis 只在 inject 里声明过的服务才安装成
// `ctx.tools` 属性；只用 ctx.get('tools') 取到的服务不能当属性用，
// 而注册函数内部读的是 `ctx.tools.register`。漏声明时 apply 不报错、
// 注册在 effect 里被静默丢弃（实测过一次，工具全缺）。
export const inject = ['satelliteSlots', 'tools']

/**
 * 声明式默认值归代码：默认不启用本地执行，也不猜 Android CLI 路径。
 * profile 只保存用户自己的覆盖；未配置 CLI 时 discover-build 明确报告"未配置"，
 * 不自动发现、不自动安装。
 */
export const Config = z.object({
  execution: z.object({
    enabled: z.boolean().default(false),
    androidCli: z.string(),
    privacy: z.string(),
    javaHome: z.string(),
    adbPath: z.string(),
    emulatorPath: z.string(),
    avdmanagerPath: z.string(),
    serverEndpoint: z.string(),
    bootPollIntervalMs: z.number(),
    operationTimeoutMs: z.number().default(DEFAULT_OPERATION_TIMEOUT_MS),
    outputMaxBytes: z.number().default(DEFAULT_OUTPUT_MAX_BYTES),
  }).default({
    enabled: false,
    operationTimeoutMs: DEFAULT_OPERATION_TIMEOUT_MS,
    outputMaxBytes: DEFAULT_OUTPUT_MAX_BYTES,
  })
    // volatile：设置页可以读写这组机器相关路径，且保存后**无需重启**（每次调用读取）。
    .volatile(),
})

const SKILL_NAMES = ANDROID_SKILL_NAMES

/** 把用户配置收窄成执行工具真正接受的形状；非法值不猜，按"未配置"处理。 */
export function resolveExecutionConfig(raw: unknown): AndroidExecutionConfig {
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const execution = record(record(raw).execution)
  const privacy = execution.privacy
  const bounded = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? Math.floor(value) : fallback
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined
  return {
    enabled: execution.enabled === true,
    ...(text(execution.androidCli) ? { androidCli: text(execution.androidCli) as string } : {}),
    ...(privacy === 'verified-disabled' || privacy === 'explicit-user-opt-in' ? { privacy } : {}),
    ...(text(execution.javaHome) ? { javaHome: text(execution.javaHome) as string } : {}),
    ...(text(execution.adbPath) ? { adbPath: text(execution.adbPath) as string } : {}),
    ...(text(execution.emulatorPath) ? { emulatorPath: text(execution.emulatorPath) as string } : {}),
    ...(text(execution.avdmanagerPath) ? { avdmanagerPath: text(execution.avdmanagerPath) as string } : {}),
    ...(text(execution.serverEndpoint) ? { serverEndpoint: text(execution.serverEndpoint) as string } : {}),
    ...(typeof execution.bootPollIntervalMs === 'number' && Number.isFinite(execution.bootPollIntervalMs)
      ? { bootPollIntervalMs: bounded(execution.bootPollIntervalMs, 2000, 10, 10_000) }
      : {}),
    operationTimeoutMs: bounded(execution.operationTimeoutMs, DEFAULT_OPERATION_TIMEOUT_MS, 1000, 60 * 60 * 1000),
    outputMaxBytes: bounded(execution.outputMaxBytes, DEFAULT_OUTPUT_MAX_BYTES, 1024, 4 * 1024 * 1024),
  }
}


/** 插槽服务在本入口里用到的部分。 */
interface SlotsApi {
  hasSlot(name: string): boolean
  register(extension: SlotExtension): () => void
  onSlotsChanged(listener: () => void): () => void
}

/** `ctx.inject(['skills'], ...)` 传入的子上下文。 */
interface SkillContext {
  readonly skills: { register(skill: BundledSkill): () => void }
  effect(fn: () => void | (() => void)): unknown
}

/**
 * 本入口使用的 Cordis 上下文能力。DSH 的原生服务由各自的原生包声明合并到 `Context`，
 * 这里只声明真正读取的部分，入口处收窄一次。
 */
interface AndroidContext {
  readonly satelliteSlots: SlotsApi
  effect(fn: () => void | (() => void)): unknown
  inject(deps: readonly string[], callback: (ctx: SkillContext) => void): unknown
}

export function apply(ctx: Context, config?: unknown): void {
  // 执行配置是 volatile 设置：按每次调用读取，设置页保存后无需重启。
  // 注意形状：resolveExecutionConfig 读的是外层 { execution }。
  const rawConfig = (config && typeof config === 'object' ? config : {}) as Record<string, unknown>
  const getExecutionConfig = () => resolveExecutionConfig({ execution: readLiveConfigValue(rawConfig.execution, undefined) })

  // `tools` 已由 inject 声明，`ctx.tools` 是受跟踪属性。
  const toolCtx = ctx as unknown as ReuseToolContext & AndroidToolContext
  const report = (error: unknown): void => {
    const logger = ctx.get('logger') as { error?: (message: string) => void } | undefined
    logger?.error?.(`satellite/android: tool registration failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
  try {
    registerReuseMaintenance(toolCtx, {
      revision: ANDROID_REUSE_SOURCE_REVISION, extract: extractAndroidReuseSource,
    })
    ctx.effect(() => registerAndroidExecutionTools(toolCtx, getExecutionConfig))
  } catch (error) {
    // 不再静默：注册失败要能在宿主日志里看到，而不是"行 active、工具全缺"。
    report(error)
    throw error
  }

  const scoped = ctx as unknown as AndroidContext
  const slots = scoped.satelliteSlots
  // 只读专项扩展共享同一只读角色，按各自声明的插槽与 required 开关触发；
  // 静态上下文扩展保持原有三态行为，不在本单元改动。
  const registration = createSlotRegistration({
    slots,
    extensions: [createAndroidValidationContext(), ...createAndroidNodeExtensions()],
  })

  scoped.effect(() => {
    registration.sync()
    const off = slots.onSlotsChanged(() => registration.sync())
    return () => {
      if (typeof off === 'function') off()
      registration.dispose()
    }
  })

  // 技能表是可选的：没有它时扩展仍可注册，调用时会因技能不可见而明确阻塞。
  scoped.inject(['skills'], (skillCtx) => {
    for (const name of SKILL_NAMES) {
      let skill: BundledSkill
      try {
        // 构建后入口在 lib/android/，资源仍在包根的 android/（locale/icon/skills 不参与构建）。
        skill = loadSkill(resourceDirFrom(import.meta.url, 'android'), name)
      } catch {
        // 单个技能缺失只影响使用它的专项，不能让整个领域行失效。
        continue
      }
      skillCtx.effect(() => skillCtx.skills.register(skill))
    }
  })
}
