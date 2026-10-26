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
const BASE_CONFIG = Object.freeze({
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
			objective: "把有界事实转成可评审的选项，逐条列出需要谁做什么决定；默认承担常规求解与完整影响检查，不实施、不扩大目标，提交方案后停下等待决定。",
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
			objective: "只改已同意的基线，一次一个单元：动手前用一小段写明改什么、范围与不在范围内、验证方式，以及仍缺的决定（缺决定就停在这里）；默认承担常规求解与完整影响检查，改动取满足单元的最小面，复用既有约定，不顺手重构、不扩大目标、不提交不发布；完成后跑该范围需要的编译/类型检查并如实报告（完整验证归 validate）。",
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
			objective: "锁定当前差异与其消费者，独立审查实际改动与相关源码，给出结论与限制；默认承担常规审查与完整影响检查，不修改任何文件，不自动修复，不提交。",
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
* 档位变体只复制基础角色既有的方法默认值与权限（toolFilter/sandbox），不构造权限阶梯。
* 复制 `agentOptions` 是为了让每个新角色拥有自己的代码默认路由；运行时仍按角色名
* 精确匹配用户 `routes`，不会继承用户对基础角色的覆盖，也不按模型名推断强弱。
*/
function tierVariant(base, label, objective) {
	return Object.freeze({
		...base,
		label,
		objective
	});
}
const solutionDesign = BASE_CONFIG.roles["solution-design"];
const implementation = BASE_CONFIG.roles.implementation;
const changeReview = BASE_CONFIG.roles["change-review"];
const DEFAULT_CONFIG = Object.freeze({
	...BASE_CONFIG,
	nodes: Object.freeze({
		...BASE_CONFIG.nodes,
		solution: Object.freeze({
			role: "solution-design",
			tierRoles: Object.freeze({
				light: "solution-design-light",
				standard: "solution-design",
				senior: "solution-design-senior",
				critical: "solution-design-critical"
			})
		}),
		implement: Object.freeze({
			role: "implementation",
			tierRoles: Object.freeze({
				light: "implementation-light",
				standard: "implementation",
				senior: "implementation-senior",
				critical: "implementation-critical"
			})
		}),
		review: Object.freeze({
			role: "change-review",
			tierRoles: Object.freeze({
				light: "change-review-light",
				standard: "change-review",
				senior: "change-review-senior",
				critical: "change-review-critical"
			})
		})
	}),
	roles: Object.freeze({
		...BASE_CONFIG.roles,
		"solution-design-light": tierVariant(solutionDesign, "局部清晰方案", `${solutionDesign.objective} 该档只处理边界清楚、局部低歧义、易回退的方案问题：写明局部事实与未检查影响，保留实际必要的安全检查；超出范围时停止交回，不把局部方案当整体结论。`),
		"solution-design-senior": tierVariant(solutionDesign, "跨模块方案", `${solutionDesign.objective} 该档处理跨模块耦合、复杂约束或已有失败证据的方案问题：先核对旧证据，不重复已被否定的假设；仍无法收敛时报告缺口并交回父流程选择 critical、专项或用户方向。`),
		"solution-design-critical": tierVariant(solutionDesign, "疑难方案复核", `${solutionDesign.objective} 该档重新检验问题的核心假设并构造反例，深入解决顽固问题；不与高风险自动绑定，也不要求每项决定都不可逆；证据充分时可给出通过的方案结论，无解时停止并报告缺口、请求决定。`),
		"implementation-light": tierVariant(implementation, "局部低歧义实施", `${implementation.objective} 该档只承担边界清楚、局部低歧义、易回退的单元：明确局部影响，保留实际必要的安全检查；超出范围或出现未解风险时停止并交回，不降低任务整体审查要求。`),
		"implementation-senior": tierVariant(implementation, "复杂边界实施", `${implementation.objective} 该档处理跨模块耦合、复杂约束或已有失败证据的单元：先核对已有失败历史与当前改动，不通过重派清零同档预算、不重复被证据否定的方法；仍无法解决时报告缺口并交回父流程选择 critical、专项或用户方向。`),
		"implementation-critical": tierVariant(implementation, "疑难问题攻坚", `${implementation.objective} 该档重新检验实现的核心假设并构造反例，深入解决顽固问题；不与高风险自动绑定，也不要求每项改动都不可逆；证据充分时可给出通过结论，仍无解时停止并报告缺口、请求决定。`),
		"change-review-light": tierVariant(changeReview, "局部低歧义审查", `${changeReview.objective} 该档只审查局部低歧义、直接消费者明确的改动：明确局部证据与未检查影响，保留实际必要的安全检查；证据超出局部范围或返工后仍未解决时交回常规或更高审查，不把局部结论当整体通过。`),
		"change-review-senior": tierVariant(changeReview, "复杂耦合审查", `${changeReview.objective} 该档审查跨模块耦合、复杂约束或已有失败证据的改动：先核对旧结论与当前差异，不重复已被证据否定的判断；仍无法收敛时报告缺口并交回父流程选择 critical、专项或用户方向。`),
		"change-review-critical": tierVariant(changeReview, "疑难反例审查", `${changeReview.objective} 该档重新检验改动的核心假设并构造反例，深入追查顽固问题；不与高风险自动绑定，也不要求每项改动都不可逆；证据充分时可给出通过结论，仍无法收敛时停止并报告缺口、请求决定。`)
	})
});
Object.freeze(Object.keys(DEFAULT_CONFIG.roles));
Object.freeze(Object.entries(DEFAULT_CONFIG.roles).flatMap(([role, entry]) => {
	const options = entry.agentOptions;
	if (!options?.provider || !options.model) return [];
	return [{
		role,
		provider: options.provider,
		model: options.model
	}];
}));
//#endregion
//#region src/node/lib/role-catalog.ts
/**
* 调用方传入 normalizeConfig 的有效结果与 slots.snapshot()。
* 没有角色定义的旧路由不构造角色；没有 role 元数据的扩展不猜测角色。
* 目录描述已部署的挂载，不声称当前任务已匹配、就绪或获准。
*/
function buildRoleCatalog(config, extensions) {
	const bindings = new Map(Object.keys(config.roles).map((role) => [role, []]));
	for (const [node, entry] of Object.entries(config.nodes)) {
		const conditions = /* @__PURE__ */ new Map([[entry.role, ["省略 tier"]]]);
		for (const [tier, role] of Object.entries(entry.tierRoles ?? {})) conditions.set(role, [...conditions.get(role) ?? [], `tier=${tier}`]);
		for (const [name, choices] of conditions) {
			if (!Object.hasOwn(config.roles, name)) continue;
			const role = config.roles[name];
			bindings.get(name)?.push({
				node,
				phase: "base",
				...role.skill !== void 0 ? { skill: role.skill } : {},
				...role.objective !== void 0 ? { objective: role.objective } : {},
				condition: `调用 ${node} 节点且${choices.join(" 或 ")}时执行基础阶段。`
			});
		}
	}
	for (const extension of extensions) {
		const metadata = extension.role;
		if (!metadata) continue;
		const target = bindings.get(metadata.name);
		if (!target) continue;
		const slot = /^([a-z][a-z0-9-]*)\.(before|after)$/.exec(extension.slot);
		if (!slot) continue;
		target.push({
			node: slot[1],
			phase: slot[2],
			extension: extension.id,
			skill: metadata.skill,
			objective: metadata.objective,
			condition: metadata.condition
		});
	}
	return {
		version: 1,
		roles: Object.entries(config.roles).map(([role, entry]) => ({
			role,
			label: entry.label || role,
			description: entry.objective ?? "",
			...entry.skill !== void 0 ? { skill: entry.skill } : {},
			sandbox: effectiveSandboxMode(entry).mode,
			bindings: bindings.get(role)
		}))
	};
}
//#endregion
export { buildRoleCatalog };
