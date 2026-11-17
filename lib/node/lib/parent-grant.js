//#region src/node/lib/parent-grant.ts
const PARENT_REQUEST_TOOL = "satellite_parent_request";
const PARENT_TARGET_TOOL = "plugin_manager";
/** Fixed from request time; a resume never refreshes it. */
const PARENT_REQUEST_TTL_MS = 600 * 1e3;
const MAX_REASON_CHARS = 4e3;
const MAX_IDENTIFIER_CHARS = 1024;
const MAX_OFFSET = 1e6;
/** Actions this feature may hand back. Version-exemption actions stay unavailable. */
const SUPPORTED_ACTIONS = Object.freeze([
	"list_plugins",
	"list_bundles",
	"set_plugin",
	"set_bundle",
	"install_bundle",
	"remove_bundle"
]);
const SUPPORTED_ACTION_SET = new Set(SUPPORTED_ACTIONS);
const REQUEST_KEYS = /* @__PURE__ */ new Set(["reason", "arguments"]);
const ARGUMENT_KEYS = /* @__PURE__ */ new Set([
	"action",
	"target",
	"enabled",
	"registry",
	"offset",
	"limit"
]);
/** Close a grant once and drop its listeners; never touches another grant. */
function closeGrant(grant, state) {
	if (grant.state === "open" || grant.state === "pending") grant.state = state;
	grant.detach();
}
function isPlainRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
/**
* Accept only a plain, enumerable, data-property record. The shared pipeline
* already freezes a lossless JSON snapshot; this second check keeps the broker
* total even if a caller reaches the tool through another path.
*/
function assertPlainRecord(value, label) {
	if (!isPlainRecord(value)) throw new Error(`${label} 必须是普通对象`);
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") throw new Error(`${label} 不能包含 symbol 键`);
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor) || descriptor.get !== void 0 || descriptor.set !== void 0) throw new Error(`${label} 不能包含访问器属性`);
		if (!descriptor.enumerable) throw new Error(`${label} 不能包含不可枚举属性`);
	}
	return value;
}
/** Canonical JSON with sorted object keys; rejects values JSON cannot represent. */
function canonicalJson(value, path = "value") {
	if (value === null) return "null";
	switch (typeof value) {
		case "string":
		case "boolean": return JSON.stringify(value);
		case "number":
			if (!Number.isFinite(value)) throw new Error(`${path} 不是有限数字`);
			return JSON.stringify(value);
		case "object": {
			if (Array.isArray(value)) return `[${value.map((item, index) => canonicalJson(item, `${path}[${index}]`)).join(",")}]`;
			const record = assertPlainRecord(value, path);
			return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], `${path}.${key}`)}`).join(",")}}`;
		}
		default: throw new Error(`${path} 不是无损 JSON 值`);
	}
}
function freezeJson(value) {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) {
		for (const item of value) freezeJson(item);
		return Object.freeze(value);
	}
	for (const item of Object.values(value)) freezeJson(item);
	return Object.freeze(value);
}
/** Strict closed validation of the child request; independent of host schema lint. */
function parseParentRequest(value) {
	const request = assertPlainRecord(value, "父请求");
	for (const key of Object.keys(request)) if (!REQUEST_KEYS.has(key)) throw new Error(`父请求含不支持字段：${key}`);
	const reason = request.reason;
	if (typeof reason !== "string" || reason.trim().length === 0) throw new Error("父请求 reason 必须是非空字符串");
	if (reason.length > MAX_REASON_CHARS) throw new Error(`父请求 reason 超过 ${MAX_REASON_CHARS} 字符`);
	const raw = assertPlainRecord(request.arguments, "父请求 arguments");
	const out = {};
	for (const [key, item] of Object.entries(raw)) {
		if (!ARGUMENT_KEYS.has(key)) throw new Error(`plugin_manager 参数含不支持字段：${key}`);
		switch (key) {
			case "action":
				if (typeof item !== "string" || !SUPPORTED_ACTION_SET.has(item)) throw new Error(`plugin_manager action 只支持：${SUPPORTED_ACTIONS.join("、")}`);
				out.action = item;
				break;
			case "target":
				if (typeof item !== "string" || item.length === 0 || item.length > MAX_IDENTIFIER_CHARS) throw new Error("plugin_manager target 必须是 1–1024 字符的字符串");
				out.target = item;
				break;
			case "enabled":
				if (typeof item !== "boolean") throw new Error("plugin_manager enabled 必须是布尔值");
				out.enabled = item;
				break;
			case "registry":
				if (typeof item !== "string" || item.length === 0 || item.length > MAX_IDENTIFIER_CHARS) throw new Error("plugin_manager registry 必须是 1–1024 字符的字符串，按原值精确传递");
				out.registry = item;
				break;
			case "offset":
				if (!Number.isInteger(item) || item < 0 || item > MAX_OFFSET) throw new Error(`plugin_manager offset 必须是 0–${MAX_OFFSET} 的整数`);
				out.offset = item;
				break;
			case "limit":
				if (!Number.isInteger(item) || item < 1 || item > 100) throw new Error("plugin_manager limit 必须是 1–100 的整数");
				out.limit = item;
				break;
			default: throw new Error(`plugin_manager 参数含不支持字段：${key}`);
		}
	}
	if (!Object.hasOwn(out, "action")) throw new Error("plugin_manager 参数缺少 action");
	const frozen = freezeJson(out);
	return Object.freeze({
		reason,
		arguments: frozen,
		canonicalArguments: canonicalJson(frozen, "arguments")
	});
}
const TOOL_DESCRIPTION = "请求主 Agent 按精确参数代执行一次 plugin_manager（仅 implement 基础节点绑定）。请求只在本节点完成且父调用未取消后交付一次；参数必须与闭集完全一致，宿主审批仍独立，这不是批准、不是权限提升，也不能用于其它工具、脚本或命令。";
const PARAMETERS = Object.freeze({
	reason: {
		type: "string",
		required: true,
		description: "交回的真实待办与原因，供主 Agent 判断；不是批准声明，不会成为宿主批准。"
	},
	arguments: {
		type: "object",
		additionalProperties: false,
		description: "plugin_manager 的完整精确参数。只支持 list_plugins、list_bundles、set_plugin、set_bundle、install_bundle、remove_bundle；版本豁免相关字段、approvedBuilds 与其它字段一律拒绝。",
		properties: {
			action: {
				type: "string",
				enum: SUPPORTED_ACTIONS,
				required: true,
				description: "要交回的动作；list_bundles/list_plugins 是列目录，set/install/remove 是具体改动。"
			},
			target: {
				type: "string",
				description: "plugin_manager target 原值，按精确字符串传递。"
			},
			enabled: {
				type: "boolean",
				description: "set_plugin/set_bundle 使用。"
			},
			registry: {
				type: "string",
				description: "install_bundle 的 npm registry，按原值精确传递。"
			},
			offset: {
				type: "number",
				description: "list 分页起点，0–1000000 的整数。"
			},
			limit: {
				type: "number",
				description: "list 分页大小，1–100 的整数。"
			}
		}
	}
});
const OUTPUT = Object.freeze({
	type: "object",
	additionalProperties: false,
	properties: {
		status: {
			type: "string",
			enum: ["proposed", "rejected"],
			required: true
		},
		tool: {
			type: "string",
			description: "固定为 plugin_manager"
		},
		arguments: {
			type: "json",
			description: "通过校验的精确参数；不是执行凭证"
		},
		source: {
			type: "object",
			additionalProperties: false,
			properties: {
				node: { type: "string" },
				unit: { type: "string" },
				runId: { type: "string" }
			}
		},
		expiresAt: { type: "string" },
		note: { type: "string" }
	}
});
function createParentGrantBroker(options) {
	const clock = options.now ?? (() => Date.now());
	const rootTools = options.root.get("tools");
	const available = rootTools !== void 0 && typeof rootTools.get === "function";
	const members = /* @__PURE__ */ new Map();
	const proposals = /* @__PURE__ */ new Map();
	/** Call tokens whose suspension was confirmed by its final result. */
	const held = /* @__PURE__ */ new Set();
	const grants = /* @__PURE__ */ new Map();
	const parentHooks = /* @__PURE__ */ new Map();
	let released = false;
	let sequence = 0;
	function parentToolOf(parent) {
		return rootTools?.get?.(PARENT_TARGET_TOOL, parent);
	}
	function revokeParent(parent) {
		const grant = grants.get(parent);
		if (grant) closeGrant(grant, "revoked");
		for (const [token, proposal] of proposals) if (proposal.parent === parent) {
			proposals.delete(token);
			held.delete(token);
		}
	}
	/** Install at most one parent-scope dispose hook per exact parent object. */
	function ensureParentHook(parent) {
		if (parentHooks.has(parent) || !parent.ctx || typeof parent.ctx.effect !== "function") return;
		try {
			const remove = parent.ctx.effect(() => () => {
				revokeParent(parent);
				parentHooks.delete(parent);
			});
			if (typeof remove === "function") parentHooks.set(parent, remove);
		} catch {}
	}
	function releaseMember(member) {
		if (!member.active) return;
		member.active = false;
		if (members.get(member.spec.child) === member) members.delete(member.spec.child);
		for (const remove of member.releases.splice(0).reverse()) try {
			remove();
		} catch {}
	}
	const tool = options.defineTool({
		name: PARENT_REQUEST_TOOL,
		description: TOOL_DESCRIPTION,
		parameters: PARAMETERS,
		output: {
			schema: OUTPUT,
			render: (_args, value) => [{
				type: "text",
				text: value.status === "proposed" ? `父请求已暂存（node=${value.source?.node ?? "?"}, run=${value.source?.runId ?? "?"}）：plugin_manager ${JSON.stringify(value.arguments)}；仅在本节点完成且父调用未取消后由主 Agent 执行一次，宿主批准仍独立，票据有效至 ${value.expiresAt ?? "未知"}。这不是批准或权限提升。` : `父请求被拒绝：${value.note ?? "未说明原因"}。未暂存任何请求，也不会交给主 Agent。`
			}]
		},
		async execute(args, exec) {
			const rejected = (note) => ({
				status: "rejected",
				note
			});
			try {
				if (released) return rejected("节点行已卸载，父请求不可用");
				const agent = exec.agent;
				const member = agent ? members.get(agent) : void 0;
				if (!agent || !member || !member.active) return rejected("当前作用域没有有效的父请求绑定");
				if (agent !== member.spec.child) return rejected("父请求只属于绑定的 base child");
				if (exec.parent !== void 0) return rejected("父请求只允许直接调用，不接受嵌套/派生作用域");
				if (!member.spec.live()) return rejected("委派已结束或失效");
				if (exec.signal.aborted || member.spec.signal.aborted) return rejected("调用已取消");
				const callId = exec.callId;
				if (typeof callId !== "string" || callId.length === 0) return rejected("缺少子调用标识");
				if (proposals.has(member.spec.callToken)) return rejected("本次节点调用已使用过唯一一次父请求");
				const request = parseParentRequest(args);
				const definition = parentToolOf(member.spec.parent);
				if (definition === void 0 || definition !== member.definition) return rejected("父作用域的 plugin_manager 工具定义已变化或不可见");
				const now = clock();
				const proposal = Object.freeze({
					callToken: member.spec.callToken,
					parent: member.spec.parent,
					parentSession: member.spec.parentSession,
					childId: member.spec.child.id,
					runId: member.spec.runId,
					nodeId: member.spec.nodeId,
					...member.spec.unit !== void 0 ? { unit: member.spec.unit } : {},
					parentCallId: member.spec.parentCallId,
					requestedAt: now,
					expiresAt: now + PARENT_REQUEST_TTL_MS,
					definition,
					arguments: request.arguments,
					canonicalArguments: request.canonicalArguments,
					reason: request.reason,
					requestSignal: member.spec.signal,
					...member.spec.execution !== void 0 ? { execution: member.spec.execution } : {}
				});
				proposals.set(proposal.callToken, proposal);
				return {
					status: "proposed",
					tool: PARENT_TARGET_TOOL,
					arguments: request.arguments,
					source: {
						node: proposal.nodeId,
						runId: proposal.runId,
						...proposal.unit !== void 0 ? { unit: proposal.unit } : {}
					},
					expiresAt: new Date(proposal.expiresAt).toISOString(),
					note: "已暂存。只有本节点完成且父调用未取消时才由主 Agent 按精确参数执行一次；宿主批准仍独立；这不是批准、权限提升或可重放的凭证。"
				};
			} catch (error) {
				return rejected(error instanceof Error ? error.message : String(error));
			}
		}
	});
	return {
		available,
		issuer: {
			unavailableReason(parent) {
				if (released) return "节点行已卸载";
				if (!available) return "宿主缺少原生工具注册表（tools.get）";
				if (parentToolOf(parent) === void 0) return "父作用域看不到 plugin_manager（未挂载或被工具过滤）";
			},
			bind(spec) {
				if (released) throw new Error("父请求 broker 已卸载");
				if (!available) throw new Error("父请求需要原生工具注册表（tools.get），当前宿主缺少该接口");
				if (spec.nodeId !== "implement") throw new Error("父请求只在 implement 基础节点绑定");
				if (!spec.child || !spec.parent || spec.child === spec.parent) throw new Error("父请求绑定身份不完整");
				if (spec.parent.session !== spec.parentSession) throw new Error("父会话与绑定不一致");
				for (const [label, value] of [
					["parentCallId", spec.parentCallId],
					["runId", spec.runId],
					["callToken", spec.callToken]
				]) if (typeof value !== "string" || value.length === 0) throw new Error(`父请求缺少 ${label}`);
				if (typeof spec.live !== "function" || !spec.signal) throw new Error("父请求绑定缺少生命周期");
				if (members.has(spec.child)) throw new Error("该 child 已绑定父请求");
				const definition = parentToolOf(spec.parent);
				if (definition === void 0) throw new Error("父作用域没有 plugin_manager 工具，拒绝绑定父请求");
				const childTools = spec.child.ctx.get("tools");
				if (!childTools || typeof childTools.register !== "function" || typeof childTools.guard !== "function") throw new Error("子作用域缺少工具注册或 guard 能力，拒绝父请求");
				const member = {
					spec,
					definition,
					active: true,
					releases: []
				};
				members.set(spec.child, member);
				try {
					const removeGuard = childTools.guard((exec) => {
						if (exec.name !== "satellite_parent_request") return void 0;
						if (released || !member.active) return "Satellite：父请求绑定已结束，拒绝执行";
						if (exec.agent !== spec.child) return "Satellite：父请求只属于绑定的 base child";
						if (exec.parent !== void 0) return "Satellite：父请求只允许直接调用";
						if (!spec.live()) return "Satellite：委派已结束或失效，拒绝父请求";
						if (rootTools?.get?.("satellite_parent_request", spec.child) !== tool) return "Satellite：父请求工具定义已替换，拒绝执行";
					});
					member.releases.push(removeGuard);
					const removeTool = childTools.register(tool);
					member.releases.push(removeTool);
					if (rootTools?.get?.("satellite_parent_request", spec.child) !== tool) throw new Error("父请求工具未能在子作用域稳定注册");
					ensureParentHook(spec.parent);
				} catch (error) {
					releaseMember(member);
					throw error;
				}
				return () => releaseMember(member);
			}
		},
		guard: { claim(exec) {
			if (exec.name !== "plugin_manager") return { kind: "none" };
			const parent = exec.agent;
			if (!parent || typeof parent !== "object") return { kind: "none" };
			const grant = grants.get(parent);
			if (!grant) return { kind: "none" };
			const deny = (reason) => ({
				kind: "deny",
				reason: `Satellite：${reason}`
			});
			if (grant.state === "consumed") return deny("该父请求票据已使用过；一次请求只允许一次精确调用");
			if (grant.state === "revoked") return deny("该父请求票据已作废");
			if (grant.state === "pending") return deny("该父请求票据尚未随节点最终结果确认交付，暂不可用");
			if (grant.sources.some((source) => source.aborted)) {
				closeGrant(grant, "revoked");
				return deny("发布该票据的节点调用已取消；父请求票据已作废");
			}
			const now = clock();
			if (now > grant.expiresAt) {
				closeGrant(grant, "revoked");
				return deny("父请求票据已超过 10 分钟有效期；未执行工具主体，也未进入 plugin_manager 主体内的审批（宿主执行前策略审批可能已先发生）");
			}
			if (parent.session !== grant.parentSession) {
				closeGrant(grant, "revoked");
				return deny("父会话已变化；父请求票据已作废");
			}
			const agents = options.root.get("agents");
			if (!agents || typeof agents.get !== "function" || agents.get(parent.id) !== parent) {
				closeGrant(grant, "revoked");
				return deny("父 Agent 已失效；父请求票据已作废");
			}
			if (parentToolOf(parent) !== grant.definition) {
				closeGrant(grant, "revoked");
				return deny("父作用域的 plugin_manager 工具定义已替换；父请求票据已作废");
			}
			let canonical;
			try {
				canonical = canonicalJson(exec.arguments, "arguments");
			} catch {
				return deny("父请求参数无法规范化为无损 JSON；未执行工具主体，也未进入 plugin_manager 主体内的审批（宿主执行前策略审批可能已先发生）");
			}
			if (canonical !== grant.canonicalArguments) return deny("参数与节点交回的精确请求不一致；未执行工具主体，也未进入 plugin_manager 主体内的审批（宿主执行前策略审批可能已先发生）");
			closeGrant(grant, "consumed");
			grant.consumedAt = now;
			if (typeof exec.callId === "string" && exec.callId.length > 0) grant.consumedCallId = exec.callId;
			return { kind: "allow" };
		} },
		publish(callToken, parentSignal, publishCallId, execution) {
			const proposal = proposals.get(callToken);
			if (!proposal) return void 0;
			proposals.delete(callToken);
			const wasHeld = held.delete(callToken);
			const source = Object.freeze({
				node: proposal.nodeId,
				...proposal.unit !== void 0 ? { unit: proposal.unit } : {},
				runId: proposal.runId
			});
			const audit = (status, note, ticket) => Object.freeze({
				status,
				tool: PARENT_TARGET_TOOL,
				arguments: proposal.arguments,
				...ticket !== void 0 ? { ticket } : {},
				source,
				expiresAt: new Date(proposal.expiresAt).toISOString(),
				...note !== void 0 ? { note } : {}
			});
			if (released) return audit("dropped", "节点行已卸载，未发布");
			if (proposal.execution !== void 0 && proposal.execution !== execution && !wasHeld) return audit("dropped", "暂存该请求的调用未确认交付，未发布");
			if (parentSignal.aborted) return audit("dropped", "父调用已取消，未发布");
			if (proposal.requestSignal.aborted) return audit("dropped", "暂存该请求的父调用已取消，恢复也不发布");
			const now = clock();
			if (now > proposal.expiresAt) return audit("expired", "超过请求起的 10 分钟有效期，未发布；恢复调用不会刷新");
			const parent = proposal.parent;
			if (parent.session !== proposal.parentSession) return audit("dropped", "父会话已变化，未发布");
			const agents = options.root.get("agents");
			if (!agents || typeof agents.get !== "function" || agents.get(parent.id) !== parent) return audit("dropped", "父 Agent 已失效，未发布");
			const definition = parentToolOf(parent);
			if (definition === void 0 || definition !== proposal.definition) return audit("dropped", "父作用域的 plugin_manager 工具定义已变化，未发布");
			sequence += 1;
			const next = `satellite-parent-request-${sequence}`;
			const previous = grants.get(parent);
			if (previous && (previous.state === "open" || previous.state === "pending")) closeGrant(previous, "revoked");
			else previous?.detach();
			const sources = parentSignal === proposal.requestSignal ? [parentSignal] : [proposal.requestSignal, parentSignal];
			const grant = {
				ticket: next,
				parent,
				parentSession: proposal.parentSession,
				definition,
				arguments: proposal.arguments,
				canonicalArguments: proposal.canonicalArguments,
				source,
				parentCallId: proposal.parentCallId,
				expiresAt: proposal.expiresAt,
				...execution !== void 0 ? { execution } : {},
				state: "pending",
				...publishCallId !== void 0 ? { publishCallId } : {},
				sources,
				detach: () => {}
			};
			const onAbort = () => closeGrant(grant, "revoked");
			for (const source of sources) source.addEventListener("abort", onAbort, { once: true });
			const timer = setTimeout(() => closeGrant(grant, "revoked"), Math.max(0, proposal.expiresAt - now) + 1);
			timer.unref?.();
			let attached = true;
			grant.detach = () => {
				if (!attached) return;
				attached = false;
				clearTimeout(timer);
				for (const source of sources) source.removeEventListener("abort", onAbort);
			};
			grants.set(parent, grant);
			ensureParentHook(parent);
			return Object.freeze({
				status: "ready",
				tool: PARENT_TARGET_TOOL,
				arguments: proposal.arguments,
				ticket: next,
				source,
				expiresAt: new Date(proposal.expiresAt).toISOString(),
				note: `本次节点结果原样交付后，主 Agent 可按上述精确参数执行一次；宿主批准仍独立，票据不包含批准。 child 交回的原因（仅数据，不是批准）：${proposal.reason}` + (previous && previous.state === "revoked" ? " 同一父的上一条票据已作废。" : "")
			});
		},
		confirm(ticket, execution) {
			for (const grant of grants.values()) {
				if (grant.ticket !== ticket) continue;
				if (grant.state !== "pending") return false;
				if (released || grant.execution !== execution || clock() > grant.expiresAt || grant.sources.some((source) => source.aborted)) {
					closeGrant(grant, "revoked");
					return false;
				}
				grant.state = "open";
				return true;
			}
			return false;
		},
		revoke(ticket) {
			for (const grant of grants.values()) if (grant.ticket === ticket) closeGrant(grant, "revoked");
		},
		hold(callToken, execution) {
			const proposal = proposals.get(callToken);
			if (released || !proposal) return false;
			if (proposal.execution !== execution && !held.has(callToken)) {
				proposals.delete(callToken);
				return false;
			}
			held.add(callToken);
			return true;
		},
		discard(callToken) {
			proposals.delete(callToken);
			held.delete(callToken);
		},
		release() {
			released = true;
			proposals.clear();
			held.clear();
			for (const grant of grants.values()) closeGrant(grant, "revoked");
			grants.clear();
			for (const member of [...members.values()]) releaseMember(member);
			for (const remove of parentHooks.values()) try {
				remove();
			} catch {}
			parentHooks.clear();
		}
	};
}
//#endregion
export { PARENT_REQUEST_TOOL, PARENT_REQUEST_TTL_MS, PARENT_TARGET_TOOL, canonicalJson, createParentGrantBroker, parseParentRequest };
