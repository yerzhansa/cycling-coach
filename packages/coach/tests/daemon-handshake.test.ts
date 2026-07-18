import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXIT_VERSION_MISMATCH,
  PROTOCOL_VERSION,
  createAcceptedServerHandshakeFrame,
  createVersionMismatchServerHandshakeFrame,
  type DaemonOwner,
} from "@enduragent/coach-contract";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { acquireWriteLock } from "@enduragent/kernel-node/lock";
import {
  HANDOFF_RESERVED_MESSAGE,
  UNMANAGED_UPGRADE_MESSAGE,
  UPGRADE_SUCCESSOR_FAILED_MESSAGE,
  alreadyServingNotice,
  classifyPeerReadOnly,
  lowerClientMessage,
  observePeerHandshake,
  openAuthenticatedDaemonControl,
  resolveSecondStarter,
  type ResolveSecondStarterDependencies,
} from "../src/daemon/handshake.js";
import { createCoachRpcServer } from "../src/daemon/rpc-server.js";
import type { UpgradeFenceHandle } from "../src/daemon/upgrade-fence.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function home(): Promise<AthleteHome> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "daemon-handshake-"));
  roots.push(root);
  return {
    root,
    storeDir: join(root, "store"),
    archiveDir: join(root, "archive"),
    configDir: join(root, "config"),
  };
}

async function loopbackAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPERM") {
        process.stderr.write("SKIP_MARKER loopback-listen EPERM daemon-handshake\n");
      }
      resolve(false);
    });
    server.listen({ host: "127.0.0.1", port: 0 }, () => server.close(() => resolve(true)));
  });
}

const hasLoopback = await loopbackAvailable();

describe.skipIf(!hasLoopback)("production peer observations", () => {
  it("classifies writer-clear, healthy, bound-unresponsive, and foreign cases", async () => {
    const clearHome = await home();
    await expect(classifyPeerReadOnly(clearHome)).resolves.toEqual({ status: "writer-clear" });

    const healthyHome = await home();
    const healthy = await acquireWriteLock({
      configDir: healthyHome.configDir,
      athleteHome: healthyHome.root,
      version: "0.1.0",
    });
    expect(healthy.status).toBe("acquired");
    if (healthy.status !== "acquired") return;
    const healthyBinding = await healthy.listener.bind({
      request: (_request, response) => {
        response.end(`${JSON.stringify({
          service: "enduragent-store-writer",
          version: "0.1.0",
        })}\n`);
      },
      upgrade: (_request, socket) => socket.destroy(),
    });
    await expect(classifyPeerReadOnly(healthyHome)).resolves.toEqual({
      status: "peer-healthy",
      peer: {
        status: "peer-healthy",
        pid: process.pid,
        port: healthyBinding.port,
        peerVersion: "0.1.0",
      },
    });
    await healthy.release();

    const boundHome = await home();
    const bound = await acquireWriteLock({
      configDir: boundHome.configDir,
      athleteHome: boundHome.root,
      version: "0.1.0",
    });
    expect(bound.status).toBe("acquired");
    if (bound.status !== "acquired") return;
    await expect(classifyPeerReadOnly(boundHome)).resolves.toMatchObject({
      status: "bound-unresponsive",
      stdout: "",
    });
    await bound.release();

    const foreignHome = await home();
    const foreign = await acquireWriteLock({
      configDir: foreignHome.configDir,
      athleteHome: foreignHome.root,
      version: "0.1.0",
    });
    expect(foreign.status).toBe("acquired");
    if (foreign.status !== "acquired") return;
    await foreign.listener.bind({
      request: (_request, response) => response.end("foreign\n"),
      upgrade: (_request, socket) => socket.destroy(),
    });
    await expect(classifyPeerReadOnly(foreignHome)).resolves.toMatchObject({
      status: "foreign-port",
      stdout: "",
    });
    await foreign.release();
  });

  it("observes strict compatible, mismatch, and auth-invalid handshakes", async () => {
    const selectedHome = await home();
    const lock = await acquireWriteLock({
      configDir: selectedHome.configDir,
      athleteHome: selectedHome.root,
      version: "0.1.0",
    });
    expect(lock.status).toBe("acquired");
    if (lock.status !== "acquired") return;
    const token = "x".repeat(43);
    const rpc = createCoachRpcServer({
      token,
      owner: "service-managed",
      engine: {
        chat: async () => ({ text: "ok" }),
        resetSession: async () => ({ memoryFlushed: true }),
        hasSession: async () => ({ hasSession: false }),
        getAthleteState: async () => ({
          schemaVersion: "3",
          lastUpdated: "2026-01-01T00:00:00.000Z",
          freshness: "fresh",
          degraded: false,
          lastSynced: "2026-01-01T00:00:00.000Z",
          athleteProfile: {},
          currentStatus: {},
          derivedMetrics: {},
          recentActivities: [],
          plannedWorkouts: [],
          wellness: {},
        }),
      },
    });
    const binding = await lock.listener.bind({
      request: (_request, response) => response.end(),
      upgrade: rpc.handleUpgrade,
    });
    await expect(observePeerHandshake({
      port: binding.port,
      token,
      clientProtocolVersion: PROTOCOL_VERSION,
    })).resolves.toMatchObject({ status: "accepted", owner: "service-managed" });
    await expect(observePeerHandshake({
      port: binding.port,
      token,
      clientProtocolVersion: PROTOCOL_VERSION + 1,
    })).resolves.toMatchObject({ status: "version-mismatch", direction: "client-newer" });
    const control = await openAuthenticatedDaemonControl({
      port: binding.port,
      token,
      incumbentProtocolVersion: PROTOCOL_VERSION,
      expectedOwner: "service-managed",
    });
    await expect(control.reserveUpgrade({
      targetProtocolVersion: PROTOCOL_VERSION + 1,
      handoffCapability: Buffer.alloc(32, 6).toString("base64url"),
    })).resolves.toEqual({ status: "reserved" });
    await control.close();
    await expect(observePeerHandshake({
      port: binding.port,
      token: "wrong",
      clientProtocolVersion: PROTOCOL_VERSION,
    })).rejects.toThrow("daemon handshake failed");
    await rpc.close();
    await binding.close();
    await lock.release();
  });
});

