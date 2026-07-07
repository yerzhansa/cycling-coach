import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntervalsClient } from "intervals-icu-api";
import {
  CHAT_PER_REQUEST_TIMEOUT_MS,
  makeAbortableClient,
  makeChatClient,
  resetSharedRequestBucketForTests,
  wrapFetchWithSharedBucket,
  wrapFetchWithSignal,
} from "../src/reference/sync/intervals-client-factory.js";

beforeEach(() => {
  resetSharedRequestBucketForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * `AbortSignal.timeout` uses Node's internal timer scheduler — `vi.useFakeTimers()`
 * cannot intercept it directly. Replace it with a `setTimeout`-driven controller
 * for tests that need deterministic per-request-timeout firing.
 */
function mockAbortSignalTimeout(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("timeout (mock)")), ms);
    return controller.signal;
  });
}

function stub500(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => new Response("boom", { status: 500 }));
}

/** A fetch that never resolves on its own; rejects only when its signal aborts. */
function hungFetch(): typeof globalThis.fetch {
  return (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason ?? new Error("aborted")),
        { once: true },
      );
    });
}

describe("wrapFetchWithSignal", () => {
  it("threads a chained AbortSignal into the init passed to baseFetch", async () => {
    let captured: AbortSignal | undefined;
    const baseFetch: typeof globalThis.fetch = async (_input, init) => {
      captured = init?.signal ?? undefined;
      return new Response("ok");
    };
    const outer = new AbortController();

    const wrapped = wrapFetchWithSignal({
      baseFetch,
      outer: outer.signal,
      perRequestMs: 30_000,
    });
    await wrapped("https://example.test/", {});

    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured!.aborted).toBe(false);
  });

  it("aborts in-flight signals when the outer signal aborts", async () => {
    let captured: AbortSignal | undefined;
    const baseFetch: typeof globalThis.fetch = async (_input, init) => {
      captured = init?.signal ?? undefined;
      return new Response("ok");
    };
    const outer = new AbortController();

    const wrapped = wrapFetchWithSignal({
      baseFetch,
      outer: outer.signal,
      perRequestMs: 30_000,
    });
    await wrapped("https://example.test/", {});

    expect(captured!.aborted).toBe(false);
    outer.abort();
    expect(captured!.aborted).toBe(true);
  });

  it("aborts in-flight signals when the per-request timeout fires", async () => {
    vi.useFakeTimers();
    mockAbortSignalTimeout();

    let captured: AbortSignal | undefined;
    const baseFetch: typeof globalThis.fetch = async (_input, init) => {
      captured = init?.signal ?? undefined;
      return new Response("ok");
    };
    const outer = new AbortController();

    const wrapped = wrapFetchWithSignal({
      baseFetch,
      outer: outer.signal,
      perRequestMs: 50,
    });
    await wrapped("https://example.test/", {});
    expect(captured!.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(60);

    expect(captured!.aborted).toBe(true);
    expect(outer.signal.aborted).toBe(false);
  });

  it("threads a timeout-only AbortSignal when no outer signal is provided", async () => {
    vi.useFakeTimers();
    mockAbortSignalTimeout();

    let captured: AbortSignal | undefined;
    const baseFetch: typeof globalThis.fetch = async (_input, init) => {
      captured = init?.signal ?? undefined;
      return new Response("ok");
    };

    const wrapped = wrapFetchWithSignal({ baseFetch, perRequestMs: 50 });
    await wrapped("https://example.test/", {});

    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(60);
    expect(captured!.aborted).toBe(true);
  });
});

