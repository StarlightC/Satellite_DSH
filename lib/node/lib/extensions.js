//#region src/lib/contracts.ts
const MATCH_YES = Object.freeze({ kind: "yes" });
const MATCH_NO = Object.freeze({ kind: "no" });
const READY = Object.freeze({ ready: true });
//#endregion
//#region src/node/lib/extensions.ts
/** 事实：本次节点调用是否要求一个处理决定。只有字面 `true` 才算要求。 */
const ACCEPTANCE_REQUIRED_FACT = "acceptance.required";
/** 事实：已提交的处理决定。存在（任意值）即视为已决定。 */
const DECISION_FACT = "decision";
/** 扩展 id 前缀；完整 id 形如 `core.acceptance-decision.validate`。 */
const ACCEPTANCE_DECISION_ID_PREFIX = "core.acceptance-decision";
/** 暂停原因文案：告诉模型为什么停、下一步交什么。 */
const ACCEPTANCE_DECISION_NOTE = "基础节点已完成，等待提交处理决定";
function acceptanceDecisionId(nodeId) {
	return `${ACCEPTANCE_DECISION_ID_PREFIX}.${nodeId}`;
}
/**
* 为某一个已声明节点造一个 after 扩展。
* `slotVersion` 必须与目录声明的版本一致，由调用方（wiring）在声明节点时给出。
*/
function createAcceptanceDecisionExtension(nodeId, slotVersion = 1) {
	return {
		id: acceptanceDecisionId(nodeId),
		slot: `${nodeId}.after`,
		slotVersion,
		match(facts) {
			if (facts.values["acceptance.required"] !== true) return MATCH_NO;
			if (facts.values["decision"] !== void 0) return MATCH_NO;
			return MATCH_YES;
		},
		ready() {
			return READY;
		},
		run() {
			return {
				status: "needs_decision",
				note: ACCEPTANCE_DECISION_NOTE
			};
		}
	};
}
/** 为每个已声明节点各造一个 after 扩展（顺序与入参一致）。 */
function createBuiltinAfterExtensions(nodeIds, slotVersion = 1) {
	return Object.freeze(nodeIds.map((nodeId) => createAcceptanceDecisionExtension(nodeId, slotVersion)));
}
//#endregion
export { ACCEPTANCE_DECISION_ID_PREFIX, ACCEPTANCE_DECISION_NOTE, ACCEPTANCE_REQUIRED_FACT, DECISION_FACT, acceptanceDecisionId, createAcceptanceDecisionExtension, createBuiltinAfterExtensions };
