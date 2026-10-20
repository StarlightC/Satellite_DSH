import { createHash, randomUUID } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
Object.freeze([
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
/** 未知字段一律拒绝：模型传来的多余字段不能被静默忽略。 */
function rejectUnknownKeys(value, allowed, where = "arguments") {
	const extra = Object.keys(value).filter((key) => !allowed.includes(key));
	if (extra.length > 0) throw new ArgumentError(`${where}: unknown field(s): ${extra.join(", ")}`);
}
/** 有界字符串：非空、无控制字符、不超过上限。 */
function requireText(value, where, max = 2048) {
	if (typeof value !== "string") throw new ArgumentError(`${where} must be a string`);
	if (value.length === 0) throw new ArgumentError(`${where} must not be empty`);
	if (value.length > max) throw new ArgumentError(`${where} must be at most ${max} characters`);
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new ArgumentError(`${where} must not contain control characters`);
	return value;
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
/** 清理阶段的硬上限：不允许用没有截止时间的清理挂住卸载。 */
const CLEANUP_TIMEOUT_MS = 3e4;
/** 只读取收集模式的前 N 字节，按原始字节截断而不是先解码再截断。 */
function collect(reader, maxBytes) {
	if (!reader) return {
		text: "",
		truncated: false
	};
	const read = reader.readFrom(0);
	const bytes = Buffer.from(read.text, "utf8");
	if (bytes.byteLength <= maxBytes) return {
		text: read.text,
		truncated: read.lossy
	};
	return {
		text: bytes.subarray(0, maxBytes).toString("utf8"),
		truncated: true
	};
}
/** 合并调用信号、期限与 owner 控制器；三者都由调用方拥有生命周期。 */
function linkSignals(parent, timeoutMs, owner) {
	const controller = new AbortController();
	let timeoutHit = false;
	const timer = setTimeout(() => {
		timeoutHit = true;
		controller.abort();
	}, timeoutMs);
	const onParent = () => controller.abort();
	const onOwner = () => controller.abort();
	parent.addEventListener("abort", onParent, { once: true });
	owner?.addEventListener("abort", onOwner, { once: true });
	if (parent.aborted || owner?.aborted) controller.abort();
	return {
		signal: controller.signal,
		timedOut: () => timeoutHit,
		aborted: () => parent.aborted || owner?.aborted === true,
		dispose: () => {
			clearTimeout(timer);
			parent.removeEventListener("abort", onParent);
			owner?.removeEventListener("abort", onOwner);
		}
	};
}
/**
* 执行一次有界命令。
* `sandbox`/`subprocess` 由调用方从其作用域取得，本函数不访问全局。
*/
async function runBounded(services, request, signal) {
	if (signal.aborted) return {
		ok: false,
		failure: { kind: "cancelled" }
	};
	if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1) return {
		ok: false,
		failure: {
			kind: "unavailable",
			message: "invalid timeout"
		}
	};
	if (!Number.isInteger(request.outputMaxBytes) || request.outputMaxBytes < 1) return {
		ok: false,
		failure: {
			kind: "unavailable",
			message: "invalid output limit"
		}
	};
	const unconfined = request.mode === "danger-full-access";
	let confined;
	try {
		confined = unconfined ? {
			argv: [request.executable, ...request.args],
			enforcement: "full",
			denialSignatures: []
		} : await services.sandbox.confine([request.executable, ...request.args], {
			mode: request.mode,
			workspaceRoot: request.workspaceRoot,
			...request.sessionId !== void 0 ? { sessionId: request.sessionId } : {}
		}, signal);
	} catch (error) {
		return {
			ok: false,
			failure: {
				kind: "unavailable",
				message: error instanceof Error ? error.message : String(error)
			}
		};
	}
	signal.throwIfAborted();
	if (!confined || !Array.isArray(confined.argv) || confined.argv.length === 0) return {
		ok: false,
		failure: {
			kind: "unavailable",
			message: "sandbox confinement returned no argv"
		}
	};
	if (confined.enforcement !== "full") return {
		ok: false,
		failure: {
			kind: "unavailable",
			message: `sandbox confinement is ${confined.enforcement}, refusing to run`
		}
	};
	const linked = linkSignals(signal, request.timeoutMs, request.ownerSignal);
	let execution;
	let cleanup = "completed";
	try {
		try {
			execution = services.subprocess.spawn({
				argv: confined.argv,
				cwd: request.cwd,
				stdio: {
					stdin: request.stdin === void 0 ? "ignore" : { data: request.stdin },
					stdout: { maxBytes: request.outputMaxBytes },
					stderr: { maxBytes: request.outputMaxBytes }
				},
				graceMs: request.graceMs ?? 2e3,
				signal: linked.signal,
				...request.env !== void 0 ? { env: request.env } : {}
			});
		} catch (error) {
			return {
				ok: false,
				failure: {
					kind: "unavailable",
					message: error instanceof Error ? error.message : String(error)
				}
			};
		}
		let watchdog;
		const aborted = new Promise((resolve) => {
			const onAbort = () => {
				watchdog = setTimeout(() => resolve("aborted"), Math.min((request.graceMs ?? 2e3) + 250, 5e3));
			};
			if (linked.signal.aborted) onAbort();
			else linked.signal.addEventListener("abort", onAbort, { once: true });
		});
		let settled;
		let doneError;
		const raced = await Promise.race([execution.done.then((value) => ({
			kind: "settled",
			value
		})).catch((error) => ({
			kind: "failed",
			error
		})), aborted.then(() => ({ kind: "watchdog" }))]);
		if (raced.kind === "settled") settled = raced.value;
		else if (raced.kind === "failed") doneError = raced.error;
		const timedOut = linked.timedOut();
		const wasAborted = linked.aborted();
		if (settled === void 0) {
			cleanup = await terminate(execution);
			if (raced.kind === "failed") return {
				ok: true,
				result: {
					exitCode: null,
					signal: null,
					timedOut,
					aborted: wasAborted,
					stdout: {
						text: "",
						truncated: false
					},
					stderr: {
						text: "",
						truncated: false
					},
					enforcement: "full",
					cleanup,
					failureDetail: doneError instanceof Error ? doneError.message : String(doneError)
				}
			};
			return {
				ok: true,
				result: {
					exitCode: null,
					signal: null,
					timedOut: timedOut || !wasAborted,
					aborted: wasAborted,
					stdout: collect(execution.collected.stdout, request.outputMaxBytes),
					stderr: collect(execution.collected.stderr, request.outputMaxBytes),
					enforcement: "full",
					cleanup,
					failureDetail: "the provider did not report process exit after cancellation"
				}
			};
		}
		clearTimeout(watchdog);
		if (timedOut || wasAborted) cleanup = await terminate(execution);
		return {
			ok: true,
			result: {
				exitCode: settled.exitCode,
				signal: settled.signal,
				timedOut,
				aborted: wasAborted,
				stdout: collect(execution.collected.stdout, request.outputMaxBytes),
				stderr: collect(execution.collected.stderr, request.outputMaxBytes),
				enforcement: "full",
				cleanup,
				...unconfined ? { unconfined: true } : {}
			}
		};
	} finally {
		linked.dispose();
	}
}
/**
* 终止并等待退出；超过清理上限算清理失败。
*
* 必须自己带硬截止：`waitForExit` 是 provider 的承诺，不守承诺时
* 无限 await 会把插件卸载挂死。这里用 race 保证一定返回。
*/
async function terminateBounded(handle, timeoutMs = CLEANUP_TIMEOUT_MS) {
	const controller = new AbortController();
	let timer;
	const deadline = new Promise((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve("timeout");
		}, timeoutMs);
	});
	try {
		handle.terminate();
		const exited = Promise.resolve().then(() => handle.waitForExit(controller.signal)).then((value) => value ? "completed" : "failed").catch(() => "failed");
		const raced = await Promise.race([exited, deadline]);
		return raced === "timeout" ? "failed" : raced;
	} catch {
		return "failed";
	} finally {
		clearTimeout(timer);
	}
}
const terminate = (execution) => terminateBounded(execution);
const CLI_VERSION_POLICY = "android-cli-1.0.x";
/** 观测有效期：过期必须重新发现，不能把旧模型套到新批准上。 */
const OBSERVATION_TTL_MS$1 = 300 * 1e3;
/** `android --version` 的支持线；只接受 1.0.x 的稳定数字版本。 */
function parseAndroidCliVersion(output) {
	const text = output.trim();
	return /^1\.0\.\d+$/u.test(text) ? text : void 0;
}
/**
* 解析 Android CLI 1.0.x `describe` 报告。
*
* 报告是行式的：锚点行 + 缩进的 Task/Variant/APK 三级结构。
* 任何锚点缺失、重复、路径非绝对或形状不符都抛错——宁可不可用，不猜。
*/
function parseAndroidCliDescribe(stdout, canonicalProjectRoot, platform = "posix") {
	const lines = stdout.replaceAll("\r\n", "\n").split("\n");
	const separator = platform === "windows" ? "\\" : "/";
	const expectedWrapper = `${canonicalProjectRoot}${canonicalProjectRoot.endsWith(separator) ? "" : separator}${platform === "windows" ? "gradlew.bat" : "gradlew"}`;
	if (!lines.includes(`Target project directory: ${canonicalProjectRoot}`)) throw new TypeError("Android CLI describe target does not match the requested project root");
	if (!lines.includes(`Project directory exists: ${canonicalProjectRoot}`)) throw new TypeError("Android CLI did not confirm the requested project directory");
	if (!lines.includes("Parsed tasks:")) throw new TypeError("Android CLI report is missing its task section");
	if (!lines.includes("gradlew completed successfully.")) throw new TypeError("Android CLI did not complete Gradle description successfully");
	const modules = /* @__PURE__ */ new Map();
	let currentModule;
	let currentVariant;
	for (const line of lines) {
		const task = /^Task: (:[^\s]+)$/u.exec(line);
		if (task !== null) {
			const path = task[1];
			if (modules.has(path)) throw new TypeError(`Android CLI reported duplicate module ${path}`);
			currentModule = {
				path,
				variants: /* @__PURE__ */ new Map()
			};
			modules.set(path, currentModule);
			currentVariant = void 0;
			continue;
		}
		const variant = /^ {4}Variant: ([A-Za-z][A-Za-z0-9_]*)$/u.exec(line);
		if (variant !== null) {
			if (currentModule === void 0) throw new TypeError("Android CLI reported a variant before its module");
			const name = variant[1];
			if (currentModule.variants.has(name)) throw new TypeError(`Android CLI reported duplicate variant ${currentModule.path}:${name}`);
			currentVariant = [];
			currentModule.variants.set(name, currentVariant);
			continue;
		}
		const apk = /^ {8}APK: (.+?)(?: \(Exists\))?$/u.exec(line);
		if (apk !== null) {
			if (currentVariant === void 0) throw new TypeError("Android CLI reported an APK before its variant");
			const path = apk[1];
			if (!path.startsWith("/") && !/^[a-zA-Z]:[\\/]/u.test(path)) throw new TypeError(`Android CLI reported a non-absolute APK path: ${path}`);
			currentVariant.push({
				kind: "apk",
				path
			});
		}
	}
	if (modules.size === 0) throw new TypeError("Android CLI describe report declared no modules");
	return {
		gradleWrapper: expectedWrapper,
		modules: [...modules.values()].map((module) => ({
			path: module.path,
			variants: [...module.variants.entries()].map(([name, artifacts]) => ({
				name,
				artifacts
			}))
		}))
	};
}
/** 观测只定位事实，不授予执行；id 不透明、按调用方隔离、有寿命。 */
function createObservationStore(now, randomId, ttlMs = OBSERVATION_TTL_MS$1) {
	const entries = /* @__PURE__ */ new Map();
	return {
		put(ownerId, facts, modelDigest) {
			const observation = Object.freeze({
				id: randomId(),
				ownerId,
				facts,
				expiresAt: now() + ttlMs,
				modelDigest
			});
			entries.set(observation.id, observation);
			return observation;
		},
		get(id) {
			const observation = entries.get(id);
			if (!observation) return {
				ok: false,
				code: "TARGET_REQUIRED",
				message: "unknown or expired build observation id"
			};
			if (observation.expiresAt <= now()) {
				entries.delete(id);
				return {
					ok: false,
					code: "TARGET_CHANGED",
					message: "build observation expired; discover again"
				};
			}
			return {
				ok: true,
				observation
			};
		},
		/** 只允许观测所有者消费；跨调用方/跨会话的 id 一律拒绝。 */
		getFor(id, ownerId) {
			const found = this.get(id);
			if (!found.ok) return found;
			if (found.observation.ownerId !== ownerId) return {
				ok: false,
				code: "TARGET_CHANGED",
				message: "build observation belongs to another caller"
			};
			return found;
		},
		size() {
			return entries.size;
		}
	};
}
/** 从项目根与文件系统能力构造静态线索；不执行任何进程。 */
async function inspectStaticProject(params) {
	const { projectRoot, fs, signal } = params;
	const rootPath = projectRoot;
	const leads = [];
	const missing = [];
	const resolveIn = async (relative) => fs.resolve(relative, {
		cwd: rootPath,
		signal
	});
	const exists = async (relative) => {
		const target = await resolveIn(relative);
		return await fs.stat(target, signal) ? fs.processPath(target) : void 0;
	};
	for (const [kind, relative, detail] of [
		[
			"wrapper",
			"gradlew",
			"Gradle wrapper script; not executed by static inspection"
		],
		[
			"settings",
			"settings.gradle",
			"Gradle settings file (Groovy)"
		],
		[
			"settings",
			"settings.gradle.kts",
			"Gradle settings file (Kotlin DSL)"
		],
		[
			"build-file",
			"build.gradle",
			"root build file (Groovy)"
		],
		[
			"build-file",
			"build.gradle.kts",
			"root build file (Kotlin DSL)"
		]
	]) {
		const found = await exists(relative);
		if (found) leads.push({
			kind,
			path: found,
			detail
		});
	}
	if (!leads.some((lead) => lead.kind === "wrapper")) missing.push("gradlew");
	let entries = [];
	try {
		entries = await fs.listDir(await resolveIn("."), signal);
	} catch {
		entries = [];
	}
	let inspected = 0;
	for (const entry of entries) {
		if (inspected >= 50) break;
		if (entry.type !== "directory") continue;
		if (entry.name.startsWith(".") || entry.name === "build" || entry.name === "node_modules") continue;
		inspected += 1;
		for (const candidate of ["build.gradle", "build.gradle.kts"]) {
			const found = await exists(`${entry.name}/${candidate}`);
			if (!found) continue;
			leads.push({
				kind: "module-dir",
				path: found,
				detail: "directory contains a Gradle build file; module identity and tasks are NOT verified by static inspection"
			});
			break;
		}
	}
	if (!leads.some((lead) => lead.kind === "module-dir")) missing.push("module build files");
	return Object.freeze({
		projectRoot: rootPath,
		leads: Object.freeze(leads),
		missing: Object.freeze(missing),
		provenance: "static-text",
		verified: false
	});
}
/** 动态事实的摘要：批准前后逐字段比较用。 */
function digestDynamicFacts(sha256, facts) {
	return sha256(JSON.stringify({
		projectRoot: facts.projectRoot,
		gradleWrapper: facts.gradleWrapper,
		cliVersion: facts.cliVersion,
		modules: facts.modules
	}));
}
//#endregion
//#region src/android/lib/execution/device.ts
const DEVICE_TOOL = "satellite_android_device";
const OBSERVATION_TTL_MS = 300 * 1e3;
/** `adb devices -l` 的解析：只认真正有意义的行，其他如实忽略。 */
function parseAdbDevicesL(text) {
	const devices = [];
	for (const raw of text.replaceAll("\r\n", "\n").split("\n")) {
		const line = raw.trim();
		if (line.length === 0) continue;
		if (line.startsWith("List of devices attached")) continue;
		const [serial, state, ...rest] = line.split(/\s+/u);
		if (!serial || !state) continue;
		const extra = {};
		for (const entry of rest) {
			const index = entry.indexOf(":");
			if (index <= 0) continue;
			extra[entry.slice(0, index)] = entry.slice(index + 1);
		}
		devices.push({
			serial,
			state,
			...extra.transport_id ? { transportId: extra.transport_id } : {},
			...extra.product ? { product: extra.product } : {},
			...extra.model ? { model: extra.model } : {},
			...extra.device ? { device: extra.device } : {}
		});
	}
	return devices;
}
/** `adb shell getprop` 的 `[name]: [value]` 行解析。 */
function parseGetprop(text) {
	const props = {};
	for (const raw of text.replaceAll("\r\n", "\n").split("\n")) {
		const match = /^\[([^\]]+)\]: \[(.*)\]$/u.exec(raw.trim());
		if (match === null) continue;
		props[match[1]] = match[2];
	}
	return props;
}
/** 身份摘要：固定字段顺序，含 server endpoint 与 transport，避免"serial 相同即同一台"。 */
function identityDigest(sha256, identity) {
	return sha256(JSON.stringify([
		identity.world,
		identity.adbPath,
		identity.serverEndpoint,
		identity.serial,
		identity.transportId,
		identity.state,
		identity.bootSerial ?? null,
		identity.buildFingerprint ?? null
	]));
}
/** 逐字段比较：serial 相同但 transport/属性变化视为不同实例。 */
function sameInstance(a, b) {
	if (a.serial !== b.serial) return {
		ok: false,
		reason: `serial changed: ${a.serial} → ${b.serial}`
	};
	if (a.transportId !== b.transportId) return {
		ok: false,
		reason: `transport changed: ${a.transportId} → ${b.transportId}`
	};
	if (a.serverEndpoint !== b.serverEndpoint) return {
		ok: false,
		reason: "adb server endpoint changed"
	};
	if ((a.bootSerial ?? "") !== (b.bootSerial ?? "")) return {
		ok: false,
		reason: "boot serial changed"
	};
	if ((a.buildFingerprint ?? "") !== (b.buildFingerprint ?? "")) return {
		ok: false,
		reason: "build fingerprint changed"
	};
	if (b.state !== "device") return {
		ok: false,
		reason: `device state is ${b.state}`
	};
	return { ok: true };
}
/** `dumpsys activity activities` 里的前台包名；解析不出来就是不知道，不猜。 */
function parseForegroundPackage$1(text) {
	for (const pattern of [
		/mResumedActivity: ActivityRecord\{[^}]*\bu\d+\s+([A-Za-z0-9_.]+)\//u,
		/topResumedActivity=ActivityRecord\{[^}]*\bu\d+\s+([A-Za-z0-9_.]+)\//u,
		/mFocusedApp=AppWindowToken\{[^}]*\s([A-Za-z0-9_.]+)\//u
	]) {
		const match = pattern.exec(text);
		if (match?.[1]) return match[1];
	}
}
/** 组件实例内的互斥：busy 立即拒绝，不排队。 */
function createDeviceLock() {
	const held = /* @__PURE__ */ new Set();
	return {
		tryAcquire(key) {
			if (held.has(key)) return false;
			held.add(key);
			return true;
		},
		release(key) {
			held.delete(key);
		},
		held(key) {
			return held.has(key);
		},
		size() {
			return held.size;
		}
	};
}
function lockKey(identity) {
	return [
		identity.world,
		identity.adbPath,
		identity.serverEndpoint,
		identity.serial
	].join("|");
}
/** 观测表：与构建观测同一套语义（不透明 id、按调用方隔离、会过期）。 */
function createDeviceObservationStore(now, randomId, ttlMs = OBSERVATION_TTL_MS) {
	const entries = /* @__PURE__ */ new Map();
	const lookup = (id) => {
		const observation = entries.get(id);
		if (!observation) return {
			ok: false,
			code: "TARGET_REQUIRED",
			message: "unknown device observation id"
		};
		if (observation.expiresAt <= now()) {
			entries.delete(id);
			return {
				ok: false,
				code: "TARGET_CHANGED",
				message: "device observation expired; discover again"
			};
		}
		return {
			ok: true,
			observation
		};
	};
	return {
		put(ownerId, identity, digest) {
			const observation = Object.freeze({
				id: randomId(),
				ownerId,
				identity,
				observedAt: new Date(now()).toISOString(),
				expiresAt: now() + ttlMs,
				digest
			});
			entries.set(observation.id, observation);
			return observation;
		},
		get: lookup,
		getFor(id, ownerId) {
			const found = lookup(id);
			if (!found.ok) return found;
			if (found.observation.ownerId !== ownerId) return {
				ok: false,
				code: "TARGET_CHANGED",
				message: "device observation belongs to another caller"
			};
			return found;
		},
		size() {
			return entries.size;
		}
	};
}
/** 固定 adb 前缀：server endpoint 与目标选择都由已核对的观测提供。 */
function adbArgv(config, target) {
	const argv = [config.adbPath];
	if (config.serverEndpoint) argv.push("-L", config.serverEndpoint);
	if (target?.serial) argv.push("-s", target.serial);
	return argv;
}
function runFailure(action, run) {
	if (run.ok) return void 0;
	if (run.failure.kind === "cancelled") return cancelled(action, "not-needed");
	return blocked(action, "CAPABILITY_UNAVAILABLE", run.failure.message ?? "execution unavailable");
}
/** 执行一次 adb 调用；argv 由调用方给出，且只允许固定的子命令形状。 */
async function adbRun(deps, args, action, target) {
	const { services, binding, exec, config } = deps;
	const run = await runBounded(services, {
		executable: config.adbPath,
		args: [...adbArgv(config, target).slice(1), ...args],
		cwd: binding.root,
		mode: binding.mode,
		workspaceRoot: binding.workspaceRoot,
		...binding.sessionId !== void 0 ? { sessionId: binding.sessionId } : {},
		timeoutMs: config.operationTimeoutMs,
		outputMaxBytes: config.outputMaxBytes
	}, exec.signal);
	const failure = runFailure(action, run);
	if (failure) return {
		ok: false,
		outcome: failure
	};
	if (!run.ok) return {
		ok: false,
		outcome: blocked(action, "CAPABILITY_UNAVAILABLE", "execution unavailable")
	};
	if (run.result.aborted || run.result.timedOut) return {
		ok: false,
		outcome: run.result.aborted ? cancelled(action, run.result.cleanup === "completed" ? "completed" : "failed") : failed(action, "TIMEOUT", "adb did not finish before its deadline")
	};
	return {
		ok: true,
		text: run.result.stdout.text,
		exitCode: run.result.exitCode
	};
}
/** 解析设备属性；`ro.boot.serialno`/`ro.serialno` 都没有时身份不可用。 */
function identityFromProbe(params) {
	const bootSerial = params.props["ro.boot.serialno"] || params.props["ro.serialno"];
	if (!bootSerial) return "device reported neither ro.boot.serialno nor ro.serialno";
	const state = [
		"device",
		"offline",
		"unauthorized"
	].includes(params.state) ? params.state : "unknown";
	return Object.freeze({
		world: "host-shared-v1",
		adbPath: params.adbPath,
		serverEndpoint: params.serverEndpoint,
		generation: params.generation,
		serial: params.serial,
		transportId: params.transportId ?? params.serial,
		state,
		bootSerial,
		...params.props["ro.build.fingerprint"] ? { buildFingerprint: params.props["ro.build.fingerprint"] } : {},
		...params.product ? { product: params.product } : {},
		...params.model ? { model: params.model } : {}
	});
}
/**
* 观测一台明确指定的设备。
* `serial` 必须由调用方给出：本函数不会替调用方挑第一台设备。
*/
async function observeDevice(deps, serial, generation) {
	const list = await adbRun(deps, ["devices", "-l"], "device.discover");
	if (!list.ok) return {
		ok: false,
		outcome: list.outcome
	};
	const devices = parseAdbDevicesL(list.text);
	if (devices.length === 0) return {
		ok: false,
		outcome: blocked("device.discover", "TARGET_REQUIRED", "no devices are attached to this adb server")
	};
	const matches = devices.filter((entry) => entry.serial === serial);
	if (matches.length === 0) return {
		ok: false,
		outcome: blocked("device.discover", "TARGET_REQUIRED", `device is not attached: ${serial}`)
	};
	if (matches.length > 1) return {
		ok: false,
		outcome: blocked("device.discover", "TARGET_AMBIGUOUS", `adb reported ${matches.length} entries for ${serial}`)
	};
	const entry = matches[0];
	if (entry.state !== "device") return {
		ok: false,
		outcome: blocked("device.discover", "TARGET_REQUIRED", `device ${serial} is ${entry.state}`)
	};
	const props = await adbRun(deps, ["shell", "getprop"], "device.discover", { serial });
	if (!props.ok) return {
		ok: false,
		outcome: props.outcome
	};
	const identity = identityFromProbe({
		adbPath: deps.config.adbPath,
		serverEndpoint: deps.config.serverEndpoint ?? "default",
		generation,
		serial: entry.serial,
		...entry.transportId !== void 0 ? { transportId: entry.transportId } : {},
		state: entry.state,
		props: parseGetprop(props.text),
		...entry.product !== void 0 ? { product: entry.product } : {},
		...entry.model !== void 0 ? { model: entry.model } : {}
	});
	if (typeof identity === "string") return {
		ok: false,
		outcome: blocked("device.discover", "CAPABILITY_UNAVAILABLE", identity)
	};
	return {
		ok: true,
		identity
	};
}
/** 变更动作之前的立即复核：任何字段变化都要求新的观测与批准。 */
async function verifyDevice(deps, expected) {
	const probe = await observeDevice(deps, expected.serial, expected.generation);
	if (!probe.ok) return {
		ok: false,
		reason: probe.outcome.error?.message ?? "device re-probe failed"
	};
	return sameInstance(expected, probe.identity);
}
function parseDeviceRequest(args) {
	rejectUnknownKeys(args, [
		"action",
		"serial",
		"observationId",
		"artifact",
		"applicationId"
	]);
	const action = requireEnum(args.action, "action", [
		"discover",
		"install",
		"launch",
		"foreground"
	]);
	const serial = requireText(args.serial, "serial", 128);
	if (action === "discover") {
		if (args.observationId !== void 0 || args.artifact !== void 0 || args.applicationId !== void 0) throw new ArgumentError("discover does not take observationId, artifact or applicationId");
		return {
			action,
			serial
		};
	}
	const observationId = requireText(args.observationId, "observationId", 128);
	if (action === "install") return {
		action,
		serial,
		observationId,
		artifact: requireArtifactPath(requireText(args.artifact, "artifact", 1024))
	};
	const applicationId = requireText(args.applicationId, "applicationId", 255);
	if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/u.test(applicationId)) throw new ArgumentError("applicationId must be a reverse-DNS package name");
	return {
		action,
		serial,
		observationId,
		applicationId
	};
}
/** 产物只接受工作区内的相对路径；绝对路径与上跳一律拒绝。 */
function requireArtifactPath(value) {
	if (value.startsWith("/") || value.includes("\\")) throw new ArgumentError("artifact must be a workspace-relative path");
	if (value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) throw new ArgumentError("artifact must not contain empty, \".\" or \"..\" segments");
	return value;
}
/** 无需批准的动作只有 discover（只读查询）；其余都要真实批准。 */
function describeDevicePlan(request, identity) {
	switch (request.action) {
		case "discover": return "Run \"adb devices -l\" and \"adb -s <serial> shell getprop\" to observe the attached devices. This may start the adb server on this host. No device data is modified.";
		case "install": return `Install ${request.artifact} on ${identity?.serial ?? request.serial} with "adb -s <serial> install -r <artifact>". It replaces the installed app with the same application id and writes the APK to the device.`;
		case "launch": return `Launch ${request.applicationId} on ${identity?.serial ?? request.serial} with a launcher-category monkey start. It changes the device's foreground application.`;
		case "foreground": return `Read the current foreground activity on ${identity?.serial ?? request.serial} with "dumpsys activity activities". Read-only on the device.`;
	}
}
/**
* 目标绑定与互斥的统一前置（§5.1/§5.3）。
*
* 任何会在设备上产生效果的动作——安装、启动、UI 旅程、录屏/采集——
* 都必须走这里：策略重读 → 观测所有权 → 进程内互斥 → 批准后设备复核。
* 只接受裸 serial 就直接执行会绕过批准后的目标复核，因此不提供这种入口。
*/
async function prepareObservedTarget(deps, lock, observations, request, observedPolicy) {
	const action = request.action;
	if (request.observationId === void 0) return {
		ok: false,
		outcome: blocked(action, "TARGET_REQUIRED", "a device observation id is required for any action that touches the device; run discover first")
	};
	const found = observations.getFor(request.observationId, deps.exec.agent?.id ?? "unknown");
	if (!found.ok) return {
		ok: false,
		outcome: blocked(action, found.code, found.message)
	};
	const identity = found.observation.identity;
	if (request.serial !== void 0 && request.serial !== identity.serial) return {
		ok: false,
		outcome: blocked(action, "TARGET_CHANGED", "request serial does not match the observation")
	};
	const after = resolvePolicy(deps.services.sandboxPolicy, deps.exec.agent?.session);
	if (!after || policyKey(after) !== policyKey(observedPolicy)) return {
		ok: false,
		outcome: blocked(action, "POLICY_CHANGED", "session policy changed after approval; retry required")
	};
	const key = lockKey(identity);
	if (!lock.tryAcquire(key)) return {
		ok: false,
		outcome: blocked(action, "TARGET_CHANGED", `another operation is already using ${identity.serial}`)
	};
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		lock.release(key);
	};
	const check = await verifyDevice(deps, identity);
	if (!check.ok) {
		release();
		return {
			ok: false,
			outcome: blocked(action, "TARGET_CHANGED", `device changed before execution: ${check.reason}`)
		};
	}
	return {
		ok: true,
		identity,
		release
	};
}
//#endregion
//#region src/android/lib/execution/emulator.ts
/**
* Android 模拟器：明确 AVD 的有界生命周期与**会话所有权**。
*
* 只有 `start` 会保留一个长寿命进程，并且必须完成一次原子的所有权转移：
* 转移前资源属于本次调用（失败/取消都要在本调用内终止并等待）；
* 转移后资源属于当前 Agent 作用域，直到显式 stop、owner 退出或组件卸载。
*
* 与规格一致的边界：
* - 不使用 AVD 名称当作运行实例身份，也不按名称接管别人的进程；
* - 首版不提供跨 Host 重启恢复，也不承诺宿主崩溃后的清理；
* - `stop` 的 owned 分支只认本组件发过的不透明 id；external 分支必须重新观测并单独批准。
*/
const EMULATOR_TOOL = "satellite_android_emulator";
const AVD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
function parseEmulatorRequest(args) {
	rejectUnknownKeys(args, [
		"action",
		"avd",
		"ownedResourceId",
		"serial",
		"installedSystemImage",
		"deviceProfile",
		"startupTimeoutMs"
	]);
	const action = requireEnum(args.action, "action", [
		"list",
		"start",
		"stop",
		"delete",
		"create"
	]);
	const startupTimeoutMs = args.startupTimeoutMs === void 0 ? void 0 : requireInteger(args.startupTimeoutMs, "startupTimeoutMs", 1e4, 1800 * 1e3);
	if (action === "list") {
		if (args.avd !== void 0 || args.ownedResourceId !== void 0 || args.serial !== void 0 || args.installedSystemImage !== void 0 || args.deviceProfile !== void 0 || startupTimeoutMs !== void 0) throw new ArgumentError("list takes no other arguments");
		return { action };
	}
	if (action === "stop") {
		const ownedResourceId = args.ownedResourceId === void 0 ? void 0 : requireText(args.ownedResourceId, "ownedResourceId", 128);
		const serial = args.serial === void 0 ? void 0 : requireText(args.serial, "serial", 128);
		if (ownedResourceId === void 0 === (serial === void 0)) throw new ArgumentError("stop requires exactly one of ownedResourceId or serial");
		if (args.avd !== void 0 || args.installedSystemImage !== void 0 || args.deviceProfile !== void 0) throw new ArgumentError("stop takes neither avd nor system image");
		return {
			action,
			...ownedResourceId ? { ownedResourceId } : {},
			...serial ? { serial } : {}
		};
	}
	if (action === "create") {
		const avd = requireAvd(args.avd);
		const installedSystemImage = requireText(args.installedSystemImage, "installedSystemImage", 255);
		const deviceProfile = requireText(args.deviceProfile, "deviceProfile", 128);
		if (!/^[A-Za-z0-9._;+-]+$/u.test(installedSystemImage)) throw new ArgumentError("installedSystemImage must be an already installed SDK package id");
		return {
			action,
			avd,
			installedSystemImage,
			deviceProfile
		};
	}
	const avd = requireAvd(args.avd);
	if (args.ownedResourceId !== void 0 || args.serial !== void 0 || args.installedSystemImage !== void 0 || args.deviceProfile !== void 0) throw new ArgumentError(`${action} takes only avd`);
	return {
		action,
		avd,
		...startupTimeoutMs !== void 0 ? { startupTimeoutMs } : {}
	};
}
function requireAvd(value) {
	const avd = requireText(value, "avd", 64);
	if (!AVD_NAME.test(avd)) throw new ArgumentError("avd must be a plain AVD name");
	return avd;
}
/** `emulator -list-avds` 的解析：只保留合法名称，重复项视为歧义。 */
function parseAvdList(text) {
	const names = [];
	for (const raw of text.replaceAll("\r\n", "\n").split("\n")) {
		const line = raw.trim();
		if (line.length === 0) continue;
		if (/^(INFO|WARNING|ERROR)\b/u.test(line)) continue;
		if (!AVD_NAME.test(line)) continue;
		if (!names.includes(line)) names.push(line);
	}
	return names;
}
/** `adb devices` 里新出现的 emulator serial。 */
function newEmulatorSerial(before, after) {
	const fresh = after.filter((serial) => serial.startsWith("emulator-") && !before.includes(serial));
	return fresh.length === 1 ? fresh[0] : void 0;
}
function adbSerials(text) {
	const serials = [];
	for (const raw of text.replaceAll("\r\n", "\n").split("\n")) {
		const line = raw.trim();
		if (line.length === 0 || line.startsWith("List of devices attached")) continue;
		const [serial, state] = line.split(/\s+/u);
		if (!serial || !state) continue;
		if (!serials.includes(serial)) serials.push(serial);
	}
	return serials;
}
/**
* 会话拥有的资源表。
* `close` 是幂等的：并发 stop、owner 退出与组件卸载共享同一个 memoized promise，
* 不依赖"第二个 disposer 会等第一个"这种假设。
*/
function createOwnedResources(cleanupTimeoutMs = 3e4) {
	const entries = /* @__PURE__ */ new Map();
	const closing = /* @__PURE__ */ new Map();
	let accepting = true;
	const close = (id) => {
		const existing = closing.get(id);
		if (existing) return existing;
		const resource = entries.get(id);
		if (!resource) return Promise.resolve("completed");
		const promise = (async () => {
			resource.ownerController.abort();
			const result = await terminateBounded(resource.handle, cleanupTimeoutMs);
			if (result === "completed") entries.delete(id);
			closing.delete(id);
			return result;
		})();
		closing.set(id, promise);
		resource.closePromise = promise;
		return promise;
	};
	return {
		adopt(resource) {
			if (!accepting) throw new Error("owned resources are closing; refusing to adopt");
			if (entries.has(resource.id)) throw new Error(`owned resource id already exists: ${resource.id}`);
			entries.set(resource.id, resource);
		},
		get(id, ownerId) {
			const resource = entries.get(id);
			if (!resource) return void 0;
			return resource.ownerId === ownerId ? resource : void 0;
		},
		has(id) {
			return entries.has(id);
		},
		close,
		/** Agent 作用域退出：只关闭该 Agent 拥有的资源，并等待完成。 */
		async closeOwner(ownerId) {
			const ids = [...entries.values()].filter((resource) => resource.ownerId === ownerId).map((resource) => resource.id);
			return (await Promise.all(ids.map((id) => close(id)))).every((value) => value === "completed") ? "completed" : "failed";
		},
		/** 组件卸载：先禁止新转移，再关闭全部；返回是否有失败。 */
		async closeAll() {
			accepting = false;
			return (await Promise.all([...entries.keys()].map((id) => close(id)))).every((value) => value === "completed") ? "completed" : "failed";
		},
		size() {
			return entries.size;
		}
	};
}
function describeEmulatorPlan(request) {
	switch (request.action) {
		case "list": return "Run \"emulator -list-avds\" to read the configured AVD names. It does not start a VM and does not modify AVD data.";
		case "start": return `Start AVD ${request.avd} with "emulator -avd ${request.avd}". The emulator keeps running after this call until it is stopped explicitly, the agent scope exits, or the plugin unloads; it consumes CPU, memory and a console/ADB port.`;
		case "stop": return request.ownedResourceId ? `Stop the emulator instance this component started (owned id ${request.ownedResourceId}) and wait for it to exit.` : `Stop the emulator attached as ${request.serial} with "adb -s ${request.serial} emu kill". This does NOT claim ownership: any instance with that serial is stopped.`;
		case "delete": return `Delete AVD ${request.avd} with "avdmanager delete avd -n ${request.avd}". It removes the AVD definition and its data from disk.`;
		case "create": return `Create AVD ${request.avd} from the already installed system image ${request.installedSystemImage} and device profile ${request.deviceProfile} with "avdmanager create avd". Nothing is downloaded.`;
	}
}
async function adbText(deps, args) {
	return mapEmulatorRun(await runBounded(deps.services, {
		executable: deps.config.adbPath,
		args,
		cwd: deps.binding.root,
		mode: deps.binding.mode,
		workspaceRoot: deps.binding.workspaceRoot,
		...deps.binding.sessionId !== void 0 ? { sessionId: deps.binding.sessionId } : {},
		timeoutMs: deps.config.operationTimeoutMs,
		outputMaxBytes: deps.config.outputMaxBytes
	}, deps.exec.signal));
}
function mapEmulatorRun(run) {
	if (!run.ok) {
		if (run.failure.kind === "cancelled") return {
			ok: false,
			outcome: cancelled("emulator", "not-needed")
		};
		return {
			ok: false,
			outcome: blocked("emulator", "CAPABILITY_UNAVAILABLE", run.failure.message ?? "execution unavailable")
		};
	}
	if (run.result.aborted || run.result.timedOut) return {
		ok: false,
		outcome: run.result.aborted ? cancelled("emulator", run.result.cleanup === "completed" ? "completed" : "failed") : failed("emulator", "TIMEOUT", "the emulator command did not finish before its deadline")
	};
	return {
		ok: true,
		text: run.result.stdout.text,
		exitCode: run.result.exitCode
	};
}
/** 近似睡眠，可被调用信号取消；不占用进程。 */
async function delay(ms, signal) {
	if (signal.aborted) return false;
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve(true);
		}, ms);
		const onAbort = () => {
			cleanup();
			resolve(false);
		};
		const cleanup = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
