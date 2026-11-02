import type { ExecutionEvent, ExecutionObserver, TaskLogEvent } from "./types.js";

export class ExecutionBroadcaster {
  private readonly observers: Set<ExecutionObserver>;
  private readonly pending = new Set<Promise<void>>();
  private readonly pendingErrors: unknown[] = [];

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
    await this.dispatch((observer) => observer.start?.());
  }

  async emit(event: ExecutionEvent): Promise<void> {
    await this.dispatch((observer) => observer.onEvent(event));
  }

  async emitTaskLog(event: TaskLogEvent): Promise<void> {
    await this.dispatch((observer) => observer.onTaskLog?.(event));
  }

  // TaskLogger is synchronous. Track its async deliveries so flush can await
  // them and report failures without creating unhandled promise rejections.
  enqueue(operation: Promise<void>): void {
    this.pending.add(operation);
    void operation
      .catch((error) => {
        this.pendingErrors.push(error);
      })
      .finally(() => {
        this.pending.delete(operation);
      });
  }

  async flush(): Promise<void> {
    await this.drain();
    await this.dispatch((observer) => observer.onFlush?.());
  }

  async stop(finalStatus?: "success" | "fail"): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.drain();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.dispatch((observer) => observer.stop?.(finalStatus));
    } catch (error) {
      errors.push(error);
    }
    this.throwFailures(errors);
  }

  private async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    this.throwFailures(this.pendingErrors.splice(0));
  }

  private async dispatch(
    deliver: (observer: ExecutionObserver) => void | Promise<void>,
  ): Promise<void> {
    const results = await Promise.allSettled(
      [...this.observers].map(async (observer) => deliver(observer)),
    );
    this.throwFailures(
      results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason),
    );
  }

  private throwFailures(errors: unknown[]): void {
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Multiple execution observers failed.");
  }
}
