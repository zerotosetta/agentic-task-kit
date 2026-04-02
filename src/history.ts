import type {
  ExecutionEvent,
  ExecutionHistorySnapshot,
  ExecutionHistoryTracker,
  TaskLogEvent
} from "./types.js";

class InMemoryExecutionHistoryTracker implements ExecutionHistoryTracker {
  private readonly events: ExecutionEvent[] = [];
  private readonly taskLogs: TaskLogEvent[] = [];
  private readonly listeners = new Set<(snapshot: ExecutionHistorySnapshot) => void>();
  private updatedAt: number | undefined;

  onEvent(event: ExecutionEvent): void {
    this.events.push(event);
    this.updatedAt = event.timestamp;
    this.notify();
  }

  onTaskLog(event: TaskLogEvent): void {
    this.taskLogs.push(event);
    this.updatedAt = event.timestamp;
    this.notify();
  }

  snapshot(): ExecutionHistorySnapshot {
    return {
      events: [...this.events],
      taskLogs: [...this.taskLogs],
      ...(this.updatedAt !== undefined ? { updatedAt: this.updatedAt } : {})
    };
  }

  subscribe(listener: (snapshot: ExecutionHistorySnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());

    return () => {
      this.listeners.delete(listener);
    };
  }

  reset(): void {
    this.events.length = 0;
    this.taskLogs.length = 0;
    this.updatedAt = undefined;
    this.notify();
  }

  private notify(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

export function createExecutionHistoryTracker(): ExecutionHistoryTracker {
  return new InMemoryExecutionHistoryTracker();
}
