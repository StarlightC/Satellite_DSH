# Satellite

Satellite 是 DeepSeek Harness 插件，帮助 Agent 按**调查 → 方案 → 实施 → 验证 → 审查 → 验收**推进项目任务，并可按需加入 Android 专项能力。

## 使用要求

- Node.js `^22.19.0 || >=24.0.0`。
- DeepSeek Harness 0.2.1 系列及兼容版本。
- 已配置可用的模型服务；默认角色使用 `deepseek-official`，也可改为自己的模型。

## 安装

### 从 GitHub 安装（推荐）

在 Harness 的 `plugin_manager` 中使用完整安装目标（显式指定包名和发布分支）：

```json
{"action":"install_bundle","target":"satellite@github:StarlightC/Satellite_DSH#main"}
```

仓库默认分支 `source` 用于开发，不包含 `lib/` 编译产物；`main` 由稳定版本发布流程同步，包含可直接安装的成品。不要使用不带 `#main` 的仓库地址，也不要安装源码 tag。显式写出 `satellite@` 可避免安装器无法识别目标包而返回 `ambiguous-install`。

如果之前安装了源码分支，直接使用上述目标重新安装即可。若 Harness 返回 `restart-required`，请重启 Harness（仅刷新页面不够）。

### 从 Release 文件安装

发布后，从 GitHub Releases 下载 `release.tgz` 并解压，使用 Harness 的 `plugin_manager` 安装解压得到的包目录：

```text
install_bundle <解压后的 package 目录>
```

发布包已包含运行所需文件，无需自行构建。不要手动修改 Harness profile 的包清单或直接运行包管理器安装。
本地目录以链接方式安装，请保留该目录；替换包文件后需要重启 Host。

一次安装包含三个可分别启停的组件：

| 组件 | 默认状态 | 用途 |
| --- | --- | --- |
| Satellite Slots | 启用 | 为节点和扩展提供共同服务，使用其他组件时请保持启用 |
| Satellite Node | 启用 | 提供流程节点、复用查询和项目技能脚本工具 |
| Satellite Android | 停用 | Android 专项调查、方案、验证、审查、验收，以及可选的本地执行工具 |

## 使用流程

向 Agent 描述任务，并要求使用 Satellite 节点推进，例如：

> 使用 Satellite 先调查登录流程的问题，再提出方案；等我确认后实施，并完成验证和审查。

节点工具为 `satellite_node`：

| 节点 | 用途 | 默认权限需求 |
| --- | --- | --- |
| `context` | 有界调查，整理事实、可复用内容与缺口 | 只读 |
| `solution` | 提出方案，列出需要用户决定的事项 | 只读 |
| `implement` | 按已确认的范围实施 | 工作区写入 |
| `validate` | 执行适用检查，报告证据与未测项 | 工作区写入 |
| `review` | 独立审查当前改动 | 只读 |
| `signoff` | 根据已有证据给出验收结论 | 只读 |

每次调用运行一个节点及其适用的前后扩展，不会自动串行执行全部六个节点。验证可能生成构建或测试产物，但不负责修复源码；验收不会自动修改代码，运行完成也不等于业务验收通过。

### 等待确认与恢复

如需节点完成后等待处理决定，可传入扁平事实键 `acceptance.required`：

```json
{"node":"validate","task":"运行本次有界验证","facts":{"acceptance.required":true}}
```

返回 `needs_decision` 时，用返回的 token 恢复同一节点，已完成的基础步骤不会重跑：

```json
{"node":"validate","task":"运行本次有界验证","resume":"<返回的 token>","decision":"accept"}
```

该行为由 `builtinExtensions.acceptanceDecision` 控制，默认开启。普通决定不能替代宿主的权限批准。

## 难度评级与升降级

这套机制分为**任务执行难度**（light / standard / critical）和**节点角色等级**（light / standard / senior）。主 Agent 按事实初评、在新证据或重复失败后复评；Critical 不自动选 Senior，安全拆分后的轻量单元也不能取消整体风险检查。

评级、失败预算与降级理由是技能指导下的判断和报告，不是自动评分器、持久计数器或任务调度服务。主 Agent 应读取基础流程技能链接的[评级与升降级方法](<node/skills/satellite-base-flow/references/difficulty-and-escalation.md>)，再分别选择实施、审查和验证角色。Android 的[平台风险补充](<android/skills/android-change-review/references/task-risk.md>)保留在领域技能中。

### 选择节点角色等级

`satellite_node` 新增可选 `tier`，例如：

```json
{"node":"implement","unit":"local-resource-fix","tier":"light","task":"修复已确认的局部资源引用；仅改指定单元并执行必要编译检查。"}
```

| 节点 | light | standard | senior |
| --- | --- | --- | --- |
| implement | `implementation-light` | `implementation` | `implementation-senior` |
| review | `change-review-light` | `change-review` | 默认未配置，返回缺口 |
| validate | `validation-light` | `validation` | 默认未配置，返回缺口 |

