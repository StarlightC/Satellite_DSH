# Satellite

Satellite 是 DeepSeek Harness 插件，帮助 Agent 按**调查 → 方案 → 实施 → 验证 → 审查 → 验收**推进项目任务，并可按需加入 Android 专项能力。

## 使用要求

- Node.js `>=24.9.0`。
- DeepSeek Harness：安装范围为 `>=0.2.2-alpha.3 <0.3.0`，不再锁定单一版本或源码提交；范围包含 `0.2.2-rc.1` 和后续范围内版本。版本范围不代替运行时接口检查：节点行在注册任何节点或工具之前检查 `subagents.rootOf`、`subagents.startActivation`、`tools.guard` 与事件注册能力，缺失时明确报告，不做旧接口猜测回退。0.2.1 等旧宿主不在安装范围内。已完成的真实 Loader 验证基线是源码 `8bd073392eef6f54e921a093b95076248eb08cbb`（`0.2.2-alpha.3`）；这不代表范围内所有版本都已验证。npm 上曾有同号但缺少 `rootOf`、仍使用 `request` 包装的构建，这类接口不兼容的宿主仍会被能力检查拒绝。
- 工具执行器只支持 native（`@deepseek-ai/dsh-tool-executor-native`，默认 preset 即是）。PTC 执行器只允许直接调用 `run_code`，与主会话协调边界及版本管理"禁止脚本/嵌套执行"冲突：在 PTC preset 下主会话的 `run_code` 与角色内的 `run_code` 会被拒绝并提示改用 native preset，不会执行程序。
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
| `version-control`（可选，无 tier） | 用户明确请求的本地5操作 | 读取只读，写入需工作区权限和真实逐次批准 |

普通角色子 Agent 有固定、不可由角色配置放宽的基线：拒绝 `subagent`、`subagent_fork`、`subagent_<provider>`、`workflow`、`send_message`、`interrupt_agent`、`team_task_create`、`team_task_update` 等不受控委派/通信入口（委派只能经 `satellite_node`）；`list_agents`、`list_subagent_models`、`team_task_list`/`team_task_get` 等只读入口不受此限。角色 `toolFilter` 必须是只含 `allow`/`deny` 合法工具名数组的对象，非法值在装配时报错；`allow: []` 视为配置错误，未知工具名（作用域局部工具）合法。

七个节点是可用目录，不是默认流水线；`version-control` 不进入任何默认意图路径。每次调用运行一个节点及其适用的前后扩展，不会自动串行执行全部节点。验证可能生成构建或测试产物，但不负责修复源码；验收不会自动修改代码，运行完成也不等于业务验收通过。

### 可选本地版本管理

只有明确用户请求才选择 `satellite_node(node="version-control")`；不自动跟随 feature、验收或版本号修改。专用同名角色及 [方法技能](<node/skills/satellite-version-control/SKILL.md>) 仅可调用 `satellite_version_control` 和必要的 skill/提问/只读方法工具，真实 child scope guard 在开始前施加，拒绝 bash、编辑、解释器、PTC、脚本、网络、委派及衍生 scope；主会话和普通 child 不能直接调用本地工具。角色可在既有目录显示并配置模型路由，但普通配置不能改宽权限或绑定别的角色，无 tier。

工具接收封闭 `request`：`status`、`diff`（working/staged）、`log`（HEAD，正安全整数条数）、`stage`（非空明确文件列表）、`commit`（整个实际 index）。仓库相对于真实 child cwd，必须在有效父 workspace 内；无任意 flags/rev/remote 字段。每次写入绑定新鲜单次 snapshot、精确 argv、真实身份和 policy，并要求宿主 `allowed-once`，批准期间变化即拒绝。commit 覆盖已存在的全部暂存，不只是本次 stage 文件；不自动 stage/commit。失败可能返回 effect-unknown，必须先观察，不自动重试。

禁止 fetch/pull/push/clone 等远程操作；不支持 tag/branch/reset/clean/amend/rebase/checkout/switch/restore/merge/stash 等。版本文本仍由 `implement` 修改，implementation 仍禁提交。缺服务只阻塞本功能，不借主会话服务或放宽沙箱。

