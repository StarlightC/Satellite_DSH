import { isDeepStrictEqual } from "node:util";
//#region src/node/lib/nodes.ts
/**
* 基础节点执行适配：一个节点调用内的 before / base / after 自动边界。
*
* 纯逻辑实现，DSH 相关能力（子 Agent、工具管线、批准）由 `runBase` 注入，
* 因此本模块可以脱离 DSH 单元测试。完整调用记录只服务当前调用的
* 去重复与继续，不保存任务图、全局队列或角色运行历史。
*/
function createCallStore() {
	const records = /* @__PURE__ */ new Map();
	let sequence = 0;
	return Object.freeze({
		begin(input) {
			if (input.resumeToken !== void 0) {
				const existing = records.get(input.resumeToken);
				if (!existing) return { error: `unknown or expired resume token: ${input.resumeToken}` };
				if (existing.nodeId !== input.nodeId) return { error: "resume token belongs to another node" };
				if (existing.caller !== input.caller) return { error: "resume token belongs to another caller" };
				if (existing.unit !== input.unit) return { error: "resume token belongs to another unit" };
				if (existing.claimed) return { error: "this node call is already being resumed" };
				existing.claimed = true;
				return {
					record: existing,
					resumed: true
				};
			}
			sequence += 1;
			const record = {
				token: `satellite-node-${sequence}`,
				nodeId: input.nodeId,
				caller: input.caller,
				unit: input.unit,
				phase: "before",
				beforeDone: false,
				baseStarted: false,
				baseFinished: false,
				baseResult: void 0,
				afterDone: false,
				claimed: true,
				extensions: [],
				verifiedFactNames: /* @__PURE__ */ new Set()
			};
			records.set(record.token, record);
			return {
				record,
				resumed: false
			};
		},
		release(token) {
			const record = records.get(token);
			if (record) record.claimed = false;
		},
		finish(token) {
			records.delete(token);
		},
		get(token) {
			return records.get(token);
		},
		size() {
			return records.size;
		}
	});
}
/**
* 把已核对的事实并入只读事实视图。
*/
function withFacts(facts, additions) {
	if (Object.keys(additions).length === 0) return facts;
	return { values: Object.freeze({
		...facts.values,
		...additions
	}) };
}
/** Keep the same definition objects for the entire call, including resume. */
function definitionsUnchanged(slots, record) {
	const relevant = (entry) => entry.slot === `${record.nodeId}.before` || entry.slot === `${record.nodeId}.after`;
	const current = slots.snapshot().filter(relevant);
	const original = record.definitions ?? [];
	return current.length === original.length && original.every((entry) => current.includes(entry));
}
const EVIDENCE_MAX_DEPTH = 12;
/**
* 深拷贝并递归冻结一个 JSON 兼容值。
*
* 只做浅冻结是不够的：`evidence.base.result.output = 'x'` 会改到记录里的同一个对象，
* 从而污染渲染给父 Agent 的基础结果和后续扩展看到的证据。
* 非 JSON 值（函数、类实例、循环引用）在这里退化为一个明确的占位字符串，
* 不把原对象引用交给扩展。
*/
function deepFreezeValue(value, depth = 0) {
	if (depth > EVIDENCE_MAX_DEPTH) return "[证据深度超限]";
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return Object.freeze(value.map((item) => deepFreezeValue(item, depth + 1)));
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return "[非 JSON 值已省略]";
	const clone = {};
	for (const [key, item] of Object.entries(value)) clone[key] = deepFreezeValue(item, depth + 1);
	return Object.freeze(clone);
}
/**
* 构造扩展可见的只读执行证据。
*
* 深拷贝并递归冻结，扩展拿到的是本次调用当时的独立快照：改写它既不影响
* 记录，也不影响后续扩展与父 Agent 看到的结果。
* `before` 阶段不暴露尚未运行的基础结果。
*/
function executionEvidence(record, slotName) {
	const stage = slotName.endsWith(".after") ? "after" : "before";
	const base = stage === "after" && record.baseFinished ? Object.freeze({
		status: record.baseStatus ?? "failed",
		result: deepFreezeValue(record.baseResult)
	}) : void 0;
	return Object.freeze({
		node: record.nodeId,
		...record.unit !== void 0 ? { unit: record.unit } : {},
		stage,
		...base ? { base } : {},
		previousExtensions: Object.freeze(record.extensions.map((item) => Object.freeze({ ...item })))
	});
}
/** Execute one step, verify, persist, then resolve again. Completed steps never replay. */
async function runSlot(params, record, slotName) {
	const { slots, signal, runExtension, view = {} } = params;
	for (;;) {
		if (signal?.aborted) return { status: "cancelled" };
		if (!definitionsUnchanged(slots, record)) return {
			status: "changed",
			reason: "extension definitions changed; this call cannot mix old and new definitions"
		};
		const completed = new Set(record.extensions.filter((item) => item.status === "completed").map((item) => item.id));
		const pending = (record.definitions ?? []).filter((entry) => !completed.has(entry.id));
		const facts = record.facts ?? { values: {} };
		let resolution;
		try {
			resolution = slots.resolve(slotName, facts, view, pending);
		} catch (error) {
			return {
				status: "changed",
				reason: error instanceof Error ? error.message : String(error)
			};
		}
		if (resolution.kind === "empty") return { status: "completed" };
		if (resolution.kind !== "run" && resolution.kind !== "waiting") return {
			status: "needs_decision",
			resolution
		};
		const priorOwners = (record.definitions ?? []).filter((entry) => entry.slot === slotName && completed.has(entry.id));
		for (const candidate of resolution.steps) for (const name of candidate.extension.provides ?? []) {
			const owner = priorOwners.find((entry) => (entry.provides ?? []).includes(name));
			if (owner) return {
				status: "needs_decision",
				resolution: {
					kind: "conflict",
					considered: resolution.considered,
					conflicts: [{
						kind: "output-ownership",
						ids: [owner.id, candidate.id],
						detail: `completed extension ${owner.id} already owns ${name}`
					}]
				}
			};
		}
		const step = resolution.steps[0];
		if (!step) return {
			status: "failed",
			reason: "resolver returned no executable step"
		};
		const missing = (step.extension.requires ?? []).filter((name) => !Object.hasOwn(facts.values, name));
		if (missing.length) return {
			status: "needs_decision",
			resolution: {
				kind: "gap",
				missing,
				considered: resolution.considered
			}
		};
		if (signal?.aborted) return { status: "cancelled" };
		if (!definitionsUnchanged(slots, record)) return {
			status: "changed",
			reason: "extension definitions changed before execution"
		};
		let outcome;
		try {
			outcome = await runExtension(step.extension, {
				facts,
				slot: slotName,
				evidence: executionEvidence(record, slotName)
			});
			if (!outcome || ![
				"completed",
				"failed",
				"blocked",
				"needs_decision"
			].includes(outcome.status)) outcome = {
				status: "failed",
				error: "extension returned an invalid outcome"
			};
		} catch (error) {
			outcome = {
				status: "failed",
				error: error instanceof Error ? error.message : String(error)
			};
		}
		if (outcome.status === "completed" && outcome.facts) {
			const accepted = {};
			try {
				for (const [name, value] of Object.entries(outcome.facts)) {
					if (name === "base.completed" || name === "base.failed") throw new Error(`reserved runtime fact: ${name}`);
					if (!(step.extension.provides ?? []).includes(name)) continue;
					if (step.extension.verify && step.extension.verify(name, value, facts) !== true) throw new Error(`extension ${step.id} verification rejected fact: ${name}`);
					accepted[name] = value;
				}
				record.facts = withFacts(facts, accepted);
				for (const name of Object.keys(accepted)) record.verifiedFactNames.add(name);
			} catch (error) {
				outcome = {
					...outcome,
					status: "failed",
					error: error instanceof Error ? error.message : String(error)
				};
			}
		}
		record.extensions.push({
			id: step.id,
			slot: slotName,
			status: outcome.status,
			...outcome.note !== void 0 ? { note: outcome.note } : {},
			...outcome.error !== void 0 ? { error: outcome.error } : {}
		});
		if (signal?.aborted) return { status: "cancelled" };
		if (outcome.status === "failed") return {
			status: "failed",
			outcome
		};
		if (outcome.status !== "completed") return {
			status: "needs_decision",
			outcome
		};
	}
}
/** Resume only pending steps; preserve original notes and verified facts at every boundary. */
async function runNode(params) {
	const { slots, store, nodeId, caller, unit, resumeToken, signal, runBase, cleanup } = params;
	const begin = store.begin({
		nodeId,
		caller,
		unit,
		resumeToken
	});
	if (begin.error || !begin.record) return {
		kind: "blocked",
		reason: begin.error ?? "node call rejected"
	};
	const record = begin.record;
	record.definitions ??= slots.snapshot().filter((entry) => entry.slot === `${nodeId}.before` || entry.slot === `${nodeId}.after`);
	const evidence = () => ({
		...record.baseFinished ? { base: record.baseResult } : {},
		...record.selection ? { selection: record.selection } : {},
		facts: record.facts,
		extensions: [...record.extensions],
		beforeRan: [...new Set(record.extensions.filter((item) => item.slot === `${nodeId}.before`).map((item) => item.id))],
		afterRan: [...new Set(record.extensions.filter((item) => item.slot === `${nodeId}.after`).map((item) => item.id))]
	});
	const finish = (kind, reason) => {
		record.phase = "done";
		store.finish(record.token);
		return {
			kind,
			...evidence(),
			...reason ? { reason } : {}
		};
	};
	const cancel = async () => {
		try {
			if (cleanup) await cleanup();
		} finally {
			store.finish(record.token);
		}
		return finish("cancelled");
	};
	const stopped = async (result, stage) => {
		if (result.status === "completed") return void 0;
		if (result.status === "cancelled") return cancel();
		if (result.status === "failed") return finish("failed", result.outcome?.error ?? result.reason ?? "extension failed");
		const resolution = result.resolution;
		return {
			kind: result.status === "changed" ? "blocked" : "suspended",
			token: record.token,
			stage,
			...evidence(),
			reason: result.reason ?? resolution?.kind ?? result.outcome?.status ?? "needs_decision",
			...resolution && "missing" in resolution ? { missing: resolution.missing } : {},
			...resolution && "conflicts" in resolution ? { conflicts: resolution.conflicts } : {},
			...resolution && "blocked" in resolution ? { blocked: resolution.blocked } : {},
			ran: record.extensions.filter((item) => item.slot === `${nodeId}.${stage}`).map((item) => item.id)
		};
	};
	try {
		if (signal?.aborted) return await cancel();
		try {
			if (params.selectRole) record.selection = params.selectRole(record.selection);
		} catch (error) {
			if (!begin.resumed) store.finish(record.token);
			return {
				kind: "blocked",
				...begin.resumed ? { token: record.token } : {},
				...evidence(),
				reason: error instanceof Error ? error.message : String(error)
			};
		}
		for (const [name, value] of Object.entries(params.facts?.values ?? {})) {
			const reserved = name === "base.completed" || name === "base.failed";
			const overwritten = record.verifiedFactNames.has(name) && !isDeepStrictEqual(record.facts?.values[name], value);
			if (reserved || overwritten) {
				if (!begin.resumed) store.finish(record.token);
				return {
					kind: "blocked",
					...begin.resumed ? { token: record.token } : {},
					...evidence(),
					reason: reserved ? `reserved runtime fact cannot be supplied: ${name}` : `verified extension fact cannot be overwritten: ${name}`
				};
			}
		}
		record.facts = withFacts(record.facts ?? { values: {} }, params.facts?.values ?? {});
		if (!definitionsUnchanged(slots, record)) return {
			kind: "blocked",
			token: record.token,
			reason: "extension definitions changed; this call cannot mix old and new definitions",
			...evidence()
		};
		if (!record.beforeDone) {
			record.phase = "before";
			const stop = await stopped(await runSlot(params, record, `${nodeId}.before`), "before");
			if (stop) return stop;
			record.beforeDone = true;
			record.beforeRan = evidence().beforeRan;
		}
		if (signal?.aborted) return await cancel();
		if (!definitionsUnchanged(slots, record)) return {
			kind: "blocked",
			token: record.token,
			reason: "extension definitions changed before base",
			...evidence()
		};
		if (!record.baseFinished) {
			record.baseStarted = true;
			record.phase = "base";
			let base;
			try {
				base = await runBase(record);
			} catch (error) {
				base = {
					status: "failed",
					error: error instanceof Error ? error.message : String(error)
				};
			}
			record.baseFinished = true;
			record.baseStatus = base?.status === "completed" ? "completed" : "failed";
			record.baseResult = base;
		}
		if (signal?.aborted) return await cancel();
		record.facts = withFacts(record.facts ?? { values: {} }, {
			"base.completed": record.baseStatus === "completed",
			"base.failed": record.baseStatus !== "completed"
		});
		record.phase = "after";
		const stop = await stopped(await runSlot(params, record, `${nodeId}.after`), "after");
		if (stop) return stop;
		if (signal?.aborted) return await cancel();
		record.afterDone = true;
		return finish(record.baseStatus === "completed" ? "completed" : "failed");
	} finally {
		if (store.get(record.token)) store.release(record.token);
	}
}
//#endregion
export { createCallStore, runNode };
