import { describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  createAcceptedServerHandshakeFrame,
  createVersionMismatchServerHandshakeFrame,
} from "@enduragent/coach-contract";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import type { LaunchdServiceStatus } from "@enduragent/kernel-node/service";
import {
  AppSupervisedDaemonStartError,
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
  const handshake = createAcceptedServerHandshakeFrame(owner, PROTOCOL_VERSION);
  return {
    kind: "compatible-healthy",
    peer,
    serverProtocolVersion: PROTOCOL_VERSION,
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
  let alive = true;
  let resolveExit!: (value: { readonly exitCode: number | null }) => void;
  const exited = new Promise<{ readonly exitCode: number | null }>((resolve) => {
    resolveExit = resolve;
  });
  const stop = vi.fn(async () => {
    if (!alive) return;
    alive = false;
    resolveExit({ exitCode: 0 });
  });
  return { pid: 90, exited, isAlive: () => alive, stop };
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

  it("refuses a daemon that never publishes after three starts", async () => {
    const children = Array.from({ length: 3 }, () => child());
    const start = vi.fn(async () => children[start.mock.calls.length - 1]!);
    const base = dependencies({ registration: "absent", observations: [{ kind: "absent" }] });
    const readStatus = vi.fn(base.readServiceStatus);
    const result = await resolveDesktopDaemon(
      {
        env: {},
        executablePath: "/Applications/Enduragent",
        appVersion: "0.1.0",
        signal: new AbortController().signal,
        startAppSupervisedDaemon: start,
      },
      { ...base, readServiceStatus: readStatus },
    );
    expect(result).toMatchObject({
      status: "refused",
      exitCode: 3,
      classification: "never-published",
    });
    expect(start).toHaveBeenCalledTimes(3);
    expect(readStatus).toHaveBeenCalledTimes(1);
    expect(children.map(({ stop }) => stop.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("preserves a utility termination failure as a nonretryable refusal", async () => {
    const start = vi.fn(async () => {
      throw new AppSupervisedDaemonStartError("termination-failed");
    });
    const result = await resolveDesktopDaemon(
      {
        env: {},
        executablePath: "/Applications/Enduragent",
        appVersion: "0.1.0",
        signal: new AbortController().signal,
        startAppSupervisedDaemon: start,
      },
      dependencies({ registration: "absent", observations: [{ kind: "absent" }] }),
    );
    expect(result).toMatchObject({
      status: "refused",
      cause: "termination-failed",
      retryable: false,
    });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("re-observes without spawning or consuming the shared recovery budget", async () => {
    const budget = { remainingAttempts: 3, deadline: 60_000 };
    const start = vi.fn();
    const result = await resolveDesktopDaemon(
      {
        env: {},
        executablePath: "/Applications/Enduragent",
        appVersion: "0.1.0",
        signal: new AbortController().signal,
        startAppSupervisedDaemon: start,
        startBudget: budget,
        observationOnly: true,
      },
      dependencies({ registration: "absent", observations: [{ kind: "absent" }] }),
    );
    expect(result).toMatchObject({ status: "refused", cause: "unavailable", retryable: true });
    expect(start).not.toHaveBeenCalled();
    expect(budget.remainingAttempts).toBe(3);
  });

  it("settles three immediate child exits without waiting for publication deadlines", async () => {
    const children = Array.from({ length: 3 }, (_, index) => ({
      pid: 100 + index,
      exited: Promise.resolve({ exitCode: 1 }),
      isAlive: () => false,
      stop: vi.fn(async () => {}),
    }));
    const start = vi.fn(async () => children[start.mock.calls.length - 1]!);
    const deps = dependencies({ registration: "absent", observations: [{ kind: "absent" }] });
    const delay = vi.spyOn(deps, "delay");
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
    expect(result).toMatchObject({ status: "refused", cause: "never-published" });
    expect(start).toHaveBeenCalledTimes(3);
    expect(delay).not.toHaveBeenCalled();
    expect(children.every(({ stop }) => stop.mock.calls.length === 1)).toBe(true);
  });

  it.each([
    ["not-configured", 4],
    ["unreadable", 1],
    ["malformed", 1],
  ] as const)(
    "immediately refuses typed %s without retrying or consuming the shared start budget",
    async (readinessFailure, exitCode) => {
      const budget = { remainingAttempts: 3, deadline: 60_000 };
      const owned = {
        pid: 100,
        exited: Promise.resolve({ exitCode, readinessFailure }),
        isAlive: () => false,
        stop: vi.fn(async () => {}),
      };
      const start = vi.fn(async () => owned);
      const deps = dependencies({ registration: "absent", observations: [{ kind: "absent" }] });
      const delay = vi.spyOn(deps, "delay");

      const result = await resolveDesktopDaemon(
        {
          env: {},
          executablePath: "/Applications/Enduragent",
          appVersion: "0.1.0",
          signal: new AbortController().signal,
          startAppSupervisedDaemon: start,
          startBudget: budget,
        },
        deps,
      );

      expect(result).toEqual({
        status: "refused",
        exitCode,
        classification: "configuration",
        cause: readinessFailure,
        retryable: false,
      });
      expect(start).toHaveBeenCalledOnce();
      expect(owned.stop).toHaveBeenCalledOnce();
      expect(delay).not.toHaveBeenCalled();
      expect(budget.remainingAttempts).toBe(3);
      expect(JSON.stringify(result)).not.toContain("synthetic-private");
    },
  );

  it("observes every child exit before starting its replacement", async () => {
    const order: string[] = [];
    const children = Array.from({ length: 3 }, (_, index) => {
      const sequence = index + 1;
      let resolveExit!: (value: { readonly exitCode: number | null }) => void;
      const exited = new Promise<{ readonly exitCode: number | null }>((resolve) => {
        resolveExit = resolve;
      }).then((value) => {
        order.push(`exit-${sequence}`);
        return value;
      });
      const stop = vi.fn(async () => {
        order.push(`stop-${sequence}`);
        resolveExit({ exitCode: 0 });
      });
      return { pid: 90 + sequence, exited, isAlive: () => true, stop };
    });
    const start = vi.fn(async () => {
      const sequence = start.mock.calls.length;
      order.push(`start-${sequence}`);
      return children[sequence - 1]!;
    });
    const result = await resolveDesktopDaemon(
      {
        env: {},
        executablePath: "/Applications/Enduragent",
        appVersion: "0.1.0",
        signal: new AbortController().signal,
        startAppSupervisedDaemon: start,
      },
      dependencies({ registration: "absent", observations: [{ kind: "absent" }] }),
    );
    expect(result).toMatchObject({ status: "refused", classification: "never-published" });
    expect(order).toEqual([
      "start-1",
      "stop-1",
      "exit-1",
      "start-2",
      "stop-2",
      "exit-2",
      "start-3",
      "stop-3",
      "exit-3",
    ]);
  });

  it("allows a cold first start to publish after twenty-five seconds", async () => {
    let now = 0;
    let started = false;
    const owned = child();
    const start = vi.fn(async () => {
      started = true;
      return owned;
    });
    const base = dependencies({ registration: "absent", observations: [{ kind: "absent" }] });
    const result = await resolveDesktopDaemon(
      {
        env: {},
        executablePath: "/Applications/Enduragent",
        appVersion: "0.1.0",
        signal: new AbortController().signal,
        startAppSupervisedDaemon: start,
      },
      {
        ...base,
        observeDaemonState: async () =>
          started && now >= 25_000 ? healthy("app-supervised") : { kind: "absent" },
        delay: async (ms) => {
          now += ms;
        },
        monotonicNow: () => now,
      },
    );
    expect(result).toMatchObject({ status: "connected", supervision: "app-supervised" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(now).toBeGreaterThanOrEqual(25_000);
    expect(now).toBeLessThan(30_000);
    if (result.status === "connected") await result.close();
    expect(owned.stop).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["registered auth failure", "registered", { kind: "auth-invalid" }, 3, "unavailable", true],
    ["registered foreign peer", "registered", { kind: "foreign" }, 3, "contention", true],
    ["registered bound peer", "registered", { kind: "bound-unresponsive" }, 3, "unavailable", true],
    ["unregistered auth failure", "absent", { kind: "auth-invalid" }, 3, "unavailable", true],
    [
      "client-older mismatch",
      "registered",
      mismatch("service-managed", "client-older"),
      5,
      "version-mismatch",
      false,
    ],
  ] as const)(
    "refuses %s without spawning",
    async (_name, registration, observation, exitCode, cause, retryable) => {
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
      expect(result).toMatchObject({ status: "refused", exitCode, cause, retryable });
      expect(start).not.toHaveBeenCalled();
    },
  );

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
    expect(result).toMatchObject({ status: "refused", exitCode: 3, cause: "unavailable" });
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

  it.each(["refuse", "retry", "throw"] as const)(
    "preserves a typed client-newer handoff exit when second-starter resolution ends with %s",
    async (outcome) => {
      const budget = { remainingAttempts: 3, deadline: 60_000 };
      const successor = {
        pid: 101,
        exited: Promise.resolve({ exitCode: 1, readinessFailure: "malformed" as const }),
        isAlive: () => false,
        stop: vi.fn(async () => {}),
      };
      const start = vi.fn(async () => successor);
      const base = dependencies({
        registration: "absent",
        observations: [mismatch("app-supervised", "client-newer")],
      });
      const resolveSecondStarter = vi.fn(async (_input, binding) => {
        await binding.serviceUpgrade.startEphemeralSuccessor({
          home,
          targetProtocolVersion: PROTOCOL_VERSION,
          handoffCapability: "h".repeat(43),
        });
        if (outcome === "throw") throw new Error("synthetic handoff failure");
        if (outcome === "retry") return { status: "retry-startup" as const };
        return {
          status: "refuse" as const,
          exitCode: 3 as const,
          stdout: "" as const,
          stderr: "",
        };
      });

      const result = await resolveDesktopDaemon(
        {
          env: {},
          executablePath: "/Applications/Enduragent",
          appVersion: "0.1.0",
          signal: new AbortController().signal,
          startAppSupervisedDaemon: start,
          startBudget: budget,
        },
        { ...base, resolveSecondStarter },
      );

      expect(result).toEqual({
        status: "refused",
        exitCode: 1,
        classification: "configuration",
        cause: "malformed",
        retryable: false,
      });
      expect(start).toHaveBeenCalledOnce();
      expect(successor.stop).toHaveBeenCalledOnce();
      expect(budget.remainingAttempts).toBe(3);
      expect(JSON.stringify(result)).not.toContain("synthetic handoff failure");
    },
  );

  it("keeps handoff cleanup failure ahead of an already typed successor exit", async () => {
    const successor = {
      pid: 101,
      exited: Promise.resolve({ exitCode: 1, readinessFailure: "unreadable" as const }),
      isAlive: () => false,
      stop: vi.fn(async () => {
        throw new Error("synthetic cleanup failure");
      }),
    };
    const base = dependencies({
      registration: "absent",
      observations: [mismatch("app-supervised", "client-newer")],
    });
    const resolveSecondStarter = vi.fn(async (_input, binding) => {
      await binding.serviceUpgrade.startEphemeralSuccessor({
        home,
        targetProtocolVersion: PROTOCOL_VERSION,
        handoffCapability: "h".repeat(43),
      });
      throw new Error("synthetic handoff failure");
    });

    const result = await resolveDesktopDaemon(
      {
        env: {},
        executablePath: "/Applications/Enduragent",
        appVersion: "0.1.0",
        signal: new AbortController().signal,
        startAppSupervisedDaemon: vi.fn(async () => successor),
      },
      { ...base, resolveSecondStarter },
    );

    expect(result).toMatchObject({
      status: "refused",
      cause: "termination-failed",
      retryable: false,
    });
    expect(successor.stop).toHaveBeenCalledOnce();
  });

  it("stops client-newer handoff after an unconfirmed utility cleanup", async () => {
    const successor = child();
    const start = vi
      .fn()
      .mockRejectedValueOnce(new AppSupervisedDaemonStartError("termination-failed"))
      .mockResolvedValue(successor);
    const base = dependencies({
      registration: "absent",
      observations: [mismatch("app-supervised", "client-newer")],
    });
    const resolveSecondStarter = vi.fn(async (_input, binding) => {
      await binding.serviceUpgrade.startEphemeralSuccessor({
        home,
        targetProtocolVersion: PROTOCOL_VERSION,
        handoffCapability: "h".repeat(43),
      });
      throw new Error("unreachable");
    });
    const result = await resolveDesktopDaemon(
      {
        env: {},
        executablePath: "/Applications/Enduragent",
        appVersion: "0.1.0",
        signal: new AbortController().signal,
        startAppSupervisedDaemon: start,
      },
      { ...base, resolveSecondStarter },
    );
    expect(result).toMatchObject({
      status: "refused",
      cause: "termination-failed",
      retryable: false,
    });
    expect(resolveSecondStarter).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(successor.stop).not.toHaveBeenCalled();
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
    expect(result).toMatchObject({ status: "refused", exitCode: 3, cause: "cancelled" });
    expect(owned.stop).toHaveBeenCalledTimes(1);
  });
});
