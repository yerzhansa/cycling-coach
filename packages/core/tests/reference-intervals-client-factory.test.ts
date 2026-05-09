// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import { afterEach, describe, expect, it, vi } from "vitest";
import { IntervalsClient } from "intervals-icu-api";
import {
  makeAbortableClient,
  wrapFetchWithSignal,
} from "../src/reference/sync/intervals-client-factory.js";

afterEach(() => {
  vi.useRealTimers();
});

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

  // Per-request-timeout propagation is verified end-to-end at the runSync
  // level (`reference-run-sync.test.ts`'s outer-timeout test asserts the
  // wrapper-fetch's signal aborts when runSync's outer controller fires).
  // Pinning it here against `AbortSignal.timeout` flakes under vitest's
  // parallel pool — fake timers don't intercept `AbortSignal.timeout`'s
  // scheduler reliably, and real-timer waits race with other files'
  // worker pressure.
  it.skip("aborts in-flight signals when the per-request timeout fires", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 1_000));
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
