import { PassThrough, Writable } from "node:stream";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EXIT_SUCCESS, PROTOCOL_VERSION } from "@enduragent/coach-contract";
import {
  CoachRemoteError,
  type CoachDaemonController,
  type CoachVerbTransport,
} from "@enduragent/coach-cli";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import type { LaunchdServiceStatus } from "@enduragent/kernel-node/service";
import {
  createServiceUpgradePort,
  decideServiceAwareAutoStart,
  observeDaemonState,
  runEnduragent,
  type DaemonStateObservation,
} from "../src/enduragent.js";

function capture(): { readonly stream: Writable; read(): string } {
  let text = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        text += String(chunk);
        callback();
      },
    }),
    read: () => text,
  };
}

function terminal() {
  const stdout = capture();
  const stderr = capture();
  return {
    stdout,
    stderr,
    value: {
      input: new PassThrough(),
      stdout: stdout.stream,
      stderr: stderr.stream,
      isTTY: false,
    },
  };
}

const home: AthleteHome = {
  root: "/tmp/synthetic-athlete",
  storeDir: "/tmp/synthetic-athlete/store",
  archiveDir: "/tmp/synthetic-athlete/archive",
  configDir: "/tmp/synthetic-athlete/config",
};
const rendererCapability = Buffer.alloc(32, 2).toString("base64url");

const paths = {
  launchAgentsDir: "/tmp/LaunchAgents",
  plistPath: "/tmp/LaunchAgents/ai.enduragent.coach.synthetic.plist",
  stateDir: "/tmp/synthetic-athlete/config/service",
  envPath: "/tmp/synthetic-athlete/config/service/service.env",
  wrapperPath: "/tmp/synthetic-athlete/config/service/service.sh",
  handoffPath: "/tmp/synthetic-athlete/config/service/service.handoff",
};

const registeredStatus: LaunchdServiceStatus = {
  kind: "registered",
  registered: true,
  installed: true,
  loaded: true,
  running: false,
  label: "ai.enduragent.coach.synthetic",
  pid: null,
  lastExitStatus: 0,
  paths,
};

