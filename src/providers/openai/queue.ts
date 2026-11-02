export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly resolvers: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private closed = false;
  private failed = false;
  private failure: unknown;

  constructor(private readonly onReturn?: () => void) {}

  push(value: T): void {
    if (this.closed || this.failed) {
      return;
    }

    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver.resolve({ value, done: false });
      return;
    }

    this.values.push(value);
  }

  close(): void {
    if (this.closed || this.failed) {
      return;
    }

    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      resolver?.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.closed || this.failed) {
      return;
    }

    this.failed = true;
    this.failure = error;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      resolver?.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length > 0) {
          return Promise.resolve({
            value: this.values.shift() as T,
            done: false,
          });
        }

        if (this.failed) {
          return Promise.reject(this.failure);
        }

        if (this.closed) {
          return Promise.resolve({
            value: undefined,
            done: true,
          });
        }

        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.resolvers.push({ resolve, reject });
        });
      },
      return: async () => {
        const wasOpen = !this.closed && !this.failed;
        this.values.length = 0;
        this.close();
        this.closed = true;
        this.failed = false;
        this.failure = undefined;
        if (wasOpen) this.onReturn?.();
        return { value: undefined, done: true };
      },
    };
  }
}
