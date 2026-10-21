import { Service } from "@deepseek-ai/cordis";
Object.freeze({ kind: "yes" });
Object.freeze({ kind: "no" });
Object.freeze({ ready: true });
function createNodeCatalog() {
	const slots = /* @__PURE__ */ new Map();
	return Object.freeze({
		defineNode(node, options = {}) {
			const version = options.version ?? 1;
			const phases = options.phases ?? ["before", "after"];
			if (!/^[a-z][a-z0-9-]*$/.test(node)) throw new TypeError(`invalid node id: ${node}`);
			if (!Number.isInteger(version) || version < 1) throw new TypeError("version must be a positive integer");
			const added = [];
			for (const phase of phases) {
				if (phase !== "before" && phase !== "after") throw new TypeError(`invalid phase: ${phase}`);
				const name = `${node}.${phase}`;
				if (slots.has(name)) throw new Error(`slot already declared: ${name}`);
				slots.set(name, Object.freeze({
					name,
					node,
					phase,
					version
				}));
				added.push(name);
			}
			return () => {
				for (const name of added) slots.delete(name);
			};
		},
		get(name) {
			return slots.get(name);
		},
		has(name) {
			return slots.has(name);
		},
		list() {
			return Object.freeze([...slots.values()]);
		}
	});
}
/**
* 校验并冻结一个扩展定义。非法定义必须抛错，不接受“先加载者覆盖”。
* 参数按运行时不可信输入处理：调用方可能来自未类型化的 JS 插件。
*/
function validateExtension(extension, catalog) {
	if (!extension || typeof extension !== "object") throw new TypeError("extension must be an object");
	const { id, slot, slotVersion } = extension;
	if (typeof id !== "string" || id.length === 0) throw new TypeError("extension.id is required");
	if (!/^[a-z0-9][a-z0-9.-]*$/.test(id)) throw new TypeError(`invalid extension id: ${id}`);
	if (typeof slot !== "string" || slot.length === 0) throw new TypeError(`extension ${id}: slot is required`);
	if (!Number.isInteger(slotVersion) || slotVersion < 1) throw new TypeError(`extension ${id}: slotVersion must be a positive integer`);
	const declared = catalog.get(slot);
	if (!declared) throw new Error(`extension ${id}: unknown slot ${slot}`);
	if (declared.version !== slotVersion) throw new Error(`extension ${id}: slot ${slot} expects version ${declared.version}, got ${slotVersion}`);
	for (const method of [
		"match",
		"ready",
		"run"
	]) if (typeof extension[method] !== "function") throw new TypeError(`extension ${id}: ${method} must be a function`);
	for (const list of ["requires", "provides"]) {
		const value = extension[list];
		if (value === void 0) continue;
		if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) throw new TypeError(`extension ${id}: ${list} must be an array of non-empty strings`);
	}
	if (extension.exclusiveGroup !== void 0 && typeof extension.exclusiveGroup !== "string") throw new TypeError(`extension ${id}: exclusiveGroup must be a string`);
	if (extension.role !== void 0) {
		if (!extension.role || typeof extension.role !== "object" || Array.isArray(extension.role)) throw new TypeError(`extension ${id}: role must be an object`);
		for (const field of [
			"name",
			"skill",
			"objective",
			"condition"
		]) if (typeof extension.role[field] !== "string" || extension.role[field].trim().length === 0) throw new TypeError(`extension ${id}: role.${field} must be a non-empty string`);
	}
	return Object.freeze({
		...extension,
		...extension.role ? { role: Object.freeze({ ...extension.role }) } : {},
		requires: Object.freeze([...extension.requires ?? []]),
		provides: Object.freeze([...extension.provides ?? []])
	});
}
//#endregion
//#region src/lib/notify.ts
function createNotifier() {
	const listeners = /* @__PURE__ */ new Set();
	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		notify() {
			for (const listener of [...listeners]) try {
				listener();
			} catch {}
		},
		get size() {
			return listeners.size;
		}
	};
}
//#endregion
//#region src/lib/registry.ts
/**
* 插槽解析：注册、条件三态、就绪、同槽依赖与冲突。
*
* 纯函数式实现，不引入 Cordis；`src/slots/index.ts` 只把它包装成服务。
* 排序是插槽内的局部依赖处理，不是任务图调度。
*/
const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const byRecordId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
/**
* 就绪判定只在“当前作用域可执行”范围内回答；是否获准由 DSH 工具管线决定。
* view 由调用方提供，registry 不解释它的内部结构。
*/
function evaluateReadiness(extension, view) {
	let result;
	try {
		result = extension.ready(view);
	} catch (error) {
		return {
			ready: false,
			reason: `ready() threw: ${error instanceof Error ? error.message : String(error)}`
		};
	}
	if (!result || typeof result !== "object" || typeof result.ready !== "boolean") return {
		ready: false,
		reason: "ready() must return { ready: boolean }"
	};
	const readiness = result;
	if (readiness.ready === false && (typeof readiness.reason !== "string" || readiness.reason.length === 0)) return {
		ready: false,
		reason: "ready() denied without a reason"
	};
	return readiness;
}
function evaluateMatch(extension, facts) {
	let result;
	try {
		result = extension.match(facts);
	} catch (error) {
		return {
			kind: "unknown",
			missing: [`match() threw: ${error instanceof Error ? error.message : String(error)}`]
		};
	}
	if (!result || typeof result !== "object") return {
		kind: "unknown",
		missing: ["match() returned no result"]
	};
	const match = result;
	if (match.kind === "yes" || match.kind === "no") return { kind: match.kind };
	if (match.kind === "unknown") return {
		kind: "unknown",
		missing: Array.isArray(match.missing) ? match.missing : []
	};
	return {
		kind: "unknown",
		missing: [`match() returned unknown kind: ${String(match.kind)}`]
	};
}
function factKnown(facts, name) {
	return Object.prototype.hasOwnProperty.call(facts?.values ?? {}, name);
}
function createSlotRegistry(catalog) {
	const definitions = /* @__PURE__ */ new Map();
	function register(extension) {
		const frozen = validateExtension(extension, catalog);
		if (definitions.has(frozen.id)) throw new Error(`duplicate extension id: ${frozen.id}`);
		definitions.set(frozen.id, frozen);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			if (definitions.get(frozen.id) === frozen) definitions.delete(frozen.id);
		};
	}
	function snapshot() {
		return Object.freeze([...definitions.values()].sort(byId));
	}
	function resolve(slot, facts, view, override) {
		if (!catalog.get(slot)) throw new Error(`unknown slot: ${slot}`);
		const candidates = (override ?? snapshot()).filter((entry) => entry.slot === slot).sort(byId);
		const considered = Object.freeze(candidates.map((entry) => entry.id));
		if (candidates.length === 0) return {
			kind: "empty",
			considered
		};
		const applicable = [];
		const blockedList = [];
		const unknownMissing = [];
		for (const extension of candidates) {
			const matched = evaluateMatch(extension, facts);
			if (matched.kind === "no") continue;
			if (matched.kind === "unknown") {
				for (const fact of matched.missing) if (!unknownMissing.includes(fact)) unknownMissing.push(fact);
				continue;
			}
			const readiness = evaluateReadiness(extension, view);
			if (readiness.ready !== true) {
				blockedList.push({
					id: extension.id,
					reason: readiness.reason,
					...readiness.missing ? { missing: Object.freeze([...readiness.missing]) } : {}
				});
				continue;
			}
			applicable.push(extension);
		}
		if (blockedList.length > 0) return {
			kind: "blocked",
			blocked: Object.freeze(blockedList),
			considered
		};
		const provable = new Set(applicable.flatMap((entry) => [...entry.provides ?? []]));
		const suppliedByRun = unknownMissing.filter((fact) => provable.has(fact));
		const unprovided = unknownMissing.filter((fact) => !provable.has(fact));
		if (unknownMissing.length > 0 && suppliedByRun.length === 0) return {
			kind: "gap",
			missing: Object.freeze([...unknownMissing]),
			considered
		};
		if (applicable.length === 0) return {
			kind: "empty",
			considered
		};
		const conflicts = [];
		const claimed = /* @__PURE__ */ new Map();
		for (const extension of applicable) for (const fact of extension.provides ?? []) {
			const owner = claimed.get(fact);
			if (owner && owner !== extension.id) conflicts.push({
				kind: "output-ownership",
				ids: Object.freeze([owner, extension.id].sort()),
				detail: `both extensions claim to provide ${fact}`
			});
			else claimed.set(fact, extension.id);
		}
		const groups = /* @__PURE__ */ new Map();
		for (const extension of applicable) {
			if (!extension.exclusiveGroup) continue;
			const members = groups.get(extension.exclusiveGroup) ?? [];
			members.push(extension.id);
			groups.set(extension.exclusiveGroup, members);
		}
		for (const [group, members] of groups) if (members.length > 1) conflicts.push({
			kind: "exclusive-group",
			ids: Object.freeze([...members].sort()),
			detail: `exclusive group ${group} has more than one applicable extension`
		});
		if (conflicts.length > 0) return {
			kind: "conflict",
			conflicts: Object.freeze(conflicts),
			considered
		};
		const missingProviders = /* @__PURE__ */ new Set();
		const edges = new Map(applicable.map((entry) => [entry.id, /* @__PURE__ */ new Set()]));
		for (const extension of applicable) for (const fact of extension.requires ?? []) {
			if (factKnown(facts, fact)) continue;
			const providers = applicable.filter((entry) => entry.id !== extension.id && (entry.provides ?? []).includes(fact));
			if (providers.length === 0) {
				missingProviders.add(fact);
				continue;
			}
			for (const provider of providers) edges.get(provider.id)?.add(extension.id);
		}
		if (missingProviders.size > 0) return {
			kind: "gap",
			missing: Object.freeze([...missingProviders].sort()),
			considered
		};
		const ordered = topological(applicable, edges);
		if (!ordered) return {
			kind: "conflict",
			conflicts: Object.freeze([{
				kind: "dependency-cycle",
				ids: Object.freeze(applicable.map((entry) => entry.id)),
				detail: "requires/provides 存在依赖环"
			}]),
			considered
		};
		const steps = Object.freeze(ordered.map((extension) => Object.freeze({
			id: extension.id,
			extension
		})));
		if (unknownMissing.length > 0) return {
			kind: "waiting",
			steps,
			missing: Object.freeze([...unknownMissing]),
			unprovided: Object.freeze([...unprovided]),
			considered
		};
		return {
			kind: "run",
			steps,
			considered
		};
	}
	return Object.freeze({
		register,
		resolve,
		snapshot,
		list: snapshot
	});
}
/**
* Kahn 拓扑排序；同层按 id 稳定排序以便复现。返回 undefined 表示有环。
* edges 是 provider -> consumers。
*/
function topological(nodes, edges) {
	const indegree = new Map(nodes.map((entry) => [entry.id, 0]));
	for (const consumers of edges.values()) for (const consumer of consumers) indegree.set(consumer, (indegree.get(consumer) ?? 0) + 1);
	const remaining = new Map(nodes.map((entry) => [entry.id, entry]));
	const ordered = [];
	while (remaining.size > 0) {
		const ready = [...remaining.values()].filter((entry) => (indegree.get(entry.id) ?? 0) === 0).sort(byRecordId);
		if (ready.length === 0) return void 0;
		for (const entry of ready) {
			ordered.push(entry);
			remaining.delete(entry.id);
			for (const consumer of edges.get(entry.id) ?? []) indegree.set(consumer, (indegree.get(consumer) ?? 0) - 1);
		}
	}
	return ordered;
}
//#endregion
//#region src/slots/index.ts
/**
* `satelliteSlots`：本项目自有的 Cordis 服务。
*
* 只做三件事：声明稳定节点插槽、注册扩展定义、解析当前槽的候选与顺序。
* 它不调度 Agent、不持有任务图，也不保存角色运行历史。
*/
var SatelliteSlots = class extends Service {
	catalog;
	registry;
	slotNotifier;
	constructor(ctx, _config = {}) {
		super(ctx, "satelliteSlots");
		this.catalog = createNodeCatalog();
		this.registry = createSlotRegistry(this.catalog);
		this.slotNotifier = createNotifier();
	}
	/** 订阅插槽声明变化；返回退订函数。领域组件据此跟随声明，不依赖装配顺序。 */
	onSlotsChanged(listener) {
		return this.slotNotifier.subscribe(listener);
	}
	notifySlotsChanged() {
		this.slotNotifier.notify();
	}
	/** 声明一个基础节点的稳定插槽；返回撤销函数。 */
	defineNode(nodeId, options) {
		const remove = this.catalog.defineNode(nodeId, options);
		this.slotNotifier.notify();
		return () => {
			remove();
			this.slotNotifier.notify();
		};
	}
	/** 注册扩展定义；返回撤销函数。非法定义抛错。 */
	register(extension) {
		return this.registry.register(extension);
	}
	/** 解析某个插槽当前适用的扩展、顺序与冲突。 */
	resolve(slot, facts, view, definitions) {
		return this.registry.resolve(slot, facts, view, definitions);
	}
	/** 取定义快照；一次节点调用开始时固定，运行中新增的扩展不插入本次调用。 */
	snapshot() {
		return this.registry.snapshot();
	}
	hasSlot(name) {
		return this.catalog.has(name);
	}
	listSlots() {
		return this.catalog.list();
	}
};
//#endregion
export { SatelliteSlots, SatelliteSlots as default };
