# 开发说明

## 目录结构

```text
src/                      TypeScript 源码（唯一的可编译来源）
  plugin.ts               包根入口（插件身份行）
  lib/                    共享契约与纯逻辑，不依赖 Cordis
    contracts.ts          插槽/事实/扩展契约与节点目录
    registry.ts           注册校验、条件三态、就绪、同槽依赖与冲突
    notify.ts             极小的插槽变化订阅集合
    skills.ts             包内技能加载与资源目录推导
  slots/index.ts          插槽服务入口（默认导出 Cordis Service 子类）
  node/
    index.ts              节点工具入口（defineTool + Config + apply）
    lib/{wiring,nodes,config,routes,tool-schema}.ts
  android/
    index.ts              Android 只读扩展入口
    lib/{extension,registration}.ts
locale/ icon.svg          包根的资源（不参与构建）
slots/ node/ android/     各入口的资源：locale/、icon.svg、skills/
lib/                      tsdown 构建产物（不提交）
test/*.test.mjs           单元测试，针对 lib/ 运行
```

## 构建与验证

```bash
npm_config_cache=<工作区>/.npm-cache npm install
npm run build      # tsdown（tsdown.config.ts，每个入口一段配置）
npm run typecheck  # tsc -p tsconfig.json（include 仅 src/**/*）
npm test           # npm run build && node --test test/*.test.mjs
```

`node --test <目录>` 不会递归发现用例，所以测试脚本显式使用 `test/*.test.mjs` glob。

## 资源路径约定（构建后最容易出错的一环）

源码在 `src/<组件>/`，入口构建到 `lib/<组件>/`，而 `locale/`、`icon.svg`、`skills/`
**不参与构建**，留在包内原位的 `<组件>/`。因此：

- 资源目录不能用"入口文件所在目录"推导；
- 用 `resourceDirFrom(import.meta.url, '<组件>')`（先向上找到本包 `package.json`，再拼组件目录）；
- `test/skills.test.mjs` 用构建产物入口做真实加载验证，而不是断言字符串常量。

## 发布流程

采用 DSHOAuth 的 `source` / `main` 双分支模式：

- `source` 保存源码、测试和 GitHub Actions 配置，作为默认开发分支；
- 推送 `v*` 标签触发 `.github/workflows/release.yml`，标签提交必须属于远程 `source`；
- 校验标签、`package.json` 与 `package-lock.json` 版本一致（稳定版或预发布 SemVer，不含 build metadata），执行 `npm ci`、类型检查、构建和测试；
- `npm pack` 后校验四个构建入口、图标、翻译和技能资源，发布 GitHub Release 附件 `release.tgz`，自动生成说明；不执行 npm registry 发布；
- 稳定版通过 `scripts/publish-main.mjs` 将该附件的内容同步至 `main`，并写入 `.release.json`（版本、标签和源码提交）；首次可创建 `main`，后续只允许快进，不强推；
- 预发布标签（如 `v0.2.0-rc.1`）仅创建 prerelease，不更新 `main` 或 latest；
- 重跑已有 Release 时下载原附件，不覆盖已发布资产；同步支持幂等重试、拒绝同版本不同源码提交、跳过旧版本，避免产物分支降级。

`main` 是安装用的产物分支，不保留源码、开发文档或 Actions。所有开发继续在 `source` 上进行。
发布包保持无安装/打包生命周期钩子，用户安装无需隐式构建；`test/package.test.mjs` 和
`test/publish-main.test.mjs` 覆盖发布质量门与本地 Git 同步行为。

### 首次启用（维护者手动执行）

当前本地仓库若仍只有源码 `main` 且未配置远程，需要先提交改动，再配置 GitHub 仓库：

```bash
# 将现有源码分支改名；不要在产物 main 上开发。
git branch -m main source
git remote add origin <GitHub 仓库 URL>
git push -u origin source
```

在 GitHub 将默认分支设为 `source`，启用 Actions，并允许发布 job 的 `GITHUB_TOKEN`
写入仓库内容。若存在 `main` 分支保护或 ruleset，必须允许此发布流程推送产物；否则 Release
可能已创建但同步失败，调整权限后可重跑。首次同步也支持已存在的 `main`，会以快进提交将其
替换为产物树，因此务必先将源码保存到 `source`。本地未配置远程时不能直接发布。

### 发布版本

在 `source` 上修改版本并提交（首次发布也可使用当前尚未发布的版本）：

```bash
npm version 0.2.0 --no-git-tag-version
# 提交 package.json、package-lock.json 及本次发布的源码改动后：
git push origin source
git tag v0.2.0
git push origin v0.2.0
```

同一版本的标签和资产视为不可变；修复应增加版本，不移动已发布标签。Actions 完成后检查
Release 附件和 `main` 的 `.release.json`。若 Release 成功而同步失败，重跑原 workflow 即可
继续同步原附件，无需重新发布或强推。

### 与参考项目不同的发布白名单（有意扩展）

参考项目的发布脚本要求包内第一层只出现 `lib/`、`package.json`、`README.md`、
`cordis.patch.yml`、`LICENSE`。Satellite 是**带资源的包**：`locale/*.json`、`icon.svg`、
`node/skills/`、`android/skills/` 必须随包分发（子组件的标题/描述/图标与方法技能都来自它们），
所以白名单必须扩展。这条差异由 `test/package.test.mjs` 显式覆盖。
