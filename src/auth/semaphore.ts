/**
 * A small counting semaphore with a bounded queue.
 * Password hashing uses it: each scrypt run takes 64 MiB and a CPU core, so
 * a burst of sign-in posts must wait its turn instead of exhausting the box.
 */
export class QueueFullError extends Error {
  constructor() {
    super("Too many operations are waiting");
    this.name = "QueueFullError";
  }
}

export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private limit: number,
    private maxQueue: number,
  ) {
    this.setLimit(limit, maxQueue);
  }

  setLimit(limit: number, maxQueue = this.maxQueue): void {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Semaphore limit must be a whole number of at least 1");
    if (!Number.isInteger(maxQueue) || maxQueue < 0) throw new Error("Semaphore queue must be a whole number");
    this.limit = limit;
    this.maxQueue = maxQueue;
    while (this.active < this.limit && this.waiting.length > 0) {
      this.active += 1;
      this.waiting.shift()?.();
    }
  }

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  /** Run fn when a slot is free. Throws QueueFullError at once when the queue is full. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      if (this.waiting.length >= this.maxQueue) throw new QueueFullError();
      // The slot is handed over by release(), which already counted it.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
}
