import { describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  createAcceptedServerHandshakeFrame,
  createVersionMismatchServerHandshakeFrame,
} from "@enduragent/coach-contract";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import type { LaunchdServiceStatus } from "@enduragent/kernel-node/service";
import {
  resolveDesktopDaemon,
  type AppSupervisedChildHandle,
  type DaemonStateObservation,
  type DesktopDaemonDependencies,
} from "../src/enduragent.js";

const home: AthleteHome = {
  root: "/tmp/synthetic-athlete",
  storeDir: "/tmp/synthetic-athlete/store",
  archiveDir: "/tmp/synthetic-athlete/archive",
  configDir: "/tmp/synthetic-athlete/config",
};
const paths = {
  launchAgentsDir: "/tmp/LaunchAgents",
  plistPath: "/tmp/LaunchAgents/icu.enduragent.synthetic.plist",
  stateDir: "/tmp/synthetic-athlete/config/service",
  envPath: "/tmp/synthetic-athlete/config/service/service.env",
  wrapperPath: "/tmp/synthetic-athlete/config/service/service.sh",
  handoffPath: "/tmp/synthetic-athlete/config/service/service.handoff",
};
const token = "s".repeat(43);

function status(kind: "absent" | "registered"): LaunchdServiceStatus {
  return kind === "absent"
    ? {
        kind,
        registered: false,
        installed: false,
        loaded: false,
        running: false,
        label: "icu.enduragent.synthetic",
        pid: null,
        lastExitStatus: null,
        paths,
      }
    : {
        kind,
        registered: true,
        installed: true,
        loaded: true,
        running: false,
        label: "icu.enduragent.synthetic",
        pid: null,
        lastExitStatus: 0,
        paths,
      };
}

function healthy(
  owner: "service-managed" | "unmanaged-foreground" | "app-supervised",
): DaemonStateObservation {
  const peer = { status: "peer-healthy", pid: 12, port: 45_001, peerVersion: "0.1.0" } as const;
  const handshake = createAcceptedServerHandshakeFrame(owner, 2);
  return {
    kind: "compatible-healthy",
    peer,
    serverProtocolVersion: 2,
    authenticated: { peer, coordinates: { port: peer.port, token }, handshake },
  };
}

function mismatch(
  owner: "service-managed" | "ephemeral-client-started" | "unmanaged-foreground" | "app-supervised",
  direction: "client-older" | "client-newer",
): DaemonStateObservation {
  const peer = { status: "peer-healthy", pid: 12, port: 45_001, peerVersion: "0.1.0" } as const;
  const handshake =
    direction === "client-newer"
      ? createVersionMismatchServerHandshakeFrame(owner, PROTOCOL_VERSION, PROTOCOL_VERSION - 1)
      : createVersionMismatchServerHandshakeFrame(owner, PROTOCOL_VERSION, PROTOCOL_VERSION + 1);
  return {
    kind: "version-mismatch",
    failure: { kind: "version-mismatch", direction },
    authenticated: { peer, coordinates: { port: peer.port, token }, handshake },
  };
}

function dependencies(input: {
  readonly registration: "absent" | "registered";
  readonly observations: readonly DaemonStateObservation[];
}): DesktopDaemonDependencies {
  const queue = [...input.observations];
  let now = 0;
  return {
    resolveAthleteHome: () => home,
    readServiceStatus: async () => status(input.registration),
    resumeService: async () => "resumed",
    observeDaemonState: async () => queue.shift() ?? input.observations.at(-1)!,
    resolveSecondStarter: async () => ({ status: "refuse", exitCode: 3, stdout: "", stderr: "" }),
    delay: async (ms) => {
      now += ms;
    },
    monotonicNow: () => now,
  };
}

function child(): AppSupervisedChildHandle & { readonly stop: ReturnType<typeof vi.fn> } {
  const stop = vi.fn(async () => {});
  return { pid: 90, exited: Promise.resolve({ exitCode: 0 }), stop };
}

