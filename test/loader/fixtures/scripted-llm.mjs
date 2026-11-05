// Keyless deterministic model provider for the Satellite Loader integration
// test, modelled on DSH's loader-smoke `cli-mock-llm` fixture. It registers the
// `deepseek-official` route (the real `llm-deepseek` row is disabled by the
// overlay) and answers every request from the scenario script in script-state.
// @deepseek-ai/dsh-llm is the installation's own instance, handed over by the
// test before boot (this fixture lives outside the DSH dependency tree).
import { state } from './script-state.mjs'

const { LlmAdapter, ReasoningEffortId, ToolCallId } = state.dshLlm
const HIGH = ReasoningEffortId('high')
let callSeq = 0

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    if (block?.type === 'text') return block.text
    if (block?.type === 'tool-result' || block?.type === 'tool_result') return textOf(block.content)
    return ''
  }).join('')
}

function describe(options) {
  const messages = (options.messages ?? []).map((message) => ({
    role: message.role,
    text: textOf(message.content),
    ...(message.role === 'tool' && message.name ? { name: message.name } : {}),
  }))
  const system = [options.system ?? '', ...messages.filter((m) => m.role === 'system').map((m) => m.text)].join('\n')
  const firstUser = messages.find((m) => m.role === 'user')?.text ?? ''
  const kind = options.purpose !== undefined
    ? 'aux'
    : firstUser.startsWith('本次节点任务：') || firstUser.startsWith('原始节点任务：') ? 'child' : 'main'
  return {
    kind,
    sessionId: String(options.sessionId ?? ''),
    purpose: options.purpose,
    system,
    firstUser,
    toolNames: (options.tools ?? []).map((tool) => tool.name),
    messages,
    last: messages.at(-1),
    toolResults: messages.filter((m) => m.role === 'tool').length,
    signal: options.signal,
  }
}

class ScriptedAdapter extends LlmAdapter {
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: HIGH, name: 'High' }], defaultEffort: HIGH } }
  }

  async * stream(options) {
    const request = describe(options)
    state.requests.push(request)
    const reply = request.kind === 'aux' ? { text: 'title' } : await state.script(request)
    if (options.signal?.aborted) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'ABORTED', message: 'aborted' } } }
      return
    }
    if ('tool' in reply) {
      const id = ToolCallId(`scripted-${++callSeq}`)
      const args = JSON.stringify(reply.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: reply.tool, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: reply.tool, arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply.text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'satellite-scripted-llm'
export const inject = ['llm']

export function apply(ctx) {
  ctx.llm.registerAdapter(['deepseek-official'], new ScriptedAdapter())
}
