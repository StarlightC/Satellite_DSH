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

**本项目尚未启用 git**（当前不执行任何 git 操作），因此参考项目的 source/main 双分支模型、
`.release.json`、`scripts/publish-main.mjs`、`release.yml` 等**暂缓启用**；待启用 git 后再落地。
当前只保留不依赖 git 的部分：

- `src/` → tsdown → `lib/`，发布物为 `lib/` 加包内资源；
- `package.json` 的 `main`/`exports`/`files`/`engines`/`license`；
- `scripts` 里禁止 `preinstall`/`install`/`postinstall`/`prepare`/`prepack`/`prepublish`/`prepublishOnly`/`publish`；
- `test/package.test.mjs` 作为发布质量门。

### 与参考项目不同的发布白名单（有意扩展）

参考项目的发布脚本要求包内第一层只出现 `lib/`、`package.json`、`README.md`、
`cordis.patch.yml`、`LICENSE`。Satellite 是**带资源的包**：`locale/*.json`、`icon.svg`、
`node/skills/`、`android/skills/` 必须随包分发（子组件的标题/描述/图标与方法技能都来自它们），
所以白名单必须扩展。这条差异由 `test/package.test.mjs` 显式覆盖。
