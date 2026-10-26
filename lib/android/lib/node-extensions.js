//#region src/android/lib/extension.ts
const ROLE = "android-context";
const PROJECT_KIND_FACT = "projectKind";
const PROJECT_KIND = "android";
//#endregion
//#region src/android/lib/node-extensions.ts
/** 结构校验失败的错误码前缀：调用方按统一词表报告，不解析正文。 */
const ARGUMENT_INVALID = "ARGUMENT_INVALID";
const SOURCE_KINDS = ["file", "configured-tool"];
const CHECK_NAMES = [
	"api",
	"lifecycle",
	"resources",
	"security",
	"ui"
];
const EVIDENCE_KINDS = [
	"build",
	"unit-test",
	"device",
	"ui",
	"performance",
	"memory"
];
const CLAIM_RESULTS = [
	"passed",
	"failed",
	"not-run"
];
const MAX_SOURCES_PER_ENTRY = 8;
const MAX_REQUIREMENTS = 8;
const MAX_CLAIMS = 16;
const MAX_SCOPE_FILES = 100;
function isPlainRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** 未知字段一律拒绝：schema 漂移必须显式失败，不能被静默忽略。 */
function unknownKeys(value, allowed) {
	const extra = Object.keys(value).filter((key) => !allowed.includes(key));
	return extra.length > 0 ? `unknown field(s): ${extra.join(", ")}` : void 0;
}
function boundedString(value, max) {
	if (typeof value !== "string") return void 0;
	if (value.length === 0 || value.length > max) return void 0;
	return value;
}
function parseSourceRef(value, where) {
	if (!isPlainRecord(value)) return {
		ok: false,
		error: `${where} must be an object`
	};
	const extra = unknownKeys(value, [
		"kind",
		"location",
		"revision"
	]);
	if (extra) return {
		ok: false,
		error: `${where}: ${extra}`
	};
	if (typeof value.kind !== "string" || !SOURCE_KINDS.includes(value.kind)) return {
		ok: false,
		error: `${where}.kind must be one of ${SOURCE_KINDS.join("/")}`
	};
	const location = boundedString(value.location, 2048);
	if (location === void 0) return {
		ok: false,
		error: `${where}.location must be a non-empty string of at most 2048 characters`
	};
	const revision = boundedString(value.revision, 128);
	if (revision === void 0) return {
		ok: false,
		error: `${where}.revision must be a non-empty string of at most 128 characters`
	};
	return {
		ok: true,
		value: {
			kind: value.kind,
			location,
			revision
		}
	};
}
function parseSourceList(value, where, max) {
	if (!Array.isArray(value)) return {
		ok: false,
		error: `${where} must be an array`
	};
	if (value.length > max) return {
		ok: false,
		error: `${where} has more than ${max} entries`
	};
	const sources = [];
	for (const [index, entry] of value.entries()) {
		const parsed = parseSourceRef(entry, `${where}[${index}]`);
		if (!parsed.ok) return parsed;
		sources.push(parsed.value);
	}
	return {
		ok: true,
		value: sources
	};
}
/** 已声明专项输入的结构校验；只在启动子会话之前调用。 */
function parseReviewScope(value) {
	if (!isPlainRecord(value)) return {
		ok: false,
		error: "review scope must be an object"
	};
	const extra = unknownKeys(value, ["files", "checks"]);
	if (extra) return {
		ok: false,
		error: `review scope: ${extra}`
	};
	const files = parseSourceList(value.files, "review scope.files", MAX_SCOPE_FILES);
	if (!files.ok) return files;
	if (files.value.length === 0) return {
		ok: false,
		error: "review scope.files must name at least one source"
	};
	if (!Array.isArray(value.checks) || value.checks.length === 0) return {
		ok: false,
		error: "review scope.checks must be a non-empty array"
	};
	const checks = [];
	for (const [index, entry] of value.checks.entries()) {
		if (typeof entry !== "string" || !CHECK_NAMES.includes(entry)) return {
			ok: false,
			error: `review scope.checks[${index}] must be one of ${CHECK_NAMES.join("/")}`
		};
		if (checks.includes(entry)) return {
			ok: false,
			error: `review scope.checks has a duplicate: ${entry}`
		};
		checks.push(entry);
	}
	return {
		ok: true,
		value: {
			files: files.value,
			checks
		}
	};
}
function parseTarget(value, where) {
	if (!isPlainRecord(value)) return {
		ok: false,
		error: `${where} must be an object`
	};
	const extra = unknownKeys(value, [
		"project",
		"revision",
		"module",
		"variant",
		"serial"
	]);
	if (extra) return {
		ok: false,
		error: `${where}: ${extra}`
	};
	const project = boundedString(value.project, 2048);
	if (project === void 0) return {
		ok: false,
		error: `${where}.project must be a non-empty string of at most 2048 characters`
	};
	const revision = boundedString(value.revision, 128);
	if (revision === void 0) return {
		ok: false,
		error: `${where}.revision must be a non-empty string of at most 128 characters`
	};
	const optional = {};
	for (const key of [
		"module",
		"variant",
		"serial"
	]) {
		if (value[key] === void 0) continue;
		const parsed = boundedString(value[key], 2048);
		if (parsed === void 0) return {
			ok: false,
			error: `${where}.${key} must be a non-empty string of at most 2048 characters`
		};
		optional[key] = parsed;
	}
	return {
		ok: true,
		value: {
			project,
			revision,
			...optional
		}
	};
}
function parseRequirement(value, where) {
	if (!isPlainRecord(value)) return {
		ok: false,
		error: `${where} must be an object`
	};
	const extra = unknownKeys(value, [
		"kind",
		"target",
		"sources"
	]);
	if (extra) return {
		ok: false,
		error: `${where}: ${extra}`
	};
	if (typeof value.kind !== "string" || !EVIDENCE_KINDS.includes(value.kind)) return {
		ok: false,
		error: `${where}.kind must be one of ${EVIDENCE_KINDS.join("/")}`
	};
	const target = parseTarget(value.target, `${where}.target`);
	if (!target.ok) return target;
	const sources = parseSourceList(value.sources, `${where}.sources`, MAX_SOURCES_PER_ENTRY);
	if (!sources.ok) return sources;
	return {
		ok: true,
		value: {
			kind: value.kind,
			target: target.value,
			sources: sources.value
		}
	};
}
function parseRequirementList(value, max, where) {
	if (!Array.isArray(value)) return {
		ok: false,
		error: `${where} must be an array`
	};
	if (value.length === 0) return {
		ok: false,
		error: `${where} must name at least one requirement`
	};
	if (value.length > max) return {
		ok: false,
		error: `${where} has more than ${max} entries`
	};
	const requirements = [];
	for (const [index, entry] of value.entries()) {
		const parsed = parseRequirement(entry, `${where}[${index}]`);
		if (!parsed.ok) return parsed;
		requirements.push(parsed.value);
	}
	return {
		ok: true,
		value: requirements
	};
}
function parseEvidenceRequirements(value) {
	return parseRequirementList(value, MAX_REQUIREMENTS, "validation requirements");
}
function parseEvidenceClaims(value) {
	if (!Array.isArray(value)) return {
		ok: false,
		error: "acceptance evidence must be an array"
	};
	if (value.length === 0) return {
		ok: false,
		error: "acceptance evidence must name at least one entry"
	};
	if (value.length > MAX_CLAIMS) return {
		ok: false,
		error: `acceptance evidence has more than ${MAX_CLAIMS} entries`
	};
	const claims = [];
	for (const [index, entry] of value.entries()) {
		if (!isPlainRecord(entry)) return {
			ok: false,
			error: `acceptance evidence[${index}] must be an object`
		};
		const extra = unknownKeys(entry, [
			"kind",
			"target",
			"sources",
			"reportedResult"
		]);
		if (extra) return {
			ok: false,
			error: `acceptance evidence[${index}]: ${extra}`
		};
		if (typeof entry.reportedResult !== "string" || !CLAIM_RESULTS.includes(entry.reportedResult)) return {
			ok: false,
			error: `acceptance evidence[${index}].reportedResult must be one of ${CLAIM_RESULTS.join("/")}`
		};
		const requirement = parseRequirement({
			kind: entry.kind,
			target: entry.target,
			sources: entry.sources
		}, `acceptance evidence[${index}]`);
		if (!requirement.ok) return requirement;
		claims.push({
			...requirement.value,
			reportedResult: entry.reportedResult
		});
	}
	return {
		ok: true,
		value: claims
	};
}
/** 空 sources 表示"明确要求但未提供证据"：结构合法，但执行前拒绝假装已核对。 */
function requireNonEmptySources(entries, where) {
	const empty = entries.findIndex((entry) => entry.sources.length === 0);
	if (empty >= 0) return {
		ok: false,
		error: `${where}[${empty}] declares no source to check; collect the evidence first or drop the requirement`
	};
	return {
		ok: true,
		value: void 0
	};
}
function createMethodExtension(spec) {
	return {
		id: spec.id,
		slot: spec.slot,
		slotVersion: 1,
		role: {
			name: ROLE,
			skill: spec.skill,
			objective: spec.objective,
			condition: `${spec.requiredFact} === true 且 ${PROJECT_KIND_FACT} === '${PROJECT_KIND}'${spec.sourceFacts.length > 0 ? `，已提供 ${spec.sourceFacts.join("、")}；执行前校验输入结构` : ""}；缺少必需字段时等待补充；需角色 ${ROLE} 与技能 ${spec.skill} 可用。`
		},
		match(facts) {
			if (facts.values[spec.requiredFact] !== true) return { kind: "no" };
			const projectKind = facts.values[PROJECT_KIND_FACT];
			if (projectKind === void 0) return {
				kind: "unknown",
				missing: [PROJECT_KIND_FACT]
			};
			if (projectKind !== "android") return { kind: "no" };
			const missing = spec.sourceFacts.filter((name) => facts.values[name] === void 0);
			if (missing.length > 0) return {
				kind: "unknown",
				missing
			};
			return { kind: "yes" };
		},
		ready(view) {
			if (!view || typeof view !== "object" || typeof view.checkRoleAndSkill !== "function") return {
				ready: false,
				reason: "调用作用域未提供能力检查接口",
				missing: ["checkRoleAndSkill"]
			};
			return view.checkRoleAndSkill(ROLE, spec.skill);
		},
		run(execution) {
			if (!execution || typeof execution !== "object") return {
				status: "blocked",
				error: "调用作用域未提供执行上下文"
			};
			const scope = execution;
			if (typeof scope.runConfiguredRole !== "function") return {
				status: "blocked",
				error: "调用作用域未提供角色执行接口"
			};
			if (!scope.facts) return {
				status: "blocked",
				error: `${ARGUMENT_INVALID}: 缺少事实视图`
			};
			const parsed = spec.parse(scope.facts);
			if (!parsed.ok) return {
				status: "blocked",
				error: `${ARGUMENT_INVALID}: ${parsed.error}`
			};
			return scope.runConfiguredRole(ROLE, {
				skill: spec.skill,
				objective: `${spec.objective}\n本次专项输入（已按声明结构校验，来源仍需自行读取并核对）：\n${spec.describe(parsed.value)}`
			});
		}
	};
}
/** Android 只读专项扩展的声明清单；`android.validation-*` 沿用既有静态上下文扩展。 */
function createAndroidProjectContext() {
	return createMethodExtension({
		id: "android.project-context",
		slot: "context.before",
		requiredFact: "android.context.required",
		skill: "android-validation-context",
		objective: "按当前任务指定的工程范围补充模块、变体与入口事实；只读，不启动设备或构建。",
		sourceFacts: [],
		parse: () => ({
			ok: true,
			value: void 0
		}),
		describe: () => "（来源由节点任务指定：当前任务的工程文件与变更范围）"
	});
}
function createAndroidDesignContext() {
	return createMethodExtension({
		id: "android.design-context",
		slot: "solution.before",
		requiredFact: "android.design.required",
		skill: "android-design-handoff",
		objective: "固定设计来源与修订，交付设计事实与代码复用候选；来源不可达就明确阻塞，不补画设计。",
		sourceFacts: ["android.design.source"],
		parse: (facts) => {
			const parsed = parseSourceRef(facts.values["android.design.source"], "android.design.source");
			if (!parsed.ok) return parsed;
			return {
				ok: true,
				value: parsed.value
			};
		},
		describe: (value) => JSON.stringify(value, null, 2)
	});
}
function createAndroidPlatformReview() {
	return createMethodExtension({
		id: "android.platform-review",
		slot: "review.after",
		requiredFact: "android.review.required",
		skill: "android-change-review",
		objective: "按指定检查面对当前变更做平台专项审查；只读，不修改文件，不自动修复。",
		sourceFacts: ["android.review.scope"],
		parse: (facts) => parseReviewScope(facts.values["android.review.scope"]),
		describe: (value) => JSON.stringify(value, null, 2)
	});
}
function createAndroidValidationEvidence() {
	return createMethodExtension({
		id: "android.validation-evidence",
		slot: "validate.after",
		requiredFact: "android.validation.required",
		skill: "android-validation-evidence",
		objective: "核对声明的领域证据来源与修订，判定齐备、失配或缺失；不伪造运行结果，不代替基础节点验收。",
		sourceFacts: ["android.validation.requirements"],
		parse: (facts) => {
			const parsed = parseEvidenceRequirements(facts.values["android.validation.requirements"]);
			if (!parsed.ok) return parsed;
			const nonEmpty = requireNonEmptySources(parsed.value, "validation requirements");
			if (!nonEmpty.ok) return nonEmpty;
			return {
				ok: true,
				value: parsed.value
			};
		},
		describe: (value) => JSON.stringify(value, null, 2)
	});
}
function createAndroidAcceptanceEvidence() {
	return createMethodExtension({
		id: "android.acceptance-evidence",
		slot: "signoff.before",
		requiredFact: "android.acceptance.required",
		skill: "android-acceptance-evidence",
		objective: "汇总已有测试、设计与设备证据的位置、修订与遗漏，供基础验收判断；不替基础验收作最终接受，不触发发布。",
		sourceFacts: ["android.acceptance.evidence"],
		parse: (facts) => {
			const parsed = parseEvidenceClaims(facts.values["android.acceptance.evidence"]);
			if (!parsed.ok) return parsed;
			const nonEmpty = requireNonEmptySources(parsed.value.map((claim) => ({ sources: claim.sources })), "acceptance evidence");
			if (!nonEmpty.ok) return nonEmpty;
			return {
				ok: true,
				value: parsed.value
			};
		},
		describe: (value) => JSON.stringify(value, null, 2)
	});
}
/** 本组件注册的全部专项扩展（既有静态上下文扩展单独保留在 extension.ts）。 */
function createAndroidNodeExtensions() {
	return [
		createAndroidProjectContext(),
		createAndroidDesignContext(),
		createAndroidPlatformReview(),
		createAndroidValidationEvidence(),
		createAndroidAcceptanceEvidence()
	];
}
/** 本组件注册的全部技能名，供入口逐个加载。 */
const ANDROID_SKILL_NAMES = Object.freeze([
	"android-validation-context",
	"android-design-handoff",
	"android-change-review",
	"android-validation-evidence",
	"android-acceptance-evidence",
	"android-compose-performance",
	"android-anr-diagnostics",
	"android-permissions-security",
	"android-kotlin-concurrency",
	"android-compose-state-effects",
	"android-compose-ui-testing",
	"android-performance-analysis"
]);
//#endregion
export { ANDROID_SKILL_NAMES, ARGUMENT_INVALID, ROLE, createAndroidAcceptanceEvidence, createAndroidDesignContext, createAndroidNodeExtensions, createAndroidPlatformReview, createAndroidProjectContext, createAndroidValidationEvidence, parseEvidenceClaims, parseEvidenceRequirements, parseReviewScope };
