// DSH 0.2.2 moved `ctx.tools.execute` behind a plugin-owned batch executor.
// Tests drive one call through the shared native pipeline (pre-execute policy,
// guards, body, finalizers) without a model executor.
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'

export async function executeTool(ctx, input) {
  const pipeline = new ToolExecutionPipeline(ctx)
  const prepared = await pipeline.prepare(input)
  const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared
  return pipeline.complete(prepared.exec, outcome)
}
