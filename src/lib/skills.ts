/**
 * 包内技能加载：从 `skills/<name>/SKILL.md` 读取并转成 `ctx.skills.register` 的输入。
 *
 * 不解析 YAML：只支持本项目自有的简单 frontmatter，避免为一个文件引入依赖。
 *
 * 路径推导是构建后最容易出错的一处：源码在 `src/<组件>/`，入口构建到 `lib/<组件>/`，
 * 而 `locale/`、`icon.svg`、`skills/` 等资源**不参与构建**、留在包内原位的 `<组件>/`。
 * 因此资源目录不能再取入口文件所在目录，必须从包根推导。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 一个技能文件的 frontmatter 与正文。 */
export interface ParsedSkillFile {
  readonly meta: Readonly<Record<string, string>>
  readonly content: string
}

/** `ctx.skills.register` 接受的包内技能形态。 */
export interface BundledSkill {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly content: string
  readonly path: string
  readonly source: 'bundled'
  readonly resourceBase: { readonly kind: 'directory'; readonly path: string }
}

/**
 * 包根目录 = 从当前模块位置向上最近的、含 `package.json` 的目录。
 *
 * 构建后入口位于 `<包根>/lib/...`，安装后位于 profile 的 `node_modules/<包名>/lib/...`；
 * 两种情况下向上找到的都是本包自己的 `package.json`。
 */
export function packageRootFrom(importMetaUrl: string): string {
  let directory = dirname(fileURLToPath(importMetaUrl))
  for (;;) {
    if (existsSync(join(directory, 'package.json'))) return directory
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`package root not found from ${importMetaUrl}`)
    directory = parent
  }
}

/**
 * 某个入口的资源目录。
 *
 * 源码资源在 `<包根>/<component>/`（`component` 例如 `node`、`android`），
 * 构建产物在 `<包根>/lib/<component>/`；两者通过包根对应起来。
 */
export function resourceDirFrom(importMetaUrl: string, component: string): string {
  return join(packageRootFrom(importMetaUrl), component)
}

export function parseSkillFile(path: string): ParsedSkillFile {
  const raw = readFileSync(path, 'utf8')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw)
  const meta: Record<string, string> = {}
  if (match) {
    for (const line of match[1].split('\n')) {
      const separator = line.indexOf(':')
      if (separator <= 0) continue
      meta[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
    }
  }
  return { meta, content: raw.slice(match ? match[0].length : 0).trim() }
}

/**
 * 读一个包内技能。
 * @param resourceDir 该入口的资源目录（`resourceDirFrom(...)` 的结果）
 * @param name 技能目录名
 */
export function loadSkill(resourceDir: string, name: string): BundledSkill {
  const directory = join(resourceDir, 'skills', name)
  const path = join(directory, 'SKILL.md')
  const { meta, content } = parseSkillFile(path)
  return {
    name: meta.name ?? name,
    description: meta.description ?? '',
    ...(meta.whenToUse ? { whenToUse: meta.whenToUse } : {}),
    content,
    path,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: directory },
  }
}