/**
* 启动一个 AVD 并在 boot-ready 时把资源原子转移给调用方。
* 失败、取消或未观测到实例时都在本调用内终止并等待。
*/
async function startEmulator(deps, request, resources, adopt) {
	const avd = request.avd;
	const before = await adbText(deps, ["devices"]);
	if (!before.ok) return {
		ok: false,
		outcome: before.outcome
	};
	const beforeSerials = adbSerials(before.text);
	const ownerController = new AbortController();
	const startupController = new AbortController();
	const bridge = () => startupController.abort();
	deps.exec.signal.addEventListener("abort", bridge, { once: true });
	const startupTimeout = setTimeout(() => startupController.abort(), request.startupTimeoutMs ?? 3e5);
	let handle;
	let transferred = false;
	let cleaned;
	const cleanupOnce = async () => {
		if (cleaned !== void 0) return cleaned;
		cleaned = handle === void 0 ? "completed" : await closeHandle(handle);
		return cleaned;
	};
	try {
		try {
			handle = deps.services.subprocess.spawn({
				argv: [
					deps.config.emulatorPath,
					"-avd",
					avd
				],
				cwd: deps.binding.root,
				stdio: {
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					control: void 0
				},
				graceMs: 5e3,
				signal: ownerController.signal
			});
		} catch (error) {
			return {
				ok: false,
				outcome: blocked("emulator.start", "CAPABILITY_UNAVAILABLE", error instanceof Error ? error.message : String(error))
			};
		}
		const deadline = Date.now() + (request.startupTimeoutMs ?? 3e5);
		let serial;
		let booted = false;
		let probeFailure;
		while (Date.now() < deadline) {
			if (startupController.signal.aborted) break;
			const listed = await adbText(deps, ["devices"]);
			if (!listed.ok) {
				probeFailure = listed.outcome;
				break;
			}
			serial ??= newEmulatorSerial(beforeSerials, adbSerials(listed.text));
			if (serial) {
				const boot = await adbText(deps, [
					"-s",
					serial,
					"shell",
					"getprop",
					"sys.boot_completed"
				]);
				if (!boot.ok) {
					probeFailure = boot.outcome;
					break;
				}
				if (boot.text.trim() === "1") {
					booted = true;
					break;
				}
			}
			if (!await delay(deps.config.bootPollIntervalMs ?? 2e3, startupController.signal)) break;
		}
		if (probeFailure !== void 0 || !booted || !serial || startupController.signal.aborted) {
			const cleanup = await cleanupOnce();
			if (probeFailure !== void 0) return {
				ok: false,
				outcome: {
					...probeFailure,
					action: "emulator.start",
					cleanup,
					...cleanup === "failed" ? { error: {
						code: "CLEANUP_FAILED",
						message: `emulator.start failed (${probeFailure.error?.message ?? probeFailure.status}) and the started process did not report exit`
					} } : {}
				}
			};
			const outcome = startupController.signal.aborted && !deps.exec.signal.aborted ? failed("emulator.start", "TIMEOUT", `AVD ${avd} did not reach boot-complete before its deadline`) : deps.exec.signal.aborted ? cancelled("emulator.start", cleanup) : failed("emulator.start", "EFFECT_UNKNOWN", `AVD ${avd} started but no boot-complete emulator serial was observed`);
			return {
				ok: false,
				outcome: cleanup === "failed" && outcome.status !== "cancelled" ? {
					...outcome,
					cleanup: "failed",
					error: {
						code: "CLEANUP_FAILED",
						message: `${outcome.error?.message ?? "start failed"}; the started process did not report exit`
					}
				} : {
					...outcome,
					cleanup
				}
			};
		}
		deps.exec.signal.removeEventListener("abort", bridge);
		clearTimeout(startupTimeout);
		const resource = {
			id: `owned-${randomUUID()}`,
			ownerId: deps.exec.agent?.id ?? "unknown",
			avd,
			serial,
			handle: {
				terminate: () => handle?.terminate(),
				waitForExit: (signal) => handle?.waitForExit(signal) ?? Promise.resolve(true)
			},
			ownerController
		};
		try {
			adopt(resource);
		} catch (error) {
			const cleanup = await cleanupOnce();
			return {
				ok: false,
				outcome: blocked("emulator.start", "CAPABILITY_UNAVAILABLE", `${error instanceof Error ? error.message : String(error)} (cleanup: ${cleanup})`)
			};
		}
		transferred = true;
		return {
			ok: true,
			result: {
				ownedResourceId: resource.id,
				serial,
				avd
			}
		};
	} finally {
		deps.exec.signal.removeEventListener("abort", bridge);
		clearTimeout(startupTimeout);
		if (!transferred && handle !== void 0) await cleanupOnce();
	}
}
const closeHandle = (handle) => terminateBounded(handle, 3e4);
/** list / create / delete / external stop：都是有界的一次进程。 */
async function runBoundedEmulatorAction(deps, request) {
	const run = (executable, args, action) => runBounded(deps.services, {
		executable,
		args,
		cwd: deps.binding.root,
		mode: deps.binding.mode,
		workspaceRoot: deps.binding.workspaceRoot,
		...deps.binding.sessionId !== void 0 ? { sessionId: deps.binding.sessionId } : {},
		timeoutMs: deps.config.operationTimeoutMs,
		outputMaxBytes: deps.config.outputMaxBytes
	}, deps.exec.signal).then((outcome) => ({
		outcome,
		action
	}));
	if (request.action === "list") {
		const { outcome: run1, action } = await run(deps.config.emulatorPath, ["-list-avds"], "emulator.list");
		const mapped = mapEmulatorRun(run1);
		if (!mapped.ok) return mapped.outcome;
		return outcome("succeeded", action, { evidence: parseAvdList(mapped.text).map((avd) => ({
			kind: "avd",
			source: avd
		})) });
	}
	if (request.action === "delete" || request.action === "create") {
		if (!deps.config.avdmanagerPath) return blocked(`emulator.${request.action}`, "CAPABILITY_UNAVAILABLE", "avdmanager executable is not configured (avdmanagerPath)");
		const args = request.action === "delete" ? [
			"delete",
			"avd",
			"-n",
			request.avd
		] : [
			"create",
			"avd",
			"-n",
			request.avd,
			"-k",
			request.installedSystemImage,
			"--device",
			request.deviceProfile
		];
		const { outcome: run1, action } = await run(deps.config.avdmanagerPath, args, `emulator.${request.action}`);
		const mapped = mapEmulatorRun(run1);
		if (!mapped.ok) return mapped.outcome;
		const ok = mapped.exitCode === 0;
		return outcome(ok ? "succeeded" : "failed", action, {
			evidence: [{
				kind: "avd",
				source: request.avd
			}],
			...ok ? {} : { error: {
				code: "CAPABILITY_UNAVAILABLE",
				message: `avdmanager exited with ${mapped.exitCode}`
			} }
		});
	}
	const serial = request.serial;
	const { outcome: run1, action } = await run(deps.config.adbPath, [
		"-s",
		serial,
		"emu",
		"kill"
	], "emulator.stop");
	const mapped = mapEmulatorRun(run1);
	if (!mapped.ok) return mapped.outcome;
	const ok = mapped.exitCode === 0;
	return outcome(ok ? "succeeded" : "failed", action, {
		evidence: [{
			kind: "device",
			source: serial
		}],
		cleanup: "not-needed",
		...ok ? {} : { error: {
			code: "CAPABILITY_UNAVAILABLE",
			message: `adb emu kill exited with ${mapped.exitCode}`
		} }
	});
}
//#endregion
//#region src/android/lib/execution/journey.ts
/**
* 有界 UI 旅程（A3.3）：把一组判别类型步骤映射成**精确的 adb argv**。
*
* 不变量：
* - 没有任意命令、没有 shell 字符串、没有无限循环：每一步只对应一条固定的 argv；
* - 所有参数在启动任何进程之前完成严格校验（未知字段/未知步骤/越界值直接拒绝）；
* - 断言失败立即停止后续步骤，并如实标记 failed，不把"没断言"当成通过；
* - 截图走 `screencap -p <设备路径>` + `adb pull`，**不**把二进制当文本从 stdout 解码；
*   拉回后必须用文件系统核对存在与摘要；
* - UI 文本断言走 `uiautomator dump` + `exec-out cat` 读取**有界文本**；
*   输出被截断或解析不出节点时报告 failed/unavailable，绝不当作通过；
* - 设备临时文件在 finally 中清理，清理失败单列，不用成功掩盖。
*
* 批准（真实 `approval.request`）由接线方在调用前完成；本模块只暴露
* `describeJourneyPlan()` 供批准理由使用，并负责执行与结果映射。
*/
/** 设备上的临时目录：所有中间产物都写在这里，并在 finally 清理。 */
const DEVICE_TMP_DIR = "/data/local/tmp";
const MAX_TEXT_LENGTH = 1024;
const MAX_WAIT_MS = 3e4;
/** 一次 UI dump 的文本上限。 */
const UI_DUMP_MAX_BYTES = 4 * 1024 * 1024;
const SCREENSHOT_DIGEST_MAX_BYTES = 16 * 1024 * 1024;
/** 允许的按键白名单（`input keyevent` 的 KEYCODE_* 名）。 */
const JOURNEY_KEYS = Object.freeze([
	"KEYCODE_HOME",
	"KEYCODE_BACK",
	"KEYCODE_ENTER",
	"KEYCODE_DEL",
	"KEYCODE_TAB",
	"KEYCODE_ESCAPE",
	"KEYCODE_MENU",
	"KEYCODE_APP_SWITCH",
	"KEYCODE_DPAD_UP",
	"KEYCODE_DPAD_DOWN",
	"KEYCODE_DPAD_LEFT",
	"KEYCODE_DPAD_RIGHT",
	"KEYCODE_DPAD_CENTER",
	"KEYCODE_MOVE_HOME",
	"KEYCODE_MOVE_END",
	"KEYCODE_PAGE_UP",
	"KEYCODE_PAGE_DOWN"
]);
/** adb serial：不接受空值、选项形状或 shell/argv 危险字符。 */
function parseSerial$1(value) {
	const serial = requireText(value, "serial", 128);
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(serial)) throw new ArgumentError("serial must match [A-Za-z0-9][A-Za-z0-9._:-]* (no spaces, leading \"-\" or shell characters)");
	return serial;
}
/** 应用包名：只允许点分标识符，避免把任意串拼进设备 shell。 */
function parsePackageName$1(value, where) {
	const name = requireText(value, where, 255);
	if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u.test(name)) throw new ArgumentError(`${where} must be a dotted package name`);
	return name;
}
/**
* `input text` 的字符集收窄。
*
* adb 会把 argv 重新拼成远程 shell 命令，因此**任何**shell 元字符都不能放行；
* 这里只接受字母数字与少量安全标点，空格按 `input text` 的要求编码成 `%s`。
* 这不是"方便"的选择，而是把注入面直接去掉。
*/
const INPUT_TEXT_PATTERN = /^[A-Za-z0-9 .,_@/:+=_-]+$/u;
function encodeInputText(value) {
	if (typeof value !== "string") throw new ArgumentError("text must be a string");
	requireText(value, "text", MAX_TEXT_LENGTH);
	if (!INPUT_TEXT_PATTERN.test(value)) throw new ArgumentError("text may only contain letters, digits, space and . , _ @ / : + = - (shell metacharacters are not accepted)");
	if (value.startsWith("-")) throw new ArgumentError("text must not start with \"-\"");
	return value.replaceAll(" ", "%s");
}
function parseStep(value, index) {
	const where = `steps[${index}]`;
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ArgumentError(`${where} must be an object`);
	const step = value;
	const action = requireEnum(step.action, `${where}.action`, [
		"tap",
		"text",
		"key",
		"wait",
		"assert-foreground",
		"assert-ui-text",
		"screenshot"
	]);
	switch (action) {
		case "tap":
			rejectUnknownKeys(step, [
				"action",
				"x",
				"y"
			], where);
			return {
				action,
				x: requireInteger(step.x, `${where}.x`, 0, 1e5),
				y: requireInteger(step.y, `${where}.y`, 0, 1e5)
			};
		case "text": {
			rejectUnknownKeys(step, ["action", "text"], where);
			const text = requireText(step.text, `${where}.text`, MAX_TEXT_LENGTH);
			encodeInputText(text);
			return {
				action,
				text
			};
		}
		case "key":
			rejectUnknownKeys(step, ["action", "key"], where);
			return {
				action,
				key: requireEnum(step.key, `${where}.key`, JOURNEY_KEYS)
			};
		case "wait":
			rejectUnknownKeys(step, ["action", "ms"], where);
			return {
				action,
				ms: requireInteger(step.ms, `${where}.ms`, 1, MAX_WAIT_MS)
			};
		case "assert-foreground":
			rejectUnknownKeys(step, ["action", "package"], where);
			return {
				action,
				packageName: parsePackageName$1(step.package, `${where}.package`)
			};
		case "assert-ui-text":
			rejectUnknownKeys(step, ["action", "text"], where);
			return {
				action,
				text: requireText(step.text, `${where}.text`, 512)
			};
		case "screenshot":
			rejectUnknownKeys(step, ["action", "output"], where);
			return {
				action,
				output: requireRelativePath(step.output, `${where}.output`)
			};
	}
}
/** 严格解析：未知字段、未知动作、越界值与超长文本都在启动前拒绝。 */
function parseJourneyRequest(args) {
	if (typeof args !== "object" || args === null || Array.isArray(args)) throw new ArgumentError("journey arguments must be an object");
	const record = args;
	rejectUnknownKeys(record, [
		"serial",
		"applicationId",
		"steps"
	]);
	const serial = parseSerial$1(record.serial);
	const applicationId = parsePackageName$1(record.applicationId, "applicationId");
	if (!Array.isArray(record.steps)) throw new ArgumentError("steps must be an array");
	if (record.steps.length === 0) throw new ArgumentError("steps must not be empty");
	if (record.steps.length > 30) throw new ArgumentError(`steps must contain at most 30 entries`);
	return Object.freeze({
		serial,
		applicationId,
		steps: Object.freeze(record.steps.map((step, index) => Object.freeze(parseStep(step, index))))
	});
}
/** 供批准理由使用的计划描述：写哪些设备临时文件、拉回哪些工作区路径都要出现。 */
function describeJourneyPlan(request) {
	const shots = request.steps.filter((step) => step.action === "screenshot");
	const asserts = request.steps.filter((step) => step.action === "assert-ui-text" || step.action === "assert-foreground").length;
	return [
		`Run a bounded UI journey of ${request.steps.length} steps (max 30) on device "${request.serial}" for ${request.applicationId}.`,
		"Every step is one fixed adb command; no shell strings and no arbitrary commands are accepted.",
		"Taps, text input and key events change real device UI state.",
		shots.length > 0 ? `Screenshots are captured on the device under ${DEVICE_TMP_DIR} and pulled into the workspace at: ${shots.map((step) => step.output).join(", ")}; device copies are deleted afterwards.` : "No screenshots are captured.",
		asserts > 0 ? "UI assertions dump the on-device view hierarchy to a device temporary file, read it back as bounded text, and delete the device copy afterwards." : "No UI assertions run.",
		"On-device effects happen outside the file sandbox; the session sandbox only covers workspace writes."
	].join(" ");
}
/**
* 只构造 adb 之后的参数：可执行文件由 `runBounded` 通过 `executable` 统一前置，
* 两处都加会把 adb 拼两次。
*/
const adb$1 = (_deps, serial, args) => [
	"-s",
	serial,
	...args
];
/** 设备临时路径：只由本模块生成，不接受调用方提供。 */
function deviceTempPath(suffix, token) {
	const safe = suffix.replace(/[^A-Za-z0-9._-]/gu, "");
	return `${DEVICE_TMP_DIR}/satellite-${token}${safe ? `.${safe}` : ""}`;
}
/** 从 `dumpsys activity activities` 文本里读出前台包名；读不出返回 undefined。 */
function parseForegroundPackage(text) {
	for (const line of text.split("\n")) {
		if (!/(mResumedActivity|topResumedActivity|ResumedActivity)/u.test(line)) continue;
		const match = /\s([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)\//u.exec(line);
		if (match?.[1]) return match[1];
	}
}
/** 从 uiautomator dump 的 XML 文本里取出全部节点 text 属性（已解转义）。 */
function parseUiTexts(xml) {
	const texts = [];
	const pattern = /\stext="([^"]*)"/gu;
	let match;
	while ((match = pattern.exec(xml)) !== null) texts.push(unescapeXml(match[1] ?? ""));
	return texts;
}
function unescapeXml(value) {
	return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", "\"").replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}