只支持 host-shared POSIX：child fs 必须证明 workspace/cwd 与固定 `/usr/bin/env`、`/usr/bin/git` 为同一宿主文件且进程路径不变，subprocess 与其共享执行世界；不明确、容器重映射或 Windows 拒绝。每进程强制 full 原生 confinement（读 read-only，写 workspace-write），不超过父权限；clean `env -i`，禁 hooks/filter/signing/extdiff/lazy fetch。正常合法配置、vscode/未知惰性 key、attributes/宏可用；针对可达风险拒绝 executable filter 定义、include 与 worktree 重定向，已由固定参数禁用的 hooks/fsmonitor/pager/signing/diff driver 配置可保留。

**DSH child 固定 approval=never；stage/commit 由受信运行时在父会话开放的显式节点调用内使用父作用域服务执行，真实逐次 allowed-once 后、最终 confine 到 spawn 核对策略、布局、必要元数据和 stage 目标。** 明确 commit 默认一次 version-control 节点完成：status 确认 scope，必要时一次合并 diff 总结，按需 stage 后再一次 status，核对完整实际 index 后 commit；不主动追加其它节点、测试/build/质量审查/验收、逐文件 diff 或全树重复调查。已有批准内容不要求再次逐行 review，成功只短报 message/hash/scope，不再主动 log/status。观察只绑定 HEAD/index/config、必要 attributes/locks/layout 及 status 报告变化或明确 stage 目标，不哈希 ignored/dependencies、objects、refs/logs/hooks 全树，也不为 commit 哈希每个 index 对应 worktree 文件。普通 hardlink 内容与 symlink linktext 支持且不 follow，metadata 仍拒链接/硬链接；子模块 metadata 不递归，stage 子模块 HEAD/content 仍不支持。浅仓库、本地 gitlinks 和规范 linked worktree 支持保持；partial-clone/alternates/config.worktree 等既有执行边界保持。linked worktree 仍按 commonDir 串行，外部 commonDir 须证明 host-shared 映射并在本次调用精确授予 additionalWritableRoots；无关 sibling index/worktree 改动不再使本树 commit 失效。token 在消费及开始审批前须新鲜；用户阅读审批超五分钟不再单因时间拒绝，内容/index/HEAD/config/policy/layout 等变化仍拒。commit 返回 before/after HEAD、index 摘要及完整 scope；stage 暂不跨父子返回 replacement token（通常共两次 status）。diff 超 128KiB 展示预算返回明确截断预览，不能当作完整摘要或批准；内部完整 index/status cached raw diff/审批 patch 保留现有每流 16MiB 资源上限，截断仍拒。effect-unknown 保留且不自动重试。本地临时 fixture 的模拟宿主测试不等于真实宿主审批 UI 或 Axon 性能实测；详情见 [限制](<node/skills/satellite-version-control/references/limits.md>)。

**委派子 Agent 的其他审批工具（Android 全部审批动作、`satellite_reuse_maintain`、`satellite_skill_script_run`）同样不让 child 弹窗：** child 仍为 never，执行仍用 child 自己的 fs/沙箱/子进程；每次子调用由受信运行时把一次审批转给 exact live 父会话（标注父 `satellite_node` callId、子 callId 与完整计划），仅 `allowed-once` 放行本次调用，不缓存、不重放，批准后到每次 confine/spawn/写入前复核委派、会话、服务与工具定义。父为 never、无应答者、拒绝或取消时失败关闭并说明原因；不新增任何沙箱权限。device `discover` 也需要审批。委派调用绑定 child 原始 fs/sandbox/subprocess/shell/sandboxPolicy 与其策略快照：任何选定模式不得宽于 child 当前上限，委派路径的 `sandboxPermissions`/升级请求一律失败关闭，未经 confine 的自动 danger 运行在 spawn 处被拒；父策略在每次复核时重新读取（变为 never 或读不到即拒）。旅程/采集在取消或许可失效后仅通过有界清理能力删除本次登记的设备临时文件（精确 serial/路径/`rm -f`），不做 pull 或其他动作。审批 broker 由 node 行在本地创建，发证方不出该闭包；Android 只经可选注入的内部（非 Remote）服务取得消费者，node 卸载即作废，无 node 时 child 保持 never，不回落根会话。**信任域说明：** 同进程的 Host 插件属受信代码，本机制不对恶意进程内插件提供隔离；它保证的是模型与客户端没有可伪造发证/身份的入口。

