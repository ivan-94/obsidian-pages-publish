/**
 * Lets a UI discard stale asynchronous results after its underlying target
 * (configuration, account, or connection) changes.
 */
export class LatestAsyncValue<T> {
  private generation = 0;

  invalidate(): void {
    this.generation += 1;
  }

  async resolve(action: () => Promise<T>): Promise<T | undefined> {
    const generation = ++this.generation;
    try {
      const value = await action();
      return generation === this.generation ? value : undefined;
    } catch (error) {
      if (generation !== this.generation) return undefined;
      throw error;
    }
  }
}
