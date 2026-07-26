/**
 * FIFO rate limiter enforcing a minimum interval between call *starts*.
 * Volcengine's Visual/CV OpenAPI defaults to 2 QPS on most endpoints and
 * hard-rejects anything faster — this applies to submit AND poll calls
 * against the same service, so every caller must share one limiter instance
 * per provider/service to actually bound the combined rate.
 */
export function createRateLimiter(minIntervalMs: number) {
  let lastRunAt = 0;
  let queue: Promise<void> = Promise.resolve();

  return function schedule<T>(fn: () => Promise<T>): Promise<T> {
    const runPromise = queue.then(async () => {
      const wait = Math.max(0, lastRunAt + minIntervalMs - Date.now());
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastRunAt = Date.now();
      return fn();
    });
    // Keep the queue chain alive even if a scheduled call rejects.
    queue = runPromise.then(
      () => undefined,
      () => undefined,
    );
    return runPromise;
  };
}
