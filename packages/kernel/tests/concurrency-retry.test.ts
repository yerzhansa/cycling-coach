import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseRetryAfterMs,
  retryAfterMsFromHeaders,
  retryWithBackoff,
} from "../src/concurrency/retry.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Retry-After handling", () => {
  it("parses Retry-After at the raw header seam", () => {
    const now = Date.UTC(1998, 0, 2, 3, 4, 5);
    expect(retryAfterMsFromHeaders({}, now)).toBeNull();
    expect(retryAfterMsFromHeaders({ "ReTrY-AfTeR": "120" }, now)).toBe(120_000);
    expect(retryAfterMsFromHeaders({ "Retry-After": "1", "retry-after": "2" }, now)).toBeNull();
    expect(
      retryAfterMsFromHeaders(Object.create({ "Retry-After": "3" }) as Record<string, string>, now),
    ).toBeNull();

    expect(parseRetryAfterMs(null, now)).toBeNull();
    expect(parseRetryAfterMs("", now)).toBeNull();
    expect(parseRetryAfterMs("0", now)).toBe(0);
    expect(parseRetryAfterMs("120", now)).toBe(120_000);
    expect(parseRetryAfterMs("\t 120 \t", now)).toBe(120_000);
    expect(parseRetryAfterMs(String(Number.MAX_SAFE_INTEGER), now)).toBeNull();
    for (const malformed of [
      "1.5",
      "+1",
      "1e2",
      "1,000",
      "1 2",
      "\r120",
      "120\n",
      "\v120",
      "120\f",
      "\u00a0120",
      "120\u2003",
    ]) {
      expect(parseRetryAfterMs(malformed, now), malformed).toBeNull();
    }

    expect(parseRetryAfterMs("Fri, 02 Jan 1998 03:05:05 GMT", now)).toBe(60_000);
    expect(parseRetryAfterMs("Fri, 02 Jan 1998 03:03:05 GMT", now)).toBe(0);
    expect(parseRetryAfterMs("Tue, 29 Feb 2000 00:00:00 GMT", Date.UTC(2000, 1, 28))).toBe(
      86_400_000,
    );
    for (const malformed of [
      "Mon, 29 Feb 1999 00:00:00 GMT",
      "Thu, 02 Jan 1998 03:05:05 GMT",
      "Friday, 02-Jan-98 03:05:05 GMT",
      "Fri Jan  2 03:05:05 1998",
      "Fri, 02 Jan 1998 03:05:05 UTC",
      "Fri, 02 Jan 1998 03:05:05 gmt",
    ]) {
      expect(parseRetryAfterMs(malformed, now), malformed).toBeNull();
    }

    for (const invalidClock of [-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseRetryAfterMs("0", invalidClock)).toThrowError(
        new TypeError("invalid retry clock"),
      );
      expect(() => retryAfterMsFromHeaders({}, invalidClock)).toThrowError(
        new TypeError("invalid retry clock"),
      );
    }
  });

  it("preserves an opt-in server lower bound above the local cap", async () => {
    const delays: number[] = [];
    const run = (retryAfterMode?: "cap" | "lower-bound") => {
      const fn = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error("busy"))
        .mockResolvedValue("ok");
      return retryWithBackoff(fn, {
        attempts: 2,
        baseMs: 100,
        capMs: 30_000,
        shouldRetry: () => true,
        retryAfterMs: () => 120_000,
        retryAfterMode,
        random: () => 0.5,
        sleep: async (delay) => {
          delays.push(delay);
        },
      });
    };

    await expect(run("lower-bound")).resolves.toBe("ok");
    await expect(run()).resolves.toBe("ok");
    expect(delays).toEqual([120_500, 30_000]);
  });

  it("rejects invalid callback hints before retry visibility or sleep", async () => {
    for (const hint of [-1, 1.5, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY]) {
      const onRetry = vi.fn();
      const sleep = vi.fn(async () => undefined);
      await expect(
        retryWithBackoff(
          async () => {
            throw new Error("busy");
          },
          {
            attempts: 2,
            baseMs: 1,
            capMs: 2,
            shouldRetry: () => true,
            retryAfterMs: () => hint,
            random: () => 0.5,
            onRetry,
            sleep,
          },
        ),
      ).rejects.toThrow("invalid retry-after delay");
      expect(onRetry).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    }

    await expect(
      retryWithBackoff(
        async () => {
          throw new Error("busy");
        },
        {
          attempts: 2,
          baseMs: 1,
          capMs: 2,
          shouldRetry: () => true,
          retryAfterMs: () => 1,
          retryAfterMode: "invalid" as "cap",
        },
      ),
    ).rejects.toThrow("invalid retry-after mode");
  });

  it("aborts a scheduled long hint before another attempt", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const attemptError = new Error("busy");
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(attemptError);
    const onRetry = vi.fn();
    const promise = retryWithBackoff(fn, {
      attempts: 3,
      baseMs: 1,
      capMs: 30_000,
      shouldRetry: () => true,
      retryAfterMs: () => 120_000,
      retryAfterMode: "lower-bound",
      random: () => 0.5,
      signal: controller.signal,
      onRetry,
    });
    const settled = promise.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0]).toMatchObject({ delayMs: 120_500 });
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    await expect(settled).resolves.toBe(attemptError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
