/**
 * buffer — decouple upstream from downstream with a bounded async queue.
 *
 * Without this, composed `async function*` chains are lazy-pull: each stage
 * sits idle until downstream asks for the next item. `buffer(stream, N)`
 * eagerly drains up to N items from `stream` in parallel with whatever
 * downstream is doing, so stages can run concurrently on different items.
 *
 * This is the piece that makes pipeline-stage concurrency work. Every stage
 * itself stays a plain `async function*` — pure transform, no concurrency
 * machinery of its own.
 */
export async function* buffer<T>(
  source: AsyncIterable<T>,
  size: number,
): AsyncIterable<T> {
  // Infinity = unbounded (upstream never blocks). Otherwise min 1.
  const capacity = size === Number.POSITIVE_INFINITY ? size : Math.max(1, size);
  const iter = source[Symbol.asyncIterator]();
  const queue: T[] = [];
  let done = false;
  let upstreamError: unknown;

  // Promise that resolves whenever the queue state changes.
  let notify: (() => void) | null = null;
  const wait = () => new Promise<void>((resolve) => { notify = resolve; });
  const fire = () => {
    const n = notify;
    notify = null;
    if (n) n();
  };

  // Eager drainer — pulls from source, pushes into queue up to capacity.
  (async () => {
    try {
      while (!done) {
        if (queue.length >= capacity) {
          await wait();
          continue;
        }
        const step = await iter.next();
        if (step.done) {
          done = true;
          break;
        }
        queue.push(step.value);
        fire();
      }
    } catch (err) {
      upstreamError = err;
      done = true;
    }
    fire();
  })();

  while (true) {
    if (queue.length > 0) {
      const item = queue.shift()!;
      fire();
      yield item;
      continue;
    }
    if (done) {
      if (upstreamError) throw upstreamError;
      return;
    }
    await wait();
  }
}

/**
 * parallelMap — bounded-concurrency async-generator transform.
 *
 * Takes an upstream `AsyncIterable<T>` and a per-item async function, runs up
 * to `concurrency` items in flight simultaneously, and yields results
 * **in completion order** (not input order). Use `ordered: true` to preserve
 * input order at the cost of head-of-line blocking when a slow item stalls
 * the queue.
 *
 * Errors thrown by the mapper don't kill the stream; they're surfaced by the
 * mapper returning a PipelineItem whose `error` field is set. That's the
 * convention every stage follows, so parallelMap itself doesn't need
 * try/catch semantics baked in.
 *
 * The generator drains upstream lazily — it only pulls the next input when
 * there's room in the concurrency window.
 */

export interface ParallelMapOptions {
  /** Max number of items in flight at once. Default 4. */
  readonly concurrency?: number;
  /** Preserve input order in the output stream. Default false (completion order). */
  readonly ordered?: boolean;
}

export async function* parallelMap<T, U>(
  source: AsyncIterable<T>,
  fn: (item: T) => Promise<U>,
  opts: ParallelMapOptions = {},
): AsyncIterable<U> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);

  if (opts.ordered) {
    yield* orderedParallelMap(source, fn, concurrency);
    return;
  }

  yield* unorderedParallelMap(source, fn, concurrency);
}

/** Unordered: yield whatever finishes first. Maximizes throughput. */
async function* unorderedParallelMap<T, U>(
  source: AsyncIterable<T>,
  fn: (item: T) => Promise<U>,
  concurrency: number,
): AsyncIterable<U> {
  const iter = source[Symbol.asyncIterator]();
  type Entry = { readonly id: number; readonly p: Promise<{ id: number; value: U }> };
  const inFlight = new Map<number, Entry>();
  let nextId = 0;
  let done = false;

  async function startNext(): Promise<void> {
    if (done) return;
    const step = await iter.next();
    if (step.done) {
      done = true;
      return;
    }
    const id = nextId++;
    const p = fn(step.value).then((value) => ({ id, value }));
    inFlight.set(id, { id, p });
  }

  // Prime the window.
  for (let i = 0; i < concurrency; i++) await startNext();

  while (inFlight.size > 0) {
    const winner = await Promise.race(Array.from(inFlight.values()).map((e) => e.p));
    inFlight.delete(winner.id);
    yield winner.value;
    if (!done) await startNext();
  }
}

/** Ordered: yield in input order. Head-of-line blocking if one item is slow. */
async function* orderedParallelMap<T, U>(
  source: AsyncIterable<T>,
  fn: (item: T) => Promise<U>,
  concurrency: number,
): AsyncIterable<U> {
  const iter = source[Symbol.asyncIterator]();
  const queue: Promise<U>[] = [];
  let done = false;

  async function fillQueue(): Promise<void> {
    while (queue.length < concurrency && !done) {
      const step = await iter.next();
      if (step.done) {
        done = true;
        return;
      }
      queue.push(fn(step.value));
    }
  }

  await fillQueue();
  while (queue.length > 0) {
    const next = queue.shift()!;
    const value = await next;
    await fillQueue();
    yield value;
  }
}

/**
 * Merge several upstream generators into a single stream. Yields in whatever
 * order items arrive across sources.
 */
export async function* merge<T>(
  ...sources: ReadonlyArray<AsyncIterable<T>>
): AsyncIterable<T> {
  if (sources.length === 0) return;
  if (sources.length === 1) {
    yield* sources[0];
    return;
  }
  type Slot = { readonly idx: number; iter: AsyncIterator<T>; p: Promise<{ idx: number; result: IteratorResult<T> }> };
  const slots: (Slot | null)[] = sources.map((src, idx) => {
    const iter = src[Symbol.asyncIterator]();
    return { idx, iter, p: iter.next().then((result) => ({ idx, result })) };
  });
  let alive = slots.length;
  while (alive > 0) {
    const live = slots.filter((s): s is Slot => s !== null);
    const winner = await Promise.race(live.map((s) => s.p));
    const slot = slots[winner.idx];
    if (!slot) continue;
    if (winner.result.done) {
      slots[winner.idx] = null;
      alive--;
    } else {
      yield winner.result.value;
      slot.p = slot.iter.next().then((result) => ({ idx: winner.idx, result }));
    }
  }
}
