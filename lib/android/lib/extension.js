//#region src/android/lib/extension.ts
const EXTENSION_ID = "android.validation-context";
const SLOT = "validate.before";
const SLOT_VERSION = 1;
/** Optional caller-supplied context; this text-only extension does not produce a verified machine fact. */
const CONTEXT_FACT = "validation.context";
const ROLE = "android-context";
const SKILL = "android-validation-context";
const OBJECTIVE = "确认当前模块、变体和相关测试入口；不启动设备或运行测试。";
function createAndroidValidationContext() {
	return {
		id: EXTENSION_ID,
		slot: SLOT,
		slotVersion: 1,
		match(facts) {
			const projectKind = facts.values["projectKind"];
			if (projectKind === void 0) return {
				kind: "unknown",
				missing: ["projectKind"]
			};
			if (projectKind !== "android") return { kind: "no" };
			if (facts.values["validation.context"] !== void 0) return { kind: "no" };
			return { kind: "yes" };
		},
		ready(view) {
			if (!view || typeof view !== "object" || typeof view.checkRoleAndSkill !== "function") return {
				ready: false,
				reason: "调用作用域未提供能力检查接口",
				missing: ["checkRoleAndSkill"]
			};
			return view.checkRoleAndSkill(ROLE, SKILL);
		},
		run(execution) {
			if (!execution || typeof execution !== "object" || typeof execution.runConfiguredRole !== "function") return {
				status: "blocked",
				error: "调用作用域未提供角色执行接口"
			};
			return execution.runConfiguredRole(ROLE, {
				skill: SKILL,
				objective: OBJECTIVE
			});
		}
	};
}
//#endregion
export { CONTEXT_FACT, EXTENSION_ID, OBJECTIVE, ROLE, SKILL, SLOT, SLOT_VERSION, createAndroidValidationContext };