- **不传 `tier` 保持原有角色选择**。`context`、`solution`、`signoff` 默认不提供等级映射。
- 显式等级必须存在于该节点的 `nodes.<node>.tierRoles`，且目标角色真实存在；缺失时不会静默退回默认角色。`critical` 不是合法的角色等级。
- 等级映射只选择基础节点角色，不跳过前后扩展，不改变扩展自己的角色，也不改变父会话权限。
- `selection` 表示本次选定的角色与等级；`execution` 表示已通过创建边界的基础角色及向后端请求的显式模型路由，不是从子会话读回的模型实测值。前置暂停或创建前拒绝可以只有选择、没有执行；启动也不等于业务完成或验收通过。
- 同一暂停调用冻结等级和角色。`resume` 时可省略 `tier` 以继承原选择，不能改变它；需要升级或降级时发起新的有界节点调用。after 恢复复用原基础结果，不把新的模型设置当作上次已执行的模型。

部署可通过 `nodes.<node>.tierRoles` 显式配置允许的角色映射，支持这三个等级名；提供的映射整体替换该节点默认映射，空对象可禁用显式等级。已有 `nodes.<node>.role` 覆盖会移除隐含的内置等级映射，避免绕过自定义角色；需要等级时须同时显式配置映射。角色定义、方法与文件沙箱仍归 `roles`，模型覆盖仍只走 `routes`。

新增角色沿用对应类别的现有默认模型，不因为 Senior 名称另选更贵模型。各角色的 `routes` 独立：新增角色不会自动继承旧角色的用户模型覆盖，请核对所用档位的实际模型。模型相同不意味着职责相同，模型不同也不等于获得专项能力。

### 失败与复评边界

- 实施预算为同一单元、当前等级最多三次有证据的失败尝试，可发生在一次子调用内；重派、改名或刷新上下文不能清零。耗尽后按 Light → Standard → Senior/专项 → 专项或用户方向处理。
- 审查、验证使用各自的返工升级规则，不能机械套成三次。未配置更高角色或缺少专项方法时，报告缺口而不是重复同配置假装升级。
- 计数依据完整修改假设和验收失败证据，不是工具报错次数、节点 `kind` 或 Agent `stopReason`；权限、设备、依赖等外部阻塞单独报告。
- 新证据可支持更轻的角色。不得为赶时间、工具不足或规避未解决问题而降级；若会减少已约定的审查/验收义务、改变批准范围或模型使用约定，先请用户确认。
- 历史依赖现有会话记录和节点摘要；恢复后证据不足时明确报告，不声称自动恢复预算或未完成节点。原有 `resume` 令牌仍仅服务当前运行时调用，不承诺跨 Host 重启恢复。

程序测试验证角色选择、路由和恢复等可达调用路径，不能证明模型正确理解每次失败假设。语义行为的人工验收案例见开发仓库中的 `test/tier-scenarios.md`，不作为已执行的自动测试。

## 配置模型

默认验证角色使用 `deepseek-flash`，其他内置角色使用 `deepseek-v4-pro`，均通过 `deepseek-official`。
可在设置页修改角色模型，保存后下次调用生效，无需重启。

如使用行配置，通过 `routes` 覆盖模型，例如：

```yaml
routes:
  - role: investigation
    provider: <provider-id>
    model: <model-id>
  - role: validation
    provider: <provider-id>
    model: <model-id>
```

六个节点对应的角色依次为 `investigation`、`solution-design`、`implementation`、`validation`、`change-review`、`acceptance`；Android 调查角色为 `android-context`。
`reasoningEffort`、`maxTokens` 等模型选项也写在对应 route 中。不需要自定义的项目保持默认即可，升级不会强制清除用户覆盖。

旧配置若含内置 `roles.<role>.agentOptions` 模型覆盖，请迁移到 `routes`；若含 `roles.<role>.cwd`，请删除，该字段不再支持。

### 插件角色说明

配套 UI 只配置已定义角色的模型，不提供“新增角色”。节点行通过原生只读 Remote `satelliteRoles.describe()` 提供版本化角色目录：友好名称、有效职责、方法技能、配置的文件沙箱，以及当前节点/已注册扩展的执行位置和触发说明。目录来自实际装配配置与扩展快照，不调用模型或执行扩展；部署自定义角色可用 `roles.<role>.label` 补充显示名称。

打开页面或刷新角色说明时重新读取目录。停用 Android 扩展后，角色定义仍在，但目录不再列出已撤销的绑定。说明只表示配置和挂载，不代表当前任务匹配、技能就绪或已获权限；实际权限仍受父会话限制。

