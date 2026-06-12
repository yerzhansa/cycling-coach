import { afterEach, describe, expect, it, vi } from "vitest";
import { IntervalsClient } from "intervals-icu-api";
import {
  makeAbortableClient,
  makeChatClient,
  wrapFetchWithSignal,
} from "../src/reference/sync/intervals-client-factory.js";

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
