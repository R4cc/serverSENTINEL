/** Serializes a file's saves and lease changes without holding a SQLite transaction across I/O. */
export class FileEditCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(serverId: string, path: string, action: () => Promise<T> | T): Promise<T> {
    const key = JSON.stringify([serverId, path]);
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(action);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
