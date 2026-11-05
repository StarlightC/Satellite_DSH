// A composed `approval/request` answerer: the deterministic stand-in for the
// human who answers the prompt. It does NOT replace the approval service — the
// real `@deepseek-ai/dsh-user-approval` row still applies session policy, writes
// the `approval/asked` + `approval/decided` audit pair, races the signal, and
// normalizes the outcome. This row only answers the question it is asked.
import { state } from './script-state.mjs'

export const name = 'satellite-approval-answerer'
export const inject = ['approval', 'agents']

export function apply(ctx) {
  ctx.on('approval/request', async (req, next) => {
    // Record whether the asking agent is the exact live registry identity at ask time.
    state.approvals.push({
      toolName: req.toolName, callId: req.callId, reason: req.reason, agentId: req.agent?.id,
      live: req.agent !== undefined && ctx.get('agents').get(req.agent.id) === req.agent,
    })
    if (state.onApproval) await state.onApproval(req)
    if (state.approvalAnswer === 'next') return next()
    return state.approvalAnswer
  })
}
