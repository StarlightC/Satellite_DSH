import { randomUUID } from "node:crypto";
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
Object.freeze([
	"read-only",
	"workspace-write",
	"danger-full-access"
]);
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
const DEFAULT_STARTUP_TIMEOUT_MS = 300 * 1e3;
const BOOT_POLL_INTERVAL_MS = 2e3;
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
export { BOOT_POLL_INTERVAL_MS, DEFAULT_STARTUP_TIMEOUT_MS, EMULATOR_TOOL, adbSerials, createOwnedResources, describeEmulatorPlan, newEmulatorSerial, parseAvdList, parseEmulatorRequest, runBoundedEmulatorAction, startEmulator };