describe("service-aware arbitration", () => {
  it("implements every registration and peer decision row", () => {
    const peers: DaemonStateObservation["kind"][] = [
      "compatible-healthy",
      "absent",
      "bound-unresponsive",
      "foreign",
      "auth-invalid",
      "version-mismatch",
    ];
    for (const registration of ["unknown", "registered", "absent"] as const) {
      for (const peer of peers) {
        const expected =
          peer === "compatible-healthy"
            ? "attach"
            : registration === "registered" && peer === "absent"
              ? "resume-service-then-attach"
              : registration === "absent" && peer === "absent"
                ? "spawn-ephemeral"
                : "refuse-daemon-unavailable";
        expect(decideServiceAwareAutoStart({ registration, peer })).toBe(expected);
      }
    }
  });

  it("maps the landed classifier and authenticated handshake without preserving transport", async () => {
    const peer = { status: "peer-healthy" as const, pid: 7, port: 43_210, peerVersion: "0.1.0" };
    const classify = vi.fn(async () => ({ status: "peer-healthy" as const, peer }));
    const handshake = vi.fn(async () => ({
      type: "handshake" as const,
      status: "accepted" as const,
      clientProtocolVersion: 14 as const,
      serverProtocolVersion: 14 as const,
      owner: "service-managed" as const,
      athleteHome: home.root,
      rendererCapability,
    }));
    await expect(
      observeDaemonState(
        { home },
        {
          classifyPeerReadOnly: classify,
          observePeerHandshake: handshake,
          readDaemonCoordinates: async () => ({ port: peer.port, token: "x".repeat(43) }),
        },
      ),
    ).resolves.toEqual({
      kind: "compatible-healthy",
      peer: { pid: 7, port: 43_210, peerVersion: "0.1.0" },
      serverProtocolVersion: PROTOCOL_VERSION,
      authenticated: {
        peer,
        coordinates: { port: peer.port, token: "x".repeat(43) },
        handshake: {
          type: "handshake",
          status: "accepted",
          clientProtocolVersion: PROTOCOL_VERSION,
          serverProtocolVersion: PROTOCOL_VERSION,
          owner: "service-managed",
          athleteHome: home.root,
          rendererCapability,
        },
      },
    });
    expect(handshake).toHaveBeenCalledWith({
      port: peer.port,
      token: "x".repeat(43),
      clientProtocolVersion: PROTOCOL_VERSION,
    });

    for (const [classification, expected] of [
      [{ status: "writer-clear" as const }, { kind: "absent" }],
      [
        { status: "bound-unresponsive" as const, stdout: "" as const, stderr: "x" },
        { kind: "bound-unresponsive" },
      ],
      [{ status: "foreign-port" as const, stdout: "" as const, stderr: "x" }, { kind: "foreign" }],
    ] as const) {
      await expect(
        observeDaemonState(
          { home },
          {
            classifyPeerReadOnly: async () => classification,
            observePeerHandshake: vi.fn(),
            readDaemonCoordinates: vi.fn(),
          },
        ),
      ).resolves.toEqual(expected);
    }
  });

  it("collapses handshake rejection to auth-invalid and preserves typed mismatch", async () => {
    const peer = { status: "peer-healthy" as const, pid: null, port: 43_211, peerVersion: "old" };
    const common = {
      classifyPeerReadOnly: async () => ({ status: "peer-healthy" as const, peer }),
      readDaemonCoordinates: async () => ({ port: peer.port, token: "y".repeat(43) }),
    };
    await expect(
      observeDaemonState(
        { home },
        {
          ...common,
          observePeerHandshake: async () => {
            throw new Error("private auth cause");
          },
        },
      ),
    ).resolves.toEqual({ kind: "auth-invalid" });
    await expect(
      observeDaemonState(
        { home },
        {
          ...common,
          observePeerHandshake: async () => ({
            type: "handshake",
            status: "accepted",
            clientProtocolVersion: PROTOCOL_VERSION,
            serverProtocolVersion: PROTOCOL_VERSION,
            owner: "service-managed",
            athleteHome: "/tmp/different-athlete",
            rendererCapability,
          }),
        },
      ),
    ).resolves.toEqual({ kind: "auth-invalid" });
    await expect(
      observeDaemonState(
        { home },
        {
          ...common,
          observePeerHandshake: async () => ({
            type: "handshake",
            status: "version-mismatch",
            clientProtocolVersion: PROTOCOL_VERSION,
            serverProtocolVersion: PROTOCOL_VERSION + 1,
            direction: "client-older",
            owner: "service-managed",
          }),
        },
      ),
    ).resolves.toEqual({
      kind: "version-mismatch",
      failure: { kind: "version-mismatch", direction: "client-older" },
      authenticated: {
        peer,
        coordinates: { port: peer.port, token: "y".repeat(43) },
        handshake: {
          type: "handshake",
          status: "version-mismatch",
          clientProtocolVersion: PROTOCOL_VERSION,
          serverProtocolVersion: PROTOCOL_VERSION + 1,
          direction: "client-older",
          owner: "service-managed",
        },
      },
    });
  });
});

