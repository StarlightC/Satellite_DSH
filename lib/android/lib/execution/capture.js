import { createHash, randomUUID } from "node:crypto";
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
//#region src/android/lib/execution/journey.ts
/** 设备上的临时目录：所有中间产物都写在这里，并在 finally 清理。 */
const DEVICE_TMP_DIR = "/data/local/tmp";
Object.freeze([
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
const MIN_DURATION_SECONDS = 1;
const MAX_DURATION_SECONDS = 120;
/** logcat dump 模式的固定尾部行数：不给调用方任意 `-t` 的自由度。 */
const LOG_DUMP_LINES = 2e3;
/** perfetto 配置文件的读入上限。 */
const PERFETTO_CONFIG_MAX_BYTES = 256 * 1024;
/** 文本产物写回后的读回校验上限。 */
const TEXT_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
/** 二进制产物摘要的限量读取上限：只对前缀取摘要并在证据里写明范围。 */
const ARTIFACT_DIGEST_MAX_BYTES = 16 * 1024 * 1024;
/** 采集结束后拉取与停止的额外预算。 */
const CAPTURE_SETTLE_MS = 3e4;
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
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
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
				digest: sha256(bytes)
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
			digest: sha256(content)
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
export { ARTIFACT_DIGEST_MAX_BYTES, CAPTURE_ACTIONS, CAPTURE_CLEANUP_TIMEOUT_MS, CAPTURE_SETTLE_MS, LOG_DUMP_LINES, MAX_DURATION_SECONDS, MIN_DURATION_SECONDS, PERFETTO_CONFIG_MAX_BYTES, TEXT_ARTIFACT_MAX_BYTES, describeCapturePlan, parseCaptureRequest, runCapture };
