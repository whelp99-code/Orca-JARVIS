type Batch = { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void; controller: AbortController };

/** One running read and one shared follow-up. Transports must honor the signal and bound their own deadline. */
export function createCoalescedRefresh(load: (signal: AbortSignal) => Promise<void>) {
  let active: Batch | undefined;
  let pending: Batch | undefined;
  let closed = false;

  function request(): Promise<void> {
    if (closed) return Promise.resolve();
    if (pending) return pending.promise;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const batch: Batch = { promise, resolve, reject, controller: new AbortController() };
    // SSE notifications do not await reads. Manual callers still receive the original rejection.
    void batch.promise.catch(() => {});
    if (active) pending = batch;
    else run(batch);
    return batch.promise;
  }

  function run(batch: Batch): void {
    active = batch;
    try { void load(batch.controller.signal).then(() => finish(batch), error => finish(batch, { error })); }
    catch (error: unknown) { finish(batch, { error }); }
  }

  function finish(batch: Batch, failure?: { error: unknown }): void {
    if (active !== batch) return;
    active = undefined;
    const next = pending;
    pending = undefined;
    if (failure) batch.reject(failure.error);
    else batch.resolve();
    if (!closed && next) run(next);
  }

  function close(): void {
    closed = true;
    pending?.resolve();
    pending = undefined;
    const previous = active;
    active = undefined;
    if (previous) {
      previous.resolve();
      previous.controller.abort();
    }
  }

  return { request, close };
}