describe("launchd composition", () => {
  it("preserves the designated successor input and fails closed on unknown status", async () => {
    const input = {
      home,
      targetProtocolVersion: PROTOCOL_VERSION,
      handoffCapability: "z".repeat(43),
    };
    const restartInstalled = vi.fn(async () => {});
    const resumeAfterEphemeral = vi.fn(async () => {});
    const startEphemeral = vi.fn(async () => {});
    const service = createServiceUpgradePort(home, {
      readStatus: async () => registeredStatus,
      restartInstalled,
      resumeAfterEphemeral,
      startEphemeral,
    });
    await expect(service.isInstalled(home)).resolves.toBe(true);
    await service.restartInstalledService(input);
    await service.kickstartInstalledServiceAfterEphemeral(input);
    await service.startEphemeralSuccessor(input);
    expect(restartInstalled).toHaveBeenCalledWith(input);
    expect(resumeAfterEphemeral).toHaveBeenCalledWith(input);
    expect(startEphemeral).toHaveBeenCalledWith(input);
    await expect(
      createServiceUpgradePort(home, {
        readStatus: async () => ({
          ...registeredStatus,
          kind: "unknown",
          registered: null,
          installed: null,
          loaded: null,
          running: null,
          pid: null,
          lastExitStatus: null,
          detail: "launchd status unavailable",
        }),
        restartInstalled,
        resumeAfterEphemeral,
        startEphemeral,
      }).isInstalled(home),
    ).rejects.toThrow("service status unavailable");
  });

  it("short-circuits unsupported daemon verbs before resolving home or executable", async () => {
    const io = terminal();
    const resolveHome = vi.fn(() => home);
    const resolveExecutablePath = vi.fn(async () => "/tmp/enduragent");
    await expect(
      runEnduragent(
        {
          argv: ["daemon", "status"],
          env: {},
          terminal: io.value,
          signal: new AbortController().signal,
        },
        {
          resolveAthleteHome: resolveHome,
          withLocalCoach: vi.fn(),
          readPackageVersion: async () => "unused",
          resolveExecutablePath,
          platform: "linux",
        },
      ),
    ).resolves.toBe(2);
    expect(resolveHome).not.toHaveBeenCalled();
    expect(resolveExecutablePath).not.toHaveBeenCalled();
    expect(io.stderr.read()).toBe("Enduragent service management is available only on macOS.\n");
  });

  it("prepares one physical Darwin home before invoking a daemon controller action", async () => {
    const io = terminal();
    const relativeHome: AthleteHome = {
      root: "synthetic-relative",
      storeDir: "synthetic-relative/store",
      archiveDir: "synthetic-relative/archive",
      configDir: "synthetic-relative/config",
    };
    const physicalHome: AthleteHome = {
      root: "/tmp/physical-synthetic-athlete",
      storeDir: "/tmp/physical-synthetic-athlete/store",
      archiveDir: "/tmp/physical-synthetic-athlete/archive",
      configDir: "/tmp/physical-synthetic-athlete/config",
    };
    const prepareHome = vi.fn(async (selectedHome: AthleteHome) => {
      expect(selectedHome).toEqual({
        root: resolve("synthetic-relative"),
        storeDir: resolve("synthetic-relative/store"),
        archiveDir: resolve("synthetic-relative/archive"),
        configDir: resolve("synthetic-relative/config"),
      });
      return physicalHome;
    });
    const install = vi.fn(async () => ({
      kind: "registered" as const,
      label: "ai.enduragent.coach.synthetic",
      installed: true,
      loaded: true,
      running: true,
      pid: 9,
    }));
    let received: { readonly home: AthleteHome; readonly executablePath: string } | undefined;
    const controller: CoachDaemonController = {
      supported: true,
      install,
      status: vi.fn(),
      restart: vi.fn(),
    };
    await expect(
      runEnduragent(
        {
          argv: ["daemon", "install"],
          env: {},
          terminal: io.value,
          signal: new AbortController().signal,
        },
        {
          resolveAthleteHome: () => relativeHome,
          prepareAthleteHome: prepareHome,
          withLocalCoach: vi.fn(),
          readPackageVersion: async () => "unused",
          platform: "darwin",
          resolveExecutablePath: async () => "/tmp/real-enduragent",
          createDaemonController: (input) => {
            received = input;
            return controller;
          },
        },
      ),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(received).toEqual({
      home: physicalHome,
      executablePath: "/tmp/real-enduragent",
    });
    expect(prepareHome).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("resumes a registered stopped service before bounded retry and never spawns", async () => {
    const io = terminal();
    const transport: CoachVerbTransport = {
      kind: "remote",
      async request(request) {
        const envelope = { jsonrpc: "2.0" as const, id: 1, result: { text: "ok" } };
        request.onTerminalEnvelope(envelope);
        return envelope;
      },
      close: async () => {},
    };
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new CoachRemoteError({ kind: "unavailable" }))
      .mockResolvedValueOnce(transport);
    const resumeService = vi.fn(async () => "resumed" as const);
    const startEphemeralDaemon = vi.fn();
    await expect(
      runEnduragent(
        {
          argv: ["ask", "hello"],
          env: {},
          terminal: io.value,
          signal: new AbortController().signal,
        },
        {
          resolveAthleteHome: () => home,
          withLocalCoach: vi.fn(),
          readPackageVersion: async () => "unused",
          connectRemoteTransport: connect,
          serviceRegistrationState: async (): Promise<"present"> => "present",
          observeDaemonState: async () => ({ kind: "absent" }),
          resolveExecutablePath: async () => "/tmp/real-enduragent",
          resumeService,
          startEphemeralDaemon,
          delay: async () => {},
          monotonicNow: () => 0,
        },
      ),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(resumeService).toHaveBeenCalledTimes(1);
    expect(startEphemeralDaemon).not.toHaveBeenCalled();
    expect(io.stdout.read()).toBe("ok\n");
  });
});
