// A real later `agent/created` hook. Registration happens when a scenario arms
// it (after every composed row, including Satellite, has applied), so it runs
// after Satellite's hook in the real listener order. Once armed, it records what the child looked like at that point (the
// mode Satellite already enforced) and throws, so the real subagent manager
// has to roll the creation back. It never narrows or widens anything.
import { state } from './script-state.mjs'

export const name = 'satellite-lifecycle-probe'
export const inject = ['sandboxPolicy', 'agents']

export function apply(ctx) {
  state.armLateAgentCreated = () => ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.origin !== 'subagent') return undefined
    state.lifecycle.push({
      id: agent.id,
      mode: ctx.get('sandboxPolicy').resolve({ session: agent.session })?.mode,
      live: ctx.get('agents').get(agent.id) === agent,
    })
    throw new Error('lifecycle-probe: later agent/created hook rejects')
  })
}
