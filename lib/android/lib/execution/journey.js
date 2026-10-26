import { createHash, randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";
//#region src/platform/paths.ts
/**
* Pure host-path syntax used by platform-independent/static inputs.
* Recognising Windows syntax does not enable Windows execution; dynamic execution
* still requires a supported adapter and canonical filesystem containment.
*/
function isAbsoluteHostPathSyntax(path) {
	return posix.isAbsolute(path) || win32.isAbsolute(path);
}
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
	if (request.beforeSpawn) {
		await request.beforeSpawn(confined.argv);
		signal.throwIfAborted();
	}
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
const MAX_JOURNEY_STEPS = 30;
const MAX_TEXT_LENGTH = 1024;
const MAX_ASSERT_TEXT_LENGTH = 512;
const MIN_WAIT_MS = 1;
const MAX_WAIT_MS = 3e4;
/** 单步上限：与规格"每步 ≤30 秒"一致。 */
const STEP_TIMEOUT_MS = 3e4;
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
function parseSerial(value) {
	const serial = requireText(value, "serial", 128);
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(serial)) throw new ArgumentError("serial must match [A-Za-z0-9][A-Za-z0-9._:-]* (no spaces, leading \"-\" or shell characters)");
	return serial;
}
/** 应用包名：只允许点分标识符，避免把任意串拼进设备 shell。 */
function parsePackageName(value, where) {
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
				packageName: parsePackageName(step.package, `${where}.package`)
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
	const serial = parseSerial(record.serial);
	const applicationId = parsePackageName(record.applicationId, "applicationId");
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
const adb = (_deps, serial, args) => [
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
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function frozen(status, action, extra) {
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
async function runCommand(context, args, options = {}) {
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
		digest = sha256(bytes);
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
async function requireParentDirectory(context, relativePath) {
	const parent = relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/")) : ".";
	const target = await context.deps.fs.resolve(parent, {
		cwd: context.deps.binding.root,
		signal: context.deps.exec.signal
	});
	const info = await context.deps.fs.stat(target, context.deps.exec.signal);
	if (!info || info.type !== "directory") return `output directory does not exist in the workspace: ${parent === "." ? "." : parent}`;
}
async function runScreenshot(context, step) {
	const missingParent = await requireParentDirectory(context, step.output);
	if (missingParent) return {
		ok: false,
		status: "blocked",
		code: "TARGET_REQUIRED",
		detail: missingParent
	};
	const devicePath = deviceTempPath("png", context.token);
	context.cleanupPaths.add(devicePath);
	const capture = await runCommand(context, adb(context.deps, context.request.serial, [
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
	const pull = await runCommand(context, adb(context.deps, context.request.serial, [
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
	const dump = await runCommand(context, adb(context.deps, context.request.serial, [
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
	const dump = await runCommand(context, adb(context.deps, context.request.serial, [
		"shell",
		"uiautomator",
		"dump",
		devicePath
	]));
	if (!dump.ok) return dump.outcome;
	const read = await runCommand(context, adb(context.deps, context.request.serial, [
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
			digest: sha256(step.text)
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
	if (!isAbsoluteHostPathSyntax(deps.adbPath)) return frozen("blocked", "journey", {
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
		for (const path of [...context.cleanupPaths]) if (await removeDeviceFile(context, path)) context.cleanupPaths.delete(path);
	}
	const cleanupFailed = context.cleanupPaths.size > 0;
	const cleanup = cleanupFailed ? "failed" : "completed";
	if (!failure && !cleanupFailed) return frozen("succeeded", "journey", {
		evidence: collected,
		cleanup,
		steps
	});
	if (!failure) return frozen("failed", "journey", {
		evidence: collected,
		cleanup,
		steps,
		error: {
			code: "CLEANUP_FAILED",
			message: "some device temporary files could not be removed"
		}
	});
	if (failure.status === "cancelled") return frozen("cancelled", "journey", {
		evidence: collected,
		cleanup,
		steps
	});
	const alreadyChangedDevice = steps.some((entry) => entry.status === "succeeded");
	if (failure.status === "blocked" && !alreadyChangedDevice) return frozen("blocked", "journey", {
		evidence: collected,
		cleanup,
		steps,
		error: {
			code: failure.code ?? "CAPABILITY_UNAVAILABLE",
			message: failure.detail ?? "journey could not start"
		}
	});
	if (failure.status === "blocked") return frozen("failed", "journey", {
		evidence: collected,
		cleanup,
		steps,
		error: {
			code: failure.code ?? "CAPABILITY_UNAVAILABLE",
			message: `${failure.detail ?? "step could not start"} (earlier steps already changed device state)`
		}
	});
	return frozen("failed", "journey", {
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
			const run = await runCommand(context, adb(deps, request.serial, [
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
			const run = await runCommand(context, adb(deps, request.serial, [
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
			const run = await runCommand(context, adb(deps, request.serial, [
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
export { DEVICE_TMP_DIR, INPUT_TEXT_PATTERN, JOURNEY_KEYS, MAX_ASSERT_TEXT_LENGTH, MAX_JOURNEY_STEPS, MAX_TEXT_LENGTH, MAX_WAIT_MS, MIN_WAIT_MS, SCREENSHOT_DIGEST_MAX_BYTES, STEP_TIMEOUT_MS, UI_DUMP_MAX_BYTES, describeJourneyPlan, deviceTempPath, encodeInputText, parseForegroundPackage, parseJourneyRequest, parseUiTexts, runJourney };
