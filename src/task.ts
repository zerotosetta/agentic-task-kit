import type {
  MemoryPhase,
  MemoryTaskType,
  TaskLike,
  TaskResult,
  WorkflowContext
} from "./types.js";

export abstract class Task implements TaskLike {
  abstract name: string;
  abstract memoryPhase: MemoryPhase;
  abstract memoryTaskType: MemoryTaskType;

  before?(ctx: WorkflowContext): Promise<void>;

  abstract run(ctx: WorkflowContext): Promise<TaskResult>;

  after?(ctx: WorkflowContext, result: TaskResult): Promise<void>;
}
