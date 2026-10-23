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
  platform/               宿主执行世界策略（node 与 android 共用）
    contracts.ts          宿主平台契约与能力形状
    index.ts              平台检测与选择（只用调用作用域 fs + terminalEnvironment）
    apple.ts              Apple (macOS) 路径/命令策略；当前唯一受支持宿主
    linux.ts              未实现占位
    windows.ts            未实现占位
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

## 宿主平台与新增平台步骤

动态执行（Android 发现构建/构建/设备/模拟器/旅程/采集）与项目技能脚本只支持
**Apple (macOS)** 宿主执行世界。平台不是用宿主的 `process.platform` 猜出来的，
而是用**调用作用域的 `fs` 正向系统标记 + `terminalEnvironment`** 检测：

- Apple：`/System/Library/CoreServices/SystemVersion.plist` 与 `/usr/bin/sw_vers` 都是文件；
- Linux：`/etc/os-release` 或 `/proc/version` 是文件；
- Windows：`terminalEnvironment().platform === 'windows'`；
- 无标记或 Apple/Linux 标记冲突 → `unknown`，一律失败关闭。

检测不执行进程，AbortError 原样传播；探测错误或标记形状异常返回 unknown，不把无法读取当成不存在。
结果只用于能力选择，不是认证、授权或执行世界身份证明，也不承诺远端平台兼容。

消费方依赖 `SupportedPlatform` 能力契约，不导入 Apple 实现，也不按 Apple id 分支。
契约提供宿主绝对路径规则、路径分隔符、Gradle wrapper 路径，以及解析器的运行时、环境与命令组装。
Android CLI 报告解析器接收路径能力；静态工程参数和 adb 路径的纯语法检查使用
`isAbsoluteHostPathSyntax`（包含 Windows 盘符/UNC 语法），语法有效不代表该平台可执行。
`project.inspect` 不经过动态平台门禁，能识别 `gradlew` 和 `gradlew.bat`。

所有 Android 动态工具在批准前核对平台，将平台 id 写入批准文本，批准后再次检测；
不支持或平台变化时停止，且不启动新进程。构建内已被批准覆盖的 CLI 复核仍独立检查平台。
这不替代原有策略、设备观测、产物或生命周期核验；已拥有的资源在作用域退出/卸载时仍清理。
外部工程仍保留原 `GRADLE_OPTS` 并追加禁用 daemon 的开关，不借重构改变批准范围。

新增一个宿主平台的步骤（保持失败关闭，不要给 unsupported 平台回落）：

1. 为已有 Linux/Windows 占位实现 `SupportedPlatform`；仅新增其他 id 时扩展 `HostPlatformId`；
2. 在该平台模块实现完整能力，不复制调用方的批准/沙箱/生命周期逻辑；
3. 必要时在 `src/platform/index.ts` 增加检测规则，未知、冲突和探测失败仍不回落；
4. 若增加新模块入口，更新 `tsdown.config.ts`；
5. 既有 Android/脚本消费方通过共同能力调用，无需添加或修改业务 Apple 分支；
6. 补平台能力测试，以及动态工具在批准前不支持、批准期间平台变化时零 spawn 的回归；
   对新增平台实际运行构建、设备和沙箱验证，不能把 fixture 测试当作真机兼容证明。

设备侧 `/data/local/tmp` 与 `/data/misc/perfetto-traces` 属于 Android 设备协议，
不属于宿主平台策略，不要迁入 `src/platform/`。

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
