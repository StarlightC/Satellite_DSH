import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadSkill, packageRootFrom, parseSkillFile, resourceDirFrom } from '../lib/skills.js'

// 子插件的技能都在自己的目录下，加载器共用同一个。
// 这里刻意用**构建产物入口**推导：构建后入口在 lib/<组件>/，资源仍在包根的 <组件>/，
// 这是本次改造最容易断的一环，用真实加载而不是断言字符串常量来验证。
const NODE_ENTRY = new URL('../lib/node/index.js', import.meta.url).href
const ANDROID_ENTRY = new URL('../lib/android/index.js', import.meta.url).href
const NODE_DIR = resourceDirFrom(NODE_ENTRY, 'node')
const ANDROID_DIR = resourceDirFrom(ANDROID_ENTRY, 'android')

test('每个子插件从自己的目录加载本包技能', () => {
  const base = loadSkill(NODE_DIR, 'satellite-base-flow')
  assert.equal(base.name, 'satellite-base-flow')
  assert.match(base.description, /Public baseline workflow/)
  assert.match(base.content, /Public base flow/)
  assert.equal(base.source, 'bundled')
  assert.equal(base.path, `${NODE_DIR}/skills/satellite-base-flow/SKILL.md`)
  assert.equal(base.resourceBase.path, `${NODE_DIR}/skills/satellite-base-flow`)

  // 第二个基础节点的技能：当前差异的独立审查（同样从构建产物入口真实读取）。
  const review = loadSkill(NODE_DIR, 'satellite-change-review')
  assert.equal(review.name, 'satellite-change-review')
  assert.match(review.description, /Independently review the current change/)
  assert.match(review.whenToUse, /review node/)
  assert.match(review.content, /Current change review/)
  assert.equal(review.source, 'bundled')
  assert.equal(review.path, `${NODE_DIR}/skills/satellite-change-review/SKILL.md`)
  assert.equal(review.resourceBase.path, `${NODE_DIR}/skills/satellite-change-review`)
  assert.equal(review.content.startsWith('---'), false)

  // 第三个基础节点的技能：流程第一步的有界调查（同样从构建产物入口真实读取）。
  const investigation = loadSkill(NODE_DIR, 'satellite-investigation')
  assert.equal(investigation.name, 'satellite-investigation')
  assert.match(investigation.description, /Bounded read-only investigation/)
  assert.match(investigation.whenToUse, /`context` node/)
  assert.match(investigation.content, /Bounded investigation/)
  assert.match(investigation.content, /stop condition/)
  assert.equal(investigation.source, 'bundled')
  assert.equal(investigation.path, `${NODE_DIR}/skills/satellite-investigation/SKILL.md`)
  assert.equal(investigation.resourceBase.path, `${NODE_DIR}/skills/satellite-investigation`)
  assert.equal(investigation.content.startsWith('---'), false)

  // 第四个基础节点的技能：流程第二步的方案与决策（同样从构建产物入口真实读取）。
  const solution = loadSkill(NODE_DIR, 'satellite-solution')
  assert.equal(solution.name, 'satellite-solution')
  assert.match(solution.description, /Solution shaping/)
  assert.match(solution.whenToUse, /`solution` node/)
  assert.match(solution.content, /Solution shaping/)
  assert.match(solution.content, /does not implement/)
  assert.equal(solution.source, 'bundled')
  assert.equal(solution.path, `${NODE_DIR}/skills/satellite-solution/SKILL.md`)
  assert.equal(solution.resourceBase.path, `${NODE_DIR}/skills/satellite-solution`)
  assert.equal(solution.content.startsWith('---'), false)

  // 第五个基础节点的技能：流程末步的验收（同样从构建产物入口真实读取）。
  const acceptance = loadSkill(NODE_DIR, 'satellite-acceptance')
  assert.equal(acceptance.name, 'satellite-acceptance')
  assert.match(acceptance.description, /Acceptance for Satellite DSH/)
  assert.match(acceptance.whenToUse, /`signoff` node/)
  assert.match(acceptance.content, /# Acceptance/)
  assert.match(acceptance.content, /not business acceptance|runtime fact/)
  assert.equal(acceptance.source, 'bundled')
  assert.equal(acceptance.path, `${NODE_DIR}/skills/satellite-acceptance/SKILL.md`)
  assert.equal(acceptance.resourceBase.path, `${NODE_DIR}/skills/satellite-acceptance`)
  assert.equal(acceptance.content.startsWith('---'), false)

  // 第六个基础节点的技能：流程第三步的实施（同样从构建产物入口真实读取）。
  const implementation = loadSkill(NODE_DIR, 'satellite-implementation')
  assert.equal(implementation.name, 'satellite-implementation')
  assert.match(implementation.description, /Implementation in reviewable units/)
  assert.match(implementation.whenToUse, /`implement` node/)
  assert.match(implementation.content, /# Implementation in units/)
  assert.match(implementation.content, /does not commit/)
  assert.equal(implementation.source, 'bundled')
  assert.equal(implementation.path, `${NODE_DIR}/skills/satellite-implementation/SKILL.md`)
  assert.equal(implementation.resourceBase.path, `${NODE_DIR}/skills/satellite-implementation`)
  assert.equal(implementation.content.startsWith('---'), false)

  const android = loadSkill(ANDROID_DIR, 'android-validation-context')
  assert.equal(android.name, 'android-validation-context')
  assert.match(android.description, /bounded Android validation context/)
  assert.equal(android.path, `${ANDROID_DIR}/skills/android-validation-context/SKILL.md`)
})

test('构建后资源目录仍指向包内原位，而不是 lib/', () => {
  const root = packageRootFrom(NODE_ENTRY)
  assert.equal(packageRootFrom(ANDROID_ENTRY), root)
  assert.equal(NODE_DIR, `${root}/node`)
  assert.equal(ANDROID_DIR, `${root}/android`)
  for (const directory of [NODE_DIR, ANDROID_DIR]) {
    assert.equal(directory.includes('/lib/'), false, `${directory} 不应落在构建产物目录里`)
  }
  // 反向确认：如果按入口文件所在目录取资源，构建后就是错的（这正是要防的回归）。
  assert.throws(() => loadSkill(`${root}/lib/node`, 'satellite-base-flow'), /ENOENT/)
})

test('whenToUse 从 frontmatter 读出，正文不含 frontmatter', () => {
  const skill = loadSkill(NODE_DIR, 'satellite-base-flow')
  assert.match(skill.whenToUse, /non-trivial change/)
  assert.equal(skill.content.startsWith('---'), false)
})

test('六个技能目录互不串用：基目录给错就抛错，而不是加载到另一个技能', () => {
  assert.throws(() => loadSkill(NODE_DIR, 'android-validation-context'), /ENOENT/)
  assert.throws(() => loadSkill(ANDROID_DIR, 'satellite-base-flow'), /ENOENT/)
  assert.throws(() => loadSkill(ANDROID_DIR, 'satellite-investigation'), /ENOENT/)
  assert.throws(() => loadSkill(ANDROID_DIR, 'satellite-solution'), /ENOENT/)
  assert.throws(() => loadSkill(ANDROID_DIR, 'satellite-acceptance'), /ENOENT/)
  assert.throws(() => loadSkill(ANDROID_DIR, 'satellite-implementation'), /ENOENT/)
  assert.throws(() => loadSkill(NODE_DIR, 'does-not-exist'), /ENOENT/)
})

test('全部绑定技能都能从构建产物入口读到：入口模块的 skills 清单逐个真实加载', async () => {
  // 从**构建产物**取真实清单（而不是只对目录做断言），再逐个真实读取文件。
  const { DEFAULT_CONFIG } = await import(new URL('../lib/node/lib/config.js', import.meta.url).href)
  const listed = [...DEFAULT_CONFIG.skills]
  assert.deepEqual(listed, [
    'satellite-base-flow',
    'satellite-validation',
    'satellite-change-review',
    'satellite-investigation',
    'satellite-solution',
    'satellite-acceptance',
    'satellite-implementation',
  ])
  // 入口模块必须真实可加载（子插件入口与技能资源在同一构建产物里）。
  const entry = await import(new URL('../lib/node/index.js', import.meta.url).href)
  assert.deepEqual(Object.keys(entry).sort(), ['Config', 'apply', 'inject'])
  for (const name of listed) {
    const skill = loadSkill(NODE_DIR, name)
    assert.equal(skill.name, name)
    assert.equal(skill.source, 'bundled')
    assert.equal(skill.path, `${NODE_DIR}/skills/${name}/SKILL.md`)
    assert.ok(skill.description.length > 0, `${name} 必须有 description`)
    assert.ok(skill.whenToUse.length > 0, `${name} 必须有 whenToUse`)
    assert.equal(skill.content.startsWith('---'), false)
  }
})

test('没有 frontmatter 的文件解析为空元数据、正文为全文', () => {
  const parsed = parseSkillFile(`${NODE_DIR}/../package.json`)
  assert.deepEqual(parsed.meta, {})
  assert.match(parsed.content, /"name": "satellite"/)
})

test('CRLF 行尾的 SKILL.md 仍能纯解析 frontmatter 与正文', () => {
  const dir = mkdtempSync(join(tmpdir(), 'satellite-skill-'))
  try {
    const path = join(dir, 'SKILL.md')
    writeFileSync(path, '---\r\nname: crlf-skill\r\ndescription: CRLF only\r\n---\r\n# Body\r\n')
    const parsed = parseSkillFile(path)
    assert.equal(parsed.meta.name, 'crlf-skill')
    assert.equal(parsed.meta.description, 'CRLF only')
    assert.equal(parsed.content, '# Body')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// 技能目录下的 references/ 只有被 SKILL.md 用相对链接指到才可发现。
// 两个方向都查：链接必须真实存在，已存在的按需参考也必须被链接（否则是死文件）。
test('按需参考与 SKILL.md 相对链接双向一致', () => {
  // Production path: a loaded core/domain skill points the Agent to a deferred
  // reference. Check actual loadable resources, not policy keywords as behaviour.
  const entries = [NODE_DIR, ANDROID_DIR].flatMap((directory) =>
    readdirSync(`${directory}/skills`, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ directory, name: entry.name })))
  assert.ok(entries.some(({ name }) => name === 'satellite-base-flow'))

  for (const { directory, name } of entries) {
    const skill = loadSkill(directory, name)
    const content = readFileSync(skill.path, 'utf8')
    const links = [...content.matchAll(/\]\((references\/[^)\s]+)\)/g)].map((match) => match[1])
    assert.deepEqual(
      links,
      [...new Set(links)],
      `${name}: 同一个参考不应重复链接`,
    )
    for (const link of links) {
      assert.ok(existsSync(`${skill.resourceBase.path}/${link}`), `${name}: 链接缺少文件 ${link}`)
    }

    const references = `${skill.resourceBase.path}/references`
    if (!existsSync(references)) continue
    for (const file of readdirSync(references)) {
      assert.ok(
        links.includes(`references/${file}`),
        `${name}: references/${file} 没有被 SKILL.md 链接，模型无法按需读到`,
      )
    }
  }
})