function resolverHarness(owner: DaemonOwner, clientVersion: number, serverVersion: number) {
  const selectedHome: AthleteHome = {
    root: "/synthetic",
    storeDir: "/synthetic/store",
    archiveDir: "/synthetic/archive",
    configDir: "/synthetic/config",
  };
  const peer = { status: "peer-healthy", pid: 7, port: 41_001, peerVersion: "old" } as const;
  const publishedPeer = {
    status: "peer-healthy",
    pid: 8,
    port: 41_002,
    peerVersion: "new",
  } as const;
  const handshake = clientVersion === serverVersion
    ? createAcceptedServerHandshakeFrame(owner, clientVersion, serverVersion)
    : createVersionMismatchServerHandshakeFrame(owner, clientVersion, serverVersion);
  const publishedHandshake = createAcceptedServerHandshakeFrame(
    owner,
    clientVersion,
    clientVersion,
  );
  const fence: UpgradeFenceHandle = {
    socketPath: "/synthetic/config/upgrade.sock",
    handoffCapability: Buffer.alloc(32, 1).toString("base64url"),
    release: vi.fn(async () => {}),
  };
  const serviceUpgrade = {
    isInstalled: vi.fn(async () => true),
    restartInstalledService: vi.fn(async () => {}),
    kickstartInstalledServiceAfterEphemeral: vi.fn(async () => {}),
    startEphemeralSuccessor: vi.fn(async () => {}),
  };
  const control = {
    port: peer.port,
    accepted: createAcceptedServerHandshakeFrame(owner, serverVersion, serverVersion),
    reserveUpgrade: vi.fn(async () => ({ status: "reserved" as const })),
    shutdownForUpgrade: vi.fn(async () => ({ status: "accepted" as const })),
    close: vi.fn(async () => {}),
  };
  const acquireFence = vi.fn<ResolveSecondStarterDependencies["acquireUpgradeFence"]>(
    async () => ({ status: "acquired", handle: fence }),
  );
  const dependencies = {
    observePeerHandshake: vi.fn(async () => handshake),
    openUpgradeControl: vi.fn(async () => control),
    classifyPeerReadOnly: vi.fn(async () => ({ status: "peer-healthy" as const, peer })),
    acquireUpgradeFence: acquireFence,
    serviceUpgrade,
    timer: { nowMs: () => 100, schedule: () => ({ cancel() {} }) },
    waitForWriterRelease: vi.fn(async () => ({ status: "released" as const })),
    waitForCompatiblePeer: vi.fn(async () => ({
      status: "published" as const,
      peer: publishedPeer,
      handshake: publishedHandshake,
    })),
  } satisfies ResolveSecondStarterDependencies;
  return { selectedHome, peer, publishedPeer, handshake, dependencies, fence, control, serviceUpgrade };
}

