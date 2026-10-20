# Satellite

Satellite 是 DeepSeek Harness 插件，帮助 Agent 按**调查 → 方案 → 实施 → 验证 → 审查 → 验收**推进项目任务，并可按需加入 Android 专项能力。

## 使用要求

- Node.js `^22.19.0 || >=24.0.0`。
- DeepSeek Harness 0.2.1 系列及兼容版本。
- 已配置可用的模型服务；默认角色使用 `deepseek-official`，也可改为自己的模型。

## 安装

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
- **项目技能脚本**（`satellite_skill_script_run`）：仅运行已加载项目技能中明确声明的脚本，需批准，受只读文件沙箱、时间与输出限额约束；当前仅支持 POSIX 环境，不能用于提交任意 shell 命令。

## 权限与限制

- 角色权限不能超过父会话权限；父会话只读时，实施和验证节点也无法获得写权限。
- 文件沙箱不等于网络或设备授权；可写工作区也不代表可以修改任务范围外的文件。
- 无法保证所需权限约束或缺少必要宿主能力时，相关操作会拒绝执行。
- 远程执行环境及不同后端的能力可能不同；本地测试通过不代表所有宿主和平台均已验证。请以实际返回的证据、未测项及限制为准。

## 许可

MIT，见 [LICENSE](<LICENSE>)。
