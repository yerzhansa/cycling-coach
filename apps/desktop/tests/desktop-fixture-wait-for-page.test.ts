import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForPage } from "./helpers/desktop-fixture.js";

describe("Desktop renderer discovery", () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
      });
    }
  });

  it("honors the overall deadline when a debugging probe never responds", async () => {
    const server = createServer(() => undefined);
    servers.push(server);
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new TypeError();

    const started = performance.now();
    await expect(waitForPage(address.port, { timeoutMs: 150, probeTimeoutMs: 25 })).rejects.toThrow(
      "timed out waiting for the desktop renderer",
    );
    expect(performance.now() - started).toBeLessThan(750);
  });
});