**基础节点的一次父请求交回（`satellite_parent_request`）：** 只有实际沙箱非只读、且父会话权限不比它更宽的基础 child（默认如 implement、validate；与节点名无关，自定义 tier 同样适用）的真实作用域会注册该工具；只读基础角色、扩展角色与主会话都看不到、也不能调用它；父已更宽时该能力不可用，child 任务会写明原因，普通节点照常运行。child 只能暂存一条通用请求 `{tool, arguments}`（`reason` 可选、仅作数据）：`tool` 必须是父作用域中 `tools.get` 与 `tools.executable` 解析到同一定义的已有工具（条件注册、子父看到不同定义、未挂载或被过滤均拒绝），`arguments` 必须是普通无损 JSON 对象（有大小上限），并先用宿主同一 `validateJsonSchemaValue` 按该工具自身参数 schema 预校验；通用层不维护命令或业务字段白名单，`bash` 的 `command`/`sandbox_permissions`/`justification` 等与其它参数一样只做原样精确匹配。请求自身、`run_code`/PTC、主会话协调闭集工具与不受控编排入口不能作为目标；来源角色的 allow/deny 仍对目标适用。每次节点调用（含 resume）最多一条。只有该节点真正完成（base `completed` 且父调用未取消、父仍解析到同一目标定义、来源角色与父权限未扩大）才发布一张待确认票（`parentAction.status=ready`）：运行时行级 guard 在任何 `tools/execute` wrapper 之前为本行真实 `satellite_node` 记录宿主执行 token、Agent、callId 与原始 signal，只有同一执行的冻结最终 `tools/result` 是成功且规范值未被 wrapper/post-execute 改写时才开放该票，最终失败、取消、阻断或改写都撤销它；未经宿主管线的调用不获得该能力；暂停也只有在该次暂停结果原样交付后才保留到同一 token/调用方/unit 恢复（暂存该请求的原父调用若已取消，恢复也保守作废、不发布），票据自请求起 10 分钟过期且恢复不刷新；失败/取消/错误丢弃，父 dispose/行卸载/工具定义替换撤销，正常 child end 不丢已暂存请求（之后按保存的来源角色/模式快照与父实时权限复核）。主会话协调 guard 仍是默认闭集：闭集工具照原路径放行且不消耗票；其它工具只有该 exact 父、同名票据、未替换的定义、按规范键排序后完全相同的参数（缺省与显式值不同）、父权限仍不宽于来源角色、未过期且未消费时才放行一次，并在 guard 内原子消费（后续其它 guard 或宿主拒绝不退还）；参数不同则不进入目标工具主体（因此也没有主体内审批）、不执行；但宿主的执行前策略审批（pre-execute ask）先于 guard，仍可能先弹出，本插件不改变宿主审批。票据只准按原参数调用、不授予任何权限：目标 `bash` 带显式 `sandbox_permissions` 时仍由原工具自己的审批决定。结果里的 `parentAction` 与票据只是审计数据（tool/args/source node/run/expiry），不是用户同意、批准或权限提升、不可重放；通用层不代填 `approvedBuilds`/`acceptRisk`/权限理由。主 Agent 调用前须读原工具说明，原工具要求的用户许可或前置条件（如 `plugin_manager` 的先 list、改动需用户明确同意）未满足就不调用；child 不能自声明用户已批准，主会话也不能调用该 child 工具或凭 facts/文本/resume token 造票；`run_code`/PTC、脚本、fs、web 等原有 guard 不变。

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

## 方案评分与决策支持

`solution` 与父会话自己提出的方案都按[方案评分参考](<node/skills/satellite-solution/references/option-scoring.md>)给出最小评分内容：必要性 N、目标方向一致性 D、复杂度适配 C、证据充分性 E（各 0–4，或以显式 U 表示未知），`T = N + D + C + E`。T 是决策支持指数与置信度计算，不是成功概率，也不宣称客观确定或经统计校准；算术可复算，评分判断不可。

先执行硬否决/暂停，再看得分：

