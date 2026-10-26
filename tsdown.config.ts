import { defineConfig } from 'tsdown'

/**
 * 每个入口一段配置。与参考项目一致：宿主侧 ESM / platform node / target es2024，
 * `@deepseek-ai/*` 一律不打包（由 Host 提供），产物名由 `entryFileNames` 固定。
 *
 * 差异说明：本包是**多入口**包（参考项目只有一个宿主入口），入口较多，
 * 因此共享字段由下面的 `entry()` 生成，入口清单仍在数组里逐条显式列出。
 *
 * 资源不参与构建：`locale/`、`icon.svg`、`node/skills/`、`android/skills/`
 * 保留在包内原位，`exports` 与 `files` 继续指向它们。
 */
function entry(name: string, outDir: string, source: string, fileName: string) {
  return {
    name,
    entry: { entry: source },
    outDir,
    format: 'esm' as const,
    platform: 'node' as const,
    target: 'es2024',
    dts: false,
    clean: false,
    deps: { neverBundle: [/^@deepseek-ai\//] },
    outputOptions: { entryFileNames: fileName },
  }
}

export default defineConfig([
  // 包根入口（插件身份行）
  entry('satellite', 'lib', 'src/plugin.ts', 'plugin.js'),
  // 共享库：单元测试直接针对构建产物导入这些模块
  entry('satellite/lib/contracts', 'lib', 'src/lib/contracts.ts', 'contracts.js'),
  entry('satellite/lib/notify', 'lib', 'src/lib/notify.ts', 'notify.js'),
  entry('satellite/lib/registry', 'lib', 'src/lib/registry.ts', 'registry.js'),
  entry('satellite/lib/skills', 'lib', 'src/lib/skills.ts', 'skills.js'),
  // 宿主平台策略（共享模块：node 与 android 都引用，也供测试单独导入）
  entry('satellite/platform/index', 'lib/platform', 'src/platform/index.ts', 'index.js'),
  entry('satellite/platform/contracts', 'lib/platform', 'src/platform/contracts.ts', 'contracts.js'),
  entry('satellite/platform/apple', 'lib/platform', 'src/platform/apple.ts', 'apple.js'),
  entry('satellite/platform/linux', 'lib/platform', 'src/platform/linux.ts', 'linux.js'),
  entry('satellite/platform/windows', 'lib/platform', 'src/platform/windows.ts', 'windows.js'),
  // 插槽服务入口（默认导出 Cordis Service 子类）
  entry('satellite/slots', 'lib/slots', 'src/slots/index.ts', 'index.js'),
  // 节点工具入口
  entry('satellite/node', 'lib/node', 'src/node/index.ts', 'index.js'),
  entry('satellite/node/lib/config', 'lib/node/lib', 'src/node/lib/config.ts', 'config.js'),
  entry('satellite/node/lib/role-catalog', 'lib/node/lib', 'src/node/lib/role-catalog.ts', 'role-catalog.js'),
  entry('satellite/node/lib/role-service', 'lib/node/lib', 'src/node/lib/role-service.ts', 'role-service.js'),
  entry('satellite/node/lib/extensions', 'lib/node/lib', 'src/node/lib/extensions.ts', 'extensions.js'),
  entry('satellite/node/lib/nodes', 'lib/node/lib', 'src/node/lib/nodes.ts', 'nodes.js'),
  entry('satellite/node/lib/routes', 'lib/node/lib', 'src/node/lib/routes.ts', 'routes.js'),
  entry('satellite/node/lib/reuse-index', 'lib/node/lib', 'src/node/lib/reuse-index.ts', 'reuse-index.js'),
  entry('satellite/node/lib/reuse-tools', 'lib/node/lib', 'src/node/lib/reuse-tools.ts', 'reuse-tools.js'),
  // Internal kernel test entry; the restricted runtime bridge is wired only by node.
  entry('satellite/node/lib/version-control-runtime', 'lib/node/lib', 'src/node/lib/version-control-runtime.ts', 'version-control-runtime.js'),
  entry('satellite/node/lib/version-control', 'lib/node/lib', 'src/node/lib/version-control.ts', 'version-control.js'),
  entry('satellite/node/lib/tool-schema', 'lib/node/lib', 'src/node/lib/tool-schema.ts', 'tool-schema.js'),
  entry('satellite/node/lib/wiring', 'lib/node/lib', 'src/node/lib/wiring.ts', 'wiring.js'),
  // Android 只读扩展入口
  entry('satellite/android', 'lib/android', 'src/android/index.ts', 'index.js'),
  entry('satellite/android/lib/extension', 'lib/android/lib', 'src/android/lib/extension.ts', 'extension.js'),
  entry('satellite/android/lib/node-extensions', 'lib/android/lib', 'src/android/lib/node-extensions.ts', 'node-extensions.js'),
  entry('satellite/android/lib/execution/contracts', 'lib/android/lib/execution', 'src/android/lib/execution/contracts.ts', 'contracts.js'),
  entry('satellite/android/lib/execution/process', 'lib/android/lib/execution', 'src/android/lib/execution/process.ts', 'process.js'),
  entry('satellite/android/lib/execution/project', 'lib/android/lib/execution', 'src/android/lib/execution/project.ts', 'project.js'),
  entry('satellite/android/lib/execution/device', 'lib/android/lib/execution', 'src/android/lib/execution/device.ts', 'device.js'),
  entry('satellite/android/lib/execution/emulator', 'lib/android/lib/execution', 'src/android/lib/execution/emulator.ts', 'emulator.js'),
  entry('satellite/android/lib/execution/journey', 'lib/android/lib/execution', 'src/android/lib/execution/journey.ts', 'journey.js'),
  entry('satellite/android/lib/execution/capture', 'lib/android/lib/execution', 'src/android/lib/execution/capture.ts', 'capture.js'),
  entry('satellite/android/lib/execution/tools', 'lib/android/lib/execution', 'src/android/lib/execution/tools.ts', 'tools.js'),
  entry('satellite/android/lib/registration', 'lib/android/lib', 'src/android/lib/registration.ts', 'registration.js'),
  entry('satellite/android/lib/reuse-source', 'lib/android/lib', 'src/android/lib/reuse-source.ts', 'reuse-source.js'),
])
