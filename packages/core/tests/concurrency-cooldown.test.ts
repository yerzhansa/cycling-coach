// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import { describe, it, expect } from "vitest";
import { Cooldown } from "../src/concurrency/cooldown.js";

describe("Cooldown", () => {
  it("returns ok for the first check on a previously-unseen key", () => {
    const cd = new Cooldown();
    expect(cd.check("chat-1", 30_000)).toEqual({ ok: true });
  });

  it("returns retryAfterMs when the same key is checked within the window after record", () => {
    let now = 1_000_000;
    const cd = new Cooldown(() => now);
    cd.record("chat-1");
    now += 5_000;
    const r = cd.check("chat-1", 30_000);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryAfterMs).toBe(25_000);
    }
  });

  it("returns ok again once the window has elapsed", () => {
    let now = 1_000_000;
    const cd = new Cooldown(() => now);
    cd.record("chat-1");
    now += 30_000;
    expect(cd.check("chat-1", 30_000)).toEqual({ ok: true });
  });

  it("tracks each key independently", () => {
    let now = 1_000_000;
    const cd = new Cooldown(() => now);
    cd.record("chat-1");
    expect(cd.check("chat-1", 30_000).ok).toBe(false);
    expect(cd.check("chat-2", 30_000)).toEqual({ ok: true });
  });

  it("clamps elapsed to non-negative when the clock skews backwards (NTP correction)", () => {
    let now = 1_000_000;
    const cd = new Cooldown(() => now);
    cd.record("chat-1");
    // Clock jumps back 5 seconds before the next check.
    now -= 5_000;
    const r = cd.check("chat-1", 30_000);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Without the clamp this would be 35_000 (windowMs - negative-elapsed).
      expect(r.retryAfterMs).toBe(30_000);
    }
  });
});
