import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { apply } from '../lib/android/index.js'
import { createAndroidValidationContext } from '../lib/android/lib/extension.js'
import { ANDROID_SKILL_NAMES, createAndroidNodeExtensions } from '../lib/android/lib/node-extensions.js'
import { loadSkill, resourceDirFrom } from '../lib/skills.js'

const ANDROID_ENTRY = new URL('../lib/android/index.js', import.meta.url).href
const ANDROID_DIR = resourceDirFrom(ANDROID_ENTRY, 'android')
const SKILLS_ROOT = join(ANDROID_DIR, 'skills')
const ANDROID_SHA = '4ebabf2b0fd6c04b7150023c8b612f80592a6226'
const CHRIS_SHA = '6c30c500c36a1827c8fde75415dd7a31394bc02c'

// Independent expectation: do not derive this from the implementation list.
const EXISTING_SKILLS = [
  'android-validation-context',
  'android-design-handoff',
  'android-change-review',
  'android-validation-evidence',
  'android-acceptance-evidence',
]
const NEW_SKILLS = [
  'android-compose-performance',
  'android-anr-diagnostics',
  'android-permissions-security',
  'android-kotlin-concurrency',
  'android-compose-state-effects',
  'android-compose-ui-testing',
  'android-performance-analysis',
]
const ALL_SKILLS = [...EXISTING_SKILLS, ...NEW_SKILLS]
const SOURCE_BY_SKILL = new Map([
  ['android-compose-performance', [ANDROID_SHA]],
  ['android-anr-diagnostics', [ANDROID_SHA]],
  ['android-permissions-security', [ANDROID_SHA]],
  ['android-kotlin-concurrency', [CHRIS_SHA]],
  ['android-compose-state-effects', [CHRIS_SHA]],
  ['android-compose-ui-testing', [CHRIS_SHA]],
  ['android-performance-analysis', [ANDROID_SHA]],
])

function setup() {
  const skills = []
  const noopDisposer = () => {}
  const ctx = {
    tools: { register: noopDisposer },
    satelliteSlots: {
      hasSlot: () => false,
      register: noopDisposer,
      onSlotsChanged: noopDisposer,
    },
    get: (name) => (name === 'logger' ? { error: () => {} } : undefined),
    inject(deps, callback) {
      if (!deps.includes('skills')) return
      callback({
        skills: { register: (skill) => { skills.push(skill); return noopDisposer } },
        effect: (fn) => fn(),
      })
    },
    effect: (fn) => fn(),
  }
  apply(ctx)
  return skills
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : []
  })
}

function codeBlocks(file) {
  return [...readFileSync(file, 'utf8').matchAll(/```[a-zA-Z]*\n([\s\S]*?)```/g)].map((match) => match[1])
}

test('12 个 Android 技能按既有 5 项、新增 7 项的真实顺序注册', () => {
  assert.deepEqual([...ANDROID_SKILL_NAMES], ALL_SKILLS)
  assert.equal(new Set(ANDROID_SKILL_NAMES).size, 12)
  assert.deepEqual(setup().map((skill) => skill.name), ALL_SKILLS)
})

test('新增技能有可加载的单行元数据，并带完整来源、SHA 与修改标注', () => {
  for (const name of NEW_SKILLS) {
    const skill = loadSkill(ANDROID_DIR, name)
    assert.equal(skill.name, name)
    assert.equal(skill.source, 'bundled')
    assert.ok(skill.description.length >= 80, `${name} 的 description 应说明实际用途`)
    assert.ok(skill.whenToUse.length >= 40, `${name} 应有明确的 whenToUse`)
    assert.equal(/[\r\n]/.test(skill.description), false, `${name} 的 description 必须是单行`)
    assert.equal(/[\r\n]/.test(skill.whenToUse), false, `${name} 的 whenToUse 必须是单行`)
    assert.equal(skill.content.startsWith('---'), false)
    assert.match(skill.content, /Modified by Satellite DSH/)
    assert.match(skill.content, /Licensed Apache-2\.0/)
    assert.match(skill.content, /LICENSE-APACHE-2\.0\.txt/)
    assert.match(skill.content, /THIRD_PARTY_SOURCES\.md/)
    for (const sha of SOURCE_BY_SKILL.get(name)) {
      assert.ok(skill.content.includes(sha), `${name} 应能追溯到上游完整 SHA ${sha}`)
    }

    const referencesDir = join(skill.resourceBase.path, 'references')
    assert.ok(existsSync(referencesDir), `${name} 应有按需 references 目录`)
    const references = readdirSync(referencesDir).filter((file) => file.endsWith('.md'))
    assert.ok(references.length > 0, `${name} 不能只有概述，至少需要一个技术参考`)
    for (const file of references) {
      const content = readFileSync(join(referencesDir, file), 'utf8')
      assert.match(content, /Modified by Satellite DSH/, `${name}/references/${file} 缺少修改标注`)
      assert.ok(
        SOURCE_BY_SKILL.get(name).some((sha) => content.includes(sha)),
        `${name}/references/${file} 缺少上游完整 SHA`,
      )
    }
  }
})

