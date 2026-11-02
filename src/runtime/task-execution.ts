import type { TaskLike, TaskResult, WorkflowContext } from "../types.js";
import { toFailureResult } from "./errors.js";
import { assertTaskResult } from "./validation.js";

export async function executeTask(
  task: TaskLike,
  ctx: WorkflowContext,
  currentStep: string,
): Promise<TaskResult> {
  let result: TaskResult;
  try {
    ctx.cancellation.throwIfRequested();
    await task.before?.(ctx);
    ctx.cancellation.throwIfRequested();
    result = await task.run(ctx);
    assertTaskResult(result, task.name);
  } catch (error) {
    result = toFailureResult(error, ctx.cancellation);
  }
  try {
    await task.after?.(ctx, result);
  } catch (error) {
    result = toFailureResult(error, ctx.cancellation);
  }
  await ctx.memory.afterStep({
    workflowId: ctx.workflowId,
    runId: ctx.runId,
    currentStep,
    taskName: task.name,
    taskType: task.memoryTaskType,
    phase: task.memoryPhase,
    input: ctx.input,
    result,
    now: ctx.now(),
  });
  return result;
}
