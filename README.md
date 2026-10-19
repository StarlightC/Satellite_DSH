# Satellite

Satellite 把项目的**基础流程**当作节点运行，并允许在节点前后挂接可插拔扩展。

一次安装（bundle = Satellite）包含三个可分别启停的功能行；包根仅提供插件身份，不占配置行：

| 行 id | 入口 | 默认 | 作用 |
| --- | --- | --- | --- |
| —（插件本体） | `satellite` | 启用 | 插件的身份入口：只承载插件级标题、描述与图标 |
| `satellite-slots` | `satellite/slots` | 启用 | 插槽服务：节点插槽目录、扩展注册校验、条件三态与同槽解析 |
| `satellite-node` | `satellite/node` | 启用 | 节点工具 `satellite_node`：一次调用内的 before/base/after 自动边界与角色委派（六个节点 `context`、`solution`、`implement`、`validate`、`review`、`signoff` 全部有 base runner） |
| `satellite-android` | `satellite/android` | 停用（按项目启用） | Android 领域行：只读专项扩展（`context`/`solution`/`review`/`validate`/`signoff` 的按需补充）+ 五个只读方法技能；**本地执行工具默认关闭**，需显式配置 `execution` 才注册 |

Android 执行工具（`satellite_android_project`、`satellite_android_build`、`satellite_android_device`、`satellite_android_emulator`、`satellite_android_journey`、`satellite_android_capture`）在领域行启用后**始终注册**；`execution` 是 **volatile** 设置，按每次调用读取，所以在设置页保存后**无需重启**。未启用或缺所需路径时，每次调用都以 `CAPABILITY_UNAVAILABLE` 失败关闭，不会产生任何副作用：

配置可在设置页的 Satellite Android 一节编辑（本机路径、保存在 profile、不进仓库），也可写在行配置里：

```jsonc
// satellite-android 行配置（默认值归代码：enabled=false，其余留空即"未配置"）
{
  "execution": {
    "enabled": true,
    "androidCli": "/abs/path/to/android",          // discover-build 用；未配置则该动作明确不可用
    "privacy": "verified-disabled",                 // 或 explicit-user-opt-in；未配置则拒绝 discover-build
    "adbPath": "/abs/path/to/adb",                  // 设备/模拟器/旅程/采集
    "emulatorPath": "/abs/path/to/emulator",        // 只注册模拟器工具
    "avdmanagerPath": "/abs/path/to/avdmanager",    // 仅 create/delete 需要
    "javaHome": "/abs/path/to/jdk",                 // 传给 Gradle 的 JAVA_HOME
    "serverEndpoint": "tcp:5037",                   // 可省略；省略即用 adb 默认
    "operationTimeoutMs": 600000,
    "outputMaxBytes": 262144
  }
}
```

所有会碰设备的动作（`install`、`launch`、`journey`、`capture`）都必须先用 `satellite_android_device` 的 `discover` 取得观测 id，并在批准后用该 id 复核设备与加进程内互斥；不接受"只有裸 serial"的调用。

不自动发现 SDK/JDK、不自动安装、不下载镜像。

`workspace-write` 会话里 `~/.android` 与 `~/.gradle` 不可写，因此工具会把 **Android CLI 与 Gradle 的用户目录**定向到 `<会话工作区>/.satellite/{android-user-home,gradle-user-home}`（已 gitignore）。实测不这么做时 `android --version` 会直接报 `Failed to open ".../.android/cli/bundles/lock"`。执行工具的边界（已按用户选择确定）：复用 DSH 的文件/进程/批准能力，**不提供跨进程设备排他，也不承诺宿主崩溃后的清理**；模拟器 `start` 成功后会移交给当前会话作用域，在显式 `stop`、Agent 作用域退出或插件卸载时终止并等待。

插槽服务是另外两行的共同依赖；停用它，节点工具与领域扩展都不会激活。

## 使用要求

