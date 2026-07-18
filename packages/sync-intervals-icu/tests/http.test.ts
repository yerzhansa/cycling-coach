import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpPort, HttpResponse } from "@enduragent/kernel/ports";
import { createPhysicalRequestLedger, type PhysicalRequestLedger, type SyncBudget } from "@enduragent/kernel/store";
import { makeIntervalsHttpFactory } from "../../core/src/reference/sync/intervals-client-factory.js";
import { createRequester, IntervalsHttpError, SyncBudgetExceededError } from "../src/index.js";

const response = (status: number, headers: Record<string, string> = {}): HttpResponse => ({ status, headers, body: new Uint8Array([1]) });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function harness(http: HttpPort, options: { deadline?: number; maxRequests?: number; ledger?: PhysicalRequestLedger } = {}) {
  let now = 0;
  const sleeps: number[] = [];
  const budget: SyncBudget = { signal: new AbortController().signal, clock: { monotonicNow: () => now },
    deadlineMonotonicMs: options.deadline ?? 1_000_000, perRequestTimeoutMs: 30_000,
    maxRequests: options.maxRequests ?? 10, maxArtifacts: 10 };
  const requester = createRequester({ http, budget, minRequestIntervalMs: 500,
    wallClock: { now: () => Date.UTC(1998, 0, 1) }, sleep: async (ms) => { sleeps.push(ms); now += ms; },
    attemptLedger: options.ledger });
  return { requester, budget, sleeps, now: () => now };
}

describe("intervals.icu request policy", () => {
  it("honors a valid long Retry-After beyond the local cap", async () => {
    let attempts = 0;
    const value = harness({ fetch: async () => ++attempts === 1 ? response(429, { "retry-after": "120" }) : response(200) });
    await expect(value.requester.request("activities", { method: "GET", url: "https://intervals.icu/api/v1/test" }))
      .resolves.toEqual(response(200));
    expect(attempts).toBe(2);
    expect(value.sleeps[0]).toBeGreaterThanOrEqual(120_000);
    expect(value.sleeps[0]).toBeGreaterThan(30_000);
  });

  it("refuses Retry-After before sleeping past the deadline", async () => {
    const value = harness({ fetch: async () => response(429, { "retry-after": "120" }) }, { deadline: 1_000 });
    await expect(value.requester.request("activities", { method: "GET", url: "https://intervals.icu/api/v1/test" }))
      .rejects.toBeInstanceOf(SyncBudgetExceededError);
    expect(value.sleeps).toEqual([]);
  });

  it("refuses a retry before sleeping when the request budget is exhausted", async () => {
    const value = harness({ fetch: async () => response(503) }, { maxRequests: 1 });
    await expect(value.requester.request("activities", { method: "GET", url: "https://intervals.icu/api/v1/test" }))
      .rejects.toBeInstanceOf(SyncBudgetExceededError);
    expect(value.requester.requestsUsed()).toBe(1);
    expect(value.sleeps).toEqual([]);
  });

  it("applies configurable pacing before every later attempt", async () => {
    const starts: number[] = [];
    const value = harness({ fetch: async () => { starts.push(value.now()); return response(200); } });
    await value.requester.request("activities", { method: "GET", url: "https://intervals.icu/api/v1/one" });
    await value.requester.request("wellness", { method: "GET", url: "https://intervals.icu/api/v1/two" });
    expect(starts).toEqual([0, 500]); expect(value.sleeps).toEqual([500]);
  });

  it("outer abort makes exactly one attempt and no retry", async () => {
    let attempts = 0;
    const controller = new AbortController();
    const budget: SyncBudget = { signal: controller.signal, clock: { monotonicNow: () => 0 }, deadlineMonotonicMs: 10_000,
      perRequestTimeoutMs: 10, maxRequests: 10, maxArtifacts: 10 };
    const requester = createRequester({ http: { fetch: async () => { attempts += 1; controller.abort(); throw new DOMException("aborted", "AbortError"); } },
      budget, minRequestIntervalMs: 250, wallClock: { now: () => 0 }, sleep: vi.fn(async () => {}) });
    await expect(requester.request("activities", { method: "GET", url: "https://intervals.icu/api/v1/test" }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(attempts).toBe(1);
  });

  it("per-request abort makes exactly one attempt and no retry while the outer budget stays live", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("aborted", "AbortError")), ms);
      return controller.signal;
    });
    const outer = new AbortController();
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) throw new TypeError("request signal is missing");
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const http = makeIntervalsHttpFactory({ apiKey: "dummy", baseFetch: baseFetch as typeof globalThis.fetch })({
      outer: outer.signal,
      perRequestTimeoutMs: 10,
    });
    const budget: SyncBudget = { signal: outer.signal, clock: { monotonicNow: () => 0 }, deadlineMonotonicMs: 10_000,
      perRequestTimeoutMs: 10, maxRequests: 10, maxArtifacts: 10 };
    const requester = createRequester({ http, budget, minRequestIntervalMs: 250,
      wallClock: { now: () => 0 }, sleep: vi.fn(async () => {}) });

    const pending = requester.request("activities", { method: "GET", url: "https://intervals.icu/api/v1/test" });
    const settled = pending.then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    await expect(settled).resolves.toMatchObject({ name: "AbortError" });
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(requester.requestsUsed()).toBe(1);
    expect(outer.signal.aborted).toBe(false);
  });

  it("does not retry authentication, validation, or a non-proven POST", async () => {
    const fetch = vi.fn(async () => response(401));
    const value = harness({ fetch });
    await expect(value.requester.request("settings", { method: "POST", url: "https://intervals.icu/api/v1/test" }))
      .rejects.toEqual(expect.objectContaining<Partial<IntervalsHttpError>>({ status: 401, retryAfterMs: null }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("charges every physical retry and rejects bulk FIT before fetch on the gate path", async () => {
    const ledger = createPhysicalRequestLedger({ storeLimit: 64, legacyLimit: 15, totalLimit: 79 });
    let attempts = 0;
    const value = harness({ fetch: async () => ++attempts === 1 ? response(503) : response(200) }, { ledger });
    await value.requester.request("activities", { method: "GET", url: "https://intervals.icu/api/v1/test" });
    expect(ledger.snapshot()).toMatchObject({ storeRequests: 2, totalRequests: 2,
      byTag: { "store:activities": 2 } });
    const fetch = vi.fn(async () => response(200));
    const bulk = harness({ fetch }, { ledger });
    await expect(bulk.requester.request("bulk-fit", { method: "POST", url: "https://intervals.icu/api/v1/test" }))
      .rejects.toBeInstanceOf(SyncBudgetExceededError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
