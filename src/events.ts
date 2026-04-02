import type {
  ExecutionEvent,
  ExecutionObserver,
  TaskLogEvent
} from "./types.js";

export class ExecutionBroadcaster {
  private readonly observers: Set<ExecutionObserver>;

  constructor(observers: ExecutionObserver[] = []) {
    this.observers = new Set(observers);
  }

  addObserver(observer: ExecutionObserver): void {
    this.observers.add(observer);
  }

  removeObserver(observer: ExecutionObserver): void {
    this.observers.delete(observer);
  }

  listObservers(): ExecutionObserver[] {
    return [...this.observers];
  }

  async start(): Promise<void> {
    await Promise.all(
      [...this.observers].map(async (observer) => {
        if ("start" in observer && typeof observer.start === "function") {
          observer.start();
        }
      })
    );
  }

  async emit(event: ExecutionEvent): Promise<void> {
    await Promise.all([...this.observers].map((observer) => observer.onEvent(event)));
  }

  async emitTaskLog(event: TaskLogEvent): Promise<void> {
    await Promise.all(
      [...this.observers].map(async (observer) => {
        if (observer.onTaskLog) {
          await observer.onTaskLog(event);
        }
      })
    );
  }

  async flush(): Promise<void> {
    await Promise.all(
      [...this.observers].map(async (observer) => {
        if (observer.onFlush) {
          await observer.onFlush();
        }
      })
    );
  }

  async stop(finalStatus?: "success" | "fail"): Promise<void> {
    await Promise.all(
      [...this.observers].map(async (observer) => {
        if ("stop" in observer && typeof observer.stop === "function") {
          observer.stop(finalStatus);
        }
      })
    );
  }
}
