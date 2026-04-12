/**
 * Simple async mutex. Callers await `acquire()` and MUST call the returned
 * release function in a finally. Queues in FIFO order.
 *
 * Used by cachedFetch to serialize Ollama calls across the whole process —
 * classify's LLM calls and resolveIdentity's embedding calls share a single
 * GPU on battleaxe, and letting them run concurrently causes Ollama to
 * evict and reload models repeatedly, which stalls everything.
 */
export class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return this._makeRelease();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => resolve(this._makeRelease()));
    });
  }

  private _makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        // Hand the lock directly to the next waiter (stays `locked`).
        next();
      } else {
        this.locked = false;
      }
    };
  }

  get pending(): number {
    return this.queue.length;
  }

  get isLocked(): boolean {
    return this.locked;
  }
}

/** Singleton mutex serializing all outbound Ollama calls. */
export const ollamaMutex = new Mutex();
