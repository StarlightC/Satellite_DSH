//#region src/android/lib/execution/contracts.ts
/**
* Android 本地执行路线的公共契约与失败词表。
*
* 纯定义/纯校验模块，不导入 Cordis：真实服务由工具注册处按调用作用域注入。
* 这里固定的是"结果怎么说"和"参数怎么校验"，不含任何后端选择。
*/
/** 统一错误码；调用方按词表报告，不解析自然语言正文。 */
const EXECUTION_ERROR_CODES = Object.freeze([
	"CAPABILITY_UNAVAILABLE",
	"TARGET_REQUIRED",
	"TARGET_AMBIGUOUS",
	"TARGET_CHANGED",
	"PATH_DENIED",
	"ARGUMENT_INVALID",
	"APPROVAL_REJECTED",
	"APPROVAL_UNAVAILABLE",
	"POLICY_CHANGED",
	"TIMEOUT",
	"CANCELLED",
	"CLEANUP_FAILED",
	"EFFECT_UNKNOWN"
]);
function isExecutionErrorCode(value) {
	return typeof value === "string" && EXECUTION_ERROR_CODES.includes(value);
}
function outcome(status, action, extra = {}) {
	return Object.freeze({
		status,
		action,
		evidence: Object.freeze([...extra.evidence ?? []]),
		cleanup: extra.cleanup ?? "not-needed",
		...extra.error ? { error: Object.freeze({ ...extra.error }) } : {}
	});
}
const blocked = (action, code, message) => outcome("blocked", action, { error: {
	code,
	message
} });
const failed = (action, code, message) => outcome("failed", action, { error: {
	code,
	message
} });
const cancelled = (action, cleanup = "completed") => outcome("cancelled", action, { cleanup });
const effectUnknown = (action, code, message) => outcome("effect-unknown", action, {
	cleanup: "unknown",
	error: {
		code,
		message
	}
});
var ArgumentError = class extends Error {
	code = "ARGUMENT_INVALID";
	constructor(message) {
		super(message);
		this.name = "ArgumentError";
	}
};
function isPlainRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** 未知字段一律拒绝：模型传来的多余字段不能被静默忽略。 */
function rejectUnknownKeys(value, allowed, where = "arguments") {
	const extra = Object.keys(value).filter((key) => !allowed.includes(key));
	if (extra.length > 0) throw new ArgumentError(`${where}: unknown field(s): ${extra.join(", ")}`);
}
function requireRecord(value, where) {
	if (!isPlainRecord(value)) throw new ArgumentError(`${where} must be an object`);
	return value;
}
/** 有界字符串：非空、无控制字符、不超过上限。 */
function requireText(value, where, max = 2048) {
	if (typeof value !== "string") throw new ArgumentError(`${where} must be a string`);
	if (value.length === 0) throw new ArgumentError(`${where} must not be empty`);
	if (value.length > max) throw new ArgumentError(`${where} must be at most ${max} characters`);
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new ArgumentError(`${where} must not contain control characters`);
	return value;
}
function optionalText(value, where, max = 2048) {
	if (value === void 0) return void 0;
	return requireText(value, where, max);
}
function requireBoolean(value, where) {
	if (typeof value !== "boolean") throw new ArgumentError(`${where} must be a boolean`);
	return value;
}
function requireInteger(value, where, min, max) {
	if (typeof value !== "number" || !Number.isInteger(value)) throw new ArgumentError(`${where} must be an integer`);
	if (value < min || value > max) throw new ArgumentError(`${where} must be between ${min} and ${max}`);
	return value;
}
/** 项目内相对路径：不接受绝对路径、`.`/`..` 段、反斜杠或控制字符。 */
function requireRelativePath(value, where, max = 1024) {
	const text = requireText(value, where, max);
	if (text.startsWith("/") || /^[a-zA-Z]:/.test(text)) throw new ArgumentError(`${where} must be project-relative`);
	if (text.includes("\\")) throw new ArgumentError(`${where} must use forward slashes`);
	if (text.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) throw new ArgumentError(`${where} must not contain empty, "." or ".." segments`);
	return text;
}
function requireEnum(value, where, allowed) {
	if (typeof value !== "string" || !allowed.includes(value)) throw new ArgumentError(`${where} must be one of ${allowed.join("/")}`);
	return value;
}
/**
* 取本次调用真正使用的服务。
* 调用方 Agent 有作用域时只在该作用域取：缺服务就是不可用，不回落到注册根。
*/
function scopedServices(root, exec, names) {
	const scope = exec.agent?.ctx ?? root;
	const services = {};
	for (const name of names) {
		const value = typeof scope.get === "function" ? scope.get(name) : void 0;
		if (!value) return {
			ok: false,
			code: "CAPABILITY_UNAVAILABLE",
			message: `required service unavailable: ${name}`
		};
		services[name] = value;
	}
	return {
		ok: true,
		services
	};
}
const SANDBOX_MODES = Object.freeze([
	"read-only",
	"workspace-write",
	"danger-full-access"
]);
function isSandboxMode(value) {
	return typeof value === "string" && SANDBOX_MODES.includes(value);
}
/** 读当前有效沙箱策略；读不到或形状非法一律不可用，不猜默认值。 */
function resolvePolicy(policy, session) {
	let resolved;
	try {
		resolved = policy.resolve({ session });
	} catch {
		return;
	}
	if (!resolved || !isSandboxMode(resolved.mode)) return void 0;
	if (typeof resolved.workspaceRoot !== "string" || resolved.workspaceRoot.length === 0) return void 0;
	return {
		mode: resolved.mode,
		workspaceRoot: resolved.workspaceRoot,
		...typeof resolved.sessionId === "string" ? { sessionId: resolved.sessionId } : {}
	};
}
/** 同一策略的身份比较：批准前后必须逐字段一致。 */
function policyKey(policy) {
	return JSON.stringify([
		policy.mode,
		policy.workspaceRoot,
		policy.sessionId ?? null
	]);
}
//#endregion
export { ArgumentError, EXECUTION_ERROR_CODES, SANDBOX_MODES, blocked, cancelled, effectUnknown, failed, isExecutionErrorCode, isPlainRecord, isSandboxMode, optionalText, outcome, policyKey, rejectUnknownKeys, requireBoolean, requireEnum, requireInteger, requireRecord, requireRelativePath, requireText, resolvePolicy, scopedServices };