- 越权或改变目标、`D <= 1`、`N <= 1` 不能推荐；关键未知或 `E <= 1` 先调查。
- `C <= 1` 必须简化/拆分，或有证据说明该规模不可避免，且不得靠总分自动放行；`C = U` 不能当作可实施。
- `N <= E + 1`：技术必要性不能比证据多走一步；`N = 4` 需要排他性依据，用户要求“有方案”不等于某个具体技术方案必要。
- 推荐需 `N, D, C, E >= 3` 且 `T >= 12`；有条件候选（`min(N, D, E) >= 2` 且 `T >= 9`）只用于待补证据或决定讨论，不等于可执行或已批准；`C = 2` 只能作为候选，裁剪并重评后才可进入推荐；`E = 1` 先调查。

每个实际被评估的选项要给出分数、逐维依据/缺口和判定，并至少考虑不改、最小满足、更大改动（不可行者简述，不硬造选项）；同时写明反例挑战：若不必要会看见什么、已查/未查什么。未排除替代不得写“只能/必须”。父节点必须传用户原目标和授权边界，转述不得抬高证据；建议不能当作同意。只有新证据才重评分，不靠换模型或换档位刷分。

分数门槛不替代用户决定或宿主审批；有待决定时复用现有 `acceptance.required` 暂停并恢复，不新增强制扩展，也不宣称程序强制。已授权、无技术选择的纯数值/文字修改可用一行说明，不虚构比较、不额外跑 solution；该轻量例外不覆盖技术、权限、依赖、脚本、schema 或公开契约改动。这是 Agent 方法，不是运行时评分器；文档契约测试只检查存在、链接与锚点/门槛结构，不验证语义执行。

## 难度评级与升降级

这里有两个**独立**选择：

- **任务执行难度**：light / standard / critical，描述整个任务的风险与所需审查、验证义务。
- **节点角色档位**：light / standard / senior / critical，为一次 solution、implementation 或 review 单元选择已配置的角色。

两者即使同名也不绑定：Critical 任务不自动选 Senior 或 Critical 角色，独立且安全的单元仍可用 Light；Critical 角色也可以处理一个 Standard 任务里反复失败的顽固问题。档位只改变职责深度，不提升工具、沙箱、父会话权限或其他审批权限。

评级、失败预算、方案评分与降级理由是技能指导下的判断和报告，不是自动评分器、持久计数器或任务调度服务；方案评分（N/D/C/E/T）不参与任务难度或角色档位推导。主 Agent 应读取基础流程技能链接的[评级与升降级方法](<node/skills/satellite-base-flow/references/difficulty-and-escalation.md>)，再分别选择方案、实施和审查角色。Android 的[平台风险补充](<android/skills/android-change-review/references/task-risk.md>)保留在领域技能中。

### 选择节点角色档位

`satellite_node` 提供可选 `tier`，例如：

```json
{"node":"implement","unit":"local-resource-fix","tier":"light","task":"修复已确认的局部资源引用；仅改指定单元并执行必要编译检查。"}
```

| 节点 | light | standard | senior | critical |
| --- | --- | --- | --- | --- |
| solution | `solution-design-light` | `solution-design` | `solution-design-senior` | `solution-design-critical` |
| implement | `implementation-light` | `implementation` | `implementation-senior` | `implementation-critical` |
| review | `change-review-light` | `change-review` | `change-review-senior` | `change-review-critical` |

四档职责是方法深度，不是模型名称或口号：

- **light**：边界清楚、局部低歧义的单元；说明局部影响和未检查范围，但不得略过该单元实际必要的安全检查。
- **standard**：常规求解（审查为常规审查）并检查完整影响，核对真实消费者与相关检查。
- **senior**：跨模块耦合、复杂约束或已有失败证据的单元；先复核旧证据，不重复已被否定的方法。
- **critical**：重新检验核心假设、构造反例、深入处理顽固问题；不与高风险自动绑定，不要求每项都不可逆，也不禁止在证据充分时给出通过结论；仍无解时停止并报告缺口、请求决定。

