/**
 * Runs tasks one at a time per key (per WhatsApp user) so two quick messages from the same person are
 * answered in order and never race on the same conversation. Different users run in parallel.
 */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly onError: (err: unknown, key: string) => void) {}

  push(key: string, task: () => Promise<void>): void {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous
      .then(task)
      .catch((err: unknown) => this.onError(err, key))
      .finally(() => {
        if (this.tails.get(key) === next) this.tails.delete(key);
      });
    this.tails.set(key, next);
  }

  /** Resolves when every queued task has finished (used for shutdown and tests). */
  async idle(): Promise<void> {
    while (this.tails.size > 0) await Promise.all(this.tails.values());
  }
}
