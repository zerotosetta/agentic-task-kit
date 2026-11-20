import { advanceInput, initializeDurable, resumeDurable, runDurable } from "../durable-execution.js";
import { sameSnapshot, validateSnapshot } from "../durable-validation.js";
import type { DurableCheckpoint, DurableExecutionStore, DurableRunResult } from "../types/durable.js";
import type { McpWorkflowPlan } from "../types/mcp.js";
import { McpWorkflowError } from "./config.js";

export function requireMatchingInput(plan: McpWorkflowPlan, checkpoint: DurableCheckpoint): void {
  const expected = validateSnapshot(plan.input, checkpoint);
  if (!sameSnapshot(checkpoint.input, expected)) {
    throw new McpWorkflowError("INPUT_SNAPSHOT_MISMATCH", "The plugin input differs from the current committed snapshot.");
  }
}

export async function executePlan(
  runId: string,
  store: DurableExecutionStore,
  plan: McpWorkflowPlan,
  checkpoint: DurableCheckpoint | null,
  stepLimit: number | undefined,
  signal: AbortSignal,
  assertActive: () => void,
): Promise<DurableRunResult> {
  if (stepLimit !== undefined && (!Number.isSafeInteger(stepLimit) || stepLimit < 1)) {
    throw new McpWorkflowError("INVALID_INPUT", "maxSteps must be a positive safe integer.");
  }
  const { workflow, prepareNext, pauseBefore } = plan;
  let remaining = stepLimit ?? Infinity;
  let latest: DurableRunResult | undefined;
  let head = checkpoint;
  if (head) requireMatchingInput(plan, head);
  let expectedInput = plan.input;
  if (!head && plan.pauseBeforeFirst && pauseBefore) {
    assertActive();
    head = await initializeDurable(workflow, { runId, store, input: expectedInput, first: plan.first });
  }

  while (true) {
    assertActive();
    if (head?.next && pauseBefore && await pauseBefore({ checkpoint: structuredClone(head), signal })) {
      assertActive();
      return { runId, status: "interrupted", checkpoint: head, error: null };
    }
    if (head?.next && prepareNext) {
      const change = await prepareNext({ checkpoint: structuredClone(head), signal });
      assertActive();
      if (change) {
        head = await advanceInput(runId, { ...change, workflow, expectedCheckpointSeq: head.checkpointSeq, store });
        expectedInput = head.input;
      }
    }

    const maxSteps = prepareNext || pauseBefore ? 1 : stepLimit;
    const options = { store, signal, ...(maxSteps === undefined ? {} : { maxSteps }) };
    const previousSeq = head?.checkpointSeq ?? 0;
    assertActive();
    if (head) {
      latest = await resumeDurable(runId, {
        ...options,
        workflow,
        expectedInput,
        expectedCheckpointSeq: head.checkpointSeq,
      });
    } else {
      latest = await runDurable(workflow, { ...options, input: expectedInput, first: plan.first, runId });
    }
    const committed = latest.checkpoint.checkpointSeq - previousSeq;
    remaining -= committed;
    if (latest.status !== "interrupted" || committed === 0 || remaining <= 0 || (!prepareNext && !pauseBefore)) return latest;
    head = latest.checkpoint;
    expectedInput = head.input;
  }
}
