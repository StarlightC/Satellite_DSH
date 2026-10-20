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
function requireInteger(value, where, min, max) {
	if (typeof value !== "number" || !Number.isInteger(value)) throw new ArgumentError(`${where} must be an integer`);
	if (value < min || value > max) throw new ArgumentError(`${where} must be between ${min} and ${max}`);
	return value;
}
function requireEnum(value, where, allowed) {
	if (typeof value !== "string" || !allowed.includes(value)) throw new ArgumentError(`${where} must be one of ${allowed.join("/")}`);
	return value;
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
function parseForegroundPackage(text) {
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
function deviceTimeout(value, fallback, max = 1800 * 1e3) {
	if (value === void 0) return fallback;
	return requireInteger(value, "timeoutMs", 1e3, max);
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
/** 设备工具自己的请求形态适配到统一前置。 */
const prepareDeviceAction = (deps, lock, observations, request, observedPolicy) => prepareObservedTarget(deps, lock, observations, request, observedPolicy);
//#endregion
export { DEVICE_TOOL, OBSERVATION_TTL_MS, adbArgv, adbRun, createDeviceLock, createDeviceObservationStore, describeDevicePlan, deviceTimeout, identityDigest, identityFromProbe, lockKey, observeDevice, parseAdbDevicesL, parseDeviceRequest, parseForegroundPackage, parseGetprop, prepareDeviceAction, prepareObservedTarget, sameInstance, verifyDevice };
