// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

/**
 * Non-reentrant async mutex per ADR-0011. Single-owner with a FIFO waiter
 * queue. Each waiter has its own acquire-timeout — timed-out waiters never
 * acquire the lock and never run the body. `runExclusive` is the only
 * public API; ownership state is private.
 */

interface Waiter {
  signalAcquired: () => void;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  acquired: boolean;
  timedOut: boolean;
}

export class AsyncMutex {
  private heldBy: Waiter | null = null;
  private waiters: Waiter[] = [];

  isHeld(): boolean {
    return this.heldBy !== null;
  }

  async runExclusive<T>(
    fn: () => Promise<T>,
    opts: { acquireTimeoutMs: number; hotWarnMs: number; caller: string },
  ): Promise<{ kind: "ran"; value: T } | { kind: "timeout" }> {
    // Fail-loud at the boundary so future horizontal layers (Decision,
    // Heartbeat, Coaching Loop) can't silently misconfigure timing.
    // Reference's freshness.ts hard-codes valid values today; this guard is
    // for the multi-consumer future ADR-0011 explicitly anticipates.
    if (!Number.isFinite(opts.acquireTimeoutMs) || opts.acquireTimeoutMs <= 0) {
      throw new Error(
        `AsyncMutex: acquireTimeoutMs must be a finite positive number; got ${opts.acquireTimeoutMs}`,
      );
    }
    if (!Number.isFinite(opts.hotWarnMs) || opts.hotWarnMs < 0) {
      throw new Error(
        `AsyncMutex: hotWarnMs must be a finite non-negative number; got ${opts.hotWarnMs}`,
      );
    }
    if (opts.hotWarnMs >= opts.acquireTimeoutMs) {
      throw new Error(
        `AsyncMutex: hotWarnMs (${opts.hotWarnMs}) must be less than acquireTimeoutMs (${opts.acquireTimeoutMs}); the warn would never fire before the timeout`,
      );
    }

    const enqueuedAt = Date.now();
    const waiter: Waiter = {
      signalAcquired: () => {},
      timeoutHandle: null,
      acquired: false,
      timedOut: false,
    };
    let hotWarnHandle: ReturnType<typeof setTimeout> | null = null;
    const clearHotWarn = () => {
      if (hotWarnHandle !== null) {
        clearTimeout(hotWarnHandle);
        hotWarnHandle = null;
      }
    };

    const acquired = await new Promise<boolean>((resolve) => {
      waiter.signalAcquired = () => {
        if (waiter.timedOut) return;
        waiter.acquired = true;
        if (waiter.timeoutHandle !== null) {
          clearTimeout(waiter.timeoutHandle);
          waiter.timeoutHandle = null;
        }
        clearHotWarn();
        resolve(true);
      };
      waiter.timeoutHandle = setTimeout(() => {
        if (waiter.acquired) return;
        waiter.timedOut = true;
        clearHotWarn();
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(false);
      }, opts.acquireTimeoutMs);

      if (this.heldBy === null) {
        this.heldBy = waiter;
        waiter.signalAcquired();
      } else {
        this.waiters.push(waiter);
        hotWarnHandle = setTimeout(() => {
          console.warn(
            JSON.stringify({
              event: "mutex_hot",
              wait_ms: Date.now() - enqueuedAt,
              caller: opts.caller,
              ts: new Date().toISOString(),
            }),
          );
        }, opts.hotWarnMs);
      }
    });

    if (!acquired) return { kind: "timeout" };

    try {
      const value = await fn();
      return { kind: "ran", value };
    } finally {
      if (this.heldBy === waiter) {
        this.heldBy = null;
        const next = this.waiters.shift();
        if (next !== undefined) {
          this.heldBy = next;
          next.signalAcquired();
        }
      }
    }
  }
}
