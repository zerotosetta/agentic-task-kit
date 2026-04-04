import { randomUUID } from "node:crypto";

import { toWorkflowCancellationError } from "./errors.js";
import type {
  WorkflowCancellation,
  WorkflowRuntimeController
} from "./types.js";

export class WorkflowRunControl implements WorkflowCancellation {
  private readonly abortController = new AbortController();
  private active = true;

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get reason(): unknown {
    return this.abortController.signal.reason;
  }

  isCancellationRequested(): boolean {
    return this.abortController.signal.aborted;
  }

  throwIfRequested(): void {
    if (!this.abortController.signal.aborted) {
      return;
    }

    throw toWorkflowCancellationError(this.abortController.signal.reason);
  }

  cancel(reason?: unknown): boolean {
    if (this.abortController.signal.aborted) {
      return false;
    }

    this.abortController.abort(toWorkflowCancellationError(reason));
    return true;
  }

  complete(): void {
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }
}

class GlobalWorkflowRuntimeController implements WorkflowRuntimeController {
  private readonly runs = new Map<string, WorkflowRunControl>();

  register(run: WorkflowRunControl): () => void {
    const key = randomUUID();
    this.runs.set(key, run);

    return () => {
      this.runs.delete(key);
    };
  }

  hasActiveRuns(): boolean {
    for (const run of this.runs.values()) {
      if (run.isActive()) {
        return true;
      }
    }

    return false;
  }

  async cancelActiveRuns(reason?: string): Promise<number> {
    let cancelled = 0;
    for (const run of this.runs.values()) {
      if (!run.isActive()) {
        continue;
      }

      if (run.cancel(reason)) {
        cancelled += 1;
      }
    }

    return cancelled;
  }
}

const globalWorkflowRuntimeController = new GlobalWorkflowRuntimeController();

export function getGlobalWorkflowRuntimeController(): WorkflowRuntimeController {
  return globalWorkflowRuntimeController;
}

export function registerGlobalWorkflowRun(run: WorkflowRunControl): () => void {
  return globalWorkflowRuntimeController.register(run);
}
