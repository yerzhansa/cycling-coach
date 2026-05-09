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
              event: "reference_mutex_hot",
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
