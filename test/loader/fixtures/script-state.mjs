// Shared in-process state between the Loader-mounted fixture plugins and the
// integration test. The plugins are imported by the real Cordis Loader through
// their file URL, so this module record is the same one the test imports.

/** Deterministic model script: (request) => reply | Promise<reply>. Set per scenario. */
export const state = {
  /** The installation's @deepseek-ai/dsh-llm module, set by the test before boot. */
  dshLlm: undefined,
  /** @type {(request: ScriptRequest) => ScriptReply | Promise<ScriptReply>} */
  script: () => ({ text: 'no script installed' }),
  /** Every model request the scripted adapter served. */
  requests: [],
  /** Every approval question the composed answerer saw (the real ApprovalService asked it). */
  approvals: [],
  /** Answerer decision; the real ApprovalService still audits and normalizes it. */
  approvalAnswer: 'allowed-once',
  /** Optional hook run inside the answerer before it answers (e.g. revoke the delegation). */
  onApproval: undefined,
  /** Registers lifecycle-probe's late agent/created hook; returns its disposer. */
  armLateAgentCreated: undefined,
  /** What lifecycle-probe observed. */
  lifecycle: [],
}

export function resetState() {
  state.script = () => ({ text: 'no script installed' })
  state.requests = []
  state.approvals = []
  state.approvalAnswer = 'allowed-once'
  state.onApproval = undefined
  state.lifecycle = []
}

/**
 * @typedef {object} ScriptRequest
 * @property {'main' | 'child' | 'aux'} kind
 * @property {string} sessionId
 * @property {string} system concatenated system text
 * @property {string} firstUser first user text
 * @property {string[]} toolNames
 * @property {Array<{ role: string, text: string, name?: string }>} messages flattened
 * @property {{ role: string, text: string } | undefined} last
 * @property {number} toolResults number of tool results so far
 * @property {AbortSignal | undefined} signal
 */
/** @typedef {{ text: string } | { tool: string, args: object }} ScriptReply */
