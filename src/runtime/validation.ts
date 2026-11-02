import type { TaskResult, WorkflowDefinition, WorkflowInput } from "../types.js";

const PHASES = new Set(["PLANNING", "EXECUTION", "REFLECTION", "RECOVERY"]);
const TASK_TYPES = new Set(["user", "workflow", "debug", "default"]);

export function assertWorkflowInput(input: unknown): asserts input is WorkflowInput {
  if (!(input instanceof Map) || [...input.keys()].some((key) => typeof key !== "string")) {
    throw new TypeError(
      "Workflow input must be a Map with string keys. Use createWorkflowInput().",
    );
  }
}

export function validateWorkflow(key: string, workflow: WorkflowDefinition): void {
  const invalid = (message: string): never => {
    throw new TypeError(`Invalid workflow "${key}": ${message}`);
  };
  if (typeof key !== "string" || !key.trim()) invalid("registration key must be non-empty.");
  if (!workflow || typeof workflow.name !== "string" || !workflow.name.trim())
    invalid("name must be non-empty.");
  if (!workflow.tasks || typeof workflow.tasks !== "object" || Array.isArray(workflow.tasks))
    invalid("tasks must be a state-to-task object.");
  if (
    !workflow.transitions ||
    typeof workflow.transitions !== "object" ||
    Array.isArray(workflow.transitions)
  )
    invalid("transitions must be an object.");
  const end = workflow.end ?? "end";
  const checkState = (state: unknown): void => {
    if (
      typeof state !== "string" ||
      !state ||
      (state !== end && !Object.hasOwn(workflow.tasks, state))
    ) {
      invalid(`unknown state ${JSON.stringify(state)}.`);
    }
  };
  checkState(workflow.start);
  for (const [state, task] of Object.entries(workflow.tasks)) {
    if (
      !task ||
      typeof task.name !== "string" ||
      !task.name.trim() ||
      typeof task.run !== "function"
    )
      invalid(`task at "${state}" must have a name and run() method.`);
    if (!PHASES.has(task.memoryPhase) || !TASK_TYPES.has(task.memoryTaskType))
      invalid(`task "${task.name}" has invalid memory metadata.`);
    for (const hook of [task.before, task.after]) {
      if (hook !== undefined && typeof hook !== "function")
        invalid(`task "${task.name}" has an invalid lifecycle hook.`);
    }
  }
  for (const [state, transition] of Object.entries(workflow.transitions)) {
    if (!Object.hasOwn(workflow.tasks, state))
      invalid(`transition source "${state}" is not a task state.`);
    if (typeof transition === "string") {
      checkState(transition);
      continue;
    }
    if (!transition || typeof transition !== "object" || Array.isArray(transition))
      invalid(`transition for "${state}" must be a state or status map.`);
    for (const target of Object.values(transition)) {
      if (target === undefined) continue;
      if (typeof target !== "string")
        invalid("parallel transitions are not implemented in the Foundation MVP.");
      checkState(target);
    }
  }
}

export function assertTaskResult(value: unknown, taskName: string): asserts value is TaskResult {
  if (
    !value ||
    typeof value !== "object" ||
    !("status" in value) ||
    typeof value.status !== "string" ||
    !value.status.trim()
  ) {
    throw new TypeError(
      `Task "${taskName}" must return a TaskResult with a non-empty string status.`,
    );
  }
}