只有 `routes`、没有角色定义的旧条目不会创建角色，UI 标记为未关联并原样保留，直到用户明确清理。角色目录不可用或版本/结构不兼容时，UI 明确提示并停止修改，不能把读取失败当成角色已删除。模型保存仍仅修改 `routes`，不写入角色说明、角色定义或节点绑定。

此只读通道使用宿主原生 Typert Remote 的无参 `src-json` 结果描述符（已按 `0.2.1-alpha.2` 契约实现），UI 校验结果结构；不增加 HTTP 服务或手写传输。旧版主插件没有目录接口时需同步升级两包。这里展示的是重新读取时的快照，不是扩展启停的实时推送。

## Android（可选）

在设置页启用 Satellite Android，即可使用按需的只读专项扩展。设备、构建等执行能力默认关闭，需要在 Satellite Android 设置中显式开启并配置本机路径：

```json
{
  "execution": {
    "enabled": true,
    "androidCli": "/abs/path/to/android",
    "privacy": "verified-disabled",
    "adbPath": "/abs/path/to/adb",
    "emulatorPath": "/abs/path/to/emulator",
    "avdmanagerPath": "/abs/path/to/avdmanager",
    "javaHome": "/abs/path/to/jdk"
  }
}
```

- `androidCli` 用于动态发现构建信息；`privacy` 仅在已核实关闭相关遥测时设为 `verified-disabled`，明确同意时可设为 `explicit-user-opt-in`。未选择时不执行动态发现。
- `adbPath` 用于设备操作；`emulatorPath` 用于模拟器操作；`avdmanagerPath` 仅创建、删除 AVD 时需要；`javaHome` 用于 Gradle。
- 工具不会自动寻找 SDK/JDK、安装依赖或下载镜像。缺少某项配置时，对应操作会报告不可用。
- 设置保存后无需重启。执行工具在组件启用后可见，但只有满足配置与权限要求时才能执行。
- 动态执行（发现构建、构建、设备、模拟器、旅程、采集）与项目技能脚本当前只支持 **Apple (macOS)** 宿主执行环境；Linux、Windows 与无法判定的宿主会明确报告 unsupported，不会回落或猜测。
- Android 动态工具在批准前后重新检测宿主平台；批准期间变为不支持的平台或平台 id 改变时停止，不启动新进程。已有模拟器的作用域退出/卸载清理不受此门禁影响。
- 静态 `project.inspect` 与只读专项方法不依赖动态平台实现；静态检查可识别 `gradlew` 和 `gradlew.bat`，识别 Windows 路径不代表已支持 Windows 执行。

| 工具 | 用途 |
| --- | --- |
| `satellite_android_project` | 检查项目、发现构建信息 |
| `satellite_android_build` | 执行指定构建 |
| `satellite_android_device` | 发现设备、安装和启动应用、检查前台状态 |
| `satellite_android_emulator` | 管理模拟器 |
| `satellite_android_journey` | 执行有界操作与断言 |
| `satellite_android_capture` | 采集日志、内存、录屏或性能数据 |

设备操作应先发现目标并取得观测 id；安装、启动、旅程和采集会使用该 id 复核设备，不接受仅凭 serial 执行。
工具复用 Harness 的批准机制，遇到拒绝或权限不足时不会绕过。

Android CLI 与 Gradle 的用户目录定向到会话工作区内的 `.satellite/`，可能产生缓存和构建文件。
启动的模拟器由当前会话管理，可显式停止；会话作用域退出或插件卸载时也会清理，但不保证 Host 崩溃后的清理，也不提供跨进程设备独占。

## 其他工具

- **复用查询**（`satellite_reuse_query`）：查找已有代码候选并报告来源与新鲜度；没有索引时回到普通搜索，不会自动建立索引。使用候选前仍需核对源码。
- **复用维护**（`satellite_reuse_maintain`，需启用 Android 组件）：经批准为明确的文件集合初始化、更新或重建索引，不代表已扫描整个项目；不会覆盖用户自己的排除设置。
- **项目技能脚本**（`satellite_skill_script_run`）：仅运行已加载项目技能中明确声明的脚本，需批准，受只读文件沙箱、时间与输出限额约束；当前仅支持 Apple (macOS) 宿主执行环境，不能用于提交任意 shell 命令。

## 权限与限制

- 角色权限不能超过父会话权限；父会话只读时，实施和验证节点也无法获得写权限。
- 文件沙箱不等于网络或设备授权；可写工作区也不代表可以修改任务范围外的文件。
- 无法保证所需权限约束或缺少必要宿主能力时，相关操作会拒绝执行。
- 宿主平台检测基于调用作用域的文件系统正向标记，不是授权或世界身份证明；它只用于决定"当前执行世界能否运行"，不会扩大任何权限。
- 远程执行环境及不同后端的能力可能不同；本地测试通过不代表所有宿主和平台均已验证。请以实际返回的证据、未测项及限制为准。

## 许可

MIT，见 [LICENSE](<LICENSE>)。
