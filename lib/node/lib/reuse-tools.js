import { defineTool } from "@deepseek-ai/dsh-tools";
import { createHash } from "node:crypto";
//#region src/node/lib/reuse-index.ts
const REUSE_INDEX_PATH = ".satellite-reuse-index.json";
const REUSE_OVERRIDES_PATH = ".satellite-reuse-overrides.json";
const REUSE_LIMITS = Object.freeze({
	paths: 100,
	files: 1e3,
	entries: 4e3,
	fileBytes: 1024 * 1024,
	totalBytes: 16 * 1024 * 1024,
	indexBytes: 4 * 1024 * 1024,
	overrideBytes: 256 * 1024,
	outputBytes: 16 * 1024,
	terms: 20,
	results: 8
});
var ReuseIndexError = class extends Error {
	code;
	constructor(code) {
		super(code);
		this.code = code;
		this.name = "ReuseIndexError";
	}
};
function fail(code) {
	throw new ReuseIndexError(code);
}
const digest = (value) => createHash("sha256").update(value).digest("hex");
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => typeof v === "string" && v.length > 0 && v.length <= 1024 && !v.includes("\0");
const words = (v) => Array.isArray(v) && v.length <= 32 && v.every(text);
const normalize = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_./-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
function relativePath(value) {
	if (!text(value) || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.split("/").some((p) => !p || p === "." || p === "..") || value === ".satellite-reuse-index.json" || value === ".satellite-reuse-overrides.json") return fail("REUSE_PATH_DENIED");
	return value;
}
function validOverride(value) {
	return object(value) && Object.entries(value).every(([key, v]) => {
		if ([
			"aliases",
			"useWhen",
			"doNotUseWhen",
			"notes"
		].includes(key)) return words(v);
		if (key === "owner") return text(v);
		return key === "status" && typeof v === "string" && [
			"preferred",
			"compatible",
			"deprecated",
			"excluded"
		].includes(v);
	});
}
function entryId(path, kind, symbol) {
	return digest(`${path}\0${kind}\0${symbol}`).slice(0, 32);
}
function validDraft(v) {
	return object(v) && text(v.kind) && text(v.symbol) && Number.isSafeInteger(v.line) && Number(v.line) > 0 && (v.aliases === void 0 || words(v.aliases));
}
function parseIndex(raw) {
	const v = JSON.parse(raw);
	if (!object(v) || v.schemaVersion !== 1 || !object(v.project) || !text(v.project.backendId) || !text(v.project.rootKey) || !text(v.sourceRevision) || !text(v.generatedAt) || v.coverage !== "explicit-files" || !Array.isArray(v.files) || v.files.length > REUSE_LIMITS.files || !object(v.agentOverrides)) return fail("REUSE_INVALID_INDEX");
	let count = 0;
	const paths = /* @__PURE__ */ new Set(), ids = /* @__PURE__ */ new Set();
	for (const file of v.files) {
		if (!object(file) || typeof file.path !== "string" || relativePath(file.path) !== file.path || typeof file.digest !== "string" || !/^[a-f0-9]{64}$/.test(file.digest) || !Array.isArray(file.entries) || paths.has(file.path)) return fail("REUSE_INVALID_INDEX");
		paths.add(file.path);
		for (const entry of file.entries) {
			if (!validDraft(entry) || !object(entry) || entry.location !== file.path || !words(entry.aliases) || entry.id !== entryId(file.path, entry.kind, entry.symbol) || ids.has(String(entry.id))) return fail("REUSE_INVALID_INDEX");
			ids.add(String(entry.id));
			count++;
		}
	}
	if (count > REUSE_LIMITS.entries || Object.entries(v.agentOverrides).some(([id, o]) => !ids.has(id) || !validOverride(o))) return fail("REUSE_INVALID_INDEX");
	return v;
}
function checkSignal(signal) {
	signal.throwIfAborted();
}
/** Explicit-file lifecycle, not a scanner registry. Instantiate per host-bound project/call. */
function createReuseIndex(deps) {
	if (!text(deps.backendId) || !text(deps.projectRoot) || deps.sourceRevision !== void 0 && !text(deps.sourceRevision)) fail("REUSE_BINDING_REQUIRED");
	const fs = deps.fs;
	async function bind(signal) {
		checkSignal(signal);
		const root = await fs.resolve(deps.projectRoot, { signal });
		if ((await fs.stat(root, signal))?.type !== "directory") fail("REUSE_ROOT_REQUIRED");
		return {
			root,
			cwd: fs.processPath(root),
			project: {
				backendId: deps.backendId,
				rootKey: root.targetKey
			}
		};
	}
	async function target(root, cwd, path, signal) {
		checkSignal(signal);
		const result = await fs.resolve(path, {
			cwd,
			signal
		});
		if (result.targetKey === root.targetKey || !fs.contains(root, result)) fail("REUSE_PATH_DENIED");
		return result;
	}
	async function readSnapshot(target, max, signal) {
		checkSignal(signal);
		const before = await fs.stat(target, signal);
		if (!before) return void 0;
		if (before.type !== "file") fail("REUSE_NOT_FILE");
		const bytes = await fs.readBytes(target, signal, max);
		const after = await fs.stat(target, signal);
		if (!after || before.version !== after.version) fail("REUSE_SOURCE_CHANGED");
		checkSignal(signal);
		return {
			data: bytes,
			bytes: bytes.length,
			version: after.version
		};
	}
	async function read(target, max, signal) {
		const content = await readSnapshot(target, max, signal);
		return content ? {
			...content,
			raw: new TextDecoder("utf-8", { fatal: true }).decode(content.data)
		} : void 0;
	}
	async function load(binding, signal, recoverInvalid = false) {
		const destination = await target(binding.root, binding.cwd, REUSE_INDEX_PATH, signal);
		const content = await readSnapshot(destination, REUSE_LIMITS.indexBytes, signal);
		if (!content) return {
			destination,
			content,
			index: void 0
		};
		let index;
		try {
			index = parseIndex(new TextDecoder("utf-8", { fatal: true }).decode(content.data));
		} catch (error) {
			if (!recoverInvalid) throw error;
			return {
				destination,
				content,
				index: void 0,
				replacingInvalidBaseline: {
					reason: error instanceof Error ? error.message.slice(0, 256) : "REUSE_INVALID_INDEX",
					version: content.version,
					digest: digest(content.data)
				}
			};
		}
		if (index.project.backendId !== binding.project.backendId || index.project.rootKey !== binding.project.rootKey) fail("REUSE_PROJECT_MISMATCH");
		return {
			destination,
			content,
			index
		};
	}
	async function userOverrides(binding, signal) {
		const content = await read(await target(binding.root, binding.cwd, REUSE_OVERRIDES_PATH, signal), REUSE_LIMITS.overrideBytes, signal);
		if (!content) return Object.create(null);
		const v = JSON.parse(content.raw);
		if (!object(v) || v.schemaVersion !== 1 || !object(v.entries) || Object.keys(v.entries).length > REUSE_LIMITS.entries || Object.entries(v.entries).some(([id, o]) => !/^[a-f0-9]{32}$/.test(id) || !validOverride(o))) fail("REUSE_INVALID_OVERRIDES");
		return v.entries;
	}
	async function query(request, signal) {
		const terms = request.terms ?? [], limit = request.limit ?? REUSE_LIMITS.results;
		if (!Array.isArray(terms) || terms.length > REUSE_LIMITS.terms || !terms.every(text) || !Number.isSafeInteger(limit) || limit < 1 || limit > REUSE_LIMITS.results) fail("REUSE_QUERY_INVALID");
		const result = {
			status: "missing",
			coverage: "explicit-files",
			recognitionStatus: "unverified",
			checkedFiles: 0,
			indexedFiles: 0,
			candidateCount: 0,
			truncated: false,
			matches: []
		};
		const binding = await bind(signal);
		let loaded, overrides;
		try {
			loaded = await load(binding, signal);
			overrides = await userOverrides(binding, signal);
		} catch (error) {
			checkSignal(signal);
			return {
				...result,
				status: "invalid",
				reason: error instanceof Error ? error.message.slice(0, 256) : "REUSE_INVALID_INDEX"
			};
		}
		if (!loaded.index) return result;
		const index = loaded.index;
		result.sourceRevision = index.sourceRevision;
		result.recognitionStatus = deps.sourceRevision === void 0 ? "unverified" : index.sourceRevision === deps.sourceRevision ? "current" : "changed";
		result.status = result.recognitionStatus === "changed" ? "stale" : "available";
		if (result.recognitionStatus === "changed") result.reason = "REUSE_RECOGNITION_VERSION_CHANGED";
		result.indexedFiles = index.files.length;
		const normalized = [...new Set(terms.map(normalize).filter(Boolean))];
		let bytes = 0;
		const matches = [];
		for (const file of index.files) {
			checkSignal(signal);
			let freshness = "stale";
			try {
				if (bytes >= REUSE_LIMITS.totalBytes) fail("REUSE_READ_BUDGET");
				const source = await target(binding.root, binding.cwd, file.path, signal);
				const metadata = await fs.stat(source, signal);
				let allowance = Math.min(REUSE_LIMITS.fileBytes, REUSE_LIMITS.totalBytes - bytes);
				if (metadata?.size !== void 0 && Number.isSafeInteger(metadata.size) && metadata.size >= 0) allowance = Math.min(allowance, metadata.size);
				bytes += allowance;
				const content = await read(source, allowance, signal);
				freshness = !content ? "missing" : digest(content.raw) === file.digest ? "current" : "stale";
				result.checkedFiles++;
			} catch (error) {
				checkSignal(signal);
				result.reason = error instanceof Error ? error.message.slice(0, 256) : "REUSE_SOURCE_UNVERIFIED";
			}
			if (freshness !== "current") result.status = "stale";
			for (const entry of file.entries) {
				const item = {
					...entry,
					...index.agentOverrides[entry.id],
					...overrides[entry.id]
				};
				if (item.status === "excluded") continue;
				result.candidateCount++;
				const primary = [item.symbol, ...item.aliases].map(normalize);
				const secondary = [
					item.location,
					item.kind,
					item.owner ?? "",
					...item.useWhen ?? [],
					...item.notes ?? []
				].map(normalize);
				const score = normalized.reduce((sum, term) => sum + (primary.includes(term) ? 20 : primary.some((p) => p.includes(term)) ? 10 : secondary.some((p) => p.includes(term)) ? 4 : 0), 0);
				if (score > 0) matches.push({
					...item,
					freshness,
					score
				});
			}
		}
		matches.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
		for (const match of matches.slice(0, limit)) {
			if (Buffer.byteLength(JSON.stringify({
				...result,
				matches: [...result.matches, match]
			})) > REUSE_LIMITS.outputBytes) break;
			result.matches.push(match);
		}
		result.truncated = result.matches.length < matches.length;
		return result;
	}
	async function maintain(request, signal) {
		if (![
			"initialize",
			"rebuild",
			"update"
		].includes(request.action) || !Array.isArray(request.paths) || !request.paths.length || request.paths.length > REUSE_LIMITS.paths) fail("REUSE_MAINTENANCE_INVALID");
		const extract = deps.extract, sourceRevision = deps.sourceRevision;
		if (!extract || !sourceRevision) fail("REUSE_EXTRACTOR_UNAVAILABLE");
		const action = request.action;
		const paths = [...new Set(request.paths.map(relativePath))].sort();
		const adjustments = structuredClone(request.adjustments ?? []);
		if (!Array.isArray(adjustments) || adjustments.length > REUSE_LIMITS.paths || adjustments.some((a) => !object(a) || !text(a.entryId) || a.remove !== void 0 && typeof a.remove !== "boolean" || (a.remove === true ? a.value !== void 0 : !validOverride(a.value)))) fail("REUSE_ADJUSTMENT_INVALID");
		const initialPolicy = deps.policy?.();
		if (!initialPolicy || !["workspace-write", "danger-full-access"].includes(initialPolicy.mode)) fail("REUSE_WRITE_DENIED");
		const binding = await bind(signal), loaded = await load(binding, signal, action === "rebuild");
		if (action === "initialize" && loaded.index) fail("REUSE_BASELINE_EXISTS");
		if (action === "update" && !loaded.index) fail("REUSE_BASELINE_REQUIRED");
		if (action === "update" && loaded.index?.sourceRevision !== deps.sourceRevision) fail("REUSE_REBUILD_REQUIRED");
		for (const path of paths) await target(binding.root, binding.cwd, path, signal);
		const plan = Object.freeze({
			action,
			project: Object.freeze({ ...binding.project }),
			root: binding.cwd,
			destination: fs.processPath(loaded.destination),
			paths: Object.freeze([...paths]),
			adjustments: Object.freeze(structuredClone(adjustments)),
			coverage: "explicit-files",
			...loaded.replacingInvalidBaseline ? { replacingInvalidBaseline: Object.freeze({ ...loaded.replacingInvalidBaseline }) } : {}
		});
		if (await deps.approve?.(plan, signal) !== "allowed-once") fail("REUSE_APPROVAL_DENIED");
		checkSignal(signal);
		if ((await bind(signal)).root.targetKey !== binding.root.targetKey) fail("REUSE_PROJECT_CHANGED");
		if ((await target(binding.root, binding.cwd, ".satellite-reuse-index.json", signal)).targetKey !== loaded.destination.targetKey) fail("REUSE_DESTINATION_CHANGED");
		const previous = loaded.index;
		const files = action === "update" ? [...previous.files] : [];
		const permittedIds = new Set(previous?.files.filter((f) => paths.includes(f.path)).flatMap((f) => f.entries.map((e) => e.id)) ?? []);
		const observed = [];
		let bytes = 0;
		for (const path of paths) {
			checkSignal(signal);
			const source = await target(binding.root, binding.cwd, path, signal);
			const content = await read(source, Math.min(REUSE_LIMITS.fileBytes, REUSE_LIMITS.totalBytes - bytes), signal);
			const at = files.findIndex((f) => f.path === path);
			if (at >= 0) files.splice(at, 1);
			observed.push({
				path,
				targetKey: source.targetKey,
				version: content?.version
			});
			if (!content) continue;
			bytes += content.bytes;
			if (bytes > REUSE_LIMITS.totalBytes) fail("REUSE_READ_BUDGET");
			const drafts = extract(path, content.raw);
			if (!Array.isArray(drafts) || drafts.length > REUSE_LIMITS.entries || !drafts.every(validDraft)) fail("REUSE_EXTRACTOR_INVALID");
			const entries = drafts.map((d) => ({
				kind: d.kind,
				symbol: d.symbol,
				line: d.line,
				aliases: [...d.aliases ?? []],
				id: entryId(path, d.kind, d.symbol),
				location: path
			}));
			for (const entry of entries) permittedIds.add(entry.id);
			files.push({
				path,
				digest: digest(content.raw),
				entries
			});
		}
		if (files.length > REUSE_LIMITS.files || files.reduce((n, f) => n + f.entries.length, 0) > REUSE_LIMITS.entries) fail("REUSE_INDEX_BUDGET");
		const ids = new Set(files.flatMap((f) => f.entries.map((e) => e.id)));
		const agentOverrides = Object.fromEntries(Object.entries(previous?.agentOverrides ?? {}).filter(([id]) => ids.has(id)));
		for (const adjustment of adjustments) {
			if (!permittedIds.has(adjustment.entryId)) fail("REUSE_ADJUSTMENT_OUTSIDE_CHANGE");
			if (adjustment.remove) delete agentOverrides[adjustment.entryId];
			else if (ids.has(adjustment.entryId)) agentOverrides[adjustment.entryId] = adjustment.value;
			else fail("REUSE_ADJUSTMENT_ENTRY_MISSING");
		}
		const index = {
			schemaVersion: 1,
			project: binding.project,
			sourceRevision,
			coverage: "explicit-files",
			generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
			files: files.sort((a, b) => a.path.localeCompare(b.path)),
			agentOverrides
		};
		const serialized = JSON.stringify(index);
		if (Buffer.byteLength(serialized) > REUSE_LIMITS.indexBytes) fail("REUSE_INDEX_BUDGET");
		parseIndex(serialized);
		for (const item of observed) {
			const source = await target(binding.root, binding.cwd, item.path, signal);
			if (source.targetKey !== item.targetKey || (await fs.stat(source, signal))?.version !== item.version) fail("REUSE_SOURCE_CHANGED");
		}
		const destination = await target(binding.root, binding.cwd, REUSE_INDEX_PATH, signal);
		if (destination.targetKey !== loaded.destination.targetKey) fail("REUSE_DESTINATION_CHANGED");
		const resolvedPolicy = deps.policy?.();
		const policy = resolvedPolicy ? { ...resolvedPolicy } : void 0;
		if (!policy || !["workspace-write", "danger-full-access"].includes(policy.mode) || !text(policy.workspaceRoot)) fail("REUSE_WRITE_DENIED");
		const writeRoot = await fs.resolve(policy.workspaceRoot, { signal });
		if ((await fs.stat(writeRoot, signal))?.type !== "directory" || !fs.contains(writeRoot, binding.root) || !fs.contains(writeRoot, destination)) fail("REUSE_WRITE_ROOT_DENIED");
		checkSignal(signal);
		const latest = deps.policy?.();
		if (!latest || latest.mode !== policy.mode || latest.workspaceRoot !== policy.workspaceRoot || latest.sessionId !== policy.sessionId) fail("REUSE_POLICY_CHANGED");
		await fs.writeText(destination, serialized, loaded.content ? {
			kind: "replaceIfVersion",
			version: loaded.content.version
		} : { kind: "createIfAbsent" }, signal, latest);
		return {
			status: "updated",
			coverage: "explicit-files",
			changedFiles: paths.length,
			indexedFiles: files.length,
			candidateCount: ids.size,
			destination: fs.processPath(destination)
		};
	}
	return {
		query,
		maintain
	};
}
//#endregion
//#region src/node/lib/reuse-tools.ts
const unavailable = (reason) => ({
	status: "unavailable",
	reason,
	fallback: "Use bounded ordinary search; do not initialize or rebuild implicitly."
});
const json = (value) => JSON.parse(JSON.stringify(value));
const output = {
	schema: {
		type: "object",
		additionalProperties: true,
		properties: {
			status: {
				type: "string",
				required: true
			},
			reason: { type: "string" }
		}
	},
	render: (_args, value) => [{
		type: "text",
		text: JSON.stringify(value)
	}]
};
function serviceContext(ctx, exec) {
	return exec.agent?.ctx ?? ctx;
}
function hasFs(value) {
	if (!value || typeof value !== "object") return false;
	const fs = value;
	return [
		"resolve",
		"processPath",
		"processPathFromHostPath",
		"fileUrl",
		"contains",
		"stat",
		"readBytes",
		"writeText"
	].every((name) => typeof fs[name] === "function");
}
/** No model-selected root/backend id and no assumption that host files exist remotely. */
async function binding(ctx, exec) {
	exec.signal.throwIfAborted();
	const rootPath = exec.agent?.session?.header?.cwd;
	if (typeof rootPath !== "string" || rootPath.length === 0) return unavailable("REUSE_SESSION_ROOT_UNAVAILABLE");
	const services = serviceContext(ctx, exec), fs = services.get("fs");
	if (!hasFs(fs)) return unavailable("REUSE_FILESYSTEM_UNAVAILABLE");
	const mapped = fs.processPathFromHostPath(rootPath);
	if (!mapped) return unavailable("REUSE_HOST_SHARED_MAPPING_UNAVAILABLE");
	const root = await fs.resolve(mapped, { signal: exec.signal });
	if ((await fs.stat(root, exec.signal))?.type !== "directory") return unavailable("REUSE_SESSION_ROOT_UNAVAILABLE");
	const canonical = fs.processPath(root);
	const again = fs.processPathFromHostPath(canonical);
	if (!again) return unavailable("REUSE_HOST_SHARED_MAPPING_UNVERIFIED");
	const mappedAgain = await fs.resolve(again, { signal: exec.signal });
	if (mappedAgain.targetKey !== root.targetKey || fs.fileUrl(mappedAgain) !== fs.fileUrl(root) || !fs.fileUrl(root).startsWith("file:")) return unavailable("REUSE_HOST_SHARED_MAPPING_UNVERIFIED");
	exec.signal.throwIfAborted();
	return {
		fs,
		services,
		projectRoot: canonical,
		backendId: "host-shared-v1"
	};
}
function isUnavailable(value) {
	return !!value && typeof value === "object" && "status" in value;
}
function rejectExtra(args, names) {
	if (Object.keys(args).some((key) => !names.includes(key))) throw new Error("REUSE_UNKNOWN_ARGUMENT");
}
function asExecution(exec) {
	return exec;
}
function registerReuseQuery(ctx) {
	const tool = defineTool({
		name: "satellite_reuse_query",
		description: "Read a bounded set of reuse candidates for this session project. Never scans or writes an index. Missing, invalid or stale evidence requires bounded source search; explicit-file coverage is not a whole-project inventory.",
		parameters: {
			terms: {
				type: "array",
				items: { type: "string" },
				description: "Up to 20 task-specific terms, each at most 1024 characters. Omit to inspect status without matches."
			},
			limit: {
				type: "integer",
				description: "Maximum candidates, 1–8; defaults to 8."
			}
		},
		output,
		isConcurrencySafe: () => true,
		async execute(args, nativeExec) {
			rejectExtra(args, ["terms", "limit"]);
			const exec = asExecution(nativeExec), bound = await binding(ctx, exec);
			if (isUnavailable(bound)) return json(bound);
			const result = await createReuseIndex(bound).query(args, exec.signal);
			return json(result.status === "missing" ? {
				...result,
				fallback: "Use bounded ordinary search; initialization requires an explicit maintenance request and host approval."
			} : result);
		}
	});
	ctx.effect(() => ctx.tools.register(tool));
}
/** Android supplies the sole real recognizer. No recognizer registry or core→Android import. */
function registerReuseMaintenance(ctx, source) {
	const toolName = "satellite_reuse_maintain";
	const tool = defineTool({
		name: toolName,
		description: `Maintain this session project's reuse index after exact host approval. Writes ${REUSE_INDEX_PATH}; reads but never rewrites user overrides ${REUSE_OVERRIDES_PATH}. Only explicit files are covered, not a repository scan.`,
		parameters: {
			action: {
				type: "string",
				enum: [
					"initialize",
					"rebuild",
					"update"
				],
				required: true,
				description: "initialize creates a missing baseline; rebuild replaces the explicit-file baseline; update requires an existing baseline and changes only supplied files."
			},
			paths: {
				type: "array",
				items: { type: "string" },
				required: true,
				description: "1–100 exact project-relative source files (not directories); each at most 1024 characters. Deleted files may be supplied to update. Coverage remains partial."
			},
			adjustments: {
				type: "array",
				description: "Up to 100 semantic adjustments, only for entries belonging to the supplied files. User overrides always win.",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						entryId: {
							type: "string",
							required: true
						},
						remove: {
							type: "boolean",
							description: "Remove the agent override; do not supply value with true."
						},
						value: {
							type: "object",
							additionalProperties: false,
							properties: {
								aliases: {
									type: "array",
									items: { type: "string" }
								},
								useWhen: {
									type: "array",
									items: { type: "string" }
								},
								doNotUseWhen: {
									type: "array",
									items: { type: "string" }
								},
								notes: {
									type: "array",
									items: { type: "string" }
								},
								owner: { type: "string" },
								status: {
									type: "string",
									enum: [
										"preferred",
										"compatible",
										"deprecated",
										"excluded"
									]
								}
							}
						}
					}
				}
			}
		},
		output,
		isConcurrencySafe: () => false,
		async execute(args, nativeExec) {
			rejectExtra(args, [
				"action",
				"paths",
				"adjustments"
			]);
			const exec = asExecution(nativeExec), bound = await binding(ctx, exec);
			if (isUnavailable(bound)) return json(bound);
			const approval = bound.services.get("approval");
			const sandboxPolicy = bound.services.get("sandboxPolicy");
			if (!approval || typeof approval.request !== "function") return json(unavailable("REUSE_APPROVAL_UNAVAILABLE"));
			if (!sandboxPolicy || typeof sandboxPolicy.resolve !== "function") return json(unavailable("REUSE_SANDBOX_POLICY_UNAVAILABLE"));
			const agent = exec.agent;
			const policy = () => sandboxPolicy.resolve({ session: agent.session });
			const initialPolicy = policy();
			if (!initialPolicy || !["workspace-write", "danger-full-access"].includes(initialPolicy.mode)) throw new Error("REUSE_WRITE_DENIED");
			const writeRoot = await bound.fs.resolve(initialPolicy.workspaceRoot, { signal: exec.signal });
			const projectRoot = await bound.fs.resolve(bound.projectRoot, { signal: exec.signal });
			if (!bound.fs.contains(writeRoot, projectRoot)) throw new Error("REUSE_WRITE_ROOT_DENIED");
			const result = await createReuseIndex({
				...bound,
				sourceRevision: source.revision,
				extract: source.extract,
				policy,
				approve: async (plan, signal) => {
					const reason = `Reuse index maintenance (explicit files only):\n${JSON.stringify(plan)}`;
					if (Buffer.byteLength(reason) > 64 * 1024) throw new Error("REUSE_APPROVAL_PLAN_TOO_LARGE");
					signal.throwIfAborted();
					return approval.request({
						agent,
						toolName,
						...exec.callId ? { callId: exec.callId } : {},
						reason,
						signal
					});
				}
			}).maintain(args, exec.signal);
			if (Buffer.byteLength(JSON.stringify(result)) > REUSE_LIMITS.outputBytes) throw new Error("REUSE_OUTPUT_BUDGET");
			return json(result);
		}
	});
	ctx.effect(() => ctx.tools.register(tool));
}
//#endregion
export { registerReuseMaintenance, registerReuseQuery };
