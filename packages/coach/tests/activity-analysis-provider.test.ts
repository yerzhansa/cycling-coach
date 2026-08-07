import { describe, expect, it, vi } from "vitest";
import { normalizeActivityStreams, type ActivityStream } from "intervals-icu-api";
import {
  createBoundedActivityStreamFetch,
  createProviderActivityAnalysisClientAccess,
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
    const access = createProviderActivityAnalysisClientAccess({
      credentials: { read: async () => ({ apiKey: "", athleteId: "0" }) },
      createClient,
    });
    const reader = createProviderActivityStreamReader({
      access,
      archive,
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
    const access = createProviderActivityAnalysisClientAccess({
      credentials: { read: async () => ({ apiKey: "secret", athleteId: "0" }) },
      createClient: () =>
        ({
          activities: {
            getStreamMap: async () => {
              order.push("fetch");
              return { ok: true as const, value: normalized };
            },
          },
        }) as never,
    });
    const reader = createProviderActivityStreamReader({
      access,
      archive: {
        write: async () => {
          order.push("archive");
        },
      },
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
    const access = createProviderActivityAnalysisClientAccess({
      credentials: { read: async () => ({ apiKey: "secret", athleteId: "0" }) },
      createClient: () =>
        ({
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
        }) as never,
    });
    const reader = createProviderActivityStreamReader({
      access,
      archive: { write: vi.fn() },
    });

    await expect(
      reader.read({
        providerActivityId: "provider-1",
        sourceRevision: REVISION,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "rate-limited" });
  });

  it("shares a bounded physical request budget across readers for one source revision", async () => {
    const createClient = vi.fn(() => ({ activities: {} }) as never);
    const access = createProviderActivityAnalysisClientAccess({
      credentials: { read: async () => ({ apiKey: "secret", athleteId: "0" }) },
      createClient,
      maximumRequestsPerRevision: 2,
    });
    const request = {
      sourceRevision: REVISION,
      signal: new AbortController().signal,
      maximumBytes: 10,
    };

    await access.open(request);
    await access.open(request);
    await expect(access.open(request)).rejects.toMatchObject({
      code: "request-budget-exhausted",
    });
    expect(createClient).toHaveBeenCalledTimes(2);
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
