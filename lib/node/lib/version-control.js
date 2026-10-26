import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { constants } from "node:fs";
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
//#region src/node/lib/version-control-input.ts
function deny(message) {
	throw new Error(`LOCAL_GIT: ${message}`);
}
function text(value, name, max = 1024) {
	if (typeof value !== "string" || !value.length || value.length > max || /[\x00-\x1f\x7f]/.test(value)) deny(`invalid ${name}`);
	return value;
}
function literalPath(value) {
	const path = text(value, "literal file path");
	if (path.includes("\\") || /[:*?\[\]]/.test(path) || path.startsWith("/") || path.split("/").some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")) deny("non-literal or outside path");
	return path;
}
function parseGitRequest(value) {
	if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) deny("request must be a plain record");
	const v = value;
	const action = text(v.action, "action");
	const keys = {
		status: ["action", "repo"],
		diff: [
			"action",
			"repo",
			"target",
			"paths"
		],
		log: [
			"action",
			"repo",
			"count"
		],
		stage: [
			"action",
			"repo",
			"paths",
			"expectedSnapshot"
		],
		commit: [
			"action",
			"repo",
			"message",
			"expectedSnapshot"
		]
	};
	if (!Object.hasOwn(keys, action) || Reflect.ownKeys(v).some((k) => typeof k !== "string" || !keys[action].includes(k))) deny("unknown action or key");
	const repo = v.repo === "." ? "." : literalPath(v.repo);
	const paths = () => {
		if (!Array.isArray(v.paths) || !v.paths.length || v.paths.length > 100) deny("paths must contain 1–100 files");
		const result = v.paths.map(literalPath);
		if (new Set(result).size !== result.length) deny("duplicate paths");
		return result;
	};
	if (action === "status") return {
		action,
		repo
	};
	if (action === "diff") {
		if (v.target !== "working" && v.target !== "staged") deny("invalid diff target");
		return {
			action,
			repo,
			target: v.target,
			...v.paths === void 0 ? {} : { paths: paths() }
		};
	}
	if (action === "log") {
		if (!Number.isInteger(v.count) || v.count < 1 || v.count > 50) deny("log count must be 1–50");
		return {
			action,
			repo,
			count: v.count
		};
	}
	const expectedSnapshot = text(v.expectedSnapshot, "expectedSnapshot", 128);
	if (action === "stage") return {
		action,
		repo,
		paths: paths(),
		expectedSnapshot
	};
	return {
		action: "commit",
		repo,
		message: text(v.message, "commit message", 4096),
		expectedSnapshot
	};
}
/** Deliberately small config language. Unknown/escaped/continued constructs fail closed.
* It is parsed BEFORE Git reads local config; this parser never follows includes.
* Remote URLs/refspecs are inert data: no action here invokes a remote.
*/
function validateLocalConfig(source) {
	let section = "";
	for (const raw of source.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || /^[#;]/.test(line)) continue;
		const header = /^\[([a-zA-Z][a-zA-Z0-9-]*)(?: "([^"\\\x00-\x1f]*)")?\]$/.exec(line);
		if (header) {
			section = header[1].toLowerCase();
			if (![
				"core",
				"user",
				"remote",
				"branch",
				"init",
				"lfs"
			].includes(section)) deny(`unsupported config section ${section}`);
			if (["remote", "branch"].includes(section) !== (header[2] !== void 0)) deny("invalid config subsection");
			continue;
		}
		const entry = /^([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*([^\\\x00-\x1f]*)$/.exec(line);
		if (!entry) deny("unsupported config syntax");
		const key = entry[1].toLowerCase(), val = entry[2].trim();
		if (!{
			core: [
				"repositoryformatversion",
				"bare",
				"filemode",
				"logallrefupdates",
				"ignorecase",
				"precomposeunicode",
				"symlinks",
				"autocrlf",
				"safecrlf",
				"quotepath"
			],
			user: ["name", "email"],
			remote: [
				"url",
				"pushurl",
				"fetch",
				"tagopt"
			],
			branch: [
				"remote",
				"merge",
				"rebase"
			],
			init: ["defaultbranch"],
			lfs: ["repositoryformatversion"]
		}[section]?.includes(key)) deny(`unsupported config ${section}.${key}`);
		if (section === "lfs" && val !== "0") deny("unsupported lfs repository format");
		if (section === "core") {
			if (key === "repositoryformatversion" ? val !== "0" : key === "bare" ? val !== "false" : ![
				"true",
				"false",
				"input"
			].includes(val)) deny(`unsupported core value ${key}`);
		}
	}
}
function validateAttributes(source) {
	for (const raw of source.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const parts = line.split(/\s+/);
		if (parts.length < 2 || parts[0].startsWith("[attr]") || !parts.slice(1).every((a) => [
			"text",
			"-text",
			"!text",
			"binary",
			"eol=lf",
			"eol=crlf",
			"diff",
			"-diff"
		].includes(a))) deny("unsupported attributes (filters/macros/drivers forbidden)");
	}
}
//#endregion
//#region src/node/lib/version-control-repository.ts
/** Bounded host-shared repository observation. No filesystem writes. */
const digest = (value) => createHash("sha256").update(value).digest("hex");
const inside = (root, path) => path === root || !relative(root, path).startsWith(`..${sep}`) && relative(root, path) !== ".." && !isAbsolute(relative(root, path));
async function noSymlinkAncestors(path) {
	const absolute = resolve(path);
	let cursor = sep;
	for (const part of absolute.split(sep).filter(Boolean)) {
		cursor = join(cursor, part);
		if ((await lstat(cursor)).isSymbolicLink()) deny("symlink ancestor");
	}
}
async function regularBytes(path, maxBytes) {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) deny("special, hardlinked or oversized file");
		const bytes = Buffer.alloc(before.size + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const read = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (!read.bytesRead) break;
			offset += read.bytesRead;
		}
		const after = await handle.stat();
		if (offset !== before.size || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) deny("file changed while reading");
		return bytes.subarray(0, offset);
	} finally {
		await handle.close();
	}
}
async function observeRepository(workspaceRoot, repo) {
	await noSymlinkAncestors(workspaceRoot);
	if (await realpath(workspaceRoot) !== workspaceRoot) deny("workspace must be canonical");
	const root = resolve(workspaceRoot, repo);
	if (!inside(workspaceRoot, root)) deny("repository outside workspace");
	await noSymlinkAncestors(root);
	if (await realpath(root) !== root) deny("repository path must be canonical");
	const gitdir = join(root, ".git");
	const rootStat = await lstat(root), gitStat = await lstat(gitdir);
	if (!rootStat.isDirectory() || !gitStat.isDirectory() || gitStat.isSymbolicLink()) deny("ordinary .git directory required; no worktrees/submodules/bare repos");
	let entries = 0, bytes = 0;
	const records = [], attributes = [], files = /* @__PURE__ */ new Map(), locks = [];
	let config, indexDigest = null;
	const walk = async (directory, prefix, metadata) => {
		const before = await lstat(directory);
		if (!before.isDirectory() || before.isSymbolicLink()) deny("special directory");
		const names = (await readdir(directory)).sort();
		for (const name of names) {
			if (++entries > 2e4) deny("repository entry budget exceeded");
			const path = join(directory, name), rel = prefix ? `${prefix}/${name}` : name;
			if (!metadata && rel === ".git") {
				await walk(path, ".git", true);
				continue;
			}
			const lower = rel.toLowerCase(), lowerName = name.toLowerCase();
			if (metadata && [".git/config", ".git/index"].includes(lower) && rel !== lower) deny("noncanonical reserved metadata alias");
			if (!metadata && (lowerName === ".git" || lowerName === ".gitmodules")) deny("nested repository/submodule unsupported");
			if (metadata && ([
				".git/commondir",
				".git/gitdir",
				".git/shallow",
				".git/objects/info/alternates",
				".git/objects/info/http-alternates",
				".git/info/grafts",
				".git/config.worktree",
				".git/modules",
				".git/worktrees"
			].includes(lower) || lowerName.endsWith(".promisor") || lowerName.startsWith("sharedindex."))) deny(`unsupported repository metadata ${rel}`);
			const st = await lstat(path);
			if (st.isDirectory() && !st.isSymbolicLink()) {
				records.push([
					rel,
					"directory",
					st.dev,
					st.ino,
					st.mode
				]);
				await walk(path, rel, metadata);
			} else {
				if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) deny(`special path ${rel}`);
				bytes += st.size;
				if (bytes > 64 * 1024 * 1024) deny("repository byte budget exceeded");
				const content = await regularBytes(path, Math.min(8 * 1024 * 1024, 64 * 1024 * 1024 - bytes + st.size));
				const hash = digest(content);
				records.push([
					rel,
					st.dev,
					st.ino,
					st.mode,
					st.size,
					st.mtimeMs,
					st.ctimeMs,
					hash
				]);
				if (!metadata) {
					literalPath(rel);
					files.set(rel, hash);
				}
				if (lower === ".git/config") {
					config = content.toString("utf8");
					validateLocalConfig(config);
				}
				if (lower === ".git/index") indexDigest = hash;
				if (!metadata && lowerName === ".gitattributes" || lower === ".git/info/attributes") {
					validateAttributes(content.toString("utf8"));
					attributes.push([rel, hash]);
				}
				if (metadata && lowerName.endsWith(".lock")) locks.push(rel);
			}
		}
		const after = await lstat(directory);
		if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) deny("directory changed while observing");
	};
	await walk(root, "", false);
	if (config === void 0) deny("local config required");
	return {
		root,
		identity: JSON.stringify([
			root,
			rootStat.dev,
			rootStat.ino,
			gitStat.dev,
			gitStat.ino
		]),
		lockKey: JSON.stringify([
			rootStat.dev,
			rootStat.ino,
			gitStat.dev,
			gitStat.ino
		]),
		digest: digest(JSON.stringify(records)),
		configDigest: digest(config),
		attributesDigest: digest(JSON.stringify(attributes)),
		indexDigest,
		files,
		locks
	};
}
//#endregion
//#region src/node/lib/version-control.ts
/**
* Local Git kernel, exposed only through the reserved runtime identity bridge. No remote operation.
* Services/identity are trusted constructor seams, NEVER model request fields.
* Host-shared POSIX only. Full native file confinement is required for every spawn.
* This does not isolate a malicious host Git binary or eliminate external last-instant races.
*/
const queues = /* @__PURE__ */ new Map();
async function serial(key, operation) {
	const previous = queues.get(key) ?? Promise.resolve();
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => gate);
	queues.set(key, tail);
	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (queues.get(key) === tail) queues.delete(key);
	}
}
const GIT = "/usr/bin/git";
const ENV = "/usr/bin/env";
const CLEAN_ENV = [
	"PATH=/usr/bin:/bin",
	"LC_ALL=C",
	"HOME=/nonexistent",
	"XDG_CONFIG_HOME=/nonexistent",
	"GIT_CONFIG_NOSYSTEM=1",
	"GIT_CONFIG_SYSTEM=/dev/null",
	"GIT_CONFIG_GLOBAL=/dev/null",
	"GIT_ATTR_NOSYSTEM=1",
	"GIT_ALLOW_PROTOCOL=",
	"GIT_NO_LAZY_FETCH=1",
	"GIT_TERMINAL_PROMPT=0",
	"GIT_OPTIONAL_LOCKS=0",
	"GIT_NO_REPLACE_OBJECTS=1",
	"GIT_LITERAL_PATHSPECS=1",
	"GIT_PAGER=cat"
];
const FIXED = [
	"--no-pager",
	"--no-replace-objects",
	"--literal-pathspecs",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.untrackedCache=false",
	"-c",
	"commit.gpgSign=false",
	"-c",
	"tag.gpgSign=false",
	"-c",
	"core.pager=cat",
	"-c",
	"diff.external=",
	"-c",
	"diff.trustExitCode=false",
	"-c",
	"submodule.recurse=false",
	"-c",
	"gc.auto=0",
	"-c",
	"maintenance.auto=false",
	"-c",
	"core.autocrlf=false",
	"-c",
	"core.safecrlf=false",
	"-c",
	"core.attributesFile=/dev/null"
];
const TTL = 5 * 6e4;
const expired = (snapshot) => snapshot.expiresAt <= Date.now() || snapshot.deadline <= performance.now();
const ownerKey = (deps) => JSON.stringify([deps.agent.id, deps.sessionId]);
const fullArgv = (args) => [
	ENV,
	"-i",
	...CLEAN_ENV,
	GIT,
	...FIXED,
	...args
];
async function executableIdentity() {
	const records = [];
	for (const path of [ENV, GIT]) {
		const st = await lstat(path);
		if (!st.isFile() || st.isSymbolicLink() || await realpath(path) !== path) deny("trusted POSIX executable unavailable");
		records.push([
			path,
			st.dev,
			st.ino,
			st.size,
			st.mtimeMs,
			st.ctimeMs
		]);
	}
	return JSON.stringify(records);
}
/** Private in-memory tokens expire and are single-use. No persistence or model-supplied facts. */
function createLocalVersionControl(deps) {
	const snapshots = /* @__PURE__ */ new Map();
	const owner = ownerKey(deps), boundAgent = deps.agent, boundSession = deps.agent.session;
	function policy(write) {
		const p = deps.policy();
		if (!p || ![
			"read-only",
			"workspace-write",
			"danger-full-access"
		].includes(p.mode) || p.workspaceRoot !== deps.workspaceRoot || p.sessionId !== void 0 && p.sessionId !== deps.sessionId) deny("effective parent policy unavailable or mismatched");
		if (!deps.agent.id || !deps.sessionId || owner !== ownerKey(deps) || deps.agent !== boundAgent || deps.agent.session !== boundSession) deny("calling identity changed");
		if (write && p.mode === "read-only") deny("parent sandbox denies writes");
		return JSON.stringify([
			p.mode,
			p.workspaceRoot,
			p.sessionId ?? null
		]);
	}
	return {
		owner,
		take(token) {
			const snap = snapshots.get(token);
			snapshots.delete(token);
			return snap && !expired(snap) && snap.owner === owner ? snap : void 0;
		},
		async execute(input, signal, callId) {
			let request;
			try {
				request = parseGitRequest(input);
				const r = request;
				if (deps.readOnly && (r.action === "stage" || r.action === "commit")) deny("writes are only executed by the parent-owned handoff");
				policy(r.action === "stage" || r.action === "commit");
				const queuedState = await observeRepository(deps.workspaceRoot, r.repo);
				return await serial(queuedState.lockKey, async () => {
					signal.throwIfAborted();
					const initialPolicy = policy(false), executable = await executableIdentity();
					const state = await observeRepository(deps.workspaceRoot, r.repo);
					if (state.identity !== queuedState.identity) deny("repository identity changed while queued");
					let writeSnapshot;
					const check = async (write = false) => {
						signal.throwIfAborted();
						if (await executableIdentity() !== executable) deny("executable changed");
						const current = await observeRepository(deps.workspaceRoot, r.repo);
						if (current.identity !== state.identity || current.digest !== state.digest) deny("repository changed; observe again");
						if (policy(write) !== initialPolicy) deny("policy changed");
						if (write && (!writeSnapshot || expired(writeSnapshot))) deny("write snapshot expired");
						signal.throwIfAborted();
					};
					const run = async (args, write = false) => {
						const argv = fullArgv(args);
						let launched = false;
						const uncertain = (detail) => ({
							exitCode: null,
							signal: null,
							timedOut: false,
							aborted: signal.aborted,
							stdout: {
								text: "",
								truncated: false
							},
							stderr: {
								text: "",
								truncated: false
							},
							enforcement: "full",
							cleanup: "failed",
							failureDetail: detail
						});
						try {
							const subprocess = {
								...deps.subprocess,
								spawn: (spec) => {
									launched = true;
									return deps.subprocess.spawn(spec);
								}
							};
							const result = await runBounded({
								sandbox: deps.sandbox,
								subprocess
							}, {
								executable: argv[0],
								args: argv.slice(1),
								cwd: state.root,
								mode: write ? "workspace-write" : "read-only",
								workspaceRoot: deps.workspaceRoot,
								sessionId: deps.sessionId,
								timeoutMs: 3e4,
								outputMaxBytes: 128 * 1024,
								beforeSpawn: () => check(write)
							}, signal);
							if (!result.ok) {
								if (write && launched) return uncertain(JSON.stringify(result.failure));
								deny(`process unavailable: ${JSON.stringify(result.failure)}`);
							}
							return result.result;
						} catch (error) {
							if (write && launched) return uncertain(error instanceof Error ? error.message : String(error));
							throw error;
						}
					};
					const read = async (args, allowed = [0]) => {
						const result = await run(args);
						if (result.aborted || result.timedOut || result.cleanup !== "completed" || result.failureDetail || result.stdout.truncated || result.stderr.truncated || !allowed.includes(result.exitCode ?? -1)) deny(`read failed: ${JSON.stringify(result)}`);
						return result;
					};
					const headResult = await read([
						"rev-parse",
						"--verify",
						"--quiet",
						"HEAD"
					], [0, 1]);
					const head = headResult.exitCode === 1 ? null : headResult.stdout.text.trim();
					if (head !== null && !/^[a-f0-9]{40}$/.test(head)) deny("unsupported HEAD/object format");
					const index = (await read([
						"ls-files",
						"--stage",
						"-z"
					])).stdout.text.split("\0").filter(Boolean).map((line) => {
						const match = /^(100644|100755) ([a-f0-9]{40}) 0\t(.+)$/.exec(line);
						if (!match) deny("conflicted/special index entry (including gitlink/symlink)");
						return {
							mode: match[1],
							oid: match[2],
							path: literalPath(match[3])
						};
					});
					for (const entry of index.filter((e) => e.path.split("/").at(-1).toLowerCase() === ".gitattributes")) validateAttributes((await read(["show", `:${entry.path}`])).stdout.text);
					const validatePaths = async (paths, staging = true) => {
						for (const path of paths) {
							if (!state.files.has(path)) {
								if (staging && !index.some((e) => e.path === path)) deny(`not a regular file or explicit tracked deletion: ${path}`);
								try {
									await lstat(join(state.root, path));
									deny("deleted path resolves to existing alias/directory");
								} catch (error) {
									if (error.code !== "ENOENT") throw error;
								}
							}
							if ([...state.files.keys(), ...index.map((e) => e.path)].some((p) => p.startsWith(`${path}/`))) deny("directory path denied");
						}
					};
					if (r.action === "status") {
						const result = await read([
							"status",
							"--porcelain=v1",
							"-z",
							"--untracked-files=all",
							"--ignore-submodules=all"
						]);
						await check();
						for (const [key, snap] of snapshots) if (expired(snap)) snapshots.delete(key);
						if (snapshots.size >= 32) snapshots.delete(snapshots.keys().next().value);
						const token = randomBytes(32).toString("hex"), expiresAt = Date.now() + TTL;
						snapshots.set(token, {
							state,
							head,
							policy: initialPolicy,
							workspaceRoot: deps.workspaceRoot,
							expiresAt,
							deadline: performance.now() + TTL,
							owner
						});
						return {
							status: "succeeded",
							action: r.action,
							stdout: result.stdout.text,
							expectedSnapshot: token,
							snapshot: {
								head,
								indexDigest: state.indexDigest,
								digest: state.digest,
								expiresAt
							}
						};
					}
					if (r.action === "log") {
						const stdout = head === null ? "" : (await read([
							"log",
							`-${r.count}`,
							"--format=medium",
							"--no-decorate",
							"--no-show-signature",
							"HEAD",
							"--"
						])).stdout.text;
						return {
							status: "succeeded",
							action: r.action,
							stdout
						};
					}
					if (r.action === "diff") {
						if (r.paths) await validatePaths(r.paths, false);
						const result = await read([
							"diff",
							...r.target === "staged" ? ["--cached"] : [],
							"--no-ext-diff",
							"--no-textconv",
							"--no-renames",
							"--ignore-submodules=all",
							"--",
							...r.paths ?? []
						]);
						return {
							status: "succeeded",
							action: r.action,
							stdout: result.stdout.text
						};
					}
					const snap = deps.handoff ? deps.handoff.take(r.expectedSnapshot) : snapshots.get(r.expectedSnapshot);
					snapshots.delete(r.expectedSnapshot);
					const policyMatches = deps.handoff ? snap?.workspaceRoot === deps.workspaceRoot : snap?.policy === initialPolicy;
					if (!snap || expired(snap) || snap.owner !== (deps.handoff?.owner ?? owner) || snap.state.identity !== state.identity || snap.state.digest !== state.digest || snap.head !== head || !policyMatches) deny("expectedSnapshot missing, expired, foreign or changed");
					writeSnapshot = snap;
					if (state.locks.length) deny(`Git locks present (not removed): ${state.locks.join(", ")}`);
					let args, indexPatch;
					if (r.action === "stage") {
						await validatePaths(r.paths);
						args = [
							"add",
							"--",
							...r.paths
						];
					} else {
						if (!index.length) deny("empty index");
						if ((await read([
							"diff",
							"--cached",
							"--quiet",
							"--no-ext-diff",
							"--no-textconv",
							"--ignore-submodules=all",
							"--"
						], [0, 1])).exitCode === 0) deny("no staged change");
						indexPatch = (await read([
							"diff",
							"--cached",
							"--binary",
							"--full-index",
							"--no-ext-diff",
							"--no-textconv",
							"--no-renames",
							"--ignore-submodules=all",
							"--"
						])).stdout.text;
						args = [
							"commit",
							"--no-gpg-sign",
							"--no-verify",
							"-m",
							r.message
						];
					}
					const argv = fullArgv(args);
					const plan = {
						action: r.action,
						repository: state.root,
						identity: state.identity,
						head,
						indexDigest: state.indexDigest,
						treeDigest: state.digest,
						configDigest: state.configDigest,
						attributesDigest: state.attributesDigest,
						argv,
						owner,
						policy: initialPolicy,
						...r.action === "stage" ? { targets: r.paths.map((path) => ({
							path,
							digest: state.files.get(path) ?? null
						})) } : {
							entireIndex: index,
							indexPatch
						}
					};
					const reason = `Local Git exact one-shot write; no remote operation. Commit covers the ENTIRE actual index.\n${JSON.stringify(plan)}`;
					if (Buffer.byteLength(reason) > 64 * 1024) deny("approval plan too large; do not truncate");
					await check(true);
					const confinement = await deps.sandbox.confine(argv, {
						mode: "workspace-write",
						workspaceRoot: deps.workspaceRoot,
						sessionId: deps.sessionId
					}, signal);
					if (confinement.enforcement !== "full" || !confinement.argv.length) deny("full write confinement unavailable");
					if (!deps.approval || typeof deps.approval.request !== "function") deny("approval service unavailable");
					let granted;
					try {
						granted = await deps.approval.request({
							agent: deps.agent,
							toolName: "satellite_version_control",
							...callId ? { callId } : {},
							reason,
							signal
						});
					} catch {
						deny("approval service exception; denied");
					}
					if (granted !== "allowed-once") deny(`approval ${granted}; denied`);
					if (expired(snap)) deny("expectedSnapshot expired while awaiting approval");
					await check(true);
					const result = await run(args, true);
					const unknown = result.aborted || result.timedOut || result.cleanup !== "completed" || !!result.failureDetail || result.exitCode !== 0;
					return {
						status: unknown ? "effect-unknown" : "succeeded",
						action: r.action,
						exitCode: result.exitCode,
						stdout: result.stdout.text,
						stderr: result.stderr.text,
						stdoutTruncated: result.stdout.truncated,
						stderrTruncated: result.stderr.truncated,
						...unknown ? { message: "Write may have taken effect. Observe status before any new decision; never automatically retry." } : {}
					};
				});
			} catch (error) {
				return {
					status: "blocked",
					...request ? { action: request.action } : {},
					message: error instanceof Error ? error.message : String(error)
				};
			}
		}
	};
}
//#endregion
export { createLocalVersionControl };