describe("second starter resolution", () => {
  it("defers daemon starters and attaches client races for compatible peers", async () => {
    for (const caller of ["serve", "service", "cli-auto-start", "local"] as const) {
      const test = resolverHarness("service-managed", PROTOCOL_VERSION, PROTOCOL_VERSION);
      const result = await resolveSecondStarter({
        caller,
        home: test.selectedHome,
        clientProtocolVersion: PROTOCOL_VERSION,
        clientAppVersion: "new",
        bearerToken: "token",
        peer: test.peer,
      }, test.dependencies);
      if (caller === "serve" || caller === "service") {
        expect(result).toEqual({
          status: "defer",
          exitCode: 0,
          stdout: "",
          stderr: alreadyServingNotice(test.peer.port),
        });
      } else {
        expect(result).toMatchObject({ status: "attach", port: test.peer.port });
      }
      expect(test.dependencies.acquireUpgradeFence).not.toHaveBeenCalled();
    }
  });

  it("returns exit 5 for a lower client and never restarts downward", async () => {
    const test = resolverHarness("service-managed", PROTOCOL_VERSION, PROTOCOL_VERSION + 1);
    const result = await resolveSecondStarter({
      caller: "cli-auto-start",
      home: test.selectedHome,
      clientProtocolVersion: PROTOCOL_VERSION,
      clientAppVersion: "old",
      bearerToken: "token",
      peer: test.peer,
    }, test.dependencies);
    expect(result).toEqual({
      status: "refuse",
      exitCode: EXIT_VERSION_MISMATCH,
      stdout: "",
      stderr: lowerClientMessage(PROTOCOL_VERSION, PROTOCOL_VERSION + 1),
    });
    expect(test.dependencies.acquireUpgradeFence).not.toHaveBeenCalled();
    expect(test.serviceUpgrade.restartInstalledService).not.toHaveBeenCalled();
  });

  it("refuses an authenticated unmanaged owner with exit 3 and zero takeover", async () => {
    const test = resolverHarness("unmanaged-foreground", PROTOCOL_VERSION + 1, PROTOCOL_VERSION);
    const result = await resolveSecondStarter({
      caller: "local",
      home: test.selectedHome,
      clientProtocolVersion: PROTOCOL_VERSION + 1,
      clientAppVersion: "new",
      bearerToken: "token",
      peer: test.peer,
    }, test.dependencies);
    expect(result).toEqual({
      status: "refuse",
      exitCode: 3,
      stdout: "",
      stderr: UNMANAGED_UPGRADE_MESSAGE,
    });
    expect(test.dependencies.acquireUpgradeFence).not.toHaveBeenCalled();
  });

  it("performs one fenced upward restart and attaches to the new port", async () => {
    const test = resolverHarness("service-managed", PROTOCOL_VERSION + 1, PROTOCOL_VERSION);
    const result = await resolveSecondStarter({
      caller: "cli-auto-start",
      home: test.selectedHome,
      clientProtocolVersion: PROTOCOL_VERSION + 1,
      clientAppVersion: "new",
      bearerToken: "token",
      peer: test.peer,
    }, test.dependencies);
    expect(result).toMatchObject({ status: "attach", port: test.publishedPeer.port });
    expect(test.control.reserveUpgrade).toHaveBeenCalledTimes(1);
    expect(test.control.shutdownForUpgrade).toHaveBeenCalledTimes(1);
    expect(test.serviceUpgrade.restartInstalledService).toHaveBeenCalledTimes(1);
    expect(test.fence.release).toHaveBeenCalledTimes(1);
  });

  it("returns the fence to a designated ephemeral daemon starter", async () => {
    const test = resolverHarness(
      "ephemeral-client-started",
      PROTOCOL_VERSION + 1,
      PROTOCOL_VERSION,
    );
    test.serviceUpgrade.isInstalled.mockResolvedValue(false);
    const result = await resolveSecondStarter({
      caller: "serve",
      home: test.selectedHome,
      clientProtocolVersion: PROTOCOL_VERSION + 1,
      clientAppVersion: "new",
      bearerToken: "token",
      peer: test.peer,
    }, test.dependencies);
    expect(result).toMatchObject({
      status: "become-successor",
      handoffCapability: test.fence.handoffCapability,
    });
    expect(test.fence.release).not.toHaveBeenCalled();
  });

  it("maps a live fence and successor failure to their exact terminal diagnostics", async () => {
    const reserved = resolverHarness("service-managed", PROTOCOL_VERSION + 1, PROTOCOL_VERSION);
    reserved.dependencies.acquireUpgradeFence.mockResolvedValue({
      status: "reserved",
      exitCode: 3,
      message: HANDOFF_RESERVED_MESSAGE,
    });
    const reservedResult = await resolveSecondStarter({
      caller: "serve",
      home: reserved.selectedHome,
      clientProtocolVersion: PROTOCOL_VERSION + 1,
      clientAppVersion: "new",
      bearerToken: "token",
      peer: reserved.peer,
    }, reserved.dependencies);
    expect(reservedResult).toMatchObject({ stderr: HANDOFF_RESERVED_MESSAGE });

    const failed = resolverHarness("service-managed", PROTOCOL_VERSION + 1, PROTOCOL_VERSION);
    failed.serviceUpgrade.restartInstalledService.mockRejectedValue(new Error("secret"));
    const failedResult = await resolveSecondStarter({
      caller: "service",
      home: failed.selectedHome,
      clientProtocolVersion: PROTOCOL_VERSION + 1,
      clientAppVersion: "new",
      bearerToken: "token",
      peer: failed.peer,
    }, failed.dependencies);
    expect(failedResult).toMatchObject({ stderr: UPGRADE_SUCCESSOR_FAILED_MESSAGE });
  });
});
