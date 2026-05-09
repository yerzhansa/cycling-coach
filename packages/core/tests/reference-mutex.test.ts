// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import { describe, it, expect, vi, afterEach } from "vitest";
import { AsyncMutex } from "../src/reference/sync/mutex.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const opts = { acquireTimeoutMs: 5_000, hotWarnMs: 10_000, caller: "test" };

describe("AsyncMutex.runExclusive", () => {
  it("serializes concurrent callers — second body starts only after the first resolves", async () => {
    const mutex = new AsyncMutex();
    const events: Array<{ caller: string; phase: "start" | "end"; t: number }> = [];

    const body = (caller: string, durationMs: number) => async () => {
      events.push({ caller, phase: "start", t: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      events.push({ caller, phase: "end", t: Date.now() });
      return caller;
    };

    const [r1, r2] = await Promise.all([
      mutex.runExclusive(body("first", 50), opts),
      mutex.runExclusive(body("second", 20), opts),
    ]);

    expect(r1).toEqual({ kind: "ran", value: "first" });
    expect(r2).toEqual({ kind: "ran", value: "second" });

    const firstEnd = events.find((e) => e.caller === "first" && e.phase === "end")!.t;
    const secondStart = events.find((e) => e.caller === "second" && e.phase === "start")!.t;
    expect(secondStart).toBeGreaterThanOrEqual(firstEnd);
  });

  it("preserves FIFO order across N concurrent waiters", async () => {
    const mutex = new AsyncMutex();
    const order: string[] = [];

    const body = (caller: string) => async () => {
      order.push(caller);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return caller;
    };

    await Promise.all([
      mutex.runExclusive(body("A"), opts),
      mutex.runExclusive(body("B"), opts),
      mutex.runExclusive(body("C"), opts),
      mutex.runExclusive(body("D"), opts),
      mutex.runExclusive(body("E"), opts),
    ]);

    expect(order).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("returns { kind: 'timeout' } and does NOT run the body when acquire wait exceeds acquireTimeoutMs", async () => {
    const mutex = new AsyncMutex();
    let secondBodyRan = false;

    const slow = async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return "first";
    };

    const fast = async () => {
      secondBodyRan = true;
      return "second";
    };

    const [r1, r2] = await Promise.all([
      mutex.runExclusive(slow, { acquireTimeoutMs: 5_000, hotWarnMs: 10_000, caller: "first" }),
      mutex.runExclusive(fast, { acquireTimeoutMs: 30, hotWarnMs: 10_000, caller: "second" }),
    ]);

    expect(r1).toEqual({ kind: "ran", value: "first" });
    expect(r2).toEqual({ kind: "timeout" });
    expect(secondBodyRan).toBe(false);
  });

  it("releases the lock when the body throws so subsequent callers can run", async () => {
    const mutex = new AsyncMutex();
    let secondRan = false;

    const throwing = async () => {
      throw new Error("body fail");
    };
    const success = async () => {
      secondRan = true;
      return "second";
    };

    const p1 = mutex.runExclusive(throwing, opts);
    const p2 = mutex.runExclusive(success, opts);

    await expect(p1).rejects.toThrow("body fail");
    expect(await p2).toEqual({ kind: "ran", value: "second" });
    expect(secondRan).toBe(true);
  });

  // Regression for ADR-0011: AsyncMutex is non-reentrant. A nested call from
  // inside a held body must NOT deadlock — the inner call's own acquire
  // timeout fires and surfaces the bug as a 30s soft-skip rather than a hang.
  it("returns timeout (never deadlocks) when runExclusive is called from inside a held body", async () => {
    const mutex = new AsyncMutex();
    let innerResult: { kind: "ran"; value: string } | { kind: "timeout" } | null = null;

    const outerResult = await mutex.runExclusive(
      async () => {
        innerResult = await mutex.runExclusive(
          async () => "inner-body-ran",
          { acquireTimeoutMs: 50, hotWarnMs: 10_000, caller: "inner" },
        );
        return "outer-body-ran";
      },
      { acquireTimeoutMs: 5_000, hotWarnMs: 10_000, caller: "outer" },
    );

    expect(outerResult).toEqual({ kind: "ran", value: "outer-body-ran" });
    expect(innerResult).toEqual({ kind: "timeout" });
  });

  it("emits a structured reference_mutex_hot warn to stderr when acquire wait exceeds hotWarnMs", async () => {
    const mutex = new AsyncMutex();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const slow = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return "first";
    };
    const fast = async () => "second";

    await Promise.all([
      mutex.runExclusive(slow, {
        acquireTimeoutMs: 5_000,
        hotWarnMs: 5_000, // first never waits, never warns
        caller: "scheduled",
      }),
      mutex.runExclusive(fast, {
        acquireTimeoutMs: 5_000,
        hotWarnMs: 30, // wait > 30ms triggers warn
        caller: "/sync",
      }),
    ]);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(warnSpy.mock.calls[0]![0] as string);
    expect(payload.event).toBe("reference_mutex_hot");
    expect(payload.caller).toBe("/sync");
    expect(typeof payload.wait_ms).toBe("number");
    expect(payload.wait_ms).toBeGreaterThanOrEqual(30);
    expect(typeof payload.ts).toBe("string");
    expect(new Date(payload.ts).toString()).not.toBe("Invalid Date");
  });
});