describe("shared request bucket", () => {
  it("two chat clients share one process-wide bucket (burst 30, refill 10 req/s)", async () => {
    vi.useFakeTimers();
    mockAbortSignalTimeout();

    const stubA = stub500();
    const stubB = stub500();
    const clientA = makeChatClient({
      apiKey: "test-key",
      athleteId: "i1",
      fetch: stubA as unknown as typeof globalThis.fetch,
    });
    const clientB = makeChatClient({
      apiKey: "test-key",
      athleteId: "i1",
      fetch: stubB as unknown as typeof globalThis.fetch,
    });

    const event = {
      start_date_local: "1998-01-05T00:00:00",
      category: "WORKOUT" as const,
      name: "Test workout",
    };

    // Burst: 15 requests on each client drain the single 30-token bucket.
    await Promise.all([
      ...Array.from({ length: 15 }, () => clientA.events.create(event)),
      ...Array.from({ length: 15 }, () => clientB.events.create(event)),
    ]);
    expect(stubA).toHaveBeenCalledTimes(15);
    expect(stubB).toHaveBeenCalledTimes(15);

    // The 31st request (on either client) must queue until the bucket refills.
    let resolved = false;
    const p = clientA.events.create(event).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);
    expect(stubA).toHaveBeenCalledTimes(15);

    // 10 req/s refill: one token becomes available after 100 ms.
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(resolved).toBe(true);
    expect(stubA).toHaveBeenCalledTimes(16);
  });

  it("aborts a queued wait promptly without calling the base fetch", async () => {
    vi.useFakeTimers();

    const base = vi.fn(async () => new Response("ok"));
    const wrapped = wrapFetchWithSharedBucket(base as unknown as typeof globalThis.fetch);

    // Drain the burst.
    await Promise.all(Array.from({ length: 30 }, () => wrapped("https://example.test/")));
    expect(base).toHaveBeenCalledTimes(30);

    const controller = new AbortController();
    const queued = wrapped("https://example.test/", { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toThrow();
    expect(base).toHaveBeenCalledTimes(30);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const base = vi.fn(async () => new Response("ok"));
    const wrapped = wrapFetchWithSharedBucket(base as unknown as typeof globalThis.fetch);

    const controller = new AbortController();
    controller.abort();
    await expect(wrapped("https://example.test/", { signal: controller.signal })).rejects.toThrow();
    expect(base).not.toHaveBeenCalled();
  });
});

describe("makeAbortableClient", () => {
  it("returns an IntervalsClient instance configured with the abortable wrapper-fetch", () => {
    const outer = new AbortController();
    const client = makeAbortableClient({
      apiKey: "test-key",
      signal: outer.signal,
      perRequestMs: 30_000,
    });
    expect(client).toBeInstanceOf(IntervalsClient);
  });
});

describe("makeChatClient", () => {
  it("returns an IntervalsClient instance", () => {
    const client = makeChatClient({ apiKey: "test-key" });
    expect(client).toBeInstanceOf(IntervalsClient);
  });

  it("injects an abortable timeout signal into chat requests", async () => {
    let captured: AbortSignal | undefined;
    const stub = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = init?.signal ?? undefined;
      return new Response("boom", { status: 500 });
    });
    const client = makeChatClient({
      apiKey: "test-key",
      athleteId: "i1",
      fetch: stub as unknown as typeof globalThis.fetch,
    });

    await client.events.create({
      start_date_local: "1998-01-05T00:00:00",
      category: "WORKOUT",
      name: "Test workout",
    });

    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured!.aborted).toBe(false);
  });

  it("aborts a hung chat fetch at the 30 s per-request timeout", async () => {
    vi.useFakeTimers();
    mockAbortSignalTimeout();

    const client = makeChatClient({
      apiKey: "test-key",
      athleteId: "i1",
      fetch: hungFetch(),
    });

    let rejected: unknown;
    const p = client.events
      .create({
        start_date_local: "1998-01-05T00:00:00",
        category: "WORKOUT",
        name: "Test workout",
      })
      .catch((e: unknown) => {
        rejected = e;
      });

    await vi.advanceTimersByTimeAsync(CHAT_PER_REQUEST_TIMEOUT_MS - 1);
    expect(rejected).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(rejected).toBeInstanceOf(Error);
  });

  it("does not retry a POST that fails with HTTP 500", async () => {
    const stub = vi.fn(async () => new Response("boom", { status: 500 }));
    const client = makeChatClient({
      apiKey: "test-key",
      athleteId: "i1",
      fetch: stub as unknown as typeof globalThis.fetch,
    });

    const result = await client.events.create({
      start_date_local: "1998-01-05T00:00:00",
      category: "WORKOUT",
      name: "Test workout",
    });

    expect(stub).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });

  it("does not honor Retry-After on a 429 at the HTTP layer", async () => {
    const stub = vi.fn(
      async () =>
        new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "120" },
        }),
    );
    const client = makeChatClient({
      apiKey: "test-key",
      athleteId: "i1",
      fetch: stub as unknown as typeof globalThis.fetch,
    });

    const result = await client.events.create({
      start_date_local: "1998-01-05T00:00:00",
      category: "WORKOUT",
      name: "Test workout",
    });

    expect(stub).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });
});
