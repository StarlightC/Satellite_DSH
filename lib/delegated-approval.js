import { symbols } from "@deepseek-ai/cordis";
//#region src/lib/delegated-approval.ts
/**
* Delegated-approval broker (internal; not a model tool, not a Remote method).
*
* Satellite role children run with approval pinned to `never`, so a tool that asks
* the child's own approval service is always rejected without a prompt. This broker
* lets a consumer tool route exactly ONE approval per child tool call to the exact
* live delegating parent, tagged with the parent's open `satellite_node` callId.
*
* - `createDelegatedApprovalBroker()` returns a private issuer and a consumer
*   factory. The node runtime creates one broker per node row (no module-level or
*   cross-bundle singleton), keeps the issuer in its own closure and binds a
*   delegation only during its receipt preparation, keyed by the exact child Agent
*   object. There is no registration by parent id or any model-supplied value.
* - A consumer presents its own canonical tool definition; the broker compares it
*   with what the exact child resolves for that tool name.
* - Only `allowed-once` yields a permit; the permit is bound to that one call,
*   re-validated (delegation, sessions, parent approval service AND its current
*   policy) before every side effect, released when the call ends, and never
*   cached, replayed or returned as a token.
* - The child keeps its own `never` policy and its own fs/sandbox/subprocess/shell
*   services; the parent only answers the question. A delegated call is bound to
*   the original child services and the child's sandbox policy snapshot; no
*   requested mode may be wider than that snapshot.
*
* Trust domain: same-process Host plugins are trusted code. This module keeps the
* issuer private to the node runtime and gives models/clients no entry point; it is
* not an isolation boundary against a malicious in-process plugin.
*/
/** Name of the node row's internal, non-Remote consumer service. */
const DELEGATED_APPROVAL_SERVICE = "satelliteDelegatedApproval";
/** Cordis `ctx.get` returns a fresh traceable proxy; identity is the proxied target. */
const original = (value) => value && (typeof value === "object" || typeof value === "function") ? value[symbols.original] ?? value : value;
const MAX_REASON = 32 * 1024;
/** The parent's effective approval policy right now; undefined when unreadable. */
function parentPolicy(approval, session) {
	if (!approval || typeof approval.overrideOf !== "function") return void 0;
	try {
		const value = approval.overrideOf(session) ?? approval.config?.policy;
		return typeof value === "string" ? value : void 0;
	} catch {
		return;
	}
}
function createDelegatedApprovalBroker() {
	let issuerReleased = false;
	const members = /* @__PURE__ */ new Map();
	const issuer = {
		bind(spec) {
			if (issuerReleased) throw new Error("delegated approval issuer released");
			if (!spec.child || !spec.parent || spec.child === spec.parent || typeof spec.parentCallId !== "string" || spec.parentCallId.length === 0 || typeof spec.runId !== "string" || typeof spec.live !== "function" || typeof spec.toolOf !== "function" || !spec.signal) throw new Error("incomplete delegated approval binding");
			if (members.has(spec.child)) throw new Error("delegated approval already bound for this child");
			const member = {
				spec,
				parentApproval: original(spec.parent.ctx?.get("approval")),
				calls: /* @__PURE__ */ new Set(),
				active: true,
				queue: Promise.resolve()
			};
			members.set(spec.child, member);
			return () => {
				member.active = false;
				if (members.get(spec.child) === member) members.delete(spec.child);
			};
		},
		release() {
			issuerReleased = true;
			for (const member of members.values()) member.active = false;
			members.clear();
		}
	};
	function consumer() {
		let disposed = false;
		return {
			dispose() {
				disposed = true;
			},
			delegated(exec) {
				const member = exec.agent ? members.get(exec.agent) : void 0;
				return member !== void 0 && member.active;
			},
			async request(exec, tool, toolName, reason) {
				const agent = exec.agent;
				const member = agent ? members.get(agent) : void 0;
				if (!agent || !member) return { kind: "direct" };
				const { spec } = member;
				const deny = (outcome, why) => ({
					kind: "denied",
					outcome,
					reason: why
				});
				const problem = () => {
					if (disposed) return "consumer plugin unloaded";
					if (!member.active || issuerReleased) return "delegation ended";
					if (!spec.live()) return "delegation no longer live";
					if (agent.session !== spec.childSession) return "child session replaced";
					if (spec.parent.session !== spec.parentSession) return "parent session replaced";
					if (exec.signal.aborted || spec.signal.aborted) return "call cancelled";
					if (tool === void 0 || spec.toolOf(toolName) !== tool) return "tool definition is not the canonical consumer definition";
					const approval = spec.parent.ctx?.get("approval");
					if (approval === void 0 || original(approval) !== member.parentApproval) return "parent approval service unavailable or changed";
					const policy = parentPolicy(approval, spec.parentSession);
					if (policy === "never") return "parent session approval policy is \"never\": no prompt can be shown; nothing ran";
					if (policy !== "ask") return "parent session approval policy unavailable; nothing ran";
				};
				const callId = exec.callId;
				if (typeof callId !== "string" || callId.length === 0) return deny("unavailable", "child call id missing");
				if (member.calls.has(callId)) return deny("unavailable", "this child call already used its one parent approval; retry as a new call");
				member.calls.add(callId);
				const before = problem();
				if (before) return deny("unavailable", before);
				const run = member.queue.then(async () => {
					const waiting = problem();
					if (waiting) return deny("unavailable", waiting);
					const approval = spec.parent.ctx?.get("approval");
					const text = [
						`Delegated child approval: Satellite role agent ${agent.id} (run ${spec.runId}) requests ${toolName} in its own sandbox, child call ${callId}.`,
						"Approving allows only this one child call; the next call asks again.",
						"",
						reason
					].join("\n");
					if (Buffer.byteLength(text) > MAX_REASON) return deny("unavailable", "approval plan too large to show exactly; split the request");
					let outcome;
					try {
						outcome = await approval.request({
							agent: spec.parent,
							toolName,
							callId: spec.parentCallId,
							reason: text,
							signal: AbortSignal.any([exec.signal, spec.signal])
						});
					} catch (error) {
						return deny("unavailable", `parent approval failed: ${error instanceof Error ? error.message : String(error)}`);
					}
					if (outcome !== "allowed-once") return deny(outcome === "rejected" || outcome === "cancelled" ? outcome : "unavailable", outcome === "rejected" ? "parent user rejected the request" : outcome === "cancelled" ? "parent approval cancelled" : "no parent approval answerer available");
					const after = problem();
					if (after) return deny("unavailable", `${after} after approval; nothing ran`);
					let released = false;
					return {
						kind: "granted",
						permit: {
							check() {
								if (released) throw new Error("delegated approval permit already released");
								const now = problem();
								if (now) throw new Error(`delegated approval no longer holds: ${now}`);
							},
							release() {
								released = true;
							}
						}
					};
				});
				member.queue = run.then(() => void 0, () => void 0);
				return run;
			}
		};
	}
	return {
		issuer,
		consumer
	};
}
const MODE_RANK = {
	"read-only": 0,
	"workspace-write": 1,
	"danger-full-access": 2
};
function readPolicy(scope, session) {
	const service = scope?.get("sandboxPolicy");
	if (!service || typeof service.resolve !== "function") return void 0;
	let value;
	try {
		value = service.resolve({ session });
	} catch {
		return;
	}
	if (!value || typeof value.mode !== "string" || MODE_RANK[value.mode] === void 0 || typeof value.workspaceRoot !== "string" || value.workspaceRoot.length === 0) return void 0;
	const roots = Array.isArray(value.additionalWritableRoots) ? value.additionalWritableRoots.map(String) : [];
	return {
		mode: value.mode,
		workspaceRoot: value.workspaceRoot,
		roots,
		key: JSON.stringify([
			value.mode,
			value.workspaceRoot,
			[...roots].sort()
		])
	};
}
const FS_READS = /* @__PURE__ */ new Set([
	"resolve",
	"processPath",
	"processPathFromHostPath",
	"fileUrl",
	"contains",
	"stat",
	"lstat",
	"readText",
	"streamText",
	"readBytes",
	"readByteRange",
	"listDir",
	"watch"
]);
/**
* One gate per tool call. Non-delegated callers keep their own approval service and
* their services unchanged. A delegated call is bound at creation to the exact
* child's original services and sandbox policy snapshot.
*/
function createCallGate(options) {
	const { consumer, exec, toolName } = options;
	const delegated = consumer !== void 0 && consumer.delegated(exec);
	let permit;
	let denial;
	let released = false;
	const scope = exec.agent?.ctx;
	const bound = /* @__PURE__ */ new Map();
	let snapshot;
	if (delegated) {
		for (const name of options.services) bound.set(name, original(scope?.get(name)));
		snapshot = readPolicy(scope, exec.agent?.session);
	}
	const confined = /* @__PURE__ */ new WeakSet();
	const bindingProblem = () => {
		if (!scope) return "child service scope unavailable";
		for (const [name, value] of bound) {
			if (value === void 0) return `child ${name} service unavailable`;
			if (original(scope.get(name)) !== value) return `child ${name} service replaced`;
		}
		if (!snapshot) return "child sandbox policy unavailable";
		const now = readPolicy(scope, exec.agent?.session);
		if (!now || now.key !== snapshot.key) return "child sandbox policy changed";
	};
	const check = () => {
		if (!delegated) return;
		if (released) throw new Error("delegated approval permit already released");
		if (!permit) throw new Error("delegated call has no parent approval for this side effect");
		permit.check();
		const problem = bindingProblem();
		if (problem) throw new Error(`delegated approval no longer holds: ${problem}`);
	};
	/** A requested sandbox policy may never be wider than the child's snapshot. */
	const cap = (policy) => {
		if (!delegated) return;
		const limit = snapshot;
		const value = policy;
		if (!value || typeof value !== "object" || typeof value.mode !== "string" || MODE_RANK[value.mode] === void 0) throw new Error("delegated side effect without an explicit sandbox policy");
		if (MODE_RANK[value.mode] > MODE_RANK[limit.mode]) throw new Error(`requested sandbox mode ${value.mode} is wider than the child's current ${limit.mode}`);
		if (value.workspaceRoot !== limit.workspaceRoot) throw new Error("requested sandbox root differs from the child policy");
		if ((Array.isArray(value.additionalWritableRoots) ? value.additionalWritableRoots.map(String) : []).some((root) => !limit.roots.includes(root))) throw new Error("requested writable roots exceed the child policy");
	};
	const policyArg = (args) => [...args].reverse().find((arg) => !!arg && typeof arg === "object" && typeof arg.mode === "string");
	const proxy = (target, method) => new Proxy(target, { get(object, key) {
		const value = Reflect.get(object, key);
		if (typeof value !== "function") return value;
		const fn = value.bind(object);
		return (typeof key === "string" ? method(key, fn) : void 0) ?? fn;
	} });
	const wrapService = (name, service) => {
		switch (name) {
			case "fs": return proxy(service, (key, fn) => FS_READS.has(key) ? void 0 : (...args) => {
				check();
				if (key === "writeText" || key === "editText" || key === "patchText" || key === "deleteFile" || key === "moveFile") cap(policyArg(args));
				return fn(...args);
			});
			case "sandbox": return proxy(service, (key, fn) => key !== "confine" ? void 0 : async (...args) => {
				check();
				cap(args[1]);
				const result = await fn(...args);
				check();
				if (result && typeof result.argv === "object" && result.argv !== null) confined.add(result.argv);
				return result;
			});
			case "subprocess": return proxy(service, (key, fn) => key !== "spawn" && key !== "spawnTerminal" ? void 0 : (...args) => {
				check();
				const argv = args[0]?.argv;
				if (snapshot.mode !== "danger-full-access" && !(typeof argv === "object" && argv !== null && confined.has(argv))) throw new Error(`unconfined process is wider than the child's current ${snapshot.mode} sandbox`);
				return fn(...args);
			});
			case "shell": return proxy(service, (key, fn) => key !== "execute" ? void 0 : (...args) => {
				check();
				cap(args[0]?.sandboxPolicy);
				return fn(...args);
			});
			default: return service;
		}
	};
	const direct = (request) => {
		const own = options.childApproval();
		if (!own || typeof own.request !== "function") return Promise.resolve("unavailable");
		return own.request(request);
	};
	return {
		delegated,
		approval: { async request(request) {
			if (released) return "unavailable";
			if (!delegated) return direct(request);
			const before = bindingProblem();
			if (before) {
				denial = `${before}; nothing ran`;
				return "unavailable";
			}
			const decision = await consumer.request(exec, options.tool(), toolName, request.reason);
			if (decision.kind === "direct") {
				denial = "delegation ended before approval; nothing ran";
				return "unavailable";
			}
			if (decision.kind === "denied") {
				denial = decision.reason;
				return decision.outcome;
			}
			const after = released ? "call ended" : bindingProblem();
			if (after) {
				decision.permit.release();
				denial = `${after} after approval; nothing ran`;
				return "unavailable";
			}
			permit?.release();
			permit = decision.permit;
			return "allowed-once";
		} },
		check,
		wrap(services) {
			if (!delegated) return services;
			const out = { ...services };
			for (const [name, value] of Object.entries(out)) if (value && typeof value === "object") out[name] = wrapService(name, value);
			return out;
		},
		get denial() {
			return denial;
		},
		release() {
			released = true;
			permit?.release();
		}
	};
}
const gates = /* @__PURE__ */ new WeakMap();
function attachGate(exec, gate) {
	gates.set(exec, gate);
}
function detachGate(exec) {
	gates.get(exec)?.release();
	gates.delete(exec);
}
function gateOf(exec) {
	return gates.get(exec);
}
/** Approval failure text including the delegated reason when one exists. */
function approvalMessage(exec, outcome) {
	const reason = gates.get(exec)?.denial;
	return reason ? `approval ${outcome}: ${reason}` : `approval ${outcome}`;
}
//#endregion
export { DELEGATED_APPROVAL_SERVICE, approvalMessage, attachGate, createCallGate, createDelegatedApprovalBroker, detachGate, gateOf, original };
