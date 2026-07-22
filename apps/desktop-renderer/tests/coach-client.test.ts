import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CoachClientCallTimeoutError,
  CoachClientDisconnectedError,
  type CoachClient,
  type ConnectCoachClientOptions,
} from "@enduragent/coach-client";
import { createDesktopCoachClientProvider } from "../src/coach-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("desktop coach client lifecycle", () => {
  it("asks the trusted main-process bridge to recover before resolving fresh coordinates", async () => {
    const order: string[] = [];
    const auth = {
      getDaemonConnection: vi.fn(async (failedGeneration?: number) => {
        order.push(failedGeneration === undefined ? "coordinates" : `recover-${failedGeneration}`);
        return {
          url: "ws://127.0.0.1:45001/rpc",
          token: "s".repeat(43),
          generation: 7,
        };
      }),
    };
    vi.stubGlobal("window", { enduragentAuth: auth });
    const clients = createDesktopCoachClientProvider(
      vi.fn(async () => Promise.reject(new Error())),
    );
    await expect(clients.getClient()).rejects.toThrow();
    await expect(clients.reconnect()).rejects.toThrow();
    expect(order).toEqual(["coordinates", "recover-7"]);
    expect(auth.getDaemonConnection).toHaveBeenNthCalledWith(2, 7);
  });

  it("closes the old client and deduplicates successful generation-qualified reconnects", async () => {
    const first = { close: vi.fn(async () => {}) };
    const second = { close: vi.fn(async () => {}) };
    const auth = {
      getDaemonConnection: vi
        .fn()
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45001/rpc",
          token: "s".repeat(43),
          generation: 1,
        })
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45002/rpc",
          token: "t".repeat(43),
          generation: 2,
        }),
    };
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    vi.stubGlobal("window", { enduragentAuth: auth });
    const clients = createDesktopCoachClientProvider(connect);
    await expect(clients.getClient()).resolves.toBe(first);
    const reconnecting = clients.reconnect();
    expect(clients.reconnect()).toBe(reconnecting);
    await expect(reconnecting).resolves.toBe(second);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(auth.getDaemonConnection).toHaveBeenNthCalledWith(2, 1);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("recovers a terminal client lazily, generation-qualified, and coalesced", async () => {
    const first = { close: vi.fn(async () => {}) } as unknown as CoachClient;
    const second = { close: vi.fn(async () => {}) } as unknown as CoachClient;
    const auth = {
      getDaemonConnection: vi
        .fn()
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45001/rpc",
          token: "s".repeat(43),
          generation: 4,
        })
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45002/rpc",
          token: "t".repeat(43),
          generation: 5,
        }),
    };
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    vi.stubGlobal("window", { enduragentAuth: auth });
    const clients = createDesktopCoachClientProvider(connect);
    await expect(clients.getClient()).resolves.toBe(first);
    const options = connect.mock.calls[0]![0] as ConnectCoachClientOptions;
    const cause = new CoachClientCallTimeoutError("chat", 11 * 60_000);

    options.onTerminal?.(first, cause);

    expect(auth.getDaemonConnection).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(first.close).not.toHaveBeenCalled();
    const recovery = clients.getClient();
    expect(clients.getClient()).toBe(recovery);
    await expect(recovery).resolves.toBe(second);
    expect(auth.getDaemonConnection).toHaveBeenNthCalledWith(2, 4);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("advances recovery past coordinates whose client connection fails", async () => {
    const first = { close: vi.fn(async () => {}) } as unknown as CoachClient;
    const third = { close: vi.fn(async () => {}) } as unknown as CoachClient;
    const connectionFailure = new Error("generation 5 connection failed");
    const auth = {
      getDaemonConnection: vi
        .fn()
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45001/rpc",
          token: "s".repeat(43),
          generation: 4,
        })
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45002/rpc",
          token: "t".repeat(43),
          generation: 5,
        })
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45003/rpc",
          token: "u".repeat(43),
          generation: 6,
        }),
    };
    const connect = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(connectionFailure)
      .mockResolvedValueOnce(third);
    vi.stubGlobal("window", { enduragentAuth: auth });
    const clients = createDesktopCoachClientProvider(connect);
    await expect(clients.getClient()).resolves.toBe(first);
    const options = connect.mock.calls[0]![0] as ConnectCoachClientOptions;

    options.onTerminal?.(first, new CoachClientDisconnectedError(1006, ""));

    await expect(clients.getClient()).rejects.toBe(connectionFailure);
    expect(auth.getDaemonConnection).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(2);

    await expect(clients.getClient()).resolves.toBe(third);
    expect(auth.getDaemonConnection.mock.calls.map(([failed]) => failed)).toEqual([
      undefined,
      4,
      5,
    ]);
    expect(connect).toHaveBeenCalledTimes(3);
    await expect(clients.getClient()).resolves.toBe(third);
    expect(auth.getDaemonConnection).toHaveBeenCalledTimes(3);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it("rejects a client terminalized during connection resolution and recovers on the next call", async () => {
    const first = { close: vi.fn(async () => {}) } as unknown as CoachClient;
    const second = { close: vi.fn(async () => {}) } as unknown as CoachClient;
    const cause = new CoachClientDisconnectedError(1006, "");
    const auth = {
      getDaemonConnection: vi
        .fn()
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45001/rpc",
          token: "s".repeat(43),
          generation: 8,
        })
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45002/rpc",
          token: "t".repeat(43),
          generation: 9,
        }),
    };
    const connect = vi
      .fn()
      .mockImplementationOnce(async (options: ConnectCoachClientOptions) => {
        options.onTerminal?.(first, cause);
        return first;
      })
      .mockResolvedValueOnce(second);
    vi.stubGlobal("window", { enduragentAuth: auth });
    const clients = createDesktopCoachClientProvider(connect);

    await expect(clients.getClient()).rejects.toBe(cause);
    expect(auth.getDaemonConnection).toHaveBeenCalledTimes(1);
    await expect(clients.getClient()).resolves.toBe(second);
    expect(auth.getDaemonConnection).toHaveBeenNthCalledWith(2, 8);
  });

  it("fences a stale terminal callback from the replacement client", async () => {
    const first = { close: vi.fn(async () => {}) } as unknown as CoachClient;
    const second = { close: vi.fn(async () => {}) } as unknown as CoachClient;
    const auth = {
      getDaemonConnection: vi
        .fn()
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45001/rpc",
          token: "s".repeat(43),
          generation: 1,
        })
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45002/rpc",
          token: "t".repeat(43),
          generation: 2,
        }),
    };
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    vi.stubGlobal("window", { enduragentAuth: auth });
    const clients = createDesktopCoachClientProvider(connect);
    await clients.getClient();
    const oldOptions = connect.mock.calls[0]![0] as ConnectCoachClientOptions;
    await expect(clients.reconnect()).resolves.toBe(second);

    oldOptions.onTerminal?.(first, new CoachClientDisconnectedError(1000, "old close"));

    await expect(clients.getClient()).resolves.toBe(second);
    expect(auth.getDaemonConnection).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(second.close).not.toHaveBeenCalled();
  });

  it("latches shutdown before a deferred client close can invalidate the provider", async () => {
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const terminalCause = new CoachClientDisconnectedError(1000, "");
    let capturedOptions!: ConnectCoachClientOptions;
    const closeClient = vi.fn(async () => {
      capturedOptions.onTerminal?.(first, terminalCause);
      await closeGate;
    });
    const first = { close: closeClient } as unknown as CoachClient;
    const auth = {
      getDaemonConnection: vi.fn(async () => ({
        url: "ws://127.0.0.1:45001/rpc",
        token: "s".repeat(43),
        generation: 12,
      })),
    };
    const connect = vi.fn(async (options: ConnectCoachClientOptions) => {
      capturedOptions = options;
      return first;
    });
    vi.stubGlobal("window", { enduragentAuth: auth });
    const clients = createDesktopCoachClientProvider(connect);
    await expect(clients.getClient()).resolves.toBe(first);

    let closeSettled = false;
    const closing = clients.close();
    void closing.then(() => {
      closeSettled = true;
    });
    expect(clients.close()).toBe(closing);
    await vi.waitFor(() => expect(closeClient).toHaveBeenCalledTimes(1));

    const getDuringClose = await clients.getClient().catch((error: unknown) => error);
    const reconnectDuringClose = await clients.reconnect().catch((error: unknown) => error);
    expect(closeSettled).toBe(false);
    expect(getDuringClose).toBeInstanceOf(CoachClientDisconnectedError);
    expect(getDuringClose).toMatchObject({ code: 1000, reason: "" });
    expect(reconnectDuringClose).toBe(getDuringClose);
    expect(auth.getDaemonConnection).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);

    releaseClose();
    await expect(closing).resolves.toBeUndefined();
    expect(closeClient).toHaveBeenCalledTimes(1);

    const getAfterClose = await clients.getClient().catch((error: unknown) => error);
    const reconnectAfterClose = await clients.reconnect().catch((error: unknown) => error);
    expect(getAfterClose).toBe(getDuringClose);
    expect(reconnectAfterClose).toBe(getDuringClose);
    expect(auth.getDaemonConnection).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