- Node `^22.19.0 || >=24.0.0`。
- DeepSeek Harness 0.2.1 系列及兼容版本（提供 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`）。

## 安装

用 Harness 的 `plugin_manager` 安装本包目录（bundle 入口由 `cordis.patch.yml` 声明），
不要手写 profile 的 `package.json`／`cordis.patch.yml`，也不要直接运行 pnpm：

```text
install_bundle <本包目录>
```

安装本地目录是链接方式，因此**修改包内已加载过的文件后需要重启 Host** 才会载入新的模块世代。

## 配置

分层原则：**声明式默认值在代码里**（`src/node/lib/config.ts` 的 `DEFAULT_CONFIG`，以及由它派生、
供 schema 默认值使用的 `BUILTIN_ROLE_NAMES`/`BUILTIN_ROUTES`），**`cordis.patch.yml` 只声明"行"**
（`id`/`name`/`disabled` 这类装配事实），**profile 只保存用户自己的选择**（设置页里保存的覆盖）。
代码默认在没有用户覆盖时生效；用户显式覆盖继续保留，不会被升级强制重置。设置页应只保存用户选择，
不能把整张有效默认表保存成旧快照。已保存过的旧全量路由不会被自动猜测为默认，需用户主动恢复继承。

默认值：`provider: spawn`；节点 `context→investigation`、`solution→solution-design`、
`implement→implementation`、`validate→validation`、`review→change-review`、`signoff→acceptance`；
各角色的默认模型：

| 角色 | 默认 provider | 默认 model |
| --- | --- | --- |
| `investigation` | `deepseek-official` | `deepseek-v4-pro` |
| `solution-design` | `deepseek-official` | `deepseek-v4-pro` |
| `implementation` | `deepseek-official` | `deepseek-v4-pro` |
| `validation` | `deepseek-official` | `deepseek-flash` |
| `change-review` | `deepseek-official` | `deepseek-v4-pro` |
| `acceptance` | `deepseek-official` | `deepseek-v4-pro` |
| `android-context` | `deepseek-official` | `deepseek-v4-pro` |

只有在要**覆盖**默认值时才写行配置（设置页保存的覆盖是同一份语义）：

```yaml
provider: spawn
nodes:
  context:
    role: investigation
roles:
  investigation:
    objective: '自定义目标'
routes:
  - role: investigation
    provider: <provider-id>
    model: <model-id>