test('每个新增技能把全部 references 链接出来，且没有死链', () => {
  for (const name of NEW_SKILLS) {
    const skill = loadSkill(ANDROID_DIR, name)
    const content = readFileSync(skill.path, 'utf8')
    const links = [...content.matchAll(/\]\((references\/[^)\s]+)\)/g)].map((match) => match[1])
    assert.deepEqual(links, [...new Set(links)], `${name} 不应重复链接同一个 reference`)
    const references = readdirSync(join(skill.resourceBase.path, 'references'))
      .filter((file) => file.endsWith('.md'))
      .map((file) => `references/${file}`)
    assert.deepEqual([...links].sort(), references.sort(), `${name} 的 reference 链接应与文件双向一致`)
    for (const link of links) {
      assert.ok(existsSync(resolve(skill.resourceBase.path, link)), `${name} 链接缺少文件 ${link}`)
    }
  }
})

test('技能内所有相对 md/txt 链接（含 ../）解析在 android/skills 内且存在', () => {
  const rootPrefix = `${resolve(SKILLS_ROOT)}${sep}`
  for (const path of walk(SKILLS_ROOT).filter((file) => /\.(md|txt)$/.test(file))) {
    const content = readFileSync(path, 'utf8')
    for (const match of content.matchAll(/\]\(([^)\s]+)\)/g)) {
      const raw = match[1]
      if (/^(?:https?:|mailto:|#)/.test(raw)) continue
      const target = raw.split('#')[0]
      if (!target) continue
      const absolute = resolve(dirname(path), target)
      assert.ok(
        absolute === resolve(SKILLS_ROOT) || absolute.startsWith(rootPrefix),
        `${relative(SKILLS_ROOT, path)} 的链接越出 android/skills：${raw}`,
      )
      assert.ok(existsSync(absolute), `${relative(SKILLS_ROOT, path)} 的链接不存在：${raw}`)
    }
  }
})

test('android/skills 不含 scripts/bin 目录或可执行文件', () => {
  for (const path of walk(SKILLS_ROOT)) {
    const parts = relative(SKILLS_ROOT, path).split(sep)
    assert.equal(parts.includes('scripts'), false, `不应包含 scripts：${path}`)
    assert.equal(parts.includes('bin'), false, `不应包含 bin：${path}`)
    if (process.platform !== 'win32') {
      assert.equal(statSync(path).mode & 0o111, 0, `不应有可执行文件：${path}`)
    }
  }
})

test('共享 Apache-2.0 全文与第三方来源表可追溯，且不虚构 NOTICE', () => {
  const licensePath = join(SKILLS_ROOT, 'LICENSE-APACHE-2.0.txt')
  const license = readFileSync(licensePath, 'utf8')
  assert.match(license, /Apache License/)
  assert.match(license, /Version 2\.0, January 2004/)

  const sources = readFileSync(join(SKILLS_ROOT, 'THIRD_PARTY_SOURCES.md'), 'utf8')
  for (const sha of [ANDROID_SHA, CHRIS_SHA]) assert.ok(sources.includes(sha), `来源表缺少 SHA ${sha}`)
  assert.match(sources, /github\.com\/android\/skills/)
  assert.match(sources, /github\.com\/chrisbanes\/skills/)
  assert.match(sources, /Apache-2\.0/)
  assert.match(sources, /NOTICE/)
})