- **不传 `tier` 保持原有默认角色**。`context`、`validate`、`signoff` 默认不提供档位映射，应不带 `tier` 调用；`validate` 仍是独立的验证步骤，不能由更高档的实施或审查角色替代。
- 显式档位必须存在于该节点的 `nodes.<node>.tierRoles`，且目标角色真实存在；缺失时不会静默退回默认角色。省略 `tier` 时节点默认角色仍可用。
- 档位只选择基础节点角色，不跳过前后扩展，也不改变扩展自己的角色。`solution`、`review` 各档保持只读；`implement` 各档继承同一写工具与沙箱边界，父会话权限仍是上限。
- `selection` 表示本次选定的角色与档位；`execution` 表示已通过创建边界的基础角色及向后端请求的显式模型路由，不是从子会话读回的模型实测值。前置暂停或创建前拒绝可以只有选择、没有执行；启动也不等于业务完成或验收通过。
- 同一暂停调用冻结档位和角色。`resume` 时可省略 `tier` 以继承原选择，不能改变它；需要改档时发起新的有界节点调用，并在任务包中携带触发改档的证据。after 恢复复用原基础结果，不把新的模型设置当作上次已执行的模型。

除保留的 `version-control` 节点外，部署可通过 `nodes.<node>.tierRoles` 为节点显式配置角色映射，支持 `light`、`standard`、`senior`、`critical` 四个档位名；提供的映射整体替换该节点默认映射，空对象可禁用显式档位。已有 `nodes.<node>.role` 覆盖会移除隐含的内置档位映射，避免绕过自定义角色；需要档位时须同时显式配置映射。角色定义、方法与文件沙箱仍归 `roles`，模型覆盖仍只走 `routes`。

新增角色的代码默认路由复制对应基础角色的既有默认 `agentOptions`，不为 Senior/Critical 另选“更强”的模型；各角色运行时仍只匹配自己的 `routes` 条目，不自动继承用户给基础角色的覆盖。模型相同不意味着职责相同，模型不同也不等于获得专项能力。

### 迁移：validation-light

本版移除内置 `validation-light` 角色，并移除 `validate` 节点的默认 `tierRoles`。已有 profile 不会被自动改写，以下三种残留分别处理：

- **只有旧 `route`**：`routes` 里仍有 `role: validation-light` 的条目会原样保留，但不再对应内置角色，也不会被派发；它不会自动映射到 `validation` 或其他角色。保留的旧 `route` 只是用户配置，不是可派发能力。
- **旧 `tierRoles` 映射、无同名 `roles` 定义**：自定义 `nodes.validate.tierRoles` 仍指向 `validation-light` 时，显式选择该档会以“未配置角色：validation-light”停止，不会静默回退；其他角色或省略 `tier` 的默认验证仍按配置工作。
- **旧 `roles['validation-light']` 局部覆盖**：不会再被当成自定义角色。配置归一化会直接以迁移错误停止（装配前，不注册工具、不启动任何节点），提示删除该局部覆盖；如确需自定义用途，请改用新角色名定义完整角色，并把 `nodes.<node>.tierRoles` 与 `routes` 的引用改到新名。旧名不会作为别名保留。
- **清理办法**：删除旧 `route`；删除或改写自定义 `tierRoles` 中的旧引用，或把它指向一个真实存在的角色；删除旧的 `roles['validation-light']` 覆盖。
- 这项检查只针对已退役的 `validation-light` 名称，不是通用角色名校验；其他自定义 `roles` 与 `tierRoles` 不受影响。

### 失败与复评边界

- 只有**实施**使用“同一单元、当前档位最多三次有证据失败”的预算，可发生在一次子调用内；重派、改名或刷新上下文不能清零。达到当前档预算后按证据选择更高档或专项；更高档有自己的预算，并继承此前失败历史，但不把旧尝试算进新档次数。
- `solution` 与 `review` **不套三次预算**；它们的换档依据是证据变化（歧义、耦合、影响面或既有失败），不是机械次数。`validate` 没有角色档位，验证失败是任务证据，不能仅凭它自动换成更贵模型。
- `critical` 仍无法解决时停止，报告未解缺口并请求决定，不无限重试或自行升到不存在的档位。
- 计数依据完整修改假设和验收失败证据，不是工具报错次数、节点 `kind` 或 Agent `stopReason`；权限、设备、依赖、凭据等外部阻塞单独报告，不通过升级模型解决。
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

