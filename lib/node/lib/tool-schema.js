Object.freeze([
	"read-only",
	"workspace-write",
	"danger-full-access"
]);
const NODE_TIERS = [
	"light",
	"standard",
	"senior"
];
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
/** Tier variants reuse the corresponding method and safety defaults, not a new model ladder. */
const DEFAULT_CONFIG = Object.freeze({
	...BASE_CONFIG,
	nodes: Object.freeze({
		...BASE_CONFIG.nodes,
		implement: Object.freeze({
			role: "implementation",
			tierRoles: Object.freeze({
				light: "implementation-light",
				standard: "implementation",
				senior: "implementation-senior"
			})
		}),
		review: Object.freeze({
			role: "change-review",
			tierRoles: Object.freeze({
				light: "change-review-light",
				standard: "change-review"
			})
		}),
		validate: Object.freeze({
			role: "validation",
			tierRoles: Object.freeze({
				light: "validation-light",
				standard: "validation"
			})
		})
	}),
	roles: Object.freeze({
		...BASE_CONFIG.roles,
		"implementation-light": Object.freeze({
			...BASE_CONFIG.roles.implementation,
			label: "局部低风险实施",
			objective: `${BASE_CONFIG.roles.implementation.objective} 仅承担边界清楚、局部低风险且易回退的单元；超出该范围或出现未解风险时停止并交回，不降低任务整体审查要求。`
		}),
		"implementation-senior": Object.freeze({
			...BASE_CONFIG.roles.implementation,
			label: "复杂边界实施",
			objective: `${BASE_CONFIG.roles.implementation.objective} 处理无法安全拆成独立轻量单元的耦合边界；先核对已有失败历史与当前改动，不通过重派清零同档预算、不重复被证据否定的方法；仍无法解决时交回专项或用户，不无限重试。`
		}),
		"change-review-light": Object.freeze({
			...BASE_CONFIG.roles["change-review"],
			label: "局部低风险审查",
			objective: `${BASE_CONFIG.roles["change-review"].objective} 只审查局部低风险、直接消费者明确的改动；证据超出局部范围或返工后仍未解决时交回常规审查或专项，不把局部结论当整体通过。`
		}),
		"validation-light": Object.freeze({
			...BASE_CONFIG.roles.validation,
			label: "局部验证",
			objective: `${BASE_CONFIG.roles.validation.objective} 仅执行范围明确的局部检查，明确标注局部证据与未测范围；重复同因失败或需要更广验证时交回，不以局部通过替代整体验证。`
		})
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
//#region src/node/lib/tool-schema.ts
const ANNOTATION_KEYS = [
	"description",
	"title",
	"default",
	"examples"
];
const SCALAR_TYPES = [
	"string",
	"number",
	"integer",
	"boolean",
	"null"
];
/** 作者 DSL 的值节点在本地校验里按松散记录处理，由 lintValueSchema 负责收窄。 */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* 校验一个作者 DSL 值节点。
* @returns 违规列表；空数组表示合法
*/
function lintValueSchema(spec, path = "schema", options = {}) {
	const allowRequired = options.allowRequired === true;
	if (!isRecord(spec)) return [`${path} must be a value schema object`];
	const allowed = [...ANNOTATION_KEYS, ...allowRequired ? ["required"] : []];
	const keys = Object.keys(spec);
	if (allowRequired && "required" in spec && spec.required !== true) return [`${path}.required must be true when present`];
	const problems = [];
	for (const key of keys) {
		if ([
			"oneOf",
			"type",
			"properties",
			"additionalProperties",
			"items",
			"enum",
			"const"
		].includes(key)) continue;
		if (!allowed.includes(key)) problems.push(`${path}.${key} is not supported by the value schema DSL`);
	}
	if (problems.length > 0) return problems;
	if ("oneOf" in spec) {
		if ("type" in spec) problems.push(`${path} cannot declare both type and oneOf`);
		const branches = spec.oneOf;
		if (!Array.isArray(branches) || branches.length < 2) problems.push(`${path}.oneOf must be an array of at least two value schemas`);
		else branches.forEach((branch, index) => {
			problems.push(...lintValueSchema(branch, `${path}.oneOf[${index}]`));
		});
		return problems;
	}
	const type = spec.type;
	if (type === "json") return problems;
	if (type === "object") {
		if (typeof spec.additionalProperties !== "boolean") problems.push(`${path}.additionalProperties must be explicitly true or false`);
		if ("properties" in spec) if (!isRecord(spec.properties)) problems.push(`${path}.properties must be an object of value schemas`);
		else for (const [key, property] of Object.entries(spec.properties)) problems.push(...lintValueSchema(property, `${path}.properties.${key}`, { allowRequired: true }));
		return problems;
	}
	if (type === "array") {
		if ("items" in spec) problems.push(...lintValueSchema(spec.items, `${path}.items`));
		return problems;
	}
	if (typeof type === "string" && SCALAR_TYPES.includes(type)) {
		if ("enum" in spec && (!Array.isArray(spec.enum) || spec.enum.length === 0)) problems.push(`${path}.enum must be a non-empty array of scalar values`);
		return problems;
	}
	problems.push(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`);
	return problems;
}
/** parameters 是隐式属性映射：顶层直接是 名称 -> 值节点。 */
function lintParameterSchema(spec, path = "parameters") {
	if (!isRecord(spec)) return [`${path} must be an object of value schemas`];
	const problems = [];
	for (const [key, property] of Object.entries(spec)) problems.push(...lintValueSchema(property, `${path}.${key}`, { allowRequired: true }));
	return problems;
}
const PARAMETERS_SCHEMA = Object.freeze({
	node: {
		type: "string",
		required: true,
		description: "要运行的基础节点标识"
	},
	task: {
		type: "string",
		required: true,
		description: "本次节点的有界任务，包含范围与停止条件"
	},
	unit: {
		type: "string",
		description: "实施单元标识；同一节点的不同单元互不串用记录"
	},
	tier: {
		type: "string",
		enum: NODE_TIERS,
		description: "节点角色档（非执行风险）；省略用节点默认，显式档须有映射。resume 省略继承原选择，升降档须新建调用。"
	},
	facts: {
		type: "json",
		description: "本次任务已有的语义事实（例如 projectKind），只作为方法判断，不是授权凭证。事实名是扁平键，点号是键名的一部分，不解析嵌套对象。例如 {\"acceptance.required\":true}（作为 facts 的值）：默认启用的处理决定扩展会在 after 阶段暂停；用返回的 token 作为 resume 并提交 decision 继续，base 不重跑。嵌套写法 {\"acceptance\":{\"required\":true}} 不会触发该暂停。"
	},
	resume: {
		type: "string",
		description: "暂停时返回的 token，用于恢复同一节点调用"
	},
	decision: {
		type: "string",
		description: "恢复时提交的业务决定；不能代替宿主批准"
	}
});
const OUTPUT_SCHEMA = Object.freeze({
	type: "object",
	additionalProperties: false,
	description: "本次节点调用的结果；暂停时返回 token 供恢复同一调用。",
	properties: {
		kind: {
			type: "string",
			required: true,
			description: "completed | failed | suspended | cancelled | blocked"
		},
		node: {
			type: "string",
			required: true
		},
		token: {
			type: "string",
			description: "暂停时用于恢复同一节点调用"
		},
		stage: {
			type: "string",
			description: "暂停发生在 before 还是 after"
		},
		reason: { type: "string" },
		missing: {
			type: "array",
			items: { type: "string" }
		},
		conflicts: {
			type: "array",
			items: { type: "string" }
		},
		blocked: {
			type: "array",
			items: { type: "string" }
		},
		ran: {
			type: "array",
			items: { type: "string" }
		},
		extensions: {
			type: "array",
			description: "已运行扩展的原始结果与错误，含暂停前已有证据；不是授权凭证",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					slot: {
						type: "string",
						required: true
					},
					status: {
						type: "string",
						enum: [
							"completed",
							"failed",
							"blocked",
							"needs_decision"
						],
						required: true
					},
					note: { type: "string" },
					error: { type: "string" }
				}
			}
		},
		sandbox: {
			type: "array",
			items: { type: "string" },
			description: "已在创建边界核验的角色沙箱模式；不能验证权限时拒绝启动"
		},
		selection: {
			type: "object",
			additionalProperties: false,
			description: "本次调用冻结的基础角色选择；不代表已执行。",
			properties: {
				role: {
					type: "string",
					required: true
				},
				tier: {
					type: "string",
					enum: NODE_TIERS
				}
			}
		},
		execution: {
			type: "object",
			additionalProperties: false,
			description: "已确认启动的基础角色及其显式请求路由（非子会话模型读回）；恢复时保留原记录，不代表重新启动或业务通过。",
			properties: {
				role: {
					type: "string",
					required: true
				},
				provider: { type: "string" },
				model: { type: "string" }
			}
		},
		result: {
			type: "string",
			description: "基础节点的实际结果摘要"
		}
	}
});
//#endregion
export { OUTPUT_SCHEMA, PARAMETERS_SCHEMA, lintParameterSchema, lintValueSchema };
