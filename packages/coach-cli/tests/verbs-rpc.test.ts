import { describe, expect, it, vi } from "vitest";
import {
  CoachRemoteError,
  connectRemoteCoachTransport,
  connectWithBoundedRetry,
  type CoachVerbTransport,
} from "../src/index.js";

const transport: CoachVerbTransport = {
  kind: "remote",
  request: async () => {
    throw new Error("unused");
  },
  close: async () => {},
};

describe("bounded remote connection", () => {
  it("attempts immediately and pins 50/100/200 delays", async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new CoachRemoteError({ kind: "unavailable" }))
      .mockRejectedValueOnce(new CoachRemoteError({ kind: "unavailable" }))
      .mockRejectedValueOnce(new CoachRemoteError({ kind: "unavailable" }))
      .mockResolvedValueOnce(transport);
    let now = 0;
    const delays: number[] = [];
    await expect(
      connectWithBoundedRetry({
        connect,
        delay: async (ms) => {
          delays.push(ms);
          now += ms;
        },
        monotonicNow: () => now,
      }),
    ).resolves.toBe(transport);
    expect(connect).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([50, 100, 200]);
  });

  it("stops at 5000ms and propagates non-unavailable failures immediately", async () => {
    let now = 0;
    const delays: number[] = [];
    await expect(
      connectWithBoundedRetry({
        connect: async () => {
          throw new CoachRemoteError({ kind: "unavailable" });
        },
        delay: async (ms) => {
          delays.push(ms);
          now += ms;
        },
        monotonicNow: () => now,
      }),
    ).rejects.toMatchObject({ failure: { kind: "unavailable" } });
    expect(delays.reduce((sum, value) => sum + value, 0)).toBe(5_000);
    const mismatch = new CoachRemoteError({ kind: "version-mismatch", direction: "client-newer" });
    const delay = vi.fn();
    await expect(
      connectWithBoundedRetry({
        connect: async () => {
          throw mismatch;
        },
        delay,
        monotonicNow: () => 0,
      }),
    ).rejects.toBe(mismatch);
    expect(delay).not.toHaveBeenCalled();
  });

  it("resumes a registered service once and never spawns a competitor", async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new CoachRemoteError({ kind: "unavailable" }))
      .mockResolvedValueOnce(transport);
    const resumeService = vi.fn(async () => "resumed" as const);
    const startEphemeralDaemon = vi.fn();
    await expect(
      connectRemoteCoachTransport({
        connect,
        serviceRegistrationState: async () => "present",
        resumeService,
        startEphemeralDaemon,
        delay: async () => {},
        monotonicNow: () => 0,
      }),
    ).resolves.toBe(transport);
    expect(resumeService).toHaveBeenCalledTimes(1);
    expect(startEphemeralDaemon).not.toHaveBeenCalled();
  });
});