const sha256$2 = (value) => createHash("sha256").update(value).digest("hex");
function frozen$1(status, action, extra) {
	return Object.freeze({
		status,
		action,
		evidence: Object.freeze([...extra.evidence ?? []]),
		cleanup: extra.cleanup ?? "not-needed",
		...extra.error ? { error: Object.freeze({ ...extra.error }) } : {},
		steps: Object.freeze([...extra.steps])
	});
}
/** 跑一条固定 argv；返回结果或"运行层面失败"。 */
async function runCommand$1(context, args, options = {}) {
	const { deps, request } = context;
	if (deps.exec.signal.aborted) return {
		ok: false,
		outcome: {
			ok: false,
			status: "cancelled",
			code: "CANCELLED",
			detail: "cancelled before the next step"
		}
	};
	const remaining = context.deadline - Date.now();
	if (remaining <= 0) return {
		ok: false,
		outcome: {
			ok: false,
			status: "failed",
			code: "TIMEOUT",
			detail: "journey deadline exceeded before the next step"
		}
	};
	const timeoutMs = Math.min(options.timeoutMs ?? 3e4, remaining);
	const run = await runBounded({
		sandbox: deps.sandbox,
		subprocess: deps.subprocess
	}, {
		executable: deps.adbPath,
		args,
		cwd: deps.binding.root,
		mode: deps.binding.mode,
		workspaceRoot: deps.binding.workspaceRoot,
		...deps.binding.sessionId !== void 0 ? { sessionId: deps.binding.sessionId } : {},
		timeoutMs,
		outputMaxBytes: options.outputMaxBytes ?? Math.min(deps.outputMaxBytes, 1024 * 1024),
		...options.stdin !== void 0 ? { stdin: options.stdin } : {}
	}, deps.exec.signal);
	if (!run.ok) return run.failure.kind === "cancelled" ? {
		ok: false,
		outcome: {
			ok: false,
			status: "cancelled",
			code: "CANCELLED",
			detail: "cancelled"
		}
	} : {
		ok: false,
		outcome: {
			ok: false,
			status: "blocked",
			detail: run.failure.message
		}
	};
	if (run.result.aborted) return {
		ok: false,
		outcome: {
			ok: false,
			status: "cancelled",
			code: "CANCELLED",
			detail: "cancelled while running the device command"
		}
	};
	if (run.result.timedOut) return {
		ok: false,
		outcome: {
			ok: false,
			status: "failed",
			code: "TIMEOUT",
			detail: `device command exceeded ${timeoutMs}ms`
		}
	};
	if (run.result.cleanup === "failed") return {
		ok: false,
		outcome: {
			ok: false,
			status: "failed",
			code: "CLEANUP_FAILED",
			detail: "device command could not be confirmed terminated"
		}
	};
	return {
		ok: true,
		stdout: run.result.stdout.text,
		stderr: run.result.stderr.text,
		truncated: run.result.stdout.truncated
	};
}
/** 删除一个设备临时文件；失败只记清理状态，不掩盖主结果。 */
async function removeDeviceFile$1(context, path) {
	const { deps, request } = context;
	const run = await runBounded({
		sandbox: deps.sandbox,
		subprocess: deps.subprocess
	}, {
		executable: deps.adbPath,
		args: adb$1(deps, request.serial, [
			"shell",
			"rm",
			"-f",
			path
		]),
		cwd: deps.binding.root,
		mode: deps.binding.mode,
		workspaceRoot: deps.binding.workspaceRoot,
		...deps.binding.sessionId !== void 0 ? { sessionId: deps.binding.sessionId } : {},
		timeoutMs: 5e3,
		outputMaxBytes: 16 * 1024
	}, new AbortController().signal);
	if (!run.ok) return false;
	return run.result.exitCode === 0 && !run.result.aborted && !run.result.timedOut;
}
/** 拉回产物并用文件系统核对存在与摘要；核对不了就不算成功。 */
async function verifyArtifact(context, relativePath) {
	const target = await context.deps.fs.resolve(relativePath, {
		cwd: context.deps.binding.root,
		signal: context.deps.exec.signal
	});
	const info = await context.deps.fs.stat(target, context.deps.exec.signal);
	if (!info || info.type !== "file") return {
		ok: false,
		detail: `pulled artifact is missing or not a regular file: ${relativePath}`
	};
	if ((info.size ?? 0) <= 0) return {
		ok: false,
		detail: `pulled artifact is empty: ${relativePath}`
	};
	let digest;
	try {
		const bytes = await context.deps.fs.readBytes(target, context.deps.exec.signal, SCREENSHOT_DIGEST_MAX_BYTES);
		digest = sha256$2(bytes);
	} catch (error) {
		return {
			ok: false,
			detail: `pulled artifact could not be read back for verification: ${error instanceof Error ? error.message : String(error)}`
		};
	}
	return {
		ok: true,
		evidence: {
			kind: "artifact",
			source: context.deps.fs.processPath(target),
			digest
		}
	};
}
/** 父目录必须先存在：`adb pull` 不会替调用方建目录，缺目录要提前说清。 */
async function requireParentDirectory$1(context, relativePath) {
	const parent = relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/")) : ".";
	const target = await context.deps.fs.resolve(parent, {
		cwd: context.deps.binding.root,
		signal: context.deps.exec.signal
	});
	const info = await context.deps.fs.stat(target, context.deps.exec.signal);
	if (!info || info.type !== "directory") return `output directory does not exist in the workspace: ${parent === "." ? "." : parent}`;
}
async function runScreenshot(context, step) {
	const missingParent = await requireParentDirectory$1(context, step.output);
	if (missingParent) return {
		ok: false,
		status: "blocked",
		code: "TARGET_REQUIRED",
		detail: missingParent
	};
	const devicePath = deviceTempPath("png", context.token);
	context.cleanupPaths.add(devicePath);
	const capture = await runCommand$1(context, adb$1(context.deps, context.request.serial, [
		"shell",
		"screencap",
		"-p",
		devicePath
	]));
	if (!capture.ok) return capture.outcome;
	if (capture.truncated) return {
		ok: false,
		status: "failed",
		detail: "screencap produced unexpected truncated output; the device file was not confirmed"
	};
	const pull = await runCommand$1(context, adb$1(context.deps, context.request.serial, [
		"pull",
		devicePath,
		step.output
	]));
	if (!pull.ok) return pull.outcome;
	const verified = await verifyArtifact(context, step.output);
	if (!verified.ok) return {
		ok: false,
		status: "failed",
		detail: verified.detail
	};
	return {
		ok: true,
		evidence: [verified.evidence]
	};
}
async function runAssertForeground(context, step) {
	const dump = await runCommand$1(context, adb$1(context.deps, context.request.serial, [
		"shell",
		"dumpsys",
		"activity",
		"activities"
	]), { outputMaxBytes: Math.min(context.deps.outputMaxBytes, 2 * 1024 * 1024) });
	if (!dump.ok) return dump.outcome;
	if (dump.truncated) return {
		ok: false,
		status: "failed",
		detail: "activity dump was truncated, so the foreground activity could not be judged"
	};
	const foreground = parseForegroundPackage(dump.stdout);
	if (foreground === void 0) return {
		ok: false,
		status: "failed",
		detail: "could not read a foreground activity from the device dump"
	};
	if (foreground !== step.packageName) return {
		ok: false,
		status: "failed",
		detail: `expected foreground ${step.packageName} but the device reports ${foreground}`
	};
	return {
		ok: true,
		evidence: [{
			kind: "assertion",
			source: `foreground=${foreground}`
		}]
	};
}
async function runAssertUiText(context, step) {
	const devicePath = deviceTempPath("xml", context.token);
	context.cleanupPaths.add(devicePath);
	const dump = await runCommand$1(context, adb$1(context.deps, context.request.serial, [
		"shell",
		"uiautomator",
		"dump",
		devicePath
	]));
	if (!dump.ok) return dump.outcome;
	const read = await runCommand$1(context, adb$1(context.deps, context.request.serial, [
		"exec-out",
		"cat",
		devicePath
	]), { outputMaxBytes: Math.min(context.deps.outputMaxBytes, UI_DUMP_MAX_BYTES) });
	if (!read.ok) return read.outcome;
	if (read.truncated) return {
		ok: false,
		status: "failed",
		detail: "view hierarchy was truncated before it could be parsed; the assertion is unverified"
	};
	const texts = parseUiTexts(read.stdout);
	if (texts.length === 0) return {
		ok: false,
		status: "failed",
		detail: "view hierarchy contained no readable text nodes; the assertion is unverified"
	};
	if (!texts.includes(step.text)) {
		const sample = texts.filter((text) => text.length > 0).slice(0, 8);
		return {
			ok: false,
			status: "failed",
			detail: `expected visible text ${JSON.stringify(step.text)} was not found; observed: ${JSON.stringify(sample)}`
		};
	}
	return {
		ok: true,
		evidence: [{
			kind: "assertion",
			source: `visible text ${JSON.stringify(step.text)}`,
			digest: sha256$2(step.text)
		}]
	};
}
/**
* 执行一次有界 UI 旅程。
* 断言失败即停止；每一步的 argv 都是固定形状，取消/超时都会先终止进程再返回。
*/
async function runJourney(deps, request, now) {
	const startedAt = typeof now === "number" ? now : now.getTime();
	const context = {
		deps,
		request,
		token: `${startedAt.toString(36)}-${randomUUID().slice(0, 8)}`,
		deadline: startedAt + deps.operationTimeoutMs,
		cleanupPaths: /* @__PURE__ */ new Set()
	};
	const steps = [];
	const collected = [];
	let failure;
	let stoppedIndex = -1;
	if (!deps.adbPath.startsWith("/")) return frozen$1("blocked", "journey", {
		error: {
			code: "CAPABILITY_UNAVAILABLE",
			message: "adb executable was not resolved to an absolute path"
		},
		steps
	});
	try {
		for (const [index, step] of request.steps.entries()) {
			if (failure) {
				steps.push({
					index,
					action: step.action,
					status: "skipped",
					evidence: []
				});
				continue;
			}
			const result = await executeStep(context, step);
			if (result.ok) {
				steps.push({
					index,
					action: step.action,
					status: "succeeded",
					evidence: result.evidence ?? []
				});
				collected.push(...result.evidence ?? []);
			} else {
				failure = result;
				stoppedIndex = index;
				steps.push({
					index,
					action: step.action,
					status: "failed",
					...result.detail !== void 0 ? { detail: result.detail } : {},
					evidence: result.evidence ?? []
				});
			}
		}
	} finally {
		for (const path of [...context.cleanupPaths]) if (await removeDeviceFile$1(context, path)) context.cleanupPaths.delete(path);
	}
	const cleanupFailed = context.cleanupPaths.size > 0;
	const cleanup = cleanupFailed ? "failed" : "completed";
	if (!failure && !cleanupFailed) return frozen$1("succeeded", "journey", {
		evidence: collected,
		cleanup,
		steps
	});
	if (!failure) return frozen$1("failed", "journey", {
		evidence: collected,
		cleanup,
		steps,
		error: {
			code: "CLEANUP_FAILED",
			message: "some device temporary files could not be removed"
		}
	});
	if (failure.status === "cancelled") return frozen$1("cancelled", "journey", {
		evidence: collected,
		cleanup,
		steps
	});
	const alreadyChangedDevice = steps.some((entry) => entry.status === "succeeded");
	if (failure.status === "blocked" && !alreadyChangedDevice) return frozen$1("blocked", "journey", {
		evidence: collected,
		cleanup,
		steps,
		error: {
			code: failure.code ?? "CAPABILITY_UNAVAILABLE",
			message: failure.detail ?? "journey could not start"
		}
	});
	if (failure.status === "blocked") return frozen$1("failed", "journey", {
		evidence: collected,
		cleanup,
		steps,
		error: {
			code: failure.code ?? "CAPABILITY_UNAVAILABLE",
			message: `${failure.detail ?? "step could not start"} (earlier steps already changed device state)`
		}
	});
	return frozen$1("failed", "journey", {
		evidence: collected,
		cleanup,
		steps,
		error: {
			code: cleanupFailed ? "CLEANUP_FAILED" : failure.code ?? "CAPABILITY_UNAVAILABLE",
			message: `${failure.detail ?? "step failed"}${stoppedIndex >= 0 ? ` (stopped at step ${stoppedIndex}; remaining steps were not executed)` : ""}`
		}
	});
}
async function executeStep(context, step) {
	const { deps, request } = context;
	const signal = deps.exec.signal;
	switch (step.action) {
		case "tap": {
			const run = await runCommand$1(context, adb$1(deps, request.serial, [
				"shell",
				"input",
				"tap",
				String(step.x),
				String(step.y)
			]));
			if (!run.ok) return run.outcome;
			return {
				ok: true,
				evidence: [{
					kind: "device-action",
					source: `tap ${step.x},${step.y}`
				}]
			};
		}
		case "text": {
			const encoded = encodeInputText(step.text);
			const run = await runCommand$1(context, adb$1(deps, request.serial, [
				"shell",
				"input",
				"text",
				encoded
			]));
			if (!run.ok) return run.outcome;
			return {
				ok: true,
				evidence: [{
					kind: "device-action",
					source: `input text (${encoded.length} chars)`
				}]
			};
		}
		case "key": {
			const run = await runCommand$1(context, adb$1(deps, request.serial, [
				"shell",
				"input",
				"keyevent",
				step.key
			]));
			if (!run.ok) return run.outcome;
			return {
				ok: true,
				evidence: [{
					kind: "device-action",
					source: `keyevent ${step.key}`
				}]
			};
		}
		case "wait": {
			const remaining = context.deadline - Date.now();
			if (remaining <= 0) return {
				ok: false,
				status: "failed",
				code: "TIMEOUT",
				detail: "journey deadline exceeded before the wait step"
			};
			if (step.ms > remaining) return {
				ok: false,
				status: "failed",
				code: "TIMEOUT",
				detail: `requested wait of ${step.ms}ms exceeds the remaining journey budget of ${remaining}ms`
			};
			if (!await new Promise((resolve) => {
				if (signal.aborted) {
					resolve(false);
					return;
				}
				const timer = setTimeout(() => {
					cleanup();
					resolve(true);
				}, step.ms);
				const onAbort = () => {
					cleanup();
					resolve(false);
				};
				const cleanup = () => {
					clearTimeout(timer);
					signal.removeEventListener("abort", onAbort);
				};
				signal.addEventListener("abort", onAbort, { once: true });
			})) return {
				ok: false,
				status: "cancelled",
				code: "CANCELLED",
				detail: "journey cancelled during a wait step"
			};
			return {
				ok: true,
				evidence: [{
					kind: "device-action",
					source: `wait ${step.ms}ms`
				}]
			};
		}
		case "assert-foreground": return runAssertForeground(context, step);
		case "assert-ui-text": return runAssertUiText(context, step);
		case "screenshot": return runScreenshot(context, step);
	}
}
//#endregion
//#region src/android/lib/execution/capture.ts
/**
* 有界采集（A3.4）：logcat / 录屏 / perfetto / 内存快照。
*
* 每次调用都是**一条**完整的有界流程：启动 → 有限时窗 → 停止 → 拉取 → 核验 → 清理，
* 超时与取消走同一个 finally。持久化产物必须真正落地到工作区并核对摘要；
* 文本产物在写回后读回校验，二进制产物只核对存在与摘要，绝不经 stdout 当文本解码。
*
* 批准由接线方在调用前用真实 `approval.request` 完成；本模块只暴露
* `describeCapturePlan()` 供批准理由使用，并负责执行与结果映射。
*
* 与 journey 共用设备临时目录约定（同一个常量，避免两处漂移）。
*/
const CAPTURE_ACTIONS = Object.freeze([
	"logcat",
	"record",
	"perfetto",
	"memory"
]);
/** logcat dump 模式的固定尾部行数：不给调用方任意 `-t` 的自由度。 */
const LOG_DUMP_LINES = 2e3;
/** perfetto 配置文件的读入上限。 */
const PERFETTO_CONFIG_MAX_BYTES = 256 * 1024;
/** 文本产物写回后的读回校验上限。 */
const TEXT_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
/** 二进制产物摘要的限量读取上限：只对前缀取摘要并在证据里写明范围。 */
const ARTIFACT_DIGEST_MAX_BYTES = 16 * 1024 * 1024;
/** 设备临时文件删除的硬上限。 */
const CAPTURE_CLEANUP_TIMEOUT_MS = 5e3;
function parseSerial(value) {
	const serial = requireText(value, "serial", 128);
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(serial)) throw new ArgumentError("serial must match [A-Za-z0-9][A-Za-z0-9._:-]* (no spaces, leading \"-\" or shell characters)");
	return serial;
}
function parsePackageName(value, where) {
	const name = requireText(value, where, 255);
	if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u.test(name)) throw new ArgumentError(`${where} must be a dotted package name`);
	return name;
}
/** 严格解析：未知字段、未知动作与越界时长都在启动任何进程之前拒绝。 */
function parseCaptureRequest(args) {
	if (typeof args !== "object" || args === null || Array.isArray(args)) throw new ArgumentError("capture arguments must be an object");
	const record = args;
	rejectUnknownKeys(record, [
		"action",
		"serial",
		"applicationId",
		"durationSeconds",
		"output",
		"configPath"
	]);
	const action = requireEnum(record.action, "action", CAPTURE_ACTIONS);
	const serial = parseSerial(record.serial);
	const applicationId = record.applicationId === void 0 ? void 0 : parsePackageName(record.applicationId, "applicationId");
	const durationSeconds = requireInteger(record.durationSeconds, "durationSeconds", 1, 120);
	const output = requireRelativePath(record.output, "output");
	if (action === "perfetto") {
		if (record.configPath === void 0) throw new ArgumentError("configPath is required for perfetto (a workspace-relative text config that already exists)");
		return Object.freeze({
			action,
			serial,
			durationSeconds,
			output,
			...applicationId !== void 0 ? { applicationId } : {},
			configPath: requireRelativePath(record.configPath, "configPath")
		});
	}
	if (record.configPath !== void 0) throw new ArgumentError(`configPath is only valid for perfetto, not for ${action}`);
	return Object.freeze({
		action,
		serial,
		durationSeconds,
		output,
		...applicationId !== void 0 ? { applicationId } : {}
	});
}
const actionDetail = {
	logcat: `dump the last ${LOG_DUMP_LINES} logcat lines (-d) and write them to the workspace`,
	record: "record the device screen with screenrecord and pull the video into the workspace",
	perfetto: "run perfetto with the given text config from stdin and pull the trace into the workspace",
	memory: "dump dumpsys meminfo for the application and write it to the workspace"
};
/** 供批准理由使用的计划描述：设备端副作用与工作区落点都必须出现。 */
function describeCapturePlan(request) {
	const deviceWrites = request.action === "record" || request.action === "perfetto";
	return [
		request.action === "logcat" || request.action === "memory" ? `Capture "${request.action}" on device "${request.serial}" as a single bounded dump (process budget ${request.durationSeconds}s): ${actionDetail[request.action]}.` : `Capture "${request.action}" on device "${request.serial}" for at most ${request.durationSeconds}s: ${actionDetail[request.action]}.`,
		request.applicationId !== void 0 ? `Target application: ${request.applicationId}.` : "No application filter.",
		`Workspace output: ${request.output}.`,
		request.configPath !== void 0 ? `Perfetto config read from the workspace: ${request.configPath}.` : "",
		deviceWrites ? `A temporary trace file is written on the device under ${PERFETTO_DEVICE_DIR} (perfetto cannot write ${DEVICE_TMP_DIR} on this platform), then pulled into the workspace and deleted from the device.` : "No device files are written; output is transferred as bounded text.",
		"The capture window is bounded by the given duration plus a fixed settle budget; on-device effects are not confined by the file sandbox."
	].filter((line) => line.length > 0).join(" ");
}
const sha256$1 = (value) => createHash("sha256").update(value).digest("hex");
function frozen(status, extra) {
	return Object.freeze({
		status,
		action: "capture",
		evidence: Object.freeze([...extra.evidence ?? []]),
		cleanup: extra.cleanup ?? "not-needed",
		...extra.error ? { error: Object.freeze({ ...extra.error }) } : {},
		artifacts: Object.freeze([...extra.artifacts ?? []])
	});
}
/** 同 journey：可执行文件由 `runBounded` 前置，这里只给 adb 之后的参数。 */
const adb = (_deps, serial, args) => [
	"-s",
	serial,
	...args
];
/**
* 录屏产物放共享临时目录；perfetto 产物必须落在 `/data/misc/perfetto-traces`：
* 真机 perfetto 往 `/data/local/tmp` 写时被拒（errno 13 / Permission denied），
* 只有 perfetto 自己的 traces 目录可写（实测）。
*/
const PERFETTO_DEVICE_DIR = "/data/misc/perfetto-traces";
function devicePath(token, suffix) {
	return `${suffix === "perfetto-trace" ? PERFETTO_DEVICE_DIR : DEVICE_TMP_DIR}/satellite-${token}.${suffix}`;
}
async function runCommand(context, args, options) {
	const { deps } = context;
	if (deps.exec.signal.aborted) return {
		ok: false,
		status: "cancelled",
		code: "CANCELLED",
		detail: "cancelled before the command started"
	};
	const run = await runBounded({
		sandbox: deps.sandbox,
		subprocess: deps.subprocess
	}, {
		executable: deps.adbPath,
		args,
		cwd: deps.binding.root,
		mode: deps.binding.mode,
		workspaceRoot: deps.binding.workspaceRoot,
		...deps.binding.sessionId !== void 0 ? { sessionId: deps.binding.sessionId } : {},
		timeoutMs: Math.min(options.timeoutMs, deps.operationTimeoutMs),
		outputMaxBytes: options.outputMaxBytes ?? Math.min(deps.outputMaxBytes, 1024 * 1024),
		...options.stdin !== void 0 ? { stdin: options.stdin } : {}
	}, deps.exec.signal);
	if (!run.ok) return run.failure.kind === "cancelled" ? {
		ok: false,
		status: "cancelled",
		code: "CANCELLED",
		detail: "cancelled"
	} : {
		ok: false,
		status: "blocked",
		detail: run.failure.message
	};
	if (run.result.aborted) return {
		ok: false,
		status: "cancelled",
		code: "CANCELLED",
		detail: "cancelled while the device command ran"
	};
	if (run.result.timedOut) return {
		ok: false,
		status: "failed",
		code: "TIMEOUT",
		detail: `device command exceeded ${options.timeoutMs}ms`
	};
	if (run.result.cleanup === "failed") return {
		ok: false,
		status: "failed",
		code: "CLEANUP_FAILED",
		detail: "device command could not be confirmed terminated"
	};
	return {
		ok: true,
		result: {
			exitCode: run.result.exitCode,
			stdout: run.result.stdout.text,
			stderr: run.result.stderr.text,
			truncated: run.result.stdout.truncated || run.result.stderr.truncated
		}
	};
}
/** 删除设备临时文件；用独立信号，调用被取消时仍然尝试。 */
async function removeDeviceFile(context, path) {
	const { deps, request } = context;
	const run = await runBounded({
		sandbox: deps.sandbox,
		subprocess: deps.subprocess
	}, {
		executable: deps.adbPath,
		args: adb(deps, request.serial, [
			"shell",
			"rm",
			"-f",
			path
		]),
		cwd: deps.binding.root,
		mode: deps.binding.mode,
		workspaceRoot: deps.binding.workspaceRoot,
		...deps.binding.sessionId !== void 0 ? { sessionId: deps.binding.sessionId } : {},
		timeoutMs: CAPTURE_CLEANUP_TIMEOUT_MS,
		outputMaxBytes: 16 * 1024
	}, new AbortController().signal);
	return run.ok && run.result.exitCode === 0 && !run.result.aborted && !run.result.timedOut;
}
async function resolveInWorkspace(context, relative) {
	return context.deps.fs.resolve(relative, {
		cwd: context.deps.binding.root,
		signal: context.deps.exec.signal
	});
}
/** 输出的父目录必须已存在：不替调用方建目录，也不让 adb pull 半途失败。 */
async function requireParentDirectory(context, relative) {
	const parent = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : ".";
	const info = await context.deps.fs.stat(await resolveInWorkspace(context, parent), context.deps.exec.signal);
	if (!info || info.type !== "directory") return `output directory does not exist in the workspace: ${parent}`;
}
/** 二进制产物：核对存在、非空与内容摘要；不做任何文本解码。 */
async function verifyBinaryArtifact(context, relative) {
	const target = await resolveInWorkspace(context, relative);
	const info = await context.deps.fs.stat(target, context.deps.exec.signal);
	if (!info || info.type !== "file") return {
		ok: false,
		detail: `pulled artifact is missing or not a regular file: ${relative}`
	};
	if ((info.size ?? 0) <= 0) return {
		ok: false,
		detail: `pulled artifact is empty: ${relative}`
	};
	try {
		const bytes = await context.deps.fs.readBytes(target, context.deps.exec.signal, ARTIFACT_DIGEST_MAX_BYTES);
		return {
			ok: true,
			evidence: {
				kind: "artifact",
				source: context.deps.fs.processPath(target),
				digest: sha256$1(bytes)
			}
		};
	} catch (error) {
		return {
			ok: false,
			detail: `pulled artifact could not be read back for verification: ${error instanceof Error ? error.message : String(error)}`
		};
	}
}
/** 文本产物：拒绝覆盖既有文件，写回后读回校验，内容不符即失败。 */
async function persistText(context, relative, content) {
	const target = await resolveInWorkspace(context, relative);
	if (await context.deps.fs.stat(target, context.deps.exec.signal)) return {
		ok: false,
		status: "blocked",
		code: "TARGET_CHANGED",
		detail: `output already exists; choose a new path: ${relative}`
	};
	try {
		const { binding, exec } = context.deps;
		await context.deps.fs.writeText(target, content, { kind: "createIfAbsent" }, exec.signal, {
			mode: binding.mode,
			workspaceRoot: binding.workspaceRoot,
			...binding.sessionId !== void 0 ? { sessionId: binding.sessionId } : {}
		});
	} catch (error) {
		return {
			ok: false,
			status: "failed",
			detail: `could not write the capture output: ${error instanceof Error ? error.message : String(error)}`
		};
	}
	let readBack;
	try {
		const bytes = await context.deps.fs.readBytes(target, context.deps.exec.signal, TEXT_ARTIFACT_MAX_BYTES);
		readBack = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		return {
			ok: false,
			status: "failed",
			detail: `capture output could not be read back for verification: ${error instanceof Error ? error.message : String(error)}`
		};
	}
	if (readBack !== content) return {
		ok: false,
		status: "failed",
		detail: "capture output does not match what was written; the artifact is unverified"
	};
	return {
		ok: true,
		evidence: {
			kind: "artifact",
			source: context.deps.fs.processPath(target),
			digest: sha256$1(content)
		}
	};
}
/** 读入已存在的 perfetto 配置：缺失、不是文件或超限都明确不可用。 */
async function readPerfettoConfig(context) {
	const relative = context.request.configPath;
	if (relative === void 0) return {
		ok: false,
		detail: "perfetto requires configPath"
	};
	const target = await resolveInWorkspace(context, relative);
	const info = await context.deps.fs.stat(target, context.deps.exec.signal);
	if (!info || info.type !== "file") return {
		ok: false,
		detail: `perfetto config is not a readable file: ${relative}`
	};
	try {
		const bytes = await context.deps.fs.readBytes(target, context.deps.exec.signal, PERFETTO_CONFIG_MAX_BYTES);
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (!/(^|\n)\s*duration_ms\s*:\s*\d+/.test(text)) return {
			ok: false,
			detail: `perfetto config must declare duration_ms (this device's perfetto has no --time-limit): ${relative}`
		};
		return {
			ok: true,
			text
		};
	} catch (error) {
		return {
			ok: false,
			detail: `perfetto config could not be read as bounded UTF-8 text: ${error instanceof Error ? error.message : String(error)}`
		};
	}
}
/**
* 执行一次有界采集。四个动作共享同一套"启动→时窗→停止→拉取→核验→清理"，
* 取消与超时都在同一 finally 中收敛。
*/
async function runCapture(deps, request, now) {
	const startedAt = typeof now === "number" ? now : now.getTime();
	const settleMs = deps.settleMs ?? 3e4;
	const context = {
		deps,
		request,
		settleMs,
		token: `${startedAt.toString(36)}-${randomUUID().slice(0, 8)}`,
		devicePaths: /* @__PURE__ */ new Set()
	};
	const artifacts = [];
	if (!deps.adbPath.startsWith("/")) return frozen("blocked", { error: {
		code: "CAPABILITY_UNAVAILABLE",
		message: "adb executable was not resolved to an absolute path"
	} });
	if (request.durationSeconds * 1e3 + settleMs > deps.operationTimeoutMs) return frozen("blocked", { error: {
		code: "CAPABILITY_UNAVAILABLE",
		message: `the requested capture window (${request.durationSeconds}s) plus the ${settleMs}ms settle budget does not fit the ${deps.operationTimeoutMs}ms operation budget`
	} });
	const missingParent = await requireParentDirectory(context, request.output);
	if (missingParent) return frozen("blocked", { error: {
		code: "TARGET_REQUIRED",
		message: missingParent
	} });
	let failure;
	let cleanupFailed = false;
	try {
		switch (request.action) {
			case "logcat":
				failure = await captureLogcat(context, artifacts);
				break;
			case "memory":
				failure = await captureMemory(context, artifacts);
				break;
			case "record":
			case "perfetto":
				failure = await captureRecording(context, artifacts);
				break;
		}
	} finally {
		for (const path of context.devicePaths) if (!await removeDeviceFile(context, path)) cleanupFailed = true;
	}
	const cleanup = cleanupFailed ? "failed" : "completed";
	if (!failure && !cleanupFailed) return frozen("succeeded", {
		evidence: artifacts,
		artifacts,
		cleanup
	});
	if (!failure) return frozen("failed", {
		evidence: artifacts,
		artifacts,
		cleanup,
		error: {
			code: "CLEANUP_FAILED",
			message: "a device temporary file could not be removed"
		}
	});
	if (failure.status === "cancelled") return frozen("cancelled", {
		evidence: artifacts,
		artifacts,
		cleanup
	});
	if (failure.status === "blocked") return frozen("blocked", {
		evidence: artifacts,
		artifacts,
		cleanup,
		error: {
			code: failure.code ?? "CAPABILITY_UNAVAILABLE",
			message: failure.detail
		}
	});
	return frozen("failed", {
		evidence: artifacts,
		artifacts,
		cleanup,
		error: {
			code: cleanupFailed ? "CLEANUP_FAILED" : failure.code ?? "CAPABILITY_UNAVAILABLE",
			message: failure.detail
		}
	});
}
async function captureLogcat(context, artifacts) {
	const { deps, request } = context;
	const filter = [];
	if (request.applicationId !== void 0) {
		const pidof = await runCommand(context, adb(deps, request.serial, [
			"shell",
			"pidof",
			request.applicationId
		]), { timeoutMs: context.settleMs });
		if (!pidof.ok) return pidof;
		if (pidof.result.exitCode !== 0) return {
			status: "failed",
			code: "TARGET_REQUIRED",
			detail: `application is not running, so its log has no pid: ${request.applicationId}`
		};
		const pid = pidof.result.stdout.trim().split(/\s+/u)[0] ?? "";
		if (!/^[0-9]{1,10}$/u.test(pid)) return {
			status: "failed",
			detail: `could not read a valid pid for ${request.applicationId}`
		};
		filter.push("--pid", pid);
	}
	const run = await runCommand(context, adb(deps, request.serial, [
		"logcat",
		"-d",
		"-t",
		String(LOG_DUMP_LINES),
		...filter
	]), {
		timeoutMs: context.settleMs,
		outputMaxBytes: deps.outputMaxBytes
	});
	if (!run.ok) return run;
	if (run.result.truncated) return {
		status: "failed",
		detail: "logcat output was truncated by the output limit; the artifact is incomplete and is not reported as captured"
	};
	const persisted = await persistText(context, request.output, run.result.stdout);
	if (!persisted.ok) return {
		status: persisted.status,
		...persisted.code !== void 0 ? { code: persisted.code } : {},
		detail: persisted.detail
	};
	artifacts.push(persisted.evidence);
}
async function captureMemory(context, artifacts) {
	const { deps, request } = context;
	if (request.applicationId === void 0) return {
		status: "blocked",
		code: "TARGET_REQUIRED",
		detail: "memory capture requires applicationId so the dump stays bounded"
	};
	const run = await runCommand(context, adb(deps, request.serial, [
		"shell",
		"dumpsys",
		"meminfo",
		request.applicationId
	]), {
		timeoutMs: context.settleMs,
		outputMaxBytes: deps.outputMaxBytes
	});
	if (!run.ok) return run;
	if (run.result.truncated) return {
		status: "failed",
		detail: "meminfo output was truncated by the output limit; the artifact is incomplete"
	};
	if (run.result.exitCode !== 0) return {
		status: "failed",
		detail: `dumpsys meminfo exited with ${run.result.exitCode}`
	};
	const persisted = await persistText(context, request.output, run.result.stdout);
	if (!persisted.ok) return {
		status: persisted.status,
		...persisted.code !== void 0 ? { code: persisted.code } : {},
		detail: persisted.detail
	};
	artifacts.push(persisted.evidence);
}
async function captureRecording(context, artifacts) {
	const { deps, request } = context;
	const isPerfetto = request.action === "perfetto";
	const suffix = isPerfetto ? "perfetto-trace" : "mp4";
	const path = devicePath(context.token, suffix);
	let stdin;
	if (isPerfetto) {
		const config = await readPerfettoConfig(context);
		if (!config.ok) return {
			status: "blocked",
			code: "TARGET_REQUIRED",
			detail: config.detail
		};
		stdin = config.text;
	}
	context.devicePaths.add(path);
	const timeoutMs = Math.min(request.durationSeconds * 1e3 + context.settleMs, deps.operationTimeoutMs);
	const args = isPerfetto ? [
		"shell",
		"perfetto",
		"-c",
		"-",
		"--txt",
		"-o",
		path
	] : [
		"shell",
		"screenrecord",
		"--time-limit",
		String(request.durationSeconds),
		path
	];
	const run = await runCommand(context, adb(deps, request.serial, args), {
		timeoutMs,
		...stdin !== void 0 ? { stdin } : {},
		outputMaxBytes: Math.min(deps.outputMaxBytes, 256 * 1024)
	});
	if (!run.ok) return run;
	if (run.result.exitCode !== 0) return {
		status: "failed",
		detail: `${isPerfetto ? "perfetto" : "screenrecord"} exited with ${run.result.exitCode}: ${run.result.stderr.trim().slice(0, 512)}`
	};
	const pull = await runCommand(context, adb(deps, request.serial, [
		"pull",
		path,
		request.output
	]), { timeoutMs: context.settleMs });
	if (!pull.ok) return pull;
	if (pull.result.exitCode !== 0) return {
		status: "failed",
		detail: `could not pull the capture artifact from the device: ${pull.result.stderr.trim().slice(0, 512)}`
	};
	const verified = await verifyBinaryArtifact(context, request.output);
	if (!verified.ok) return {
		status: "failed",
		detail: verified.detail
	};
	artifacts.push(verified.evidence);
}
//#endregion
//#region src/android/lib/execution/tools.ts
/**
* Android 本地执行工具：项目事实、构建/测试。
*
* 装配形态与既有工具一致：一个注册函数、按调用作用域取服务、真实宿主批准、
* 批准后重读策略与目标。这里只暴露结构化动作，不提供任意 shell 入口。
*
* 边界（与剩余规格 §4–§5 一致，也是用户已接受的范围）：
* - 设备/模拟器/UI 采集在后续单元注册；本模块不假装它们已经可用；
* - 不提供跨进程设备排他，也不承诺宿主崩溃后的恢复；
* - 进程内资源由当前会话/组件作用域持有，并在卸载时等待清理。
*/
const JOURNEY_TOOL = "satellite_android_journey";
const CAPTURE_TOOL = "satellite_android_capture";
const PROJECT_TOOL = "satellite_android_project";
const BUILD_TOOL = "satellite_android_build";
const SERVICE_NAMES = [
	"fs",
	"sandbox",
	"subprocess",
	"sandboxPolicy",
	"approval"
];
/** 默认上限：单操作 10 分钟、每流 256KiB。 */
const DEFAULT_OPERATION_TIMEOUT_MS = 600 * 1e3;
const DEFAULT_OUTPUT_MAX_BYTES = 256 * 1024;
const DISCOVERY_TIMEOUT_MS = 12e4;
const VERSION_TIMEOUT_MS = 15e3;
const toolOutput = {
	schema: {
		type: "object",
		additionalProperties: true,
		properties: { status: {
			type: "string",
			required: true
		} }
	},
	render: (_args, value) => [{
		type: "text",
		text: JSON.stringify(value)
	}]
};
const json = (value) => JSON.parse(JSON.stringify(value));
function servicesFor(root, exec) {
	const scoped = scopedServices(root, exec, SERVICE_NAMES);
	if (!scoped.ok) return blocked("services", scoped.code, scoped.message);
	return scoped.services;
}
function isOutcome(value) {
	return typeof value.status === "string";
}
/**
* 绑定本次调用的项目根与有效策略。
* 根来自不可变会话 cwd（不是模型给的路径），且必须能在执行世界里往返映射。
*/
/**
* 绑定本次调用要操作的工程根。
*
* - 缺省：会话的不可变工作目录。
* - 相对路径：会话工作区内的子目录。
* - 绝对路径：允许工作区之外的工程；此时 `external: true`，写/执行类动作
*   必须由调用方逐次取得宿主批准（沙箱没有"额外可写根"这一档，
*   升级只能是一次性的 danger-full-access）。
*/
async function bindProject(services, exec, projectPath) {
	const hostRoot = (exec.agent?.session)?.header?.cwd;
	if (typeof hostRoot !== "string" || hostRoot.length === 0) return blocked("project", "TARGET_REQUIRED", "session working directory is unavailable");
	const fs = services.fs;
	const sessionTarget = await fs.resolve(hostRoot, { signal: exec.signal });
	if ((await fs.stat(sessionTarget, exec.signal))?.type !== "directory") return blocked("project", "TARGET_REQUIRED", "session root is not a readable directory");
	let rootPath = fs.processPath(sessionTarget);
	let external = false;
	if (projectPath !== void 0) {
		const absolute = projectPath.startsWith("/");
		if (!absolute && typeof fs.processPathFromHostPath === "function") {
			const mapped = fs.processPathFromHostPath(hostRoot);
			if (!mapped) return blocked("project", "CAPABILITY_UNAVAILABLE", "session root is not visible in this execution world");
			const sessionMapped = await fs.resolve(mapped, { signal: exec.signal });
			if ((await fs.stat(sessionMapped, exec.signal))?.type !== "directory") return blocked("project", "TARGET_REQUIRED", "session root is not a readable directory");
			rootPath = fs.processPath(sessionMapped);
		}
		const target = await fs.resolve(projectPath, absolute ? { signal: exec.signal } : {
			cwd: rootPath,
			signal: exec.signal
		});
		const info = await fs.stat(target, exec.signal);
		if (!info) return blocked("project", "TARGET_REQUIRED", `project directory not found: ${projectPath}`);
		if (info.type !== "directory") return blocked("project", "ARGUMENT_INVALID", `project path is not a directory: ${projectPath}`);
		external = !fs.contains(sessionTarget, target);
		rootPath = fs.processPath(target);
	}
	const policy = resolvePolicy(services.sandboxPolicy, exec.agent?.session);
	if (!policy) return blocked("project", "CAPABILITY_UNAVAILABLE", "session sandbox policy is unavailable");
	return {
		root: rootPath,
		fs,
		mode: policy.mode,
		workspaceRoot: policy.workspaceRoot,
		...policy.sessionId !== void 0 ? { sessionId: policy.sessionId } : {},
		external
	};
}
function escalationGate(binding, action, request) {
	const wants = request.sandboxPermissions !== void 0 || request.justification !== void 0;
	if (!binding.external) {
		if (wants) return {
			ok: false,
			outcome: blocked(action, "ARGUMENT_INVALID", "sandboxPermissions is only meaningful for a project outside the session workspace")
		};
		return { ok: true };
	}
	if (!wants) return {
		ok: false,
		outcome: blocked(action, "CAPABILITY_UNAVAILABLE", `project ${binding.root} is outside the session workspace (${binding.workspaceRoot}); it needs a one-call escalation: retry with sandboxPermissions:"danger-full-access" and a justification. The approval covers this one call only (its internal re-verification included); the next call needs its own approval.`)
	};
	if (request.sandboxPermissions !== "danger-full-access") return {
		ok: false,
		outcome: blocked(action, "ARGUMENT_INVALID", "sandboxPermissions must be \"danger-full-access\" (the only wider mode)")
	};
	const justification = typeof request.justification === "string" ? request.justification.replace(/\s+/gu, " ").trim() : "";
	if (justification.length === 0) return {
		ok: false,
		outcome: blocked(action, "ARGUMENT_INVALID", "a non-empty justification is required with sandboxPermissions")
	};
	return {
		ok: true,
		escalation: { justification: justification.slice(0, 2e3) }
	};
}
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
/** 真实批准：只有 allowed-once 继续；其余结果如实映射到错误码。 */
async function askApproval(services, exec, toolName, reason) {
	if (!exec.agent) return blocked(toolName, "APPROVAL_UNAVAILABLE", "tool call has no agent to route approval through");
	let granted;
	try {
		granted = await services.approval.request({
			agent: exec.agent,
			toolName,
			...exec.callId !== void 0 ? { callId: exec.callId } : {},
			reason,
			signal: exec.signal
		});
	} catch (error) {
		return blocked(toolName, "APPROVAL_UNAVAILABLE", error instanceof Error ? error.message : String(error));
	}
	if (granted === "allowed-once") return void 0;
	if (granted === "cancelled") return cancelled(toolName, "not-needed");
	return blocked(toolName, granted === "unavailable" ? "APPROVAL_UNAVAILABLE" : "APPROVAL_REJECTED", `approval ${granted}`);
}
/** 运行结果到结果码的统一映射；清理失败与效果未知都不伪装成成功。 */
function mapRun(action, run, evidence) {
	if (!run.ok) {
		if (run.failure.kind === "cancelled") return cancelled(action, "not-needed");
		return blocked(action, "CAPABILITY_UNAVAILABLE", run.failure.message ?? "execution unavailable");
	}
	const { result } = run;
	const withEvidence = [...evidence, {
		kind: "process",
		source: action,
		digest: sha256(JSON.stringify({
			exitCode: result.exitCode,
			stdout: result.stdout.text
		}))
	}];
	if (result.aborted || result.timedOut) {
		const code = result.aborted ? "CANCELLED" : "TIMEOUT";
		const cleanup = result.cleanup === "completed" ? "completed" : "failed";
		if (result.failureDetail !== void 0) return effectUnknown(action, "EFFECT_UNKNOWN", `${result.failureDetail}; the process was terminated but its effects are unconfirmed`);
		return outcome(result.aborted ? "cancelled" : "failed", action, {
			evidence: withEvidence,
			cleanup,
			error: {
				code,
				message: result.aborted ? "operation cancelled" : "operation exceeded its deadline"
			}
		});
	}
	return { result };
}
/**
* 注册六个执行工具。
*
* 配置按**每次调用**读取（`getConfig`），因为 `execution` 是 volatile 设置：
* 设置页保存后不重启也应生效。工具是否可见不再依赖机器路径；
* 未启用或缺路径时每次调用都失败关闭，不会有任何副作用。
*/
function registerAndroidExecutionTools(ctx, getConfig) {
	const observations = createObservationStore(() => Date.now(), () => randomUUID());
	const deviceObservations = createDeviceObservationStore(() => Date.now(), () => randomUUID());
	const deviceLock = createDeviceLock();
	const ownedResources = createOwnedResources();
	const ownerScopes = /* @__PURE__ */ new Set();
	const authorTool = defineTool;
	const register = (spec) => ctx.tools.register(authorTool(spec));
	const disposers = [
		register(createProjectTool(ctx, getConfig, observations)),
		register(createBuildTool(ctx, getConfig, observations)),
		register(createDeviceTool(ctx, getConfig, deviceObservations, deviceLock)),
		register(createEmulatorTool(ctx, getConfig, ownedResources, ownerScopes)),
		register(createJourneyTool(ctx, getConfig, deviceObservations, deviceLock)),
		register(createCaptureTool(ctx, getConfig, deviceObservations, deviceLock))
	];
	ctx.effect(() => async () => {
		await ownedResources.closeAll();
	});
	return () => {
		for (const dispose of disposers.reverse()) dispose();
	};
}
/**
* 工程路径：相对路径按会话工作区解析；绝对路径允许工作区之外的工程
* （其写/执行动作另需逐次升级批准）。
*/
function requireProjectPath(value, where) {
	if (typeof value !== "string" || value.length === 0) throw new ArgumentError(`${where} must be a non-empty string`);
	if (value.length > 2048) throw new ArgumentError(`${where} must be at most 2048 characters`);
	if (value.startsWith("/")) return value;
	return requireRelativePath(value, where);
}
/** 追加而不是覆盖：使用者自己的 GRADLE_OPTS 必须保留。 */
function withDaemonDisabled(existing) {
	const base = typeof existing === "string" ? existing.trim() : "";
	return base.length === 0 ? "-Dorg.gradle.daemon=false" : `${base} -Dorg.gradle.daemon=false`;
}
/** 统一的执行门：未启用或缺所需路径时给出可行动的失败，而不是静默跳过。 */
function executionGate(config, action, needs) {
	if (!config.enabled) return blocked(action, "CAPABILITY_UNAVAILABLE", "Android execution is not enabled for this row: set execution.enabled in the Satellite Android settings");
	if (needs === "cli" && !config.androidCli) return blocked(action, "CAPABILITY_UNAVAILABLE", "androidCli is not configured: set the Android CLI path in the Satellite Android settings");
	if (needs === "adb" && !config.adbPath) return blocked(action, "CAPABILITY_UNAVAILABLE", "adbPath is not configured: set the adb path in the Satellite Android settings");
	if (needs === "emulator" && !config.emulatorPath) return blocked(action, "CAPABILITY_UNAVAILABLE", "emulatorPath is not configured: set the emulator path in the Satellite Android settings");
}
function ensureOwnerScope(ctx, exec, ownedResources, ownerScopes) {
	const ownerId = exec.agent?.id ?? "unknown";
	if (ownerScopes.has(ownerId)) return { ok: true };
	const scope = exec.agent?.ctx ?? ctx;
	if (typeof scope.effect !== "function") return {
		ok: false,
		message: "no registerable effect on the caller scope; refusing to start a retained process"
	};
	try {
		scope.effect(() => async () => {
			await ownedResources.closeOwner(ownerId);
		});
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : String(error)
		};
	}
	ownerScopes.add(ownerId);
	return { ok: true };
}
function createEmulatorTool(ctx, getConfig, ownedResources, ownerScopes) {
	return {
		name: EMULATOR_TOOL,
		description: "Manage one explicitly named Android emulator (AVD). list, start, stop, delete and create each require host approval. Only start keeps a process running: it becomes owned by this agent scope and is stopped on explicit stop, agent exit or plugin unload. Nothing is downloaded.",
		parameters: {
			action: {
				type: "string",
				enum: [
					"list",
					"start",
					"stop",
					"delete",
					"create"
				],
				required: true,
				description: "list: configured AVD names. start: boot one AVD and transfer it to this session. stop: stop an owned instance or, with serial, an observed one. delete: remove an AVD. create: create from an already installed system image."
			},
			avd: {
				type: "string",
				description: "AVD name for start/delete/create."
			},
			ownedResourceId: {
				type: "string",
				description: "stop only: id returned by start in this session."
			},
			serial: {
				type: "string",
				description: "stop only: exact emulator serial; this branch does not claim ownership."
			},
			installedSystemImage: {
				type: "string",
				description: "create only: already installed SDK package id, for example \"system-images;android-34;google_apis;x86_64\"."
			},
			deviceProfile: {
				type: "string",
				description: "create only: device profile id, for example \"pixel_6\"."
			},
			startupTimeoutMs: {
				type: "integer",
				description: "start only: boot deadline in milliseconds (10000-1800000)."
			}
		},
		output: toolOutput,
		isConcurrencySafe: () => false,
		async execute(args, nativeExec) {
			const exec = nativeExec;
			try {
				const config = getConfig();
				const gate = executionGate(config, "emulator", "emulator");
				if (gate) return json(gate);
				const request = parseEmulatorRequest(args);
				const services = servicesFor(ctx, exec);
				if (isOutcome(services)) return json(services);
				const binding = await bindProject(services, exec);
				if (isOutcome(binding)) return json(binding);
				if (!config.adbPath) return json(blocked("emulator", "CAPABILITY_UNAVAILABLE", "adbPath is not configured: set the adb path in the Satellite Android settings"));
				const deps = {
					services: {
						sandbox: services.sandbox,
						subprocess: services.subprocess,
						approval: services.approval
					},
					binding: {
						root: binding.root,
						mode: binding.mode,
						workspaceRoot: binding.workspaceRoot,
						...binding.sessionId !== void 0 ? { sessionId: binding.sessionId } : {}
					},
					exec,
					config: {
						emulatorPath: config.emulatorPath,
						...config.avdmanagerPath !== void 0 ? { avdmanagerPath: config.avdmanagerPath } : {},
						adbPath: config.adbPath,
						operationTimeoutMs: config.operationTimeoutMs,
						outputMaxBytes: config.outputMaxBytes,
						...config.bootPollIntervalMs !== void 0 ? { bootPollIntervalMs: config.bootPollIntervalMs } : {}
					}
				};
				const approved = await askApproval(services, exec, EMULATOR_TOOL, describeEmulatorPlan(request));
				if (approved) return json(approved);
				const after = resolvePolicy(services.sandboxPolicy, exec.agent?.session);
				if (!after || policyKey(after) !== policyKey(binding)) return json(blocked(`emulator.${request.action}`, "POLICY_CHANGED", "session policy changed after approval; retry required"));
				if (request.action === "stop" && request.ownedResourceId !== void 0) {
					const owned = ownedResources.get(request.ownedResourceId, exec.agent?.id ?? "unknown");
					if (!owned) return json(blocked("emulator.stop", "TARGET_REQUIRED", "no such owned emulator instance in this session; an external instance needs the serial branch and its own approval"));
					const cleanup = await ownedResources.close(owned.id);
					return json({
						status: cleanup === "completed" ? "succeeded" : "failed",
						action: "emulator.stop",
						evidence: [{
							kind: "avd",
							source: `${owned.avd} (${owned.serial})`
						}],
						cleanup,
						...cleanup === "completed" ? {} : { error: {
							code: "CLEANUP_FAILED",
							message: "the emulator did not report exit before the cleanup deadline"
						} }
					});
				}
				if (request.action === "start") {
					const ownerScope = ensureOwnerScope(ctx, exec, ownedResources, ownerScopes);
					if (!ownerScope.ok) return json(blocked("emulator.start", "CAPABILITY_UNAVAILABLE", ownerScope.message));
					const started = await startEmulator(deps, request, ownedResources, (resource) => ownedResources.adopt(resource));
					if (!started.ok) return json(started.outcome);
					return json({
						status: "succeeded",
						action: "emulator.start",
						evidence: [{
							kind: "avd",
							source: `${started.result.avd} (${started.result.serial})`
						}],
						cleanup: "retained-owned",
						ownedResourceId: started.result.ownedResourceId,
						serial: started.result.serial
					});
				}
				return json(await runBoundedEmulatorAction(deps, request));
			} catch (error) {
				if (error instanceof ArgumentError) return json(blocked("emulator", "ARGUMENT_INVALID", error.message));
				throw error;
			}
		}
	};
}
function deviceDepsFor(services, binding, exec, config) {
	return deviceDeps(services, binding, exec, config);
}
function deviceDeps(services, binding, exec, config) {
	if (!config.adbPath) return blocked("device", "CAPABILITY_UNAVAILABLE", "adb executable is not configured (adbPath)");
	return {
		services: {
			sandbox: services.sandbox,
			subprocess: services.subprocess,
			approval: services.approval,
			sandboxPolicy: services.sandboxPolicy
		},
		binding: {
			root: binding.root,
			mode: binding.mode,
			workspaceRoot: binding.workspaceRoot,
			...binding.sessionId !== void 0 ? { sessionId: binding.sessionId } : {}
		},
		exec,
		config: {
			adbPath: config.adbPath,
			...config.serverEndpoint !== void 0 ? { serverEndpoint: config.serverEndpoint } : {},
			operationTimeoutMs: config.operationTimeoutMs,
			outputMaxBytes: config.outputMaxBytes
		}
	};
}
function createDeviceTool(ctx, getConfig, observations, lock) {
	return {
		name: DEVICE_TOOL,
		description: "Observe and operate one explicitly named Android device over adb. discover is read-only; install, launch and foreground change or read device state and require host approval. It never falls back to a default device and never provides arbitrary adb arguments.",
		parameters: {
			action: {
				type: "string",
				enum: [
					"discover",
					"install",
					"launch",
					"foreground"
				],
				required: true,
				description: "discover: observe one serial and return an observation id. install: install a workspace APK. launch: start the app launcher. foreground: read the current foreground package."
			},
			serial: {
				type: "string",
				description: "Exact device serial, required for discover and every other action."
			},
			observationId: {
				type: "string",
				description: "Required for install/launch/foreground; must come from discover in this session."
			},
			artifact: {
				type: "string",
				description: "install only: APK path relative to the session workspace."
			},
			applicationId: {
				type: "string",
				description: "launch/foreground only: reverse-DNS package name."
			}
		},
		output: toolOutput,
		isConcurrencySafe: () => false,
		async execute(args, nativeExec) {
			const exec = nativeExec;
			try {
				const config = getConfig();
				const gate = executionGate(config, "device", "adb");
				if (gate) return json(gate);
				const request = parseDeviceRequest(args);
				const services = servicesFor(ctx, exec);
				if (isOutcome(services)) return json(services);
				const binding = await bindProject(services, exec);
				if (isOutcome(binding)) return json(binding);
				const deps = deviceDeps(services, binding, exec, config);
				if (isOutcome(deps)) return json(deps);
				if (request.action === "discover") {
					if (request.serial === void 0) return json(blocked("device.discover", "TARGET_REQUIRED", "serial is required"));
					const approved = await askApproval(services, exec, DEVICE_TOOL, describeDevicePlan(request));
					if (approved) return json(approved);
					const after = resolvePolicy(services.sandboxPolicy, exec.agent?.session);
					if (!after || policyKey(after) !== policyKey(binding)) return json(blocked("device.discover", "POLICY_CHANGED", "session policy changed after approval; retry required"));
					const observed = await observeDevice(deps, request.serial, randomUUID());
					if (!observed.ok) return json(observed.outcome);
					const observation = observations.put(exec.agent?.id ?? "unknown", observed.identity, identityDigest(sha256, observed.identity));
					return json({
						status: "succeeded",
						action: "device.discover",
						evidence: [{
							kind: "device",
							source: observed.identity.serial,
							digest: observation.digest
						}],
						cleanup: "not-needed",
						observationId: observation.id,
						expiresAt: new Date(observation.expiresAt).toISOString(),
						identity: observed.identity
					});
				}
				const peeked = observations.getFor(request.observationId ?? "", exec.agent?.id ?? "unknown");
				if (!peeked.ok) return json(blocked(request.action, peeked.code, peeked.message));
				if (request.serial !== void 0 && request.serial !== peeked.observation.identity.serial) return json(blocked(request.action, "TARGET_CHANGED", "request serial does not match the observation"));
				const approved = await askApproval(services, exec, DEVICE_TOOL, describeDevicePlan(request, peeked.observation.identity));
				if (approved) return json(approved);
				const prepared = await prepareObservedTarget(deps, lock, observations, request, binding);
				if (!prepared.ok) return json(prepared.outcome);
				try {
					if (request.action === "install") return json(await runInstall(deps, binding, prepared.identity, request.artifact, exec));
					if (request.action === "launch") return json(await runLaunch(deps, prepared.identity, request.applicationId));
					return json(await runForeground(deps, prepared.identity, request.applicationId));
				} finally {
					prepared.release();
				}
			} catch (error) {
				if (error instanceof ArgumentError) return json(blocked("device", "ARGUMENT_INVALID", error.message));
				throw error;
			}
		}
	};
}
const ARTIFACT_DIGEST_LIMIT = 64 * 1024 * 1024;
async function runInstall(deps, binding, identity, artifact, exec) {
	const target = await binding.fs.resolve(artifact, {
		cwd: binding.root,
		signal: exec.signal
	});
	const info = await binding.fs.stat(target, exec.signal);
	if (!info || info.type !== "file") return blocked("install", "TARGET_REQUIRED", `artifact is not a readable file in this execution world: ${artifact}`);
	const path = binding.fs.processPath(target);
	const evidence = [{
		kind: "artifact",
		source: artifact
	}];
	if (typeof info.size === "number" && info.size <= ARTIFACT_DIGEST_LIMIT) {
		const bytes = await binding.fs.readBytes(target, exec.signal, ARTIFACT_DIGEST_LIMIT);
		evidence[0] = {
			kind: "artifact",
			source: artifact,
			digest: sha256(bytes)
		};
	}
	const installed = await adbRun(deps, [
		"install",
		"-r",
		path
	], "install", { serial: identity.serial });
	if (!installed.ok) return installed.outcome;
	const succeeded = installed.exitCode === 0 && /Success/iu.test(installed.text);
	return {
		status: succeeded ? "succeeded" : "failed",
		action: "install",
		evidence,
		cleanup: "not-needed",
		deviceOutput: installed.text.slice(0, 4096),
		...succeeded ? {} : { error: {
			code: "CAPABILITY_UNAVAILABLE",
			message: `adb install exited with ${installed.exitCode}`
		} }
	};
}
async function runLaunch(deps, identity, applicationId) {
	const launched = await adbRun(deps, [
		"shell",
		"monkey",
		"-p",
		applicationId,
		"-c",
		"android.intent.category.LAUNCHER",
		"1"
	], "launch", { serial: identity.serial });
	if (!launched.ok) return launched.outcome;
	const failedLaunch = /No activities found|monkey aborted|Exception/iu.test(launched.text);
	return {
		status: failedLaunch ? "failed" : "succeeded",
		action: "launch",
		evidence: [{
			kind: "launch",
			source: applicationId
		}],
		cleanup: "not-needed",
		deviceOutput: launched.text.slice(0, 4096),
		...failedLaunch ? { error: {
			code: "CAPABILITY_UNAVAILABLE",
			message: "monkey reported that no launcher activity could be started"
		} } : {}
	};
}
async function runForeground(deps, identity, applicationId) {
	const dump = await adbRun(deps, [
		"shell",
		"dumpsys",
		"activity",
		"activities"
	], "foreground", { serial: identity.serial });
	if (!dump.ok) return dump.outcome;
	const foreground = parseForegroundPackage$1(dump.text);
	if (foreground === void 0) return blocked("foreground", "CAPABILITY_UNAVAILABLE", "the device output did not expose a foreground package; not guessing");
	return {
		status: foreground === applicationId ? "succeeded" : "failed",
		action: "foreground",
		evidence: [{
			kind: "foreground-package",
			source: foreground
		}],
		cleanup: "not-needed",
		foreground,
		...foreground === applicationId ? {} : { error: {
			code: "CAPABILITY_UNAVAILABLE",
			message: `${applicationId} is not the foreground package`
		} }
	};
}
function createProjectTool(ctx, getConfig, observations) {
	return {
		name: PROJECT_TOOL,
		description: "Inspect an Android project in this session workspace. \"inspect\" is a read-only static lead list and does not verify Gradle tasks. \"discover-build\" runs the configured Android CLI after host approval and returns verified module/variant facts with an id that the build tool requires.",
		parameters: {
			action: {
				type: "string",
				enum: ["inspect", "discover-build"],
				required: true,
				description: "inspect: static leads only. discover-build: approved dynamic facts."
			},
			project: {
				type: "string",
				description: "Project directory: relative to the session workspace, or an absolute path for a project outside it. Defaults to the workspace root."
			},
			sandboxPermissions: {
				type: "string",
				enum: ["danger-full-access"],
				description: "Only for a project outside the session workspace: request a one-call unconfined run. Requires justification."
			},
			justification: {
				type: "string",
				description: "Required with sandboxPermissions: why this external project must be written/executed in this call."
			}
		},
		output: toolOutput,
		isConcurrencySafe: (args) => args?.action === "inspect",
		async execute(args, nativeExec) {
			const exec = nativeExec;
			try {
				rejectUnknownKeys(args, [
					"action",
					"project",
					"sandboxPermissions",
					"justification"
				]);
				const config = getConfig();
				const action = requireEnum(args.action, "action", ["inspect", "discover-build"]);
				const gate = executionGate(config, action === "inspect" ? "project.inspect" : "project.discover-build", action === "inspect" ? "cli" : "cli");
				if (action === "discover-build" && gate) return json(gate);
				const project = args.project === void 0 ? void 0 : requireProjectPath(args.project, "project");
				const services = servicesFor(ctx, exec);
				if (isOutcome(services)) return json(services);
				const binding = await bindProject(services, exec, project);
				if (isOutcome(binding)) return json(binding);
				if (action === "inspect") return json(await runStaticInspect(binding, exec));
				const gated = escalationGate(binding, "project.discover-build", {
					...args.sandboxPermissions !== void 0 ? { sandboxPermissions: String(args.sandboxPermissions) } : {},
					...args.justification !== void 0 ? { justification: String(args.justification) } : {}
				});
				if (!gated.ok) return json(gated.outcome);
				const discovered = await discoverBuildFacts({
					services,
					binding,
					exec,
					config,
					...gated.escalation ? { escalation: gated.escalation } : {}
				}, (/* @__PURE__ */ new Date()).toISOString());
				if (!discovered.ok) return json(discovered.outcome);
				const observation = observations.put(exec.agent?.id ?? "unknown", discovered.facts, digestDynamicFacts(sha256, discovered.facts));
				return json({
					status: "succeeded",
					action: "project.discover-build",
					evidence: [{
						kind: "android-cli",
						source: discovered.facts.cliPath,
						digest: sha256(discovered.facts.cliVersion)
					}, ...discovered.facts.modules.map((module) => ({
						kind: "module",
						source: `${module.path} (${module.variants.length} variants)`
					}))],
					cleanup: "not-needed",
					observationId: observation.id,
					expiresAt: new Date(observation.expiresAt).toISOString(),
					facts: discovered.facts,
					...gated.escalation !== void 0 ? { escalation: {
						mode: "danger-full-access",
						justification: gated.escalation.justification
					} } : {}
				});
			} catch (error) {
				if (error instanceof ArgumentError) return json(blocked("project", "ARGUMENT_INVALID", error.message));
				throw error;
			}
		}
	};
}
async function runStaticInspect(binding, exec) {
	const facts = await inspectStaticProject({
		projectRoot: binding.root,
		fs: binding.fs,
		signal: exec.signal
	});
	return {
		status: "succeeded",
		action: "project.inspect",
		evidence: facts.leads.map((lead) => ({
			kind: lead.kind,
			source: lead.path
		})),
		cleanup: "not-needed",
		facts
	};
}
/** 经批准运行 CLI 并把报告解析成动态事实；任何一步不符即不可用。 */
async function discoverBuildFacts(deps, observedAt) {
	const { services, binding, exec, config } = deps;
	if (!config.androidCli) return {
		ok: false,
		outcome: blocked("project.discover-build", "CAPABILITY_UNAVAILABLE", "Android CLI executable is not configured (androidCli.executable)")
	};
	if (config.privacy === void 0) return {
		ok: false,
		outcome: blocked("project.discover-build", "CAPABILITY_UNAVAILABLE", "Android CLI usage-collection privacy is not configured: verified-disabled or explicit-user-opt-in")
	};
	if (binding.external && deps.escalation === void 0) return {
		ok: false,
		outcome: blocked("project.discover-build", "CAPABILITY_UNAVAILABLE", "an external project requires sandboxPermissions:\"danger-full-access\" plus a justification")
	};
	const effectiveMode = binding.external && deps.escalation !== void 0 ? "danger-full-access" : binding.mode;
	if (effectiveMode === "read-only") return {
		ok: false,
		outcome: blocked("project.discover-build", "CAPABILITY_UNAVAILABLE", "discovery writes project metadata and requires a workspace-write (or wider) session policy")
	};
	if ((await services.subprocess.terminalEnvironment(exec.signal)).platform !== "posix") return {
		ok: false,
		outcome: blocked("project.discover-build", "CAPABILITY_UNAVAILABLE", "the local Android route currently requires a POSIX execution world")
	};
	let cliPath;
	try {
		cliPath = await services.subprocess.resolveExecutable(config.androidCli, void 0, exec.signal);
	} catch (error) {
		return {
			ok: false,
			outcome: blocked("project.discover-build", "CAPABILITY_UNAVAILABLE", error instanceof Error ? error.message : String(error))
		};
	}
	if (!cliPath.startsWith("/")) return {
		ok: false,
		outcome: blocked("project.discover-build", "CAPABILITY_UNAVAILABLE", "Android CLI did not resolve to an absolute path")
	};
	const describeArgs = ["describe", `--project_dir=${binding.root}`];
	if (deps.approvalMode !== "covered") {
		const externality = binding.external ? ` The project is OUTSIDE the session workspace (${binding.workspaceRoot}): this call runs UNCONFINED (danger-full-access) and Gradle may write anywhere the tooling writes. Justification: ${deps.escalation?.justification ?? "(missing)"}.` : ` Session sandbox: ${binding.mode} at ${binding.workspaceRoot}.`;
		const approved = await askApproval(services, exec, PROJECT_TOOL, `Run the configured Android CLI in ${binding.root}: "${cliPath} --version" then "${cliPath} ${describeArgs.join(" ")}". It invokes Gradle and writes AGP metadata/caches inside the project; usage collection is ${config.privacy}.` + externality + ` Network and device effects are not confined by the file sandbox; the approved wrapper is pinned by path and the report is version-gated to ${CLI_VERSION_POLICY}.`);
		if (approved) return {
			ok: false,
			outcome: approved
		};
	}
	const after = resolvePolicy(services.sandboxPolicy, exec.agent?.session);
	if (!after || policyKey(after) !== policyKey(binding)) return {
		ok: false,
		outcome: blocked("project.discover-build", "POLICY_CHANGED", "session policy changed after approval; retry required")
	};
	const androidUserHome = `${binding.workspaceRoot}/.satellite/android-user-home`;
	const runOptions = {
		cwd: binding.root,
		mode: effectiveMode,
		workspaceRoot: binding.workspaceRoot,
		...binding.sessionId !== void 0 ? { sessionId: binding.sessionId } : {},
		env: {
			ANDROID_USER_HOME: androidUserHome,
			...binding.external ? { GRADLE_OPTS: withDaemonDisabled(process.env.GRADLE_OPTS) } : {}
		}
	};
	const versionMapped = mapRun("project.discover-build", await runBounded(services, {
		executable: cliPath,
		args: ["--version"],
		...runOptions,
		timeoutMs: VERSION_TIMEOUT_MS,
		outputMaxBytes: 64 * 1024
	}, exec.signal), []);
	if ("status" in versionMapped) return {
		ok: false,
		outcome: versionMapped
	};
	const cliVersion = parseAndroidCliVersion(versionMapped.result.stdout.text);
	if (!cliVersion) return {
		ok: false,
		outcome: blocked("project.discover-build", "CAPABILITY_UNAVAILABLE", `Android CLI version is not ${CLI_VERSION_POLICY}: ${versionMapped.result.stdout.text.trim() || "unknown"}`)
	};
	const describeMapped = mapRun("project.discover-build", await runBounded(services, {
		executable: cliPath,
		args: describeArgs,
		...runOptions,
		timeoutMs: DISCOVERY_TIMEOUT_MS,
		outputMaxBytes: 1024 * 1024
	}, exec.signal), []);
	if ("status" in describeMapped) return {
		ok: false,
		outcome: describeMapped
	};
	if (describeMapped.result.exitCode !== 0) return {
		ok: false,
		outcome: failed("project.discover-build", "CAPABILITY_UNAVAILABLE", "Android CLI describe did not complete successfully")
	};
	let parsed;
	try {
		parsed = parseAndroidCliDescribe(describeMapped.result.stdout.text, binding.root);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		const stderrTail = describeMapped.result.stderr.text.trim().split("\n").slice(-6).join(" | ").slice(0, 800);
		return {
			ok: false,
			outcome: failed("project.discover-build", "CAPABILITY_UNAVAILABLE", stderrTail.length > 0 ? `${reason} (CLI stderr tail: ${stderrTail})` : reason)
		};
	}
	const wrapper = await binding.fs.resolve(parsed.gradleWrapper, { signal: exec.signal });
	if ((await binding.fs.stat(wrapper, exec.signal))?.type !== "file") return {
		ok: false,
		outcome: blocked("project.discover-build", "CAPABILITY_UNAVAILABLE", "Gradle wrapper declared by the CLI report is not readable")
	};
	const wrapperBytes = await binding.fs.readBytes(wrapper, exec.signal, 1024 * 1024);
	return {
		ok: true,
		facts: {
			projectRoot: binding.root,
			gradleWrapper: binding.fs.processPath(wrapper),
			cliVersion,
			observedAt,
			modules: parsed.modules,
			provenance: "android-cli-describe",
			cliPath,
			inputDigests: {
				gradlew: sha256(wrapperBytes),
				cli: sha256(cliPath)
			}
		}
	};
}
function createBuildTool(ctx, getConfig, observations) {
	return {
		name: BUILD_TOOL,
		description: "Run one exact Gradle build or test task for facts discovered by satellite_android_project, after host approval. No arbitrary flags, no additional tasks, no device interaction.",
		parameters: {
			action: {
				type: "string",
				enum: ["build", "test"],
				required: true,
				description: "build: assemble the selected variant. test: run the selected variant unit-test task."
			},
			observationId: {
				type: "string",
				required: true,
				description: "Id from satellite_android_project discover-build; it expires after a few minutes."
			},
			project: {
				type: "string",
				description: "Project directory: relative to the session workspace, or an absolute path outside it; must match the observation. Defaults to the workspace root."
			},
			sandboxPermissions: {
				type: "string",
				enum: ["danger-full-access"],
				description: "Only for a project outside the session workspace: request a one-call unconfined run. Requires justification."
			},
			justification: {
				type: "string",
				description: "Required with sandboxPermissions: why this external project must be built in this call."
			},
			module: {
				type: "string",
				required: true,
				description: "Gradle module path exactly as reported, for example \":app\"."
			},
			variant: {
				type: "string",
				required: true,
				description: "Variant name exactly as reported, for example \"debug\"."
			},
			clean: {
				type: "boolean",
				description: "Run \"clean\" before the selected task; defaults to false."
			},
			offline: {
				type: "boolean",
				description: "Pass --offline; defaults to false."
			},
			rerunTasks: {
				type: "boolean",
				description: "Pass --rerun-tasks; defaults to false."
			}
		},
		output: toolOutput,
		isConcurrencySafe: () => false,
		async execute(args, nativeExec) {
			const exec = nativeExec;
			try {
				rejectUnknownKeys(args, [
					"action",
					"observationId",
					"project",
					"module",
					"variant",
					"clean",
					"offline",
					"rerunTasks",
					"sandboxPermissions",
					"justification"
				]);
				const config = getConfig();
				const action = requireEnum(args.action, "action", ["build", "test"]);
				const gate = executionGate(config, action, "cli");
				if (gate) return json(gate);
				const observationId = requireText(args.observationId, "observationId", 128);
				const modulePath = requireText(args.module, "module", 512);
				const variant = requireText(args.variant, "variant", 128);
				const clean = args.clean === void 0 ? false : requireBoolean(args.clean, "clean");
				const offline = args.offline === void 0 ? false : requireBoolean(args.offline, "offline");
				const rerunTasks = args.rerunTasks === void 0 ? false : requireBoolean(args.rerunTasks, "rerunTasks");
				const project = args.project === void 0 ? void 0 : requireProjectPath(args.project, "project");
				const services = servicesFor(ctx, exec);
				if (isOutcome(services)) return json(services);
				const binding = await bindProject(services, exec, project);
				if (isOutcome(binding)) return json(binding);
				const gated = escalationGate(binding, action, {
					...args.sandboxPermissions !== void 0 ? { sandboxPermissions: String(args.sandboxPermissions) } : {},
					...args.justification !== void 0 ? { justification: String(args.justification) } : {}
				});
				if (!gated.ok) return json(gated.outcome);
				const found = observations.getFor(observationId, exec.agent?.id ?? "unknown");
				if (!found.ok) return json(blocked(action, found.code, found.message));
				const facts = found.observation.facts;
				if (facts.projectRoot !== binding.root) return json(blocked(action, "TARGET_CHANGED", "build observation belongs to a different project root"));
				if (binding.mode === "read-only") return json(blocked(action, "CAPABILITY_UNAVAILABLE", "Gradle writes outputs and requires a workspace-write (or wider) session policy"));
				const module = facts.modules.find((entry) => entry.path === modulePath);
				if (!module) return json(blocked(action, "TARGET_REQUIRED", `module is not declared by the build observation: ${modulePath}`));
				if (!module.variants.some((entry) => entry.name === variant)) return json(blocked(action, "TARGET_REQUIRED", `variant is not declared for ${modulePath}: ${variant}`));
				const suffix = `${variant.charAt(0).toUpperCase()}${variant.slice(1)}`;
				const gradleTask = action === "build" ? `${modulePath}:assemble${suffix}` : `${modulePath}:test${suffix}UnitTest`;
				const taskNames = [...clean ? ["clean"] : [], gradleTask];
				const flags = [
					"--console=plain",
					...offline ? ["--offline"] : [],
					...rerunTasks ? ["--rerun-tasks"] : [],
					...binding.external ? ["--no-daemon"] : []
				];
				const argv = [...taskNames, ...flags];
				const env = {
					GRADLE_USER_HOME: `${binding.workspaceRoot}/.satellite/gradle-user-home`,
					...config.javaHome ? { JAVA_HOME: config.javaHome } : {}
				};
				const approved = await askApproval(services, exec, BUILD_TOOL, `Run "${facts.gradleWrapper} ${argv.join(" ")}" in ${binding.root} (module ${modulePath}, variant ${variant}). It writes build outputs and caches under the workspace and may download dependencies. Session sandbox: ${binding.mode} at ${binding.workspaceRoot}. Device effects: none. Before the build starts, the Android CLI is run again to re-check the approved project facts.` + (binding.external ? ` NOTE: the project is outside the session workspace (${binding.workspaceRoot}); this call runs UNCONFINED (danger-full-access). Justification: ${gated.escalation?.justification ?? "(missing)"}.` : ""));
				if (approved) return json(approved);
				const after = resolvePolicy(services.sandboxPolicy, exec.agent?.session);
				if (!after || policyKey(after) !== policyKey(binding)) return json(blocked(action, "POLICY_CHANGED", "session policy changed after approval; retry required"));
				const reverified = await discoverBuildFacts({
					services,
					binding,
					exec,
					config,
					approvalMode: "covered",
					...gated.escalation ? { escalation: gated.escalation } : {}
				}, (/* @__PURE__ */ new Date()).toISOString());
				if (!reverified.ok) return json(blocked(action, "TARGET_CHANGED", `re-verification failed before building: ${reverified.outcome.error?.message ?? reverified.outcome.status}`));
				if (digestDynamicFacts(sha256, reverified.facts) !== found.observation.modelDigest) return json(blocked(action, "TARGET_CHANGED", "project build facts changed after the observation; discover again before building"));
				if (!reverified.facts.modules.find((entry) => entry.path === modulePath)?.variants.some((entry) => entry.name === variant)) return json(blocked(action, "TARGET_CHANGED", "the selected module/variant is no longer declared"));
				const run = await runBounded(services, {
					executable: facts.gradleWrapper,
					args: argv,
					cwd: binding.root,
					mode: binding.external && gated.escalation !== void 0 ? "danger-full-access" : binding.mode,
					workspaceRoot: binding.external && gated.escalation !== void 0 ? binding.root : binding.workspaceRoot,
					...binding.sessionId !== void 0 ? { sessionId: binding.sessionId } : {},
					timeoutMs: config.operationTimeoutMs,
					outputMaxBytes: config.outputMaxBytes,
					...env ? { env } : {}
				}, exec.signal);
				const mapped = mapRun(action, run, [{
					kind: "gradle-task",
					source: argv.join(" "),
					digest: sha256(`${modulePath}:${variant}`)
				}]);
				if ("status" in mapped) {
					if (mapped.status === "failed" && mapped.error?.code === "TIMEOUT") return json(effectUnknown(action, "EFFECT_UNKNOWN", "Gradle did not finish before its deadline; build outputs may be partial"));
					return json(mapped);
				}
				const result = mapped.result;
				const failedBuild = result.exitCode !== 0;
				const expectedArtifacts = action === "build" ? facts.modules.find((entry) => entry.path === modulePath)?.variants.find((entry) => entry.name === variant)?.artifacts ?? [] : [];
				const artifactEvidence = [];
				const missingArtifacts = [];
				for (const artifact of expectedArtifacts) {
					const target = await binding.fs.resolve(artifact.path, { signal: exec.signal });
					const info = await binding.fs.stat(target, exec.signal);
					if (!info || info.type !== "file") {
						missingArtifacts.push(artifact.path);
						continue;
					}
					const entry = {
						kind: "artifact",
						source: artifact.path
					};
					if (typeof info.size === "number" && info.size <= ARTIFACT_DIGEST_LIMIT) entry.digest = sha256(await binding.fs.readBytes(target, exec.signal, ARTIFACT_DIGEST_LIMIT));
					artifactEvidence.push(entry);
				}
				const artifactProblem = !failedBuild && expectedArtifacts.length > 0 && missingArtifacts.length > 0;
				return json({
					status: failedBuild || artifactProblem ? "failed" : "succeeded",
					action,
					evidence: [
						{
							kind: "gradle-task",
							source: argv.join(" "),
							digest: sha256(`${modulePath}:${variant}`)
						},
						...artifactEvidence,
						{
							kind: "stdout",
							source: "bounded process output",
							digest: sha256(result.stdout.text)
						}
					],
					cleanup: result.cleanup === "completed" ? "not-needed" : "failed",
					stdout: result.stdout.text,
					stderr: result.stderr.text,
					truncated: result.stdout.truncated || result.stderr.truncated,
					...expectedArtifacts.length > 0 ? { artifacts: {
						expected: expectedArtifacts.length,
						verified: artifactEvidence.length,
						missing: missingArtifacts
					} } : {},
					...binding.external && gated.escalation !== void 0 ? { escalation: {
						mode: "danger-full-access",
						justification: gated.escalation.justification
					} } : {},
					...run.ok && run.result.unconfined ? { unconfined: true } : {},
					...failedBuild ? { error: {
						code: "CAPABILITY_UNAVAILABLE",
						message: `Gradle exited with ${result.exitCode}`
					} } : artifactProblem ? { error: {
						code: "EFFECT_UNKNOWN",
						message: `Gradle exited 0 but these declared artifacts are missing: ${missingArtifacts.join(", ")}`
					} } : {}
				});
			} catch (error) {
				if (error instanceof ArgumentError) return json(blocked("build", "ARGUMENT_INVALID", error.message));
				throw error;
			}
		}
	};
}
/**
* 旅程与采集共用同一份"adb 已解析、项目已绑定"的依赖对象。
* 两个模块都只执行固定 argv；批准由本层在调用前完成。
*/
function deviceLikeDeps(services, binding, exec, config) {
	return {
		fs: binding.fs,
		sandbox: services.sandbox,
		subprocess: services.subprocess,
		binding: {
			root: binding.root,
			mode: binding.mode,
			workspaceRoot: binding.workspaceRoot,
			...binding.sessionId !== void 0 ? { sessionId: binding.sessionId } : {}
		},
		exec,
		adbPath: config.adbPath,
		operationTimeoutMs: config.operationTimeoutMs,
		outputMaxBytes: config.outputMaxBytes
	};
}
function createJourneyTool(ctx, getConfig, observations, lock) {
	return {
		name: JOURNEY_TOOL,
		description: "Run one bounded UI journey on an explicitly named device: a fixed list of tap/text/key/wait/assert steps with screenshot capture. Each step maps to one exact adb command; asserts that cannot be evaluated fail instead of passing. Requires host approval.",
		parameters: {
			serial: {
				type: "string",
				required: true,
				description: "Exact device serial; must match the observation."
			},
			observationId: {
				type: "string",
				required: true,
				description: "Id from satellite_android_device discover. The device is re-verified and locked before the first step."
			},
			applicationId: {
				type: "string",
				required: true,
				description: "Reverse-DNS package under test."
			},
			steps: {
				type: "array",
				required: true,
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						action: {
							type: "string",
							enum: [
								"tap",
								"text",
								"key",
								"wait",
								"assert-foreground",
								"assert-ui-text",
								"screenshot"
							],
							description: "Exact action of this step; supply only the fields listed for it."
						},
						x: {
							type: "integer",
							description: "tap only: x coordinate, 0–100000."
						},
						y: {
							type: "integer",
							description: "tap only: y coordinate, 0–100000."
						},
						text: {
							type: "string",
							description: "text only (max 1024 chars, charset A–Z a–z 0–9 space . , _ @ / : + = -) or assert-ui-text only (max 512 chars)."
						},
						key: {
							type: "string",
							enum: [...JOURNEY_KEYS],
							description: "key only: one of the listed key codes, exactly as spelled."
						},
						ms: {
							type: "integer",
							description: "wait only: 1–30000 milliseconds."
						},
						package: {
							type: "string",
							description: "assert-foreground only: the reverse-DNS package that must be in the foreground."
						},
						output: {
							type: "string",
							description: "screenshot only: workspace-relative path for the PNG; new files only."
						}
					}
				},
				description: "At most 30 steps, executed in order; the first failed step stops the rest. Unknown fields are rejected before any device command runs."
			}
		},
		output: toolOutput,
		isConcurrencySafe: () => false,
		async execute(args, nativeExec) {
			const exec = nativeExec;
			try {
				const config = getConfig();
				const gate = executionGate(config, "journey", "adb");
				if (gate) return json(gate);
				const { observationId: journeyObservation, ...journeyArgs } = args;
				const request = parseJourneyRequest(journeyArgs);
				const services = servicesFor(ctx, exec);
				if (isOutcome(services)) return json(services);
				const binding = await bindProject(services, exec);
				if (isOutcome(binding)) return json(binding);
				if (!config.adbPath) return json(blocked("journey", "CAPABILITY_UNAVAILABLE", "adb executable is not configured (adbPath)"));
				const peeked = observations.getFor(journeyObservation ?? "", exec.agent?.id ?? "unknown");
				if (!peeked.ok) return json(blocked("journey", peeked.code, peeked.message));
				if (peeked.observation.identity.serial !== request.serial) return json(blocked("journey", "TARGET_CHANGED", "request serial does not match the observation"));
				const approved = await askApproval(services, exec, JOURNEY_TOOL, `${describeJourneyPlan(request)} Verified target: ${peeked.observation.identity.serial} (transport ${peeked.observation.identity.transportId}).`);
				if (approved) return json(approved);
				const after = resolvePolicy(services.sandboxPolicy, exec.agent?.session);
				if (!after || policyKey(after) !== policyKey(binding)) return json(blocked("journey", "POLICY_CHANGED", "session policy changed after approval; retry required"));
				const deps = deviceLikeDeps(services, binding, exec, config);
				const deviceDeps = deviceDepsFor(services, binding, exec, config);
				if (isOutcome(deviceDeps)) return json(deviceDeps);
				const prepared = await prepareObservedTarget(deviceDeps, lock, observations, {
					action: "journey",
					serial: request.serial,
					observationId: journeyObservation
				}, binding);
				if (!prepared.ok) return json(prepared.outcome);
				try {
					return json(await runJourney(deps, request, Date.now()));
				} finally {
					prepared.release();
				}
			} catch (error) {
				if (error instanceof ArgumentError) return json(blocked("journey", "ARGUMENT_INVALID", error.message));
				throw error;
			}
		}
	};
}
function createCaptureTool(ctx, getConfig, observations, lock) {
	return {
		name: CAPTURE_TOOL,
		description: "Run one bounded capture on an explicitly named device: logcat dump, screen recording, perfetto trace or meminfo. Each action completes start → bounded window → stop → pull → verify → cleanup inside one call, and artifacts are verified on disk. Requires host approval.",
		parameters: {
			action: {
				type: "string",
				enum: [
					"logcat",
					"record",
					"perfetto",
					"memory"
				],
				required: true,
				description: "Capture kind. memory requires applicationId; perfetto requires configPath."
			},
			serial: {
				type: "string",
				required: true,
				description: "Exact device serial; must match the observation."
			},
			observationId: {
				type: "string",
				required: true,
				description: "Id from satellite_android_device discover. The device is re-verified and locked for the capture."
			},
			applicationId: {
				type: "string",
				description: "Package scope for logcat (--pid) and the subject of memory."
			},
			durationSeconds: {
				type: "integer",
				required: true,
				description: "Bounded capture window, 1–120 seconds."
			},
			output: {
				type: "string",
				required: true,
				description: "Workspace-relative artifact path; new files only."
			},
			configPath: {
				type: "string",
				description: "perfetto only: workspace-relative existing trace config file."
			}
		},
		output: toolOutput,
		isConcurrencySafe: () => false,
		async execute(args, nativeExec) {
			const exec = nativeExec;
			try {
				const config = getConfig();
				const gate = executionGate(config, "capture", "adb");
				if (gate) return json(gate);
				const { observationId: captureObservation, ...captureArgs } = args;
				const request = parseCaptureRequest(captureArgs);
				const services = servicesFor(ctx, exec);
				if (isOutcome(services)) return json(services);
				const binding = await bindProject(services, exec);
				if (isOutcome(binding)) return json(binding);
				if (!config.adbPath) return json(blocked("capture", "CAPABILITY_UNAVAILABLE", "adb executable is not configured (adbPath)"));
				const peeked = observations.getFor(captureObservation ?? "", exec.agent?.id ?? "unknown");
				if (!peeked.ok) return json(blocked("capture", peeked.code, peeked.message));
				if (peeked.observation.identity.serial !== request.serial) return json(blocked("capture", "TARGET_CHANGED", "request serial does not match the observation"));
				const approved = await askApproval(services, exec, CAPTURE_TOOL, `${describeCapturePlan(request)} Verified target: ${peeked.observation.identity.serial} (transport ${peeked.observation.identity.transportId}).`);
				if (approved) return json(approved);
				const after = resolvePolicy(services.sandboxPolicy, exec.agent?.session);
				if (!after || policyKey(after) !== policyKey(binding)) return json(blocked("capture", "POLICY_CHANGED", "session policy changed after approval; retry required"));
				const deps = { ...deviceLikeDeps(services, binding, exec, config) };
				const deviceDeps = deviceDepsFor(services, binding, exec, config);
				if (isOutcome(deviceDeps)) return json(deviceDeps);
				const prepared = await prepareObservedTarget(deviceDeps, lock, observations, {
					action: "capture",
					serial: request.serial,
					observationId: captureObservation
				}, binding);
				if (!prepared.ok) return json(prepared.outcome);
				try {
					return json(await runCapture(deps, request, Date.now()));
				} finally {
					prepared.release();
				}
			} catch (error) {
				if (error instanceof ArgumentError) return json(blocked("capture", "ARGUMENT_INVALID", error.message));
				throw error;
			}
		}
	};
}
//#endregion
export { BUILD_TOOL, CAPTURE_TOOL, DEFAULT_OPERATION_TIMEOUT_MS, DEFAULT_OUTPUT_MAX_BYTES, DEVICE_TOOL, EMULATOR_TOOL, JOURNEY_TOOL, PROJECT_TOOL, discoverBuildFacts, registerAndroidExecutionTools };
