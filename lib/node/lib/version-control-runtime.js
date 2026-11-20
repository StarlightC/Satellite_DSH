import { symbols } from "@deepseek-ai/cordis";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
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
	if (request.additionalWritableRoots !== void 0 && request.mode !== "workspace-write") return {
		ok: false,
		failure: {
			kind: "unavailable",
			message: "additionalWritableRoots require workspace-write"
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
			...request.sessionId !== void 0 ? { sessionId: request.sessionId } : {},
			...request.additionalWritableRoots !== void 0 ? { additionalWritableRoots: [...request.additionalWritableRoots] } : {}
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
	if (path.startsWith("/") || path.split("/").some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")) deny("outside path or reserved Git metadata");
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
		if (!Array.isArray(v.paths) || !v.paths.length) deny("paths must contain at least one file");
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
		if (!Number.isSafeInteger(v.count) || v.count < 1) deny("log count must be a positive safe integer");
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
/** Git's integer parser is strtoimax(value, &end, 0) plus an optional k/m/g
* unit, so 0, 00, +0, -0, 0x0 and 0k are the same zero. Any other value is
* either non-zero or rejected by Git itself. */
function isGitIntegerZero(value) {
	const parsed = /^[ \t]*[+-]?(?:0[xX]([0-9a-fA-F]+)|([0-9]+))[kKmMgG]?$/.exec(value);
	return parsed !== null && /^0+$/.test(parsed[1] ?? parsed[2]);
}
/** Parse locally, before Git startup can read includes or redirected metadata.
* Git-config(1) syntax: comments, quoted fragments, escapes, continuations,
* implicit booleans, deprecated dotted subsections and repeated keys.
* Unknown keys are NOT an execution protocol. Restrictions below name reachable
* execution/path entries not already neutralised by the kernel's fixed argv/env.
*/
function validateLocalConfig(source) {
	if (source.includes("\0")) deny("NUL in local config");
	let section = "", subsection;
	const lines = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i].trimStart();
		if (!line || /^[#;]/.test(line)) continue;
		if (line.startsWith("[")) {
			const header = /^\[([A-Za-z0-9.-]+)(?:[ \t]+"((?:[^"\\]|\\.)*)")?\]/.exec(line);
			if (!header) deny("invalid config section syntax");
			const dot = header[1].indexOf(".");
			section = (dot < 0 ? header[1] : header[1].slice(0, dot)).toLowerCase();
			subsection = header[2] !== void 0 ? header[2].replace(/\\(.)/g, "$1") : dot < 0 ? void 0 : header[1].slice(dot + 1).toLowerCase();
			line = line.slice(header[0].length).trimStart();
			if (!line || /^[#;]/.test(line)) continue;
		}
		const entry = /^([A-Za-z][A-Za-z0-9-]*)([ \t]*(?:=([\s\S]*)|[#;].*)?)$/.exec(line);
		if (!section || !entry) deny("invalid config entry syntax");
		const key = entry[1].toLowerCase();
		let value = "", pending = "", quoted = false;
		line = entry[3] ?? "";
		for (let j = 0; j < line.length; j++) {
			const c = line[j];
			if (c === "\\") {
				if (j === line.length - 1 && i + 1 < lines.length) {
					line += "\n" + lines[++i];
					j++;
					continue;
				}
				const escape = line[++j], decoded = {
					n: "\n",
					t: "	",
					b: "\b",
					"\"": "\"",
					"\\": "\\"
				};
				if (escape === void 0 || !Object.hasOwn(decoded, escape)) deny("invalid config escape");
				value += pending + decoded[escape];
				pending = "";
			} else if (c === "\"") {
				value += pending;
				pending = "";
				quoted = !quoted;
			} else if (!quoted && (c === "#" || c === ";")) break;
			else if (!quoted && /[ \t]/.test(c)) {
				if (value) pending += c;
			} else {
				value += pending + c;
				pending = "";
			}
		}
		if (quoted) deny("unterminated config quote");
		const name = `${section}.${key}`;
		const falseValue = !(entry[3] === void 0) && (/^(?:false|no|off|\+?0+[kmg]?)$/i.test(value) || value === "");
		if (section === "filter" && subsection !== void 0 && ["clean", "process"].includes(key) && value) deny(`executable filter config ${name}`);
		if ((section === "include" && subsection === void 0 || section === "includeif" && subsection !== void 0) && key === "path") deny("config includes are outside the observed config boundary");
		if (section === "core" && subsection === void 0 && key === "worktree") deny("core.worktree redirects the observed worktree");
		if (section === "core" && subsection === void 0 && key === "bare" && !falseValue) deny("bare repository unsupported");
		if (section === "core" && subsection === void 0 && key === "repositoryformatversion" && !isGitIntegerZero(value)) deny("unsupported repository format");
		if (section === "extensions" && subsection === void 0 && [
			"worktreeconfig",
			"objectformat",
			"refstorage",
			"partialclone"
		].includes(key)) deny(`unsupported repository layout ${name}`);
		if (section === "remote" && subsection !== void 0 && key === "promisor" && !falseValue) deny("partial-clone lazy object source unsupported");
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
		if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) deny("special, hardlinked metadata or oversized file");
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
/** Streamed full-content sha256; ordinary hardlinks are data, metadata aliases are refused. */
async function regularDigest(path, metadata = true) {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = await handle.stat();
		if (!before.isFile() || metadata && before.nlink !== 1) deny("special or hardlinked metadata");
		const hash = createHash("sha256"), chunk = Buffer.alloc(Math.min(1024 * 1024, before.size + 1));
		let offset = 0;
		while (offset <= before.size) {
			const read = await handle.read(chunk, 0, Math.min(chunk.length, before.size + 1 - offset), offset);
			if (!read.bytesRead) break;
			hash.update(chunk.subarray(0, read.bytesRead));
			offset += read.bytesRead;
		}
		const after = await handle.stat();
		if (offset !== before.size || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) deny("file changed while reading");
		return hash.digest("hex");
	} finally {
		await handle.close();
	}
}
async function canonicalDirectory(path, label) {
	if (!isAbsolute(path)) deny(`${label} must be absolute`);
	await noSymlinkAncestors(path);
	if (await realpath(path) !== path) deny(`${label} must be canonical`);
	const st = await lstat(path);
	if (!st.isDirectory() || st.isSymbolicLink()) deny(`${label} must be a directory`);
	return st;
}
/** One-line pointer file (gitfile/commondir/gitdir backlink); no other content. */
async function pointer(path, prefix) {
	let text;
	try {
		text = new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: true
		}).decode(await regularBytes(path, 4096));
	} catch (error) {
		if (error instanceof TypeError) deny("worktree pointer file is not valid UTF-8");
		throw error;
	}
	const match = new RegExp(`^${prefix}([^\\x00-\\x1f]+)\\n?$`).exec(text);
	if (!match) deny("malformed worktree pointer file");
	return match[1];
}
/** Validate the exact worktree layout before any Git runs. No filesystem writes. */
async function resolveLayout(root) {
	const dotPath = join(root, ".git"), dot = await lstat(dotPath);
	if (dot.isDirectory() && !dot.isSymbolicLink()) return {
		layout: {
			kind: "main",
			worktreeRoot: root,
			gitDir: dotPath,
			commonDir: dotPath
		},
		dot,
		gitStat: dot,
		commonStat: dot
	};
	if (!dot.isFile() || dot.isSymbolicLink() || dot.nlink !== 1) deny("ordinary .git directory or linked-worktree gitfile required; no submodules/bare repos");
	const gitDir = await pointer(dotPath, "gitdir: ");
	if (!isAbsolute(gitDir) || resolve(gitDir) !== gitDir) deny("linked worktree gitfile must name a canonical absolute gitdir");
	const gitStat = await canonicalDirectory(gitDir, "linked gitdir");
	const rawCommon = await pointer(join(gitDir, "commondir"), "");
	if (rawCommon !== "../.." && (!isAbsolute(rawCommon) || resolve(rawCommon) !== rawCommon)) deny("commondir must be Git default ../.. or a canonical absolute path");
	const commonDir = rawCommon === "../.." ? dirname(dirname(gitDir)) : rawCommon;
	const commonStat = await canonicalDirectory(commonDir, "common git directory");
	if (dirname(gitDir) !== join(commonDir, "worktrees")) deny("linked gitdir is not registered under commondir/worktrees");
	if (await pointer(join(gitDir, "gitdir"), "") !== dotPath) deny("linked worktree backlink does not name this worktree");
	if (inside(root, commonDir) || inside(commonDir, root)) deny("nested worktree/common directory layout unsupported");
	if (basename(commonDir) !== ".git") deny("common directory must be a non-bare .git directory");
	return {
		layout: {
			kind: "linked",
			worktreeRoot: root,
			gitDir,
			commonDir
		},
		dot,
		gitStat,
		commonStat,
		gitfile: gitDir
	};
}
/** Layout-only queue identity: never scan the worktree or object store. */
async function repositoryLayout(workspaceRoot, repo) {
	await noSymlinkAncestors(workspaceRoot);
	if (await realpath(workspaceRoot) !== workspaceRoot) deny("workspace must be canonical");
	const root = resolve(workspaceRoot, repo);
	if (!inside(workspaceRoot, root)) deny("repository outside workspace");
	await noSymlinkAncestors(root);
	if (await realpath(root) !== root) deny("repository path must be canonical");
	const rootStat = await lstat(root);
	if (!rootStat.isDirectory()) deny("repository root must be a directory");
	const resolved = await resolveLayout(root);
	const { layout, gitStat, commonStat } = resolved;
	const ids = [
		rootStat.dev,
		rootStat.ino,
		gitStat.dev,
		gitStat.ino,
		commonStat.dev,
		commonStat.ino
	];
	return {
		root,
		...resolved,
		identity: JSON.stringify([
			layout.kind,
			root,
			layout.gitDir,
			layout.commonDir,
			...ids
		]),
		lockKey: JSON.stringify([commonStat.dev, commonStat.ino])
	};
}
async function optionalStat(path) {
	try {
		return await lstat(path);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		return;
	}
}
/** Read only HEAD's actual ref chain and index; never enumerate refs or objects. */
async function headRecords(layout) {
	const records = [];
	let path = join(layout.gitDir, "HEAD");
	const seen = /* @__PURE__ */ new Set();
	while (true) {
		if (seen.has(path)) deny("cyclic HEAD reference");
		seen.add(path);
		await noSymlinkAncestors(dirname(path));
		const bytes = await optionalStat(path) ? await regularBytes(path, Number.MAX_SAFE_INTEGER) : null;
		records.push([path, bytes ? digest(bytes) : null]);
		const text = bytes ? new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim() : void 0;
		if (!text?.startsWith("ref: ")) break;
		const ref = text.slice(5);
		if (!ref.startsWith("refs/") || /[\x00-\x1f\x7f]/.test(ref) || ref.split("/").some((p) => !p || p === "." || p === "..")) deny("unsafe HEAD reference");
		path = join(layout.commonDir, ref);
	}
	return records;
}
async function repositoryReadState(layout) {
	const records = await headRecords(layout);
	const packed = join(layout.commonDir, "packed-refs");
	records.push(["packed-refs", await optionalStat(packed) ? digest(await regularBytes(packed, Number.MAX_SAFE_INTEGER)) : null]);
	const index = join(layout.gitDir, "index");
	records.push(["index", await optionalStat(index) ? await regularDigest(index) : null]);
	return digest(JSON.stringify(records));
}
/** Lightweight startup/final-tail guard, not a content observation or cache. */
async function repositoryMetadataStamp(workspaceRoot, repo) {
	const { root, layout, identity } = await repositoryLayout(workspaceRoot, repo);
	const paths = [
		layout.gitDir,
		layout.commonDir,
		join(layout.commonDir, "info"),
		join(layout.commonDir, "objects/info"),
		join(layout.commonDir, "objects/pack"),
		join(layout.commonDir, "config"),
		join(layout.gitDir, "index"),
		join(layout.gitDir, "HEAD"),
		join(layout.commonDir, "packed-refs"),
		join(layout.commonDir, "info/attributes"),
		join(root, ".gitattributes")
	];
	if (layout.kind === "linked") paths.push(join(root, ".git"), join(layout.gitDir, "commondir"), join(layout.gitDir, "gitdir"));
	const records = [identity, await headRecords(layout)];
	for (const path of paths) {
		const st = await optionalStat(path);
		records.push([path, st ? [
			st.dev,
			st.ino,
			st.mode,
			st.nlink,
			st.size,
			st.mtimeMs,
			st.ctimeMs
		] : null]);
	}
	return JSON.stringify(records);
}
/** Exact worktree leaves, including raw symlink bytes; status may tag directory boundaries, never recurse. */
async function observeTargets(root, paths, statusBoundaries = false) {
	const files = /* @__PURE__ */ new Map(), fileKinds = /* @__PURE__ */ new Map(), attrs = [];
	const directories = /* @__PURE__ */ new Set([root]);
	for (const rel of paths) {
		literalPath(rel);
		const path = join(root, rel);
		try {
			await noSymlinkAncestors(dirname(path));
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		const st = await optionalStat(path);
		if (st?.isSymbolicLink()) {
			const link = await readlink(path, { encoding: "buffer" }), after = await lstat(path);
			if (st.dev !== after.dev || st.ino !== after.ino || st.mtimeMs !== after.mtimeMs || st.ctimeMs !== after.ctimeMs) deny("symlink changed while observing");
			files.set(rel, digest(link));
			fileKinds.set(rel, {
				mode: st.mode,
				linkTextBase64: link.toString("base64")
			});
		} else if (st?.isFile()) {
			files.set(rel, await regularDigest(path, false));
			fileKinds.set(rel, { mode: st.mode });
		} else if (st?.isDirectory() && statusBoundaries) files.set(rel, "directory-boundary");
		else if (st) deny("target must be an exact regular file, symlink or tracked deletion");
		else files.set(rel, "missing");
		let dir = dirname(path);
		while (inside(root, dir)) {
			directories.add(dir);
			if (dir === root) break;
			dir = dirname(dir);
		}
	}
	for (const dir of [...directories].sort()) {
		const path = join(dir, ".gitattributes"), st = await optionalStat(path);
		if (st?.isSymbolicLink()) attrs.push([path, "symlink-not-followed"]);
		else attrs.push([path, st ? await regularDigest(path, false) : null]);
	}
	return {
		files,
		fileKinds,
		attributesDigest: digest(JSON.stringify(attrs))
	};
}
async function observeRepository(workspaceRoot, repo) {
	const { root, layout, identity, lockKey } = await repositoryLayout(workspaceRoot, repo);
	const initialStamp = await repositoryMetadataStamp(workspaceRoot, repo);
	const records = [["layout", identity]], locks = [];
	let config = "", indexDigest = null;
	const metadata = async (path) => {
		await noSymlinkAncestors(dirname(path));
		const st = await optionalStat(path);
		if (!st) {
			records.push([path, null]);
			return;
		}
		const bytes = await regularBytes(path, Number.MAX_SAFE_INTEGER);
		records.push([
			path,
			st.dev,
			st.ino,
			st.mode,
			st.size,
			st.mtimeMs,
			st.ctimeMs,
			digest(bytes)
		]);
		return bytes;
	};
	for (const dir of /* @__PURE__ */ new Set([
		layout.gitDir,
		layout.commonDir,
		join(layout.commonDir, "objects/info"),
		join(layout.commonDir, "objects/pack"),
		join(layout.commonDir, "info")
	])) {
		const st = await optionalStat(dir);
		if (!st) continue;
		if (!st.isDirectory() || st.isSymbolicLink()) deny("special metadata directory");
		await noSymlinkAncestors(dir);
		for (const name of await readdir(dir)) {
			const lower = name.toLowerCase();
			if ((dir === layout.gitDir || dir === layout.commonDir) && (lower === "config.worktree" || lower.startsWith("sharedindex.") || layout.kind === "main" && ["commondir", "gitdir"].includes(lower))) deny(`unsupported repository metadata ${name}`);
			if (dir === join(layout.commonDir, "objects/info") && ["alternates", "http-alternates"].includes(lower) || dir === join(layout.commonDir, "objects/pack") && lower.endsWith(".promisor") || dir === join(layout.commonDir, "info") && lower === "grafts") deny(`unsupported repository metadata ${name}`);
			if ((dir === layout.gitDir || dir === layout.commonDir) && lower.endsWith(".lock")) locks.push(join(dir, name));
			if ((dir === layout.gitDir || dir === layout.commonDir) && [
				"config",
				"index",
				"head"
			].includes(lower) && name !== (lower === "head" ? "HEAD" : lower)) deny("noncanonical reserved metadata alias");
		}
	}
	config = (await metadata(join(layout.commonDir, "config")))?.toString("utf8") ?? "";
	if (!config) deny("local config required");
	validateLocalConfig(config);
	indexDigest = await optionalStat(join(layout.gitDir, "index")) ? await regularDigest(join(layout.gitDir, "index")) : null;
	const readState = await repositoryReadState(layout);
	records.push(["readState", readState]);
	if (layout.kind === "linked") for (const path of [
		join(root, ".git"),
		join(layout.gitDir, "commondir"),
		join(layout.gitDir, "gitdir")
	]) await metadata(path);
	const attributes = await metadata(join(layout.commonDir, "info/attributes"));
	const rootAttributes = join(root, ".gitattributes"), attrStat = await optionalStat(rootAttributes);
	if (attrStat?.isSymbolicLink()) records.push(["root-attributes", "symlink-not-followed"]);
	else records.push(["root-attributes", attrStat ? await regularDigest(rootAttributes, false) : null]);
	const headText = (await regularBytes(join(layout.gitDir, "HEAD"), Number.MAX_SAFE_INTEGER)).toString("utf8").trim();
	if (headText.startsWith("ref: ")) {
		const lock = join(layout.commonDir, `${headText.slice(5)}.lock`);
		if (await optionalStat(lock)) locks.push(lock);
	}
	records.push(["locks", locks.sort()]);
	const again = await repositoryLayout(workspaceRoot, repo);
	if (again.identity !== identity || JSON.stringify(again.layout) !== JSON.stringify(layout)) deny("worktree layout changed while observing");
	const metadataStamp = await repositoryMetadataStamp(workspaceRoot, repo);
	if (metadataStamp !== initialStamp) deny("metadata changed while observing");
	return {
		root,
		layout,
		identity,
		lockKey,
		digest: digest(JSON.stringify(records)),
		configDigest: digest(config),
		attributesDigest: digest(attributes ?? ""),
		indexDigest,
		files: /* @__PURE__ */ new Map(),
		fileKinds: /* @__PURE__ */ new Map(),
		locks,
		metadataStamp
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
const DISPLAY_BYTES = 128 * 1024;
const INTERNAL_BYTES = 16 * 1024 * 1024;
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
				const queuedState = await repositoryLayout(deps.workspaceRoot, r.repo);
				return await serial(queuedState.lockKey, async () => {
					signal.throwIfAborted();
					const initialPolicy = policy(false), executable = await executableIdentity();
					const state = await observeRepository(deps.workspaceRoot, r.repo);
					if (state.identity !== queuedState.identity) deny("repository identity changed while queued");
					const layoutPaths = [state.layout.gitDir, state.layout.commonDir];
					const hostPaths = async () => {
						if (layoutPaths.every((path) => inside(deps.workspaceRoot, path))) return;
						if (!deps.verifyHostPaths) deny("host-shared mapping for external git directory unavailable");
						await deps.verifyHostPaths(layoutPaths, signal);
					};
					await hostPaths();
					const writableRoots = inside(deps.workspaceRoot, state.layout.commonDir) ? void 0 : [state.layout.commonDir];
					const initialReadState = await repositoryReadState(state.layout);
					let readStamp = state.metadataStamp;
					let targets;
					const targetPaths = r.action === "stage" ? r.paths : [];
					const sameTargets = (a, b) => !!a && !!b && a.attributesDigest === b.attributesDigest && JSON.stringify([...a.files]) === JSON.stringify([...b.files]) && JSON.stringify([...a.fileKinds]) === JSON.stringify([...b.fileKinds]);
					const check = async (write = false) => {
						signal.throwIfAborted();
						if (await executableIdentity() !== executable) deny("executable changed");
						if (write) {
							await hostPaths();
							const current = await observeRepository(deps.workspaceRoot, r.repo);
							if (current.identity !== state.identity || current.digest !== state.digest) deny("repository changed; observe again");
							if (current.locks.length) deny("Git locks present");
							if (r.action === "stage" && !sameTargets(targets, await observeTargets(state.root, targetPaths))) deny("stage targets or attributes changed");
							if (await repositoryMetadataStamp(deps.workspaceRoot, r.repo) !== current.metadataStamp) deny("metadata changed at final write boundary");
						} else if (await repositoryReadState(state.layout) !== initialReadState) deny("HEAD/index changed; observe again");
						if (policy(write) !== initialPolicy) deny("policy changed");
						signal.throwIfAborted();
					};
					const run = async (args, write = false, outputMaxBytes = DISPLAY_BYTES) => {
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
								...write && writableRoots ? { additionalWritableRoots: writableRoots } : {},
								timeoutMs: 3e4,
								outputMaxBytes,
								beforeSpawn: write ? () => check(true) : async () => {
									if (await repositoryMetadataStamp(deps.workspaceRoot, r.repo) !== readStamp) deny("metadata changed before Git read");
									signal.throwIfAborted();
									if (policy(false) !== initialPolicy) deny("policy changed");
								}
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
					const read = async (args, allowed = [0], outputMaxBytes = DISPLAY_BYTES, preview = false) => {
						const result = await run(args, false, outputMaxBytes);
						if (!preview && (result.stdout.truncated || result.stderr.truncated)) deny(`complete Git output exceeds ${outputMaxBytes}-byte ${outputMaxBytes === DISPLAY_BYTES ? "display" : "internal index/approval"} budget; no snapshot/approval from truncated content`);
						if (result.aborted || result.timedOut || result.cleanup !== "completed" || result.failureDetail || !allowed.includes(result.exitCode ?? -1)) deny(`read failed: ${JSON.stringify(result)}`);
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
					], [0], INTERNAL_BYTES)).stdout.text.split("\0").filter(Boolean).map((line) => {
						const match = /^(100644|100755|120000|160000) ([a-f0-9]{40}) 0\t(.+)$/.exec(line);
						if (!match) deny("conflicted or unsupported index entry");
						return {
							mode: match[1],
							oid: match[2],
							path: literalPath(match[3])
						};
					});
					const validatePaths = async (paths, staging = true) => {
						for (const path of paths) {
							if (index.some((e) => e.mode === "160000" && (e.path === path || path.startsWith(`${e.path}/`)))) {
								if (staging) deny(`staging submodule HEAD/content is unsupported without observing its separate metadata: ${path}`);
								continue;
							}
							try {
								await noSymlinkAncestors(dirname(join(state.root, path)));
							} catch (error) {
								if (error.code !== "ENOENT") throw error;
							}
							if (!state.fileKinds.has(path)) {
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
					if (r.action === "stage" || r.action === "diff" && r.paths) {
						targets = await observeTargets(state.root, r.action === "stage" ? r.paths : r.paths.filter((path) => !index.some((e) => e.mode === "160000" && e.path === path)));
						state.files = targets.files;
						state.fileKinds = targets.fileKinds;
					}
					if (r.action === "status") {
						const result = await read([
							"status",
							"--porcelain=v1",
							"-z",
							"--untracked-files=all",
							"--ignore-submodules=all"
						]);
						const stagedGitlinks = head !== null || index.some((e) => e.mode === "160000") ? (await read([
							"diff",
							"--cached",
							"--raw",
							"--no-abbrev",
							"--no-ext-diff",
							"--no-textconv",
							"--ignore-submodules=none",
							"--"
						], [0], INTERNAL_BYTES)).stdout.text.split("\n").filter((line) => /^:(?:160000 |[0-9]{6} 160000 )/.test(line)).join("\n") : "";
						await check();
						const fields = result.stdout.text.split("\0"), paths = [];
						for (let i = 0; i < fields.length; i++) {
							const field = fields[i];
							if (!field) continue;
							const path = literalPath(field.slice(3));
							if (!index.some((e) => e.mode === "160000" && (e.path === path || path.startsWith(`${e.path}/`)))) paths.push(path);
							if (/^[RC]|^.[RC]/.test(field.slice(0, 2))) i++;
						}
						const changed = await observeTargets(state.root, paths, true);
						state.files = changed.files;
						state.fileKinds = changed.fileKinds;
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
							...stagedGitlinks ? { stagedGitlinks } : {},
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
						await check();
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
							r.target === "staged" ? "--ignore-submodules=none" : "--ignore-submodules=all",
							"--submodule=short",
							"--",
							...r.paths ?? []
						], [0], DISPLAY_BYTES, true);
						await check();
						return {
							status: "succeeded",
							action: r.action,
							stdout: result.stdout.text,
							stderr: result.stderr.text,
							stdoutTruncated: result.stdout.truncated,
							stderrTruncated: result.stderr.truncated,
							...result.stdout.truncated || result.stderr.truncated ? { message: "Truncated preview only; not complete summary or approval material." } : {}
						};
					}
					const snap = deps.handoff ? deps.handoff.take(r.expectedSnapshot) : snapshots.get(r.expectedSnapshot);
					snapshots.delete(r.expectedSnapshot);
					const policyMatches = deps.handoff ? snap?.workspaceRoot === deps.workspaceRoot : snap?.policy === initialPolicy;
					if (!snap || expired(snap) || snap.owner !== (deps.handoff?.owner ?? owner) || snap.state.identity !== state.identity || snap.state.digest !== state.digest || snap.head !== head || !policyMatches) deny("expectedSnapshot missing, expired, foreign or changed");
					if (r.action === "stage") for (const path of r.paths) {
						if (!snap.state.files.has(path)) deny(`stage target not observed by status; fresh status required: ${path}`);
						if (snap.state.files.get(path) !== state.files.get(path) || JSON.stringify(snap.state.fileKinds.get(path)) !== JSON.stringify(state.fileKinds.get(path))) deny("stage target changed since status");
					}
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
							"--ignore-submodules=none",
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
							"--ignore-submodules=none",
							"--submodule=short",
							"--"
						], [0], INTERNAL_BYTES)).stdout.text;
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
						layout: state.layout,
						...writableRoots ? { additionalWritableRoots: writableRoots } : {},
						identity: state.identity,
						head,
						indexDigest: state.indexDigest,
						treeDigest: state.digest,
						configDigest: state.configDigest,
						attributesDigest: r.action === "stage" ? digest(JSON.stringify([state.attributesDigest, targets.attributesDigest])) : state.attributesDigest,
						argv,
						owner,
						policy: initialPolicy,
						...r.action === "stage" ? { targets: r.paths.map((path) => ({
							path,
							digest: state.files.get(path) === "missing" ? null : state.files.get(path) ?? null,
							...state.fileKinds.get(path) ?? {}
						})) } : {
							entireIndex: index,
							indexPatch
						}
					};
					const reason = `Local Git exact one-shot write; no remote operation. Commit covers the ENTIRE actual index.${writableRoots ? ` Also grants this one call write access to the linked worktree's shared Git directory ${writableRoots[0]} (outside the workspace).` : ""}\n${JSON.stringify(plan)}`;
					await check();
					const confinement = await deps.sandbox.confine(argv, {
						mode: "workspace-write",
						workspaceRoot: deps.workspaceRoot,
						sessionId: deps.sessionId,
						...writableRoots ? { additionalWritableRoots: [...writableRoots] } : {}
					}, signal);
					if (confinement.enforcement !== "full" || !confinement.argv.length) deny("full write confinement unavailable");
					if (!deps.approval || typeof deps.approval.request !== "function") deny("approval service unavailable");
					if (expired(snap)) deny("expectedSnapshot expired before approval");
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
					const result = await run(args, true);
					if (result.aborted || result.timedOut || result.cleanup !== "completed" || !!result.failureDetail || result.exitCode !== 0) return {
						status: "effect-unknown",
						action: r.action,
						exitCode: result.exitCode,
						stdout: result.stdout.text,
						stderr: result.stderr.text,
						stdoutTruncated: result.stdout.truncated,
						stderrTruncated: result.stderr.truncated,
						message: "Write may have taken effect. Observe status before any new decision; never automatically retry."
					};
					try {
						const after = await observeRepository(deps.workspaceRoot, r.repo);
						if (after.identity !== state.identity || after.configDigest !== state.configDigest || policy(true) !== initialPolicy) deny("post-write context changed");
						readStamp = after.metadataStamp;
						const afterResult = await run([
							"rev-parse",
							"--verify",
							"--quiet",
							"HEAD"
						]);
						const afterHead = afterResult.exitCode === 1 ? null : afterResult.stdout.text.trim();
						if (![0, 1].includes(afterResult.exitCode ?? -1) || afterResult.stdout.truncated || afterResult.stderr.truncated || afterResult.aborted || afterResult.timedOut || afterResult.cleanup !== "completed" || afterResult.failureDetail || afterHead !== null && !/^[a-f0-9]{40}$/.test(afterHead)) deny("post-write HEAD unavailable");
						return {
							status: "succeeded",
							action: r.action,
							exitCode: result.exitCode,
							stdout: result.stdout.text,
							stderr: result.stderr.text,
							stdoutTruncated: result.stdout.truncated,
							stderrTruncated: result.stderr.truncated,
							beforeHead: head,
							afterHead,
							indexDigest: after.indexDigest,
							actualScope: r.action === "stage" ? r.paths : index.map((e) => e.path)
						};
					} catch (error) {
						return {
							status: "effect-unknown",
							action: r.action,
							message: `Write completed but post-write facts unavailable: ${error instanceof Error ? error.message : String(error)}. Observe before any new decision; never automatically retry.`
						};
					}
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
Object.freeze([
	"read-only",
	"workspace-write",
	"danger-full-access"
]);
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
Object.freeze([
	"subagent",
	"subagent_fork",
	"workflow",
	"send_message",
	"interrupt_agent",
	"team_task_create",
	"team_task_update"
]);
const VERSION_CONTROL_TOOLS = Object.freeze([
	"satellite_version_control",
	"skill",
	"ask_user_question",
	"read"
]);
const VERSION_CONTROL_TOOL_FILTER = Object.freeze({ allow: VERSION_CONTROL_TOOLS });
const BASE_CONFIG = Object.freeze({
	provider: "spawn",
	skills: Object.freeze([
		"satellite-base-flow",
		"satellite-validation",
		"satellite-change-review",
		"satellite-investigation",
		"satellite-solution",
		"satellite-acceptance",
		"satellite-implementation",
		"satellite-version-control"
	]),
	nodes: Object.freeze({
		context: Object.freeze({ role: "investigation" }),
		solution: Object.freeze({ role: "solution-design" }),
		implement: Object.freeze({ role: "implementation" }),
		validate: Object.freeze({ role: "validation" }),
		review: Object.freeze({ role: "change-review" }),
		signoff: Object.freeze({ role: "acceptance" }),
		"version-control": Object.freeze({ role: "version-control" })
	}),
	roles: Object.freeze({
		investigation: Object.freeze({
			label: "有界调查",
			skill: "satellite-investigation",
			objective: "先写下本次调查的文件/命令范围与停止条件，再定向读取决定性的来源；优先精确文件与已确认子目录，全库或粗范围递归搜索先证明必要性、较窄替代与预期证据，无法证明就收窄或暂停；产出事实与状态所有者、可复用候选、对直接影响面的影响与仍未解缺口；只读，不改文件。",
			persona: "区分读到的事实与自己的推断，事实附上确切位置；缺口如实保留为缺口，不用猜测补齐；只读不等于隐私安全，不越出任务关联范围，也不经 ../、绝对路径、symlink、脚本或委派绕过访问限制。",
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
			objective: "把有界事实转成可评审的选项，逐条列出需要谁做什么决定；默认承担常规求解与完整影响检查，不实施、不扩大目标，提交方案后停下等待决定。",
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
			objective: "只改已同意的基线，一次一个单元：动手前用一小段写明改什么、范围与不在范围内、验证方式，以及仍缺的决定（缺决定就停在这里）；默认承担常规求解与完整影响检查，改动取满足单元的最小面，复用既有约定，不顺手重构、不扩大目标、不提交不发布；完成后跑该范围需要的编译/类型检查并如实报告（完整验证归 validate）。",
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
			objective: "先锁定当前差异与其消费者并按停止条件读取，独立审查实际改动与相关源码，给出结论与限制，不以审查名义扩大无关搜索；全库或粗范围递归搜索先证明必要性、较窄替代与预期证据；默认承担常规审查与完整影响检查，不修改任何文件，不自动修复，不提交。",
			persona: "只依据实际差异与相关源码下结论；区分已证实的问题与未验证的怀疑，读不到的内容明确报告为未验证；不以审查名义扩大搜索，也不经 ../、绝对路径、symlink、脚本或委派绕过访问限制。",
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
		"version-control": Object.freeze({
			label: "显式本地版本管理",
			skill: "satellite-version-control",
			objective: "明确 commit 请求默认在本节点内总结内容并提交，最多核对请求/摘要/完整实际 index 一致；不主动启动其它节点、测试/build/质量审查/验收，不逐文件 diff 或全树重复调查。范围不明才问，成功短报 message/hash/scope 即停。无默认提交或远程操作；写入须真实宿主逐次批准。",
			persona: "facts 不是授权；不得通过脚本、委派或其它执行入口绕过限制。批准拒绝或缺服务时报告阻塞，不自动重试写。",
			toolFilter: VERSION_CONTROL_TOOL_FILTER,
			sandbox: "workspace-write",
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
/**
* 档位变体只复制基础角色既有的方法默认值与权限（toolFilter/sandbox），不构造权限阶梯。
* 复制 `agentOptions` 是为了让每个新角色拥有自己的代码默认路由；运行时仍按角色名
* 精确匹配用户 `routes`，不会继承用户对基础角色的覆盖，也不按模型名推断强弱。
*/
function tierVariant(base, label, objective) {
	return Object.freeze({
		...base,
		label,
		objective
	});
}
const solutionDesign = BASE_CONFIG.roles["solution-design"];
const implementation = BASE_CONFIG.roles.implementation;
const changeReview = BASE_CONFIG.roles["change-review"];
const DEFAULT_CONFIG = Object.freeze({
	...BASE_CONFIG,
	nodes: Object.freeze({
		...BASE_CONFIG.nodes,
		solution: Object.freeze({
			role: "solution-design",
			tierRoles: Object.freeze({
				light: "solution-design-light",
				standard: "solution-design",
				senior: "solution-design-senior",
				critical: "solution-design-critical"
			})
		}),
		implement: Object.freeze({
			role: "implementation",
			tierRoles: Object.freeze({
				light: "implementation-light",
				standard: "implementation",
				senior: "implementation-senior",
				critical: "implementation-critical"
			})
		}),
		review: Object.freeze({
			role: "change-review",
			tierRoles: Object.freeze({
				light: "change-review-light",
				standard: "change-review",
				senior: "change-review-senior",
				critical: "change-review-critical"
			})
		})
	}),
	roles: Object.freeze({
		...BASE_CONFIG.roles,
		"solution-design-light": tierVariant(solutionDesign, "局部清晰方案", `${solutionDesign.objective} 该档只处理边界清楚、局部低歧义、易回退的方案问题：写明局部事实与未检查影响，保留实际必要的安全检查；超出范围时停止交回，不把局部方案当整体结论。`),
		"solution-design-senior": tierVariant(solutionDesign, "跨模块方案", `${solutionDesign.objective} 该档处理跨模块耦合、复杂约束或已有失败证据的方案问题：先核对旧证据，不重复已被否定的假设；仍无法收敛时报告缺口并交回父流程选择 critical、专项或用户方向。`),
		"solution-design-critical": tierVariant(solutionDesign, "疑难方案复核", `${solutionDesign.objective} 该档重新检验问题的核心假设并构造反例，深入解决顽固问题；不与高风险自动绑定，也不要求每项决定都不可逆；证据充分时可给出通过的方案结论，无解时停止并报告缺口、请求决定。`),
		"implementation-light": tierVariant(implementation, "局部低歧义实施", `${implementation.objective} 该档只承担边界清楚、局部低歧义、易回退的单元：明确局部影响，保留实际必要的安全检查；超出范围或出现未解风险时停止并交回，不降低任务整体审查要求。`),
		"implementation-senior": tierVariant(implementation, "复杂边界实施", `${implementation.objective} 该档处理跨模块耦合、复杂约束或已有失败证据的单元：先核对已有失败历史与当前改动，不通过重派清零同档预算、不重复被证据否定的方法；仍无法解决时报告缺口并交回父流程选择 critical、专项或用户方向。`),
		"implementation-critical": tierVariant(implementation, "疑难问题攻坚", `${implementation.objective} 该档重新检验实现的核心假设并构造反例，深入解决顽固问题；不与高风险自动绑定，也不要求每项改动都不可逆；证据充分时可给出通过结论，仍无解时停止并报告缺口、请求决定。`),
		"change-review-light": tierVariant(changeReview, "局部低歧义审查", `${changeReview.objective} 该档只审查局部低歧义、直接消费者明确的改动：明确局部证据与未检查影响，保留实际必要的安全检查；证据超出局部范围或返工后仍未解决时交回常规或更高审查，不把局部结论当整体通过。`),
		"change-review-senior": tierVariant(changeReview, "复杂耦合审查", `${changeReview.objective} 该档审查跨模块耦合、复杂约束或已有失败证据的改动：先核对旧结论与当前差异，不重复已被证据否定的判断；仍无法收敛时报告缺口并交回父流程选择 critical、专项或用户方向。`),
		"change-review-critical": tierVariant(changeReview, "疑难反例审查", `${changeReview.objective} 该档重新检验改动的核心假设并构造反例，深入追查顽固问题；不与高风险自动绑定，也不要求每项改动都不可逆；证据充分时可给出通过结论，仍无法收敛时停止并报告缺口、请求决定。`)
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
//#region src/node/lib/version-control-runtime.ts
/** Trusted execution identity bridge. No model/fact field can mint membership. */
const NAME = "satellite_version_control";
const EFFECT_UNKNOWN = "Write may have taken effect (the call was cancelled after the write entered the process boundary). Observe status before any new decision; never automatically retry.";
const SERVICES = [
	"sandbox",
	"subprocess",
	"approval",
	"sandboxPolicy",
	"workingDirectory",
	"fs"
];
/** Resolve every execution service from ONE agent's own scope; no root fallback. */
function scopeServices(agent, label) {
	const scope = agent.ctx;
	if (!scope || typeof scope.get !== "function") deny(`${label} scope unavailable`);
	const out = {};
	for (const name of SERVICES) {
		const value = scope.get(name);
		if (!value) deny(`${label} scope service unavailable: ${name}`);
		out[name] = value;
	}
	const v = out;
	if (typeof v.sandbox.confine !== "function" || typeof v.subprocess.spawn !== "function" || typeof v.subprocess.terminalEnvironment !== "function" || typeof v.approval.request !== "function" || typeof v.sandboxPolicy.resolve !== "function" || typeof v.workingDirectory.ensure !== "function" || typeof v.fs.processPathFromHostPath !== "function" || typeof v.fs.resolve !== "function" || typeof v.fs.processPath !== "function") deny(`incomplete ${label} scope services`);
	return v;
}
const allowed = new Set(VERSION_CONTROL_TOOLS);
/**
* Cordis 4 `ctx.get` returns a fresh traceable proxy per call, so service
* identity is the proxied target (`symbols.original`), not the proxy.
*/
const serviceTarget = (value) => value && (typeof value === "object" || typeof value === "function") ? value[symbols.original] ?? value : value;
/**
* Auxiliary only: exact live child and parent resolve to the same live subagent
* tree. It never replaces the private direct-parent delegation record.
*/
function sameLiveTree(ctx, agent, parent) {
	const agents = ctx.get("agents");
	const subagents = ctx.get("subagents");
	if (!agents || typeof agents.get !== "function" || !subagents || typeof subagents.rootOf !== "function") return false;
	if (agents.get(agent.id) !== agent || agents.get(parent.id) !== parent) return false;
	try {
		const root = subagents.rootOf(parent);
		return root !== void 0 && subagents.rootOf(agent) === root;
	} catch {
		return false;
	}
}
/** Called by the node runtime, bound to its private creation reservation. */
function createVersionControlBoundary(ctx, defineToolFn) {
	const members = /* @__PURE__ */ new Map();
	const writes = /* @__PURE__ */ new WeakSet();
	let disposed = false;
	const capable = typeof ctx.tools.guard === "function" && typeof ctx.tools.get === "function";
	const tool = defineToolFn({
		name: NAME,
		description: "Explicit optional version-control node only. Five local actions; no remote/flags/history rewrite. Writes require a fresh snapshot and real one-shot host approval.",
		parameters: { request: {
			required: true,
			oneOf: [
				{
					type: "object",
					additionalProperties: false,
					properties: {
						action: {
							type: "string",
							const: "status",
							required: true
						},
						repo: {
							type: "string",
							required: true
						}
					}
				},
				{
					type: "object",
					additionalProperties: false,
					properties: {
						action: {
							type: "string",
							const: "diff",
							required: true
						},
						repo: {
							type: "string",
							required: true
						},
						target: {
							type: "string",
							enum: ["working", "staged"],
							required: true
						},
						paths: {
							type: "array",
							items: { type: "string" }
						}
					}
				},
				{
					type: "object",
					additionalProperties: false,
					properties: {
						action: {
							type: "string",
							const: "log",
							required: true
						},
						repo: {
							type: "string",
							required: true
						},
						count: {
							type: "integer",
							required: true
						}
					}
				},
				{
					type: "object",
					additionalProperties: false,
					properties: {
						action: {
							type: "string",
							const: "stage",
							required: true
						},
						repo: {
							type: "string",
							required: true
						},
						paths: {
							type: "array",
							items: { type: "string" },
							required: true
						},
						expectedSnapshot: {
							type: "string",
							required: true
						}
					}
				},
				{
					type: "object",
					additionalProperties: false,
					properties: {
						action: {
							type: "string",
							const: "commit",
							required: true
						},
						repo: {
							type: "string",
							required: true
						},
						message: {
							type: "string",
							required: true
						},
						expectedSnapshot: {
							type: "string",
							required: true
						}
					}
				}
			]
		} },
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value)
			}]
		},
		finalizeContent(exec, result) {
			if (!result.isError || !writes.has(exec)) return void 0;
			return [...result.content, {
				type: "text",
				text: `effect-unknown: ${EFFECT_UNKNOWN}`
			}];
		},
		async execute(args, exec) {
			try {
				const member = exec.agent && members.get(exec.agent);
				if (!member || !member.active || disposed || !member.delegated()) deny("active version-control execution identity required");
				if (Reflect.ownKeys(args).some((key) => key !== "request")) deny("unknown tool field");
				const request = parseGitRequest(args.request);
				const agent = member.agent;
				const child = scopeServices(agent, "child");
				const boundSession = agent.session;
				const live = () => {
					if (disposed || !member.active || members.get(agent) !== member || agent.session !== boundSession || !member.delegated()) deny("execution identity ended or changed");
				};
				const prepare = async (who, s, label) => {
					const session = who.session;
					const policy = () => {
						live();
						if (who.session !== session) deny(`${label} session changed`);
						for (const name of SERVICES) if (serviceTarget(who.ctx.get(name)) !== serviceTarget(s[name])) deny(`${label} scope service changed: ${name}`);
						const p = s.sandboxPolicy.resolve({ session: who.session });
						if (!p || ![
							"read-only",
							"workspace-write",
							"danger-full-access"
						].includes(p.mode) || p.sessionId !== who.id || !isAbsolute(p.workspaceRoot) || who.session.header.id !== who.id) deny(`${label} session policy unavailable or mismatched`);
						return p;
					};
					const p = policy();
					const cwd = await s.workingDirectory.ensure(who, exec.signal);
					if (!cwd || !isAbsolute(cwd) || !inside(p.workspaceRoot, cwd)) deny(`${label} cwd outside policy workspace`);
					if ((await s.subprocess.terminalEnvironment(exec.signal)).platform !== "posix") deny("host-shared POSIX required");
					const verifyHostPaths = async (paths, signal = exec.signal) => {
						for (const path of paths) if (s.fs.processPathFromHostPath(path) !== path || s.fs.processPath(await s.fs.resolve(path, { signal })) !== path) deny(`host-shared identity mapping unavailable: ${path}`);
						policy();
					};
					await verifyHostPaths([
						p.workspaceRoot,
						cwd,
						"/usr/bin/env",
						"/usr/bin/git"
					]);
					return {
						p,
						cwd,
						adapters: {
							policy,
							verifyHostPaths,
							sandbox: { async confine(argv, requested, signal) {
								policy();
								const confined = await s.sandbox.confine(argv, requested, signal);
								policy();
								return confined;
							} },
							subprocess: {
								resolveExecutable: (...args) => s.subprocess.resolveExecutable(...args),
								terminalEnvironment: (...args) => s.subprocess.terminalEnvironment(...args),
								spawn(spec) {
									policy();
									return s.subprocess.spawn(spec);
								}
							},
							approval: { request: (input) => {
								policy();
								return s.approval.request(input);
							} }
						}
					};
				};
				const { p, cwd, adapters } = await prepare(agent, child, "child");
				const binding = JSON.stringify([
					cwd,
					p.workspaceRoot,
					p.sessionId
				]);
				if (member.binding !== void 0 && member.binding !== binding) deny("child cwd/workspace changed; new execution required");
				member.binding = binding;
				if (!member.kernel) member.kernel = createLocalVersionControl({
					workspaceRoot: p.workspaceRoot,
					sessionId: agent.id,
					agent,
					readOnly: true,
					policy: adapters.policy,
					sandbox: adapters.sandbox,
					subprocess: adapters.subprocess,
					verifyHostPaths: adapters.verifyHostPaths
				});
				const repository = resolve(cwd, request.repo);
				if (!inside(p.workspaceRoot, repository)) deny("repository outside child workspace");
				const repo = relative(p.workspaceRoot, repository) || ".";
				if (request.action !== "stage" && request.action !== "commit") return { ...await member.kernel.execute({
					...request,
					repo
				}, exec.signal, exec.callId) };
				const parent = member.parent, childKernel = member.kernel;
				if (!member.delegated() || !sameLiveTree(ctx, agent, parent)) deny("parent/child delegation unavailable or mismatched");
				const parentPrepared = await prepare(parent, scopeServices(parent, "parent"), "parent");
				if (parentPrepared.p.workspaceRoot !== p.workspaceRoot || parentPrepared.cwd !== cwd) deny("parent and child workspace differ");
				const result = await createLocalVersionControl({
					workspaceRoot: p.workspaceRoot,
					sessionId: parent.id,
					agent: parent,
					policy: parentPrepared.adapters.policy,
					sandbox: parentPrepared.adapters.sandbox,
					subprocess: parentPrepared.adapters.subprocess,
					approval: parentPrepared.adapters.approval,
					verifyHostPaths: parentPrepared.adapters.verifyHostPaths,
					handoff: {
						owner: childKernel.owner,
						take: (token) => childKernel.take(token)
					}
				}).execute({
					...request,
					repo
				}, exec.signal, member.parentCallId);
				if (result.status === "succeeded" || result.status === "effect-unknown") writes.add(exec);
				return { ...result };
			} catch (error) {
				return {
					status: "blocked",
					message: error instanceof Error ? error.message : String(error)
				};
			}
		}
	});
	const removeGlobal = capable ? ctx.tools.guard((exec) => {
		if (exec.name !== NAME) return void 0;
		const member = exec.agent && members.get(exec.agent);
		if (!member || !member.active || disposed || !member.delegated()) return "Satellite: active version-control execution identity required";
		if (ctx.tools.get(NAME, exec.agent) !== tool) return "Satellite: version-control tool shadowed";
	}) : () => {};
	const removeTool = ctx.tools.register(tool);
	return {
		capable,
		bind(agent, parent, parentCallId, delegated) {
			if (!capable || disposed || !agent.ctx || typeof agent.ctx.get !== "function" || typeof agent.ctx.effect !== "function") deny("child scope guard service unavailable");
			const childTools = agent.ctx.get("tools");
			if (!childTools || typeof childTools.guard !== "function" || typeof childTools.get !== "function") deny("child scope guard service unavailable");
			if (!sameLiveTree(ctx, agent, parent)) deny("runtime child tree unavailable or mismatched");
			const definitions = new Map(VERSION_CONTROL_TOOLS.map((name) => [name, ctx.tools.get(name, agent)]));
			if (definitions.get(NAME) !== tool) deny("version-control tool shadowed at creation");
			const member = {
				agent,
				parent,
				...parentCallId !== void 0 ? { parentCallId } : {},
				delegated,
				active: true,
				remove: () => {}
			};
			members.set(agent, member);
			try {
				member.remove = childTools.guard((exec) => {
					if (!member.active || disposed || exec.agent !== agent || !member.delegated()) return "Satellite: version-control descendant/derived or ended scope denied";
					if (exec.parent || !allowed.has(exec.name)) return "Satellite: version-control permits only its fixed direct method tools";
					if (ctx.tools.get(exec.name, agent) !== definitions.get(exec.name)) return "Satellite: version-control method tool shadowed";
				});
			} catch (error) {
				members.delete(agent);
				throw error;
			}
			const release = () => {
				member.active = false;
				members.delete(agent);
				member.kernel = void 0;
				member.remove();
			};
			try {
				agent.ctx.effect(() => release);
			} catch (error) {
				release();
				throw error;
			}
			return release;
		},
		dispose() {
			disposed = true;
			for (const member of members.values()) {
				member.active = false;
				member.kernel = void 0;
				member.remove();
			}
			members.clear();
			removeGlobal();
			removeTool();
		}
	};
}
//#endregion
export { createVersionControlBoundary };
