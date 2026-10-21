//#region src/node/lib/config.ts
/** 由严到宽：索引越小约束越强。用于"拿不准时取最严格"的失败关闭。 */
const SANDBOX_MODE_ORDER = Object.freeze([
	"read-only",
	"workspace-write",
	"danger-full-access"
]);
/** 运行时校验来自行配置/活配置的非受信字符串。 */
function isSandboxMode(value) {
	return typeof value === "string" && SANDBOX_MODE_ORDER.includes(value);
}
/**
* 取最严格的模式（失败关闭用）：候选为空时回落到 `read-only`，
* 宁可给更严格的一侧，也不静默放过更宽的一侧。
*/
function strictestSandboxMode(modes) {
	if (modes.length === 0) return "read-only";
	return modes.reduce((strictest, mode) => SANDBOX_MODE_ORDER.indexOf(mode) < SANDBOX_MODE_ORDER.indexOf(strictest) ? mode : strictest, "danger-full-access");
}
/**
* 角色实际生效的沙箱模式。缺失或非法一律**失败关闭**到 `read-only`：
* 只读边界是这条设计的目的，配错时不能退化成"不施加"。
*/
function effectiveSandboxMode(role) {
	const configured = role?.sandbox;
	if (isSandboxMode(configured)) return {
		mode: configured,
		source: "role"
	};
	return {
		mode: "read-only",
		source: configured === void 0 ? "missing-fallback" : "invalid-fallback"
	};
}
const UNSUPPORTED_ROLE_CWD = "不支持 role.cwd 收窄写范围：原生 request.cwd 只改变工作目录，不改变继承的沙箱根；请移除旧配置并重新确认父会话授权范围";
/** 执行子 Agent 不继承节点入口，避免递归包裹正式节点。 */
const EXECUTOR_TOOL_FILTER = Object.freeze({ deny: ["satellite_node"] });
/**
* 工具过滤仅减少专用写入口并避免节点递归，保留 bash 等调查工具。
* 受限文件操作由原生 sandbox 强制；不承诺网络、设备或其他非文件效果只读。
*/
const READ_ONLY_REVIEW_TOOL_FILTER = Object.freeze({ deny: [
	"satellite_node",
	"edit",
	"write"
] });
/**
* 实施角色（`implementation`）的工具过滤：拒绝节点入口（禁止递归包裹正式节点），
* 保留 `edit`/`write`；validation 为测试/构建也需要文件写权限。
* 文件权限由父会话原生沙箱根与收窄后的模式决定；旧 `RoleConfig.cwd` 一律拒绝。
*/
const IMPLEMENT_TOOL_FILTER = Object.freeze({ deny: ["satellite_node"] });
const DEFAULT_CONFIG = Object.freeze({
	provider: "spawn",
	skills: Object.freeze([
		"satellite-base-flow",
		"satellite-validation",
		"satellite-change-review",
		"satellite-investigation",
		"satellite-solution",
		"satellite-acceptance",
		"satellite-implementation"
	]),
	nodes: Object.freeze({
		context: Object.freeze({ role: "investigation" }),
		solution: Object.freeze({ role: "solution-design" }),
		implement: Object.freeze({ role: "implementation" }),
		validate: Object.freeze({ role: "validation" }),
		review: Object.freeze({ role: "change-review" }),
		signoff: Object.freeze({ role: "acceptance" })
	}),
	roles: Object.freeze({
		investigation: Object.freeze({
			label: "有界调查",
			skill: "satellite-investigation",
			objective: "先写下本次调查的范围与停止条件，再定向读取决定性的来源；产出事实与状态所有者、可复用候选、对直接影响面的影响与仍未解缺口；只读，不改文件。",
			persona: "区分读到的事实与自己的推断，事实附上确切位置；缺口如实保留为缺口，不用猜测补齐。",
			toolFilter: READ_ONLY_REVIEW_TOOL_FILTER,
			sandbox: "read-only",
			agentOptions: Object.freeze({
				provider: "deepseek-official",
				model: "deepseek-v4-pro"
			})
		}),
		"solution-design": Object.freeze({
			label: "方案设计",
			skill: "satellite-solution",
			objective: "把有界事实转成可评审的选项，逐条列出需要谁做什么决定；不实施、不扩大目标，提交方案后停下等待决定。",
			persona: "区分事实与推断，选项所依据的事实附上确切位置；判断不了的选项如实说明，不编造信心。",
			toolFilter: READ_ONLY_REVIEW_TOOL_FILTER,
			sandbox: "read-only",
			agentOptions: Object.freeze({
				provider: "deepseek-official",
				model: "deepseek-v4-pro"
			})
		}),
		implementation: Object.freeze({
			label: "代码实施",
			skill: "satellite-implementation",
			objective: "只改已同意的基线，一次一个单元：动手前用一小段写明改什么、范围与不在范围内、验证方式，以及仍缺的决定（缺决定就停在这里）；改动取满足单元的最小面，复用既有约定，不顺手重构、不扩大目标、不提交不发布；完成后跑该范围需要的编译/类型检查并如实报告（完整验证归 validate）。",
			persona: "区分\"已同意的基线\"与自己的发挥：没有同意的改动停手，把决定交回而不是替用户决定；失败证据一并保留，不把部分检查说成验证；环境或权限阻塞如实报告为阻塞。",
			toolFilter: IMPLEMENT_TOOL_FILTER,
			sandbox: "workspace-write",
			agentOptions: Object.freeze({
				provider: "deepseek-official",
				model: "deepseek-v4-pro"
			})
		}),
		validation: Object.freeze({
			label: "项目验证",
			skill: "satellite-validation",
			objective: "执行项目实际适用的验证命令；返回真实执行结果、证据位置与未测范围。",
			persona: "只报告实际执行过的验证与真实结果；不把未运行的检查说成通过。",
			toolFilter: EXECUTOR_TOOL_FILTER,
			sandbox: "workspace-write",
			agentOptions: Object.freeze({
				provider: "deepseek-official",
				model: "deepseek-flash"
			})
		}),
		"change-review": Object.freeze({
			label: "独立审查",
			skill: "satellite-change-review",
			objective: "锁定当前差异与其消费者，独立审查实际改动与相关源码，给出结论与限制；不修改任何文件，不自动修复，不提交。",
			persona: "只依据实际差异与相关源码下结论；区分已证实的问题与未验证的怀疑，读不到的内容明确报告为未验证。",
			toolFilter: READ_ONLY_REVIEW_TOOL_FILTER,
			sandbox: "read-only",
			agentOptions: Object.freeze({
				provider: "deepseek-official",
				model: "deepseek-v4-pro"
			})
		}),
		acceptance: Object.freeze({
			label: "证据验收",
			skill: "satellite-acceptance",
			objective: "按实际证据逐条声明接受与否，给出证据位置与仍未验证的剩余限制；不提交、不发布、不自动修复，需要用户决定的接受交回用户。",
			persona: "只按证据下结论；缺失证据列为未验证而不是默认通过，完成运行本身不当作业务验收。",
			toolFilter: READ_ONLY_REVIEW_TOOL_FILTER,
			sandbox: "read-only",
			agentOptions: Object.freeze({
				provider: "deepseek-official",
				model: "deepseek-v4-pro"
			})
		}),
		"android-context": Object.freeze({
			label: "Android 专项调查",
			skill: "android-validation-context",
			objective: "确认当前模块、变体和相关测试入口；不启动设备或运行测试。",
			toolFilter: EXECUTOR_TOOL_FILTER,
			sandbox: "read-only",
			agentOptions: Object.freeze({
				provider: "deepseek-official",
				model: "deepseek-v4-pro"
			})
		})
	}),
	builtinExtensions: Object.freeze({ acceptanceDecision: true })
});
/**
* 由代码计算的角色清单，供 schema 默认值使用（`src/node/index.ts` 的 `declaredRoles`）。
* 顺序与 `DEFAULT_CONFIG.roles` 的声明顺序一致。
*/
const BUILTIN_ROLE_NAMES = Object.freeze(Object.keys(DEFAULT_CONFIG.roles));
/**
* 由每个角色的 `agentOptions` 投影出的默认路由，供 schema 默认值使用
* （`src/node/index.ts` 的 `routes`）。默认在代码里，所以插件升级后设置页立即看到新默认值；
* 只有**用户保存的覆盖**才会落到 profile。
*/
const BUILTIN_ROUTES = Object.freeze(Object.entries(DEFAULT_CONFIG.roles).flatMap(([role, entry]) => {
	const options = entry.agentOptions;
	if (!options?.provider || !options.model) return [];
	return [{
		role,
		provider: options.provider,
		model: options.model
	}];
}));
function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
/**
* 把行配置归一化成默认值 + 覆盖。
* 输入按未类型化的行配置处理（Host 侧校验由 DSH 的 Config schema 负责）。
*/
function normalizeConfig(config) {
	const incoming = asRecord(config);
	const nodes = { ...DEFAULT_CONFIG.nodes };
	for (const [nodeId, entry] of Object.entries(asRecord(incoming.nodes))) nodes[nodeId] = {
		...DEFAULT_CONFIG.nodes[nodeId] ?? {},
		...asRecord(entry)
	};
	const roles = { ...DEFAULT_CONFIG.roles };
	for (const [roleName, entry] of Object.entries(asRecord(incoming.roles))) {
		const override = asRecord(entry);
		if (Object.hasOwn(DEFAULT_CONFIG.roles, roleName) && Object.hasOwn(override, "agentOptions")) {
			const supplied = override.agentOptions;
			const expected = DEFAULT_CONFIG.roles[roleName]?.agentOptions ?? {};
			const fields = Object.keys(expected);
			const candidate = asRecord(supplied);
			if (!(supplied !== null && typeof supplied === "object" && !Array.isArray(supplied) && Object.keys(candidate).length === fields.length && fields.every((key) => Object.hasOwn(candidate, key) && candidate[key] === expected[key]))) throw new Error(`内置角色 ${roleName} 的 roles.${roleName}.agentOptions 不能覆盖代码默认；请将 provider/model/reasoningEffort/maxTokens 迁移到 routes 中该角色的条目`);
		}
		roles[roleName] = {
			...DEFAULT_CONFIG.roles[roleName] ?? {},
			...override
		};
	}
	const incomingSkills = Array.isArray(incoming.skills) ? incoming.skills : [];
	const skills = [.../* @__PURE__ */ new Set([...DEFAULT_CONFIG.skills, ...incomingSkills])];
	const incomingBuiltins = asRecord(incoming.builtinExtensions);
	const builtinExtensions = { acceptanceDecision: typeof incomingBuiltins.acceptanceDecision === "boolean" ? incomingBuiltins.acceptanceDecision : DEFAULT_CONFIG.builtinExtensions.acceptanceDecision };
	return {
		provider: typeof incoming.provider === "string" ? incoming.provider : DEFAULT_CONFIG.provider,
		skills,
		nodes,
		roles,
		builtinExtensions
	};
}
/**
* 读取活配置字段。`.volatile()` 字段在插件里是引用对象（用 `.get()` 读当前值）；
* 普通配置或测试里的普通对象则原样返回。两种形态都支持，避免把形态当成契约。
*/
function readLiveConfigValue(field, fallback) {
	if (field && typeof field === "object" && "get" in field) {
		const getter = field.get;
		if (typeof getter === "function") {
			const value = getter.call(field);
			return value === void 0 || value === null ? fallback : value;
		}
	}
	return field === void 0 || field === null ? fallback : field;
}
/**
* 一个角色的实际生效路由：活配置 `routes`（按 role 匹配的条目）优先，
* 否则回落到该角色的 `agentOptions`（内置角色为代码默认；自定义角色为部署默认）。
*/
function effectiveAgentOptions(params) {
	const { role, roleName, routes } = params;
	const base = role?.agentOptions;
	if (Array.isArray(routes)) {
		const seen = /* @__PURE__ */ new Set();
		for (const entry of routes) {
			if (typeof entry?.role !== "string") continue;
			if (seen.has(entry.role)) throw new Error(`角色路由重复：${entry.role}`);
			seen.add(entry.role);
		}
	}
	const live = Array.isArray(routes) ? routes.find((entry) => entry?.role === roleName) : void 0;
	if (!live) return base;
	const { role: _role, ...route } = live;
	return {
		...base ?? {},
		...route
	};
}
//#endregion
export { BUILTIN_ROLE_NAMES, BUILTIN_ROUTES, DEFAULT_CONFIG, EXECUTOR_TOOL_FILTER, IMPLEMENT_TOOL_FILTER, READ_ONLY_REVIEW_TOOL_FILTER, UNSUPPORTED_ROLE_CWD, effectiveAgentOptions, effectiveSandboxMode, isSandboxMode, normalizeConfig, readLiveConfigValue, strictestSandboxMode };
