import { describe, expect, it, vi } from "vitest";
import {
  CoachOperationProgressNotificationEnvelopeSchema,
  JsonRpcSuccessResponseEnvelopeSchema,
} from "@enduragent/coach-contract";
import type { CoachClient, CoachClientCallOptions } from "@enduragent/coach-client";

const mocks = vi.hoisted(() => ({ connectCoachClient: vi.fn() }));

vi.mock("@enduragent/coach-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@enduragent/coach-client")>()),
  connectCoachClient: mocks.connectCoachClient,
}));

import {
  CoachRemoteError,
  connectCoachVerbTransport,
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
  it("returns the exact validated operational notification and terminal envelopes", async () => {
    const notification = CoachOperationProgressNotificationEnvelopeSchema.parse({
      jsonrpc: "2.0",
      method: "coach.operationProgress",
      params: {
        requestId: 1,
        requestMethod: "sync",
        event: { phase: "completed", completed: 1, total: 1 },
      },
    });
    const terminal = JsonRpcSuccessResponseEnvelopeSchema.parse({
      jsonrpc: "2.0",
      id: 1,
      result: {
        schemaVersion: 1,
        published: true,
        referenceSucceeded: true,
        requests: { store: 1, reference: 0, total: 1 },
      },
    });
    const call = vi.fn(
      async (method: string, params: unknown, options?: CoachClientCallOptions<"sync">) => {
        expect(method).toBe("sync");
        expect(params).toEqual({});
        options?.onNotificationEnvelope?.(notification);
        options?.onTerminalEnvelope?.(terminal);
        return terminal.result;
      },
    );
    const close = vi.fn(async () => {});
    mocks.connectCoachClient.mockResolvedValue({ call, close } as unknown as CoachClient);
    const remote = await connectCoachVerbTransport({
      url: "ws://127.0.0.1:43123/rpc",
      token: "synthetic-token",
    });
    const notifications: unknown[] = [];
    const terminals: unknown[] = [];
    const returned = await remote.request({
      method: "sync",
      params: {},
      signal: new AbortController().signal,
      onNotificationEnvelope: (envelope) => notifications.push(envelope),
      onTerminalEnvelope: (envelope) => terminals.push(envelope),
    });
    expect(notifications).toEqual([notification]);
    expect(terminals).toEqual([terminal]);
    expect(returned).toBe(terminal);
    await remote.close();
    expect(close).toHaveBeenCalledOnce();
  });

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
