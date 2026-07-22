import { afterEach, describe, expect, it, vi } from "vitest";
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
});
