import { afterEach, describe, expect, it, vi } from "vitest";
import { IntervalsClient } from "intervals-icu-api";
import { createPhysicalRequestLedger, PhysicalRequestLimitError } from "@enduragent/kernel/store";
import {
  makeAbortableClient,
  makeChatClient,
  makeIntervalsHttpFactory,
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

  it("charges the shared legacy ceiling immediately before the physical fetch", async () => {
    const ledger = createPhysicalRequestLedger({ storeLimit: 64, legacyLimit: 15, totalLimit: 79 });
    const baseFetch = vi.fn(async () => new Response("ok"));
    const wrapped = wrapFetchWithSignal({ baseFetch, outer: new AbortController().signal,
      perRequestMs: 30_000, attemptLedger: ledger });
    for (let index = 0; index < 15; index += 1) await wrapped(`https://example.test/${index}`);
    await expect(wrapped("https://example.test/rejected")).rejects.toBeInstanceOf(PhysicalRequestLimitError);
    expect(baseFetch).toHaveBeenCalledTimes(15);
    expect(ledger.snapshot()).toMatchObject({ legacyRequests: 15, totalRequests: 15 });
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

describe("makeIntervalsHttpFactory raw adapter", () => {
  const basicUser = ["API", "KEY"].join("_");

  it("injects Basic credentials while preserving raw response bytes and headers", async () => {
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Basic ${btoa(`${basicUser}:dummy`)}`);
      expect(init?.method).toBe("POST");
      expect(init?.body).toEqual(new Uint8Array([1, 2]));
      return new Response(new Uint8Array([9, 8]), { status: 201, headers: { "Retry-After": "120", "X-Test": "yes" } });
    });
    const outer = new AbortController();
    const port = makeIntervalsHttpFactory({ apiKey: "dummy", baseFetch: baseFetch as typeof globalThis.fetch })({
      outer: outer.signal,
      perRequestTimeoutMs: 30_000,
    });
    await expect(port.fetch({ method: "POST", url: "https://example.test/raw", body: new Uint8Array([1, 2]) })).resolves.toEqual({
      status: 201,
      headers: { "retry-after": "120", "x-test": "yes" },
      body: new Uint8Array([9, 8]),
    });
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects empty keys and caller-supplied authorization", async () => {
    expect(() => makeIntervalsHttpFactory({ apiKey: String() })).toThrow("API key is required");
    const port = makeIntervalsHttpFactory({ apiKey: "dummy", baseFetch: vi.fn() as never })({
      outer: new AbortController().signal,
      perRequestTimeoutMs: 1_000,
    });
    await expect(port.fetch({ method: "GET", url: "https://example.test/", headers: { Authorization: "dummy" } }))
      .rejects.toThrow("authorization header is managed");
  });

  it("creates a fresh run-scoped abort closure", async () => {
    const signals: AbortSignal[] = [];
    const baseFetch: typeof globalThis.fetch = async (_input, init) => {
      signals.push(init?.signal as AbortSignal);
      return new Response();
    };
    const factory = makeIntervalsHttpFactory({ apiKey: "dummy", baseFetch });
    const first = new AbortController(), second = new AbortController();
    await factory({ outer: first.signal, perRequestTimeoutMs: 30_000 }).fetch({ method: "GET", url: "https://example.test/1" });
    await factory({ outer: second.signal, perRequestTimeoutMs: 30_000 }).fetch({ method: "GET", url: "https://example.test/2" });
    first.abort();
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });
});
