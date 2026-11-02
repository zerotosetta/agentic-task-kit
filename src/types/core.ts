export type TaskStatus = "success" | "fail" | "retry" | "skip" | (string & {});

export type WorkflowInput = Map<string, any>;

export type ErrorSourceLocation = {
  file: string;
  line: number;
  column?: number;
  functionName?: string;
  display: string;
};

export type TaskResult<T = unknown> = {
  status: TaskStatus;
  output?: T;
  error?: {
    message: string;
    code?: string;
    details?: unknown;
  };
};