test('审查修复的五处技术示例自洽：来源区分、API 34 分支、可观察 hover、两类 lambda 收益、Channel 投递', () => {
  // 1. 来源：正文源与路由入口分开标注，SHA 仍为完整值。
  const sources = readFileSync(join(SKILLS_ROOT, 'THIRD_PARTY_SOURCES.md'), 'utf8')
  const perfRow = sources.split('\n').find((line) => line.startsWith('| `android-performance-analysis` |'))
  assert.ok(perfRow, '来源表应保留 android-performance-analysis 行')
  assert.match(perfRow, /perfetto-sql\/perfetto_sql\.md` \(routing entry only\)/)
  assert.match(perfRow, /references\/perfetto\/sql\.md` \(body of `references\/perfetto-sql\.md`\)/)
  assert.match(sources, /routing entry only/)
  assert.ok(sources.includes(ANDROID_SHA))
  const perfSkill = readFileSync(join(SKILLS_ROOT, 'android-performance-analysis/SKILL.md'), 'utf8')
  assert.match(perfSkill, /perfetto_sql\.md \(routing entry only\)/)
  assert.match(perfSkill, /references\/perfetto\/sql\.md \(body of references\/perfetto-sql\.md\)/)
  assert.ok(perfSkill.includes(ANDROID_SHA))

  // 2. Broadcast：三参 sendBroadcast 只在 SDK >= 34 分支，低版本走两参。
  const ipcFile = join(SKILLS_ROOT, 'android-permissions-security/references/manifest-ipc.md')
  const broadcast = codeBlocks(ipcFile).find((block) => block.includes('sendBroadcast(intent'))
  assert.ok(broadcast, 'manifest-ipc 应保留 broadcast 示例')
  const [guarded, fallback] = broadcast.split('} else {')
  assert.match(guarded, /Build\.VERSION\.SDK_INT >= 34/)
  assert.match(guarded, /sendBroadcast\(intent, RECEIVE_SECRET_UPDATE, options\)/)
  assert.doesNotMatch(fallback, /options/)
  assert.match(fallback, /sendBroadcast\(intent, RECEIVE_SECRET_UPDATE\)/)
  const receiver = codeBlocks(ipcFile).find((block) => block.includes('!= "com.example.trusted"'))
  assert.match(receiver, /getSentFromPackage\(\) != "com\.example\.trusted"/)

  // 3. 交互测试：按钮有 content lambda，hover 断言的是可观察状态，且不再包 runTest。
  const interaction = codeBlocks(join(SKILLS_ROOT, 'android-compose-ui-testing/references/interaction-state.md'))
    .find((block) => block.includes('OutlinedButton'))
  assert.ok(interaction, 'interaction-state 应保留 hover 示例')
  assert.doesNotMatch(interaction, /runTest/)
  assert.match(interaction, /\n\s*\) \{\n[\s\S]*Text\(/, 'OutlinedButton 必须带 content lambda')
  assert.match(interaction, /collectIsHoveredAsState\(\)/)
  assert.match(interaction, /tryEmit\(HoverInteraction\.Enter\(\)\)/)
  assert.match(interaction, /onNodeWithText\("Idle"\)\.assertIsDisplayed\(\)/)
  assert.match(interaction, /onNodeWithText\("Hovered"\)\.assertIsDisplayed\(\)/)

  // 4. lambda provider：两类收益分开说，composition 读取仍会重组。
  const composePerf = readFileSync(join(SKILLS_ROOT, 'android-compose-performance/SKILL.md'), 'utf8')
  const stability = readFileSync(join(SKILLS_ROOT, 'android-compose-performance/references/state-stability.md'), 'utf8')
  assert.doesNotMatch(composePerf, /helps only when the value is consumed in Layout or Draw/)
  assert.match(composePerf, /Layout or Draw avoids recomposition/)
  assert.match(composePerf, /narrows \*which\* scope recomposes/)
  assert.match(composePerf, /still recomposes/)
  assert.doesNotMatch(stability, /only when the child consumes it in Layout/)
  assert.match(stability, /defers no\s+phase/)

  // 5. Channel 每元素至多一个接收者且不保证送达，不是广播，也不是 exactly-once。
  const flow = readFileSync(join(SKILLS_ROOT, 'android-kotlin-concurrency/references/flow-state-events.md'), 'utf8')
  assert.doesNotMatch(flow, /one-consumer fan-out/)
  assert.doesNotMatch(flow, /exactly one consumer/)
  assert.doesNotMatch(flow, /[Ee]xactly-once handoff/)
  assert.match(flow, /at\s+most one receiver/)
  assert.match(flow, /guarantees neither\s+delivery nor exactly-once processing/)
})

test('新增技能不增加 role/extension 绑定，原 6 条 Android 扩展绑定保持', () => {
  const extensions = [createAndroidValidationContext(), ...createAndroidNodeExtensions()]
  assert.equal(extensions.length, 6)
  assert.deepEqual(extensions.map((extension) => extension.id), [
    'android.validation-context',
    'android.project-context',
    'android.design-context',
    'android.platform-review',
    'android.validation-evidence',
    'android.acceptance-evidence',
  ])
  for (const extension of extensions) {
    assert.equal(extension.role.name, 'android-context')
    assert.equal(EXISTING_SKILLS.includes(extension.role.skill), true)
  }
  for (const name of NEW_SKILLS) {
    assert.equal(extensions.some((extension) => extension.role.skill === name), false, `${name} 不应新增扩展绑定`)
  }
})
