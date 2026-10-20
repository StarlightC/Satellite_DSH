//#region src/lib/contracts.ts
const MATCH_YES = Object.freeze({ kind: "yes" });
const MATCH_NO = Object.freeze({ kind: "no" });
function unknownMatch(missing) {
	if (!Array.isArray(missing) || missing.length === 0) throw new TypeError("unknown match must name at least one missing fact");
	return Object.freeze({
		kind: "unknown",
		missing: Object.freeze([...missing])
	});
}
const READY = Object.freeze({ ready: true });
function blocked(reason, missing) {
	if (typeof reason !== "string" || reason.length === 0) throw new TypeError("blocked readiness requires a reason");
	return Object.freeze({
		ready: false,
		reason,
		...missing ? { missing: Object.freeze([...missing]) } : {}
	});
}
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
	return Object.freeze({
		...extension,
		requires: Object.freeze([...extension.requires ?? []]),
		provides: Object.freeze([...extension.provides ?? []])
	});
}
//#endregion
export { MATCH_NO, MATCH_YES, READY, blocked, createNodeCatalog, unknownMatch, validateExtension };