```

**模型选项的单一覆盖入口**：内置角色的用户模型覆盖只写 `routes`（包括
`reasoningEffort`、`maxTokens`）。内置 `roles.<role>.agentOptions` 是代码默认来源；
声明层给出与代码默认不同的对象将明确报配置错误，不再随 `routes` 缺省/空数组/稀疏数组而
忽隐忽现。迁移时将完整模型选项移到同角色的 route，并删除旧 `agentOptions`；不会自动修改 profile。
与当前代码默认完全相同的历史快照可被接受，但不会被本插件自动更新，建议移除冗余快照。
自定义角色仍可声明 `agentOptions` 默认；没有可见 route 的默认值不会由UI猜测。

工具过滤与文件沙箱承担不同责任：拒绝 `edit`/`write` 不能阻止 `bash` 写入。
`roles.<role>.sandbox` 表达角色所需模式，但不得放宽父会话有效权限。`investigation`、
`solution-design`、`change-review`、`acceptance`、`android-context` 默认只读；
`validation` 与 `implementation` 请求工作区写入能力。父会话只读时，后两者也不能升级权限。

整改后的执行要求：按明确子会话身份匹配，在原生初始化后、模型开始前施加并读回模式；
缺服务、写入或读回失败、无法保证等效约束的后端均拒绝受限执行，不以目标值冒充实际值。
文件沙箱仅约束其覆盖的操作；不代表网络/设备副作用授权，也不等于只能修改本次任务批准的文件。
真实 Host 时序与各后端强制行为需分别验收，不能只看替身测试。

节点 `context` 是流程第一步的**有界调查**：角色 `investigation` 先定范围与停止条件，再定向
读取，产出事实与状态所有者、可复用候选、影响与缺口；它与 `review` 共用同一条只读过滤
`deny: ['satellite_node', 'edit', 'write']` 与 `sandbox: 'read-only'`，因此能读事实来源但
**不能改文件**（含 `bash`）。

节点 `solution` 是流程第二步的**方案与决策**：角色 `solution-design` 把 `context` 给出的有界
事实转成可评审的选项，并逐条列出"需要谁做什么决定"；它与 `context`/`review` 共用同一条只读
过滤 `deny: ['satellite_node', 'edit', 'write']` 与 `sandbox: 'read-only'`，因此"不实施"是能力
边界——它能读事实来源，但**不能在"给方案"的同一步开始改文件**，`bash` 也写不进去。方案到此
为止：只有用户能做的决定停下来等，不由实施或换更贵的模型代答。

节点 `implement` 是有界实施：角色 `implementation` 允许必要写工具，但仍禁止递归调用
`satellite_node`，请求 `workspace-write` 且受父权限上限约束。一次一个单元、不扩大目标、不提交
不发布属于任务方法要求，由审查核对；不能把工作区内的所有可写位置等同于本次批准的修改范围。

**旧配置迁移**：`roles.<role>.cwd` 曾被误描述为写权限收窄。实际 `request.cwd` 只改变当前目录，
DSH 的不可变权限根继承父会话。为避免旧配置被静默放宽，配置该字段将明确拒绝启动；删除该字段后
沿用父工作区权限与当前执行目录。暂不提供子目录写隔离或对应设置页。

节点 `validate` 使用专用 `satellite-validation` 方法，仅执行适用检查并报告证据与未测项；
可产生测试/构建产物，但不承担源代码修复，也不要求执行子 Agent 再调用节点工具组织整个流程。

节点 `review` 是当前差异的独立审查：角色 `change-review` 的工具过滤为
`deny: ['satellite_node', 'edit', 'write']` 与 `sandbox: 'read-only'`，因此它有读 diff 与源码的能力，
在已验证的只读策略下，受沙箱覆盖的文件写入被拒绝。审查应直接检查实际源码与消费者，
不能只读实施总结；使用不同模型本身不证明审查独立性。

节点 `signoff` 是流程末步的**验收**：角色 `acceptance` 只按已有证据逐条声明接受与否、
证据位置与仍未验证的剩余限制；它与 `context`/`solution`/`review` 共用同一条只读过滤
`deny: ['satellite_node', 'edit', 'write']` 与 `sandbox: 'read-only'`，因此"不自动修复"是能力
边界——验收不会顺手改完再声明通过。"完成运行是运行时事实，不是业务验收"：缺证据一律列为未验证，
需要用户承担的接受交回用户，不提交、不发布。

`routes` 是 **volatile** 设置（可在设置页修改；不写就是代码默认，用户保存的覆盖存 profile），
插件在每次节点调用时读取，改模型不需要重启。

`builtinExtensions.acceptanceDecision`（默认 `true`）控制 core 自带的 after 扩展
`core.acceptance-decision.<node>`：`facts` 使用**扁平键**，点号是键名的一部分，不解析嵌套对象。
例如以下 `satellite_node` 参数要求基础节点完成后等待一次处理决定：

```json
{"node":"validate","task":"运行本次有界验证","facts":{"acceptance.required":true}}
```

该扩展在 `<node>.after` 返回 `needs_decision` 并暂停；用返回的 token 作为 `resume`
再次调用同一节点，并传 `decision` 即可继续，base 不会重跑。例如（替换 token 占位值）：

```json
{"node":"validate","task":"运行本次有界验证","resume":"<返回的 token>","decision":"accept"}
```

不传该事实、传非布尔 `true` 值或嵌套写法 `{"facts":{"acceptance":{"required":true}}}`
均不会触发该扩展的暂停。关闭该扩展时也不会暂停；事实与 `decision` 都不是宿主授权凭证。
恢复完成后，`extensions` 仍保留先前尝试的原始状态与正文；已完成节点的文本输出会将其中的
`needs_decision` 标为历史暂停记录，不表示当前仍在等待决定。

## 可选复用目录与项目技能解析器

节点组件同时提供 `satellite_reuse_query` 和 `satellite_skill_script_run`；Android 组件启用时提供
`satellite_reuse_maintain`。它们是现有组件的内部能力，不需要另装组件。缺少运行依赖只使对应操作
不可用，不使纯文本技能失效。以下为当前实现契约；真实宿主验收状态需另行核对。

### 复用目录

- 查询只返回有界候选及来源、新鲜度，不自动初始化。缺失或不可用时回到普通搜索；使用候选前读原源码。
- 维护使用明确的文件集合，支持 `initialize`、`rebuild`、`update`，经宿主批准后原子写入。
  单次最多 100 个相对文件路径；`update` 只处理该集合（已删除文件也在该集合声明）。
- 项目根绑定调用会话的不可变工作区，不接受模型指定身份。当前适配仅接受可证明的 Host 共享文件映射；
  不能确认的远程执行世界明确不可用。
- 生成文件为工作区根的 `.satellite-reuse-index.json`，用户覆盖为 `.satellite-reuse-overrides.json`；
  维护工具永不写用户覆盖。生成、Agent 调整、用户覆盖按顺序生效；用户可将候选标为 `excluded`。
- 覆盖范围始终是 `explicit-files`，不代表整个项目已扫描。通用查询不能核对领域识别器版本时，
  `recognitionStatus` 为 `unverified`，与源文件内容是否变化分别报告。
- Android 提取只生成 Kotlin/Java/Compose 的启发式候选，不是语义索引。旧索引不自动导入；
  损坏基线只有明确 `rebuild`、展示原版本和摘要并获批准后才可替换，合法但项目身份不匹配的索引拒绝覆盖。

### 项目技能解析器

`skill`、`script`、`parameters` 分别指定已加载项目技能、声明脚本 ID 与严格命名参数；不能提交任意
shell 命令、环境、工作目录或权限声明。必须使用机器声明与显式 `stdin-v1` 协议；旧的纯文本脚本引用
不自动兼容。主脚本内容与调用在批准前后核对，以只读文件沙箱、限时、限输出和原生取消机制执行。
首版限定 POSIX 与原生解释器发现。文件只读不等于网络、设备或动态依赖隔离。

具体声明、参数顺序、环境及迁移限制按需读取
[项目解析器协议](<node/skills/satellite-investigation/references/project-parsers.md>)。
子会话无法获得批准时应将准确请求交回父协调者，由父在自己的宿主批准边界调用；不得转述批准或用普通 shell 绕过。

## 验证边界

本地测试覆盖失败关闭、乱序会话、父权限收紧、扩展恢复、事实门禁及结果交接；
替身通过不等于真实 Host 已验收。部署更新后仍需有界验证：

- 父会话只读时请求实施，子会话仍只读，不能借角色模式获得写权限。
- 前置调查的独特证据必须实际出现在基础节点输入与父结果中；暂停恢复不再次执行已完成扩展。
- 设置页成功写入后读回相同覆盖；冲突/拒绝保存保留草稿；恢复默认后不产生整表快照。
- 只测试授权范围；拒绝后不绕过、不自行升级权限，恢复测试改变的配置与探针文件。

无原生等效约束的外部委派后端、PTC呈现及不同平台沙箱需各自验证，本包不会以单路径探针宣称全部覆盖。

## 开发

源码是 TypeScript，放在 `src/`；用 **tsdown** 构建到 `lib/`；发布物是 `lib/` 加包内资源。

```bash
npm_config_cache=<工作区>/.npm-cache npm install
npm run build      # tsdown → lib/
npm run typecheck  # tsc -p tsconfig.json
npm test           # 先 build，再 node --test test/*.test.mjs
```

`npm test` 先构建，再运行测试。入口、装配与既有用例覆盖构建产物；新增索引/脚本模块另有直接加载 TypeScript 的隔离反例测试，不能用它们代替真实宿主验收。

`locale/`、`icon.svg`、`node/skills/`、`android/skills/` 等资源**不参与构建**，保持在包内原位，
由 `exports` 与 `files` 指向；技能加载器从包根推导资源目录（见 `src/lib/skills.ts`）。

更多细节见 [docs/DEVELOP.md](docs/DEVELOP.md)。

## 发布形态说明（相对参考项目的一处有意扩展）

本包以 `DSHOAuth` 的发布模式为参考。参考项目的发布脚本断言"包内第一层只允许
`lib/`、`package.json`、`README.md`、`cordis.patch.yml`、`LICENSE`"。

Satellite 是**带资源的包**：`locale/*.json`、`icon.svg`、`node/skills/`、`android/skills/`
必须随包分发，否则子组件没有标题/描述/图标，节点工具也读不到方法技能。
因此本包**扩展了该发布白名单**：除 `lib/` 与 manifest 外，允许上述资源目录。
`test/package.test.mjs` 是这条约定的质量门（钩子禁令、入口文件真实存在、`files` 含 `lib` 与资源、无 `dependencies`、peer/dev 版本集合一致）。

## 许可

MIT。
