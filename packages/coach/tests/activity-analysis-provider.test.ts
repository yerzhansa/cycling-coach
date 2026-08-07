import { describe, expect, it, vi } from "vitest";
import { normalizeActivityStreams, type ActivityStream } from "intervals-icu-api";
import {
  createBoundedActivityStreamFetch,
  createProviderActivityStreamReader,
} from "../src/activity-analysis-provider.js";

const REVISION = "a".repeat(64);
const streams: ActivityStream[] = [
  { type: "time", data: [0, 1] },
  { type: "watts", data: [200, 200] },
  { type: "heartrate", data: [140, 140] },
];

describe("provider activity stream reader", () => {
  it("does not create a client without credentials", async () => {
    const createClient = vi.fn();
    const archive = { write: vi.fn() };
    const reader = createProviderActivityStreamReader({
      credentials: { read: async () => ({ apiKey: "", athleteId: "0" }) },
      archive,
      createClient,
    });

    await expect(
      reader.read({
        providerActivityId: "provider-1",
        sourceRevision: REVISION,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "provider-unavailable" });
    expect(createClient).not.toHaveBeenCalled();
    expect(archive.write).not.toHaveBeenCalled();
  });

  it("archives bounded duplicate-safe evidence before returning it", async () => {
    const order: string[] = [];
    const normalized = normalizeActivityStreams(streams);
    const reader = createProviderActivityStreamReader({
      credentials: { read: async () => ({ apiKey: "secret", athleteId: "0" }) },
      archive: {
        write: async () => {
          order.push("archive");
        },
      },
      createClient: () => ({
        activities: {
          getStreamMap: async () => {
            order.push("fetch");
            return { ok: true as const, value: normalized };
          },
        },
      }),
    });

    await expect(
      reader.read({
        providerActivityId: "provider-1",
        sourceRevision: REVISION,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: "available", streams: normalized });
    expect(order).toEqual(["fetch", "archive"]);
  });

  it("maps provider rate limits to a refresh failure without exposing response details", async () => {
    const reader = createProviderActivityStreamReader({
      credentials: { read: async () => ({ apiKey: "secret", athleteId: "0" }) },
      archive: { write: vi.fn() },
      createClient: () => ({
        activities: {
          getStreamMap: async () => ({
            ok: false as const,
            error: {
              kind: "RateLimit" as const,
              status: 429 as const,
              retryAfterMs: 1,
              body: "private",
            },
          }),
        },
      }),
    });

    await expect(
      reader.read({
        providerActivityId: "provider-1",
        sourceRevision: REVISION,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "rate-limited" });
  });
});

describe("bounded activity stream fetch", () => {
  it("rejects declared and streamed bodies above the private byte limit", async () => {
    const declared = vi.fn();
    const declaredFetch = createBoundedActivityStreamFetch({
      maximumBytes: 3,
      noteLimitExceeded: declared,
      baseFetch: async () => new Response("data", { headers: { "content-length": "4" } }),
    });
    await expect(declaredFetch("https://example.test")).rejects.toThrow("private byte limit");
    expect(declared).toHaveBeenCalledOnce();

    const streamed = vi.fn();
    const streamedFetch = createBoundedActivityStreamFetch({
      maximumBytes: 3,
      noteLimitExceeded: streamed,
      baseFetch: async () => new Response("data"),
    });
    await expect(streamedFetch("https://example.test")).rejects.toThrow("private byte limit");
    expect(streamed).toHaveBeenCalledOnce();
  });
});