describe("desktop daemon arbitration", () => {
  it("attaches to a healthy owner without spawning", async () => {
    const start = vi.fn();
    const result = await resolveDesktopDaemon(
      {
        env: {},
        executablePath: "/Applications/Enduragent",
        appVersion: "0.1.0",
        signal: new AbortController().signal,
        startAppSupervisedDaemon: start,
      },
      dependencies({ registration: "registered", observations: [healthy("service-managed")] }),
    );
    expect(result).toMatchObject({
      status: "connected",
      owner: "service-managed",
      supervision: "attached",
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("kickstarts registered absence and never spawns", async () => {
    const start = vi.fn();
    const deps = dependencies({
      registration: "registered",
      observations: [{ kind: "absent" }, healthy("service-managed")],
    });
    const resume = vi.spyOn(deps, "resumeService");
    const result = await resolveDesktopDaemon(
      {
        env: {},
        executablePath: "/Applications/Enduragent",
        appVersion: "0.1.0",
        signal: new AbortController().signal,
        startAppSupervisedDaemon: start,
      },
      deps,
    );
    expect(result.status).toBe("connected");
    expect(resume).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("owns one child only for unregistered absence", async () => {
    const owned = child();
    const start = vi.fn(async () => owned);
    const result = await resolveDesktopDaemon(
      {
        env: {},
        executablePath: "/Applications/Enduragent",
        appVersion: "0.1.0",
        signal: new AbortController().signal,
        startAppSupervisedDaemon: start,
      },
      dependencies({
        registration: "absent",
        observations: [{ kind: "absent" }, healthy("app-supervised")],
      }),
    );
    expect(result).toMatchObject({
      status: "connected",
      owner: "app-supervised",
      supervision: "app-supervised",
    });
    expect(start).toHaveBeenCalledTimes(1);
    if (result.status === "connected") await result.close();
    expect(owned.stop).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["registered auth failure", "registered", { kind: "auth-invalid" }, 3],
    ["registered foreign peer", "registered", { kind: "foreign" }, 3],
    ["registered bound peer", "registered", { kind: "bound-unresponsive" }, 3],
    ["unregistered auth failure", "absent", { kind: "auth-invalid" }, 3],
    ["client-older mismatch", "registered", mismatch("service-managed", "client-older"), 5],
  ] as const)("refuses %s without spawning", async (_name, registration, observation, exitCode) => {
    const start = vi.fn();
    const result = await resolveDesktopDaemon(
      {
        env: {},
        executablePath: "/Applications/Enduragent",
        appVersion: "0.1.0",
        signal: new AbortController().signal,
        startAppSupervisedDaemon: start,
      },
      dependencies({ registration, observations: [observation] }),
    );
    expect(result).toMatchObject({ status: "refused", exitCode });
    expect(start).not.toHaveBeenCalled();
  });

  it("fails closed for unknown registration without resume or spawn", async () => {
    const base = dependencies({ registration: "absent", observations: [{ kind: "absent" }] });
    const deps: DesktopDaemonDependencies = {
      ...base,
      readServiceStatus: vi.fn(
        async () =>
          ({
            kind: "unknown",
            registered: null,
            installed: null,
            loaded: null,
            running: null,
            label: "icu.enduragent.synthetic",
            pid: null,
            lastExitStatus: null,
            paths,
            detail: "synthetic",
          }) as const,
      ),
    };
    const resume = vi.spyOn(deps, "resumeService");
    const start = vi.fn();
    const result = await resolveDesktopDaemon(
      {
        env: {},
        executablePath: "/Applications/Enduragent",
        appVersion: "0.1.0",
        signal: new AbortController().signal,
        startAppSupervisedDaemon: start,
      },
      deps,
    );
    expect(result).toMatchObject({ status: "refused", exitCode: 3 });
    expect(resume).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("routes client-newer app supervision through the landed binding with one cached registration read", async () => {
    const successor = child();
    const start = vi.fn(async () => successor);
    const base = dependencies({
      registration: "absent",
      observations: [mismatch("app-supervised", "client-newer")],
    });
    const readStatus = vi.fn(base.readServiceStatus);
    const deps: DesktopDaemonDependencies = {
      ...base,
      readServiceStatus: readStatus,
      resolveSecondStarter: vi.fn(async (_input, binding) => {
        expect(await binding.serviceUpgrade.isInstalled(home)).toBe(false);
        await binding.serviceUpgrade.startEphemeralSuccessor({
          home,
          targetProtocolVersion: PROTOCOL_VERSION,
          handoffCapability: "h".repeat(43),
        });
        return {
          status: "attach" as const,
          port: 45_002,
          handshake: createAcceptedServerHandshakeFrame("app-supervised", PROTOCOL_VERSION),
        };
      }),
    };
    const result = await resolveDesktopDaemon(
      {
        env: {},
        executablePath: "/Applications/Enduragent",
        appVersion: "0.1.0",
        signal: new AbortController().signal,
        startAppSupervisedDaemon: start,
      },
      deps,
    );
    expect(result).toMatchObject({
      status: "connected",
      owner: "app-supervised",
      supervision: "app-supervised",
    });
    expect(readStatus).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    if (result.status === "connected") await result.close();
    expect(successor.stop).toHaveBeenCalledTimes(1);
  });

  it("prefers registered service handoff for a client-newer app owner", async () => {
    const start = vi.fn();
    const base = dependencies({
      registration: "registered",
      observations: [mismatch("app-supervised", "client-newer")],
    });
    const readStatus = vi.fn(base.readServiceStatus);
    const deps: DesktopDaemonDependencies = {
      ...base,
      readServiceStatus: readStatus,
      resolveSecondStarter: vi.fn(async (_input, binding) => {
        expect(await binding.serviceUpgrade.isInstalled(home)).toBe(true);
        return {
          status: "attach" as const,
          port: 45_002,
          handshake: createAcceptedServerHandshakeFrame("service-managed", PROTOCOL_VERSION),
        };
      }),
    };
    const result = await resolveDesktopDaemon(
      {
        env: {},
        executablePath: "/Applications/Enduragent",
        appVersion: "0.1.0",
        signal: new AbortController().signal,
        startAppSupervisedDaemon: start,
      },
      deps,
    );
    expect(result).toMatchObject({
      status: "connected",
      owner: "service-managed",
      supervision: "attached",
    });
    expect(readStatus).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("stops and observes a directly started child when publication is aborted", async () => {
    const controller = new AbortController();
    const owned = child();
    const start = vi.fn(async () => {
      controller.abort();
      return owned;
    });
    const result = await resolveDesktopDaemon(
      {
        env: {},
        executablePath: "/Applications/Enduragent",
        appVersion: "0.1.0",
        signal: controller.signal,
        startAppSupervisedDaemon: start,
      },
      dependencies({ registration: "absent", observations: [{ kind: "absent" }] }),
    );
    expect(result).toMatchObject({ status: "refused", exitCode: 3 });
    expect(owned.stop).toHaveBeenCalledTimes(1);
  });
});
