// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

/**
 * Per-key cooldown tracker for `/sync` rate-limiting. In-process by design
 * (Decision 5 in F4 spec) — Reference is single-operator; restart-spam is
 * bounded by mutex serialization + intervals.icu's server-side rate-limit.
 *
 * `check` is observation only; `record` stamps the success path. The
 * runSync caller pattern is: check → if ok, record after the sync settles.
 */
export class Cooldown {
  private readonly timestamps = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  check(key: string, windowMs: number): { ok: true } | { ok: false; retryAfterMs: number } {
    const last = this.timestamps.get(key);
    if (last === undefined) return { ok: true };
    const elapsed = this.now() - last;
    if (elapsed >= windowMs) return { ok: true };
    return { ok: false, retryAfterMs: windowMs - elapsed };
  }

  record(key: string): void {
    this.timestamps.set(key, this.now());
  }
}