此只读通道使用宿主原生 Typert Remote 的无参 `src-json` 结果描述符（按 `0.2.2-alpha.3` 契约实现），UI 校验结果结构；不增加 HTTP 服务或手写传输。旧版主插件没有目录接口时需同步升级两包。这里展示的是重新读取时的快照，不是扩展启停的实时推送。

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
- 静态 `project.inspect` 与只读专项方法不依赖动态平台实现；静态检查可识别 `gradlew` 和 `gradlew.bat`，识别 Windows 路径不代表已支持 Windows 执行。每次最多检查 50 个候选子目录，`facts.truncated` 标明预算截断，`facts.diagnostics` 列出读取错误/扫描缺口；未扫描或未读成功不能解释为不存在，`missing` 仅列已完整检查范围的缺失。
- CLI 版本记录稳定 semver（允许 build metadata），不以未知 major/minor 拒绝；动态发现仍要求 `describe` 的项目锚点、模块/变体/产物结构有效，坏报告不生成可执行观测。
- journey `text` 支持可打印 ASCII 标点、单引号及前导 `-`，空格编码为 `%s` 后整体按 POSIX 远端 shell 单参数引用；拒控制字符、Unicode 和字面 `%s`（普通 `%` 允许）。这是 argv 安全契约，不承诺设备输入效果：AOSP `input text` 依赖 virtual keyboard 的字符能力，中文等需要另有设备支持证据。

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

模拟器 `start`：普通（非委派）调用保持原实现直接启动；只有经委派审批门的调用才对保留进程做原生 confine（full enforcement，否则拒绝），并保留 argv 绑定与 owned 清理。是否 confine 由受信运行时的调用信息决定，不是模型可传参数。真实受限沙箱可能不允许外部 AVD/SDK 目录写入而导致委派启动失败；父会话批准不等于扩大 child 沙箱权限。这里承诺的是授权路由可用，而不是任意外部设备资源在任何沙箱下都可用。

### 专项技能（按需）

Android 组件共加载 12 个方法技能。**5 个**是既有只读扩展使用的方法技能，由**6 条**扩展绑定触发；其中 `validate.before` 与 `context.before` 共用 `android-validation-context`，因此不是 6 个独立技能。另 **7 个**是本次新增的按需专项技能，不新增角色、插槽或扩展绑定，供现有调查、方案、实施、审查、验证与验收节点在任务需要时显式调用。

| 触发位置 | 既有只读扩展 | 方法技能 |
| --- | --- | --- |
| `validate.before` | `android.validation-context` | `android-validation-context` |
| `context.before` | `android.project-context` | `android-validation-context` |
| `solution.before` | `android.design-context` | `android-design-handoff` |
| `review.after` | `android.platform-review` | `android-change-review` |
| `validate.after` | `android.validation-evidence` | `android-validation-evidence` |
| `signoff.before` | `android.acceptance-evidence` | `android-acceptance-evidence` |

按需专项技能：

| 技能 | 适用场景 | 主要边界 |
| --- | --- | --- |
| `android-compose-performance` | Compose 重组、布局、绘制、懒列表、动画和线程开销 | 先有 release 构建的帧/跟踪证据；重组计数与静态推断不算基准 |
| `android-anr-diagnostics` | 静态 ANR 风险审计与 ANR trace 诊断 | 静态结果只是候选；没有 dump/日志不声称 ANR 已发生 |
| `android-permissions-security` | manifest、导出组件、URI 授权、Binder 调用方和运行时权限 | 静态风险不等于可利用；不接触签名密钥或凭据 |
| `android-kotlin-concurrency` | 协程作用域、取消、阻塞边界、Flow 状态/事件与 replay | 不运行 Gradle；消费者/事件契约未定时先停下要决定 |
| `android-compose-state-effects` | 本地状态、状态提升、屏幕 seam、effect 生命周期与一次性事件 | 审查不虚构 owner；焦点导航不在本技能范围 |
| `android-compose-ui-testing` | Compose UI 测试选层、语义断言、交互态和截图证据 | 不执行测试或 Gradle；写了测试不等于已通过 |
| `android-performance-analysis` | 已有 Perfetto trace 的完整性检查、triage、PerfettoSQL、线程状态预算与依赖链归因 | 只分析已有 trace；不录制、不下载工具、不起子代理 |

这些技能是方法指导：调查和审查默认只读，实施只在当前授权单元内修改，执行与测量归对应验证节点；**无授权不执行**构建、设备、外部脚本或发布，风险静态推断不得写成实测结论。

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
