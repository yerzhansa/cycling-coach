import { describe, it, expect } from "vitest";
import type { IntervalsClient } from "intervals-icu-api";
import {
  downsampleStreams,
  STREAM_BIN_SECONDS,
  STREAM_RESULT_TARGET_TOKENS,
} from "../src/agent/stream-downsample.js";
import { estimateTokens } from "../src/agent/token-utils.js";
import { createPureCoreIntervalsTools } from "../src/agent/intervals-tools.js";

type AnyResult = { ok: true; value: unknown } | { ok: false; error: unknown };

function makeFakeIntervals(result: AnyResult): IntervalsClient {
  const fake = {
    activities: {
      getStreams: async () => result,
    },
  };
  return fake as unknown as IntervalsClient;
}

describe("downsampleStreams", () => {
  it("constants pin the configured values", () => {
    expect(STREAM_BIN_SECONDS).toBe(10);
    expect(STREAM_RESULT_TARGET_TOKENS).toBe(7000);
  });

  it("bin reduction shrinks the per-channel series", () => {
    const watts = Array(600).fill(200);
    const out = downsampleStreams({ watts });
    expect(out.bins).toBe(60);
    expect(out.channels.watts.samples).toHaveLength(60);
    expect(out.sampleCount).toBe(600);
  });

  it("the stats header preserves true peaks over the full channel", () => {
    const watts = [...Array(599).fill(100), 900];
    const out = downsampleStreams({ watts });
    expect(out.channels.watts.max).toBe(900);
    expect(out.channels.watts.samples.every((v) => v < 900)).toBe(true);
  });

  it("missing or non-array channels do not throw (manual-entry activity)", () => {
    const out = downsampleStreams({
      heartrate: [120, 121, 122],
      watts: undefined as unknown as number[],
      cadence: "nope" as unknown as number[],
    });
    expect(out.channels.heartrate).toBeDefined();
    expect(out.channels.watts).toBeUndefined();
    expect(out.channels.cadence).toBeUndefined();
  });

  it("a channel survives null gaps without NaN (dropped sensor packets)", () => {
    const out = downsampleStreams({
      watts: [100, null as unknown as number, 102],
    });
    expect(out.channels.watts).toBeDefined();
    expect(out.channels.watts.min).toBe(100);
    expect(out.channels.watts.max).toBe(102);
    expect(Number.isNaN(out.channels.watts.mean)).toBe(false);
    expect(out.channels.watts.samples.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("accepts the live array-of-channel shape from the streams endpoint", () => {
    const out = downsampleStreams([
      { type: "watts", data: Array(600).fill(200) },
      { type: "heartrate", data: Array(600).fill(150) },
    ]);
    expect(out.channels.watts).toBeDefined();
    expect(out.channels.heartrate).toBeDefined();
    expect(out.channels.watts.samples).toHaveLength(60);
    expect(out.sampleCount).toBe(600);
  });

  it("a 3 h-ride payload fits the per-result target after shaping (fits)", () => {
    const big = {
      watts: Array(10800).fill(250),
      heartrate: Array(10800).fill(150),
      cadence: Array(10800).fill(90),
      time: Array.from({ length: 10800 }, (_, i) => i),
      altitude: Array(10800).fill(500),
    };
    expect(estimateTokens(JSON.stringify(big))).toBeGreaterThan(STREAM_RESULT_TARGET_TOKENS);
    expect(estimateTokens(JSON.stringify(downsampleStreams(big)))).toBeLessThanOrEqual(
      STREAM_RESULT_TARGET_TOKENS,
    );
  });

  it("the shaped streams tool returns the downsampled object, not the raw value (shaped tool)", async () => {
    const big = {
      watts: Array(10800).fill(250),
      heartrate: Array(10800).fill(150),
      cadence: Array(10800).fill(90),
      time: Array.from({ length: 10800 }, (_, i) => i),
      altitude: Array(10800).fill(500),
    };
    const fake = makeFakeIntervals({ ok: true, value: big });
    const tools = createPureCoreIntervalsTools(fake);
    const out = (await tools.intervals_fetch_streams!.execute!(
      { activityId: 12345 },
      {} as never,
    )) as { bins: number; sampleCount: number; channels: Record<string, unknown> };
    expect(out.bins).toBeGreaterThan(0);
    expect(out.sampleCount).toBe(10800);
    expect(out.channels.watts).toBeDefined();
    expect(Array.isArray((out as { watts?: unknown }).watts)).toBe(false);
  });

  it("shaped tool downsamples the live array-of-channel payload", async () => {
    const live = [
      { type: "watts", data: Array(10800).fill(250) },
      { type: "heartrate", data: Array(10800).fill(150) },
    ];
    const fake = makeFakeIntervals({ ok: true, value: live });
    const tools = createPureCoreIntervalsTools(fake);
    const out = (await tools.intervals_fetch_streams!.execute!(
      { activityId: 12345 },
      {} as never,
    )) as { bins: number; sampleCount: number; channels: Record<string, unknown> };
    expect(out.sampleCount).toBe(10800);
    expect(out.bins).toBeGreaterThan(0);
    expect(out.channels.watts).toBeDefined();
    expect(out.channels.heartrate).toBeDefined();
  });

  it("typed error object on the streams failure path", async () => {
    const notFound = makeFakeIntervals({
      ok: false,
      error: { kind: "NotFound", status: 404, body: undefined },
    });
    const nfTools = createPureCoreIntervalsTools(notFound);
    const nfOut = (await nfTools.intervals_fetch_streams!.execute!(
      { activityId: 1 },
      {} as never,
    )) as { error: string; status?: number };
    expect(nfOut.error).toBe("NotFound");
    expect(nfOut.status).toBe(404);

    const timeout = makeFakeIntervals({
      ok: false,
      error: { kind: "Timeout", message: "slow down" },
    });
    const toTools = createPureCoreIntervalsTools(timeout);
    const toOut = (await toTools.intervals_fetch_streams!.execute!(
      { activityId: 1 },
      {} as never,
    )) as { error: string; message?: string };
    expect(toOut.error).toBe("Timeout");
    expect(toOut.message).toBe("slow down");
  });
});
