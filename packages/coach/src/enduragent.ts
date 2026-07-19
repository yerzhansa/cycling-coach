#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  DaemonOwnerSchema,
  EXIT_AGENT_ERROR,
  EXIT_DAEMON_UNAVAILABLE,
  EXIT_NOT_CONFIGURED,
  EXIT_SUCCESS,
  EXIT_USAGE,
  EXIT_VERSION_MISMATCH,
  PROTOCOL_VERSION,
  ServerHandshakeFrameSchema,
  type DaemonOwner,
  type ExitCode,
} from "@enduragent/coach-contract";
import {
  CoachCliSessionStartError,
  CoachRemoteError,
  InvalidCoachCliSessionError,
  connectCoachVerbTransport,
  connectWithBoundedRetry,
  createCoachVerbRequest,
  createLocalCoachVerbTransport,
  parseCoachCliInvocation,
  resolveCoachCliSession,
  runCoachRepl,
  runCoachDaemonCommand,
  runCoachVerb,
  type CoachDaemonController,
  type CoachCliTerminal,
  type CoachCliVerbInvocation,
  type CoachRemoteFailure,
  type CoachVerbRequest,
  type CoachVerbTransport,
  type DaemonServiceSnapshot,
  type ServiceRegistrationState,
} from "@enduragent/coach-cli";
import { expandTilde, resolveAthleteHome, type AthleteHome } from "@enduragent/kernel-node/home";
import { PORT_FILE_NAME } from "@enduragent/kernel-node/lock";
import {
  canonicalizeAthleteHome,
  createLaunchdServiceIdentity,
  installLaunchdService,
  readLaunchdServiceStatus,
  restartLaunchdService,
  restartLaunchdServiceForUpgrade,
  resumeLaunchdService,
  resumeLaunchdServiceAfterEphemeral,
  type LaunchdServiceStatus,
} from "@enduragent/kernel-node/service";
import { StoreNewerThanAppError } from "@enduragent/kernel/store";
import {
  classifyPeerReadOnly,
  observePeerHandshake,
  openAuthenticatedDaemonControl,
  resolveSecondStarter as resolveSecondStarterProduction,
  type CompatiblePeerWaitOutcome,
  type DesignatedSuccessorInput,
  type ReadOnlyPeerClassification,
  type ResolveSecondStarterDependencies,
  type ResolveSecondStarterInput,
  type ServiceUpgradePort,
  type StarterResolution,
  type WriterReleaseWaitOutcome,
} from "./daemon/handshake.js";
import {
  acquireUpgradeFence,
  admitStartupThroughUpgradeFence,
  type MonotonicTimer,
  type UpgradeFenceHandle,
} from "./daemon/upgrade-fence.js";
import {
  withLocalCoach,
  type LocalCoachRunResult,
  type WithLocalCoachInput,
} from "./local-runner.js";
import { serializeBoundaryError } from "./daemon/error-boundary.js";
import { CoachStoreWriterError } from "./runtime.js";
import { runCoachServe } from "./serve.js";

export interface RunEnduragentInput {
  readonly argv: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly terminal: CoachCliTerminal;
  readonly signal: AbortSignal;
}

export interface EnduragentDependencies {
  readonly resolveAthleteHome: (env: Record<string, string | undefined>) => AthleteHome;
  readonly withLocalCoach: <T>(input: WithLocalCoachInput<T>) => Promise<LocalCoachRunResult<T>>;
  readonly readPackageVersion: () => Promise<string>;
  readonly connectRemoteTransport?: (
    home: AthleteHome,
    expectedPort?: number,
  ) => Promise<CoachVerbTransport>;
  readonly serviceRegistrationState?: () => Promise<ServiceRegistrationState>;
  readonly startEphemeralDaemon?: (input: {
    readonly env: Record<string, string | undefined>;
    readonly home: AthleteHome;
    readonly executablePath?: string;
  }) => Promise<{
    readonly disposeAfterFailedStart: () => Promise<void>;
    readonly detachAfterHealthy: () => void;
  }>;
  readonly delay?: (ms: number) => Promise<void>;
  readonly monotonicNow?: () => number;
  readonly createFreshId?: () => string;
  readonly resolveExecutablePath?: () => Promise<string>;
  readonly createDaemonController?: (input: {
    readonly home: AthleteHome;
    readonly executablePath: string;
  }) => CoachDaemonController;
  readonly readServiceStatus?: (input: {
    readonly home: AthleteHome;
    readonly executablePath: string;
  }) => Promise<LaunchdServiceStatus>;
  readonly resumeService?: (input: {
    readonly home: AthleteHome;
    readonly executablePath: string;
  }) => Promise<"resumed" | "not-installed">;
  readonly observeDaemonState?: (input: {
    readonly home: AthleteHome;
  }) => Promise<DaemonStateObservation>;
  readonly startEphemeralSuccessor?: (input: DesignatedSuccessorInput) => Promise<void>;
  readonly resolveSecondStarter?: (
    input: ResolveSecondStarterInput,
    dependencies: ResolveSecondStarterDependencies,
  ) => Promise<StarterResolution>;
  readonly platform?: NodeJS.Platform;
}

export type ServiceRegistrationClass = "absent" | "registered" | "unknown";

export type DaemonStateObservation =
  | {
      readonly kind: "compatible-healthy";
      readonly peer: {
        readonly pid: number | null;
        readonly port: number;
        readonly peerVersion: string;
      };
      readonly serverProtocolVersion: number;
    }
  | { readonly kind: "absent" }
  | { readonly kind: "bound-unresponsive" }
  | { readonly kind: "foreign" }
  | { readonly kind: "auth-invalid" }
  | {
      readonly kind: "version-mismatch";
      readonly failure: Extract<CoachRemoteFailure, { kind: "version-mismatch" }>;
    };

export type PeerAvailabilityClass = DaemonStateObservation["kind"];

export type ServiceAwareAutoStartDecision =
  | "attach"
  | "resume-service-then-attach"
  | "spawn-ephemeral"
  | "refuse-daemon-unavailable";

export function decideServiceAwareAutoStart(input: {
  readonly registration: ServiceRegistrationClass;
  readonly peer: PeerAvailabilityClass;
}): ServiceAwareAutoStartDecision {
  if (input.peer === "compatible-healthy") return "attach";
  if (input.registration === "registered" && input.peer === "absent") {
    return "resume-service-then-attach";
  }
  if (input.registration === "absent" && input.peer === "absent") {
    return "spawn-ephemeral";
  }
  return "refuse-daemon-unavailable";
}

async function readPackageVersion(): Promise<string> {
  const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object") {
    throw new TypeError("invalid package metadata");
  }
  const version = (parsed as { readonly version?: unknown }).version;
  if (typeof version !== "string" || version.length === 0) {
    throw new TypeError("invalid package version");
  }
  return version;
}

interface DaemonCoordinates {
  readonly port: number;
  readonly token: string;
}

async function readDaemonCoordinates(home: AthleteHome): Promise<DaemonCoordinates> {
  const [rawPort, rawToken] = await Promise.all([
    readFile(join(home.configDir, PORT_FILE_NAME), "utf8"),
    readFile(join(home.configDir, "daemon.token"), "utf8"),
  ]);
  const port = Number(rawPort.trim());
  const token = rawToken.endsWith("\n") ? rawToken.slice(0, -1) : "";
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new TypeError("invalid daemon coordinates");
  }
  return { port, token };
}

export interface ObserveDaemonStateDependencies {
  readonly classifyPeerReadOnly: typeof classifyPeerReadOnly;
  readonly observePeerHandshake: typeof observePeerHandshake;
  readonly readDaemonCoordinates: (home: AthleteHome) => Promise<DaemonCoordinates>;
}

const observeDaemonStateDependencies: ObserveDaemonStateDependencies = {
  classifyPeerReadOnly,
  observePeerHandshake,
  readDaemonCoordinates,
};

export async function observeDaemonState(
  input: { readonly home: AthleteHome },
  dependencies: ObserveDaemonStateDependencies = observeDaemonStateDependencies,
): Promise<DaemonStateObservation> {
  let classified: ReadOnlyPeerClassification;
  try {
    classified = await dependencies.classifyPeerReadOnly(input.home);
  } catch {
    return { kind: "auth-invalid" };
  }
  if (classified.status === "writer-clear") return { kind: "absent" };
  if (classified.status === "bound-unresponsive") return { kind: "bound-unresponsive" };
  if (classified.status === "foreign-port") return { kind: "foreign" };
  try {
    const coordinates = await dependencies.readDaemonCoordinates(input.home);
    if (coordinates.port !== classified.peer.port) return { kind: "auth-invalid" };
    const { token } = coordinates;
    const frame = ServerHandshakeFrameSchema.parse(
      await dependencies.observePeerHandshake({
        port: classified.peer.port,
        token,
        clientProtocolVersion: PROTOCOL_VERSION,
      }),
    );
    if (frame.clientProtocolVersion !== PROTOCOL_VERSION) {
      return { kind: "auth-invalid" };
    }
    if (
      frame.status === "accepted" &&
      frame.clientProtocolVersion === PROTOCOL_VERSION &&
      frame.serverProtocolVersion === PROTOCOL_VERSION
    ) {
      return {
        kind: "compatible-healthy",
        peer: {
          pid: classified.peer.pid,
          port: classified.peer.port,
          peerVersion: classified.peer.peerVersion,
        },
        serverProtocolVersion: frame.serverProtocolVersion,
      };
    }
    if (frame.status === "version-mismatch") {
      return {
        kind: "version-mismatch",
        failure: { kind: "version-mismatch", direction: frame.direction },
      };
    }
    return { kind: "auth-invalid" };
  } catch {
    return { kind: "auth-invalid" };
  }
}

async function resolveExecutablePath(): Promise<string> {
  const executable = process.argv[1];
  if (executable === undefined || executable.length === 0 || !isAbsolute(executable)) {
    throw new TypeError("invalid executable path");
  }
  return realpath(resolve(executable));
}

async function resolveConfiguredExecutable(dependencies: EnduragentDependencies): Promise<string> {
  const executablePath = await dependencies.resolveExecutablePath!();
  if (!isAbsolute(executablePath)) throw new TypeError("invalid executable path");
  return executablePath;
}

function serviceSnapshot(status: LaunchdServiceStatus): DaemonServiceSnapshot {
  if (status.kind === "absent") {
    return {
      kind: "absent",
      label: status.label,
      installed: false,
      loaded: false,
      running: false,
      pid: null,
    };
  }
  if (status.kind === "registered") {
    return {
      kind: "registered",
      label: status.label,
      installed: status.installed,
      loaded: status.loaded,
      running: status.running,
      pid: status.pid,
    };
  }
  return {
    kind: "unknown",
    label: status.label,
    installed: status.installed,
    loaded: null,
    running: null,
    pid: null,
  };
}

function createDaemonController(input: {
  readonly home: AthleteHome;
  readonly executablePath: string;
}): CoachDaemonController {
  const identity = createLaunchdServiceIdentity(input);
  return {
    supported: process.platform === "darwin",
    install: async () => serviceSnapshot(await installLaunchdService(identity)),
    status: async () => serviceSnapshot(await readLaunchdServiceStatus(identity)),
    restart: async () => serviceSnapshot(await restartLaunchdService(identity)),
  };
}

async function defaultReadServiceStatus(input: {
  readonly home: AthleteHome;
  readonly executablePath: string;
}): Promise<LaunchdServiceStatus> {
  return readLaunchdServiceStatus(createLaunchdServiceIdentity(input));
}

async function defaultResumeService(input: {
  readonly home: AthleteHome;
  readonly executablePath: string;
}): Promise<"resumed" | "not-installed"> {
  return resumeLaunchdService(createLaunchdServiceIdentity(input));
}

const defaultDependencies: EnduragentDependencies = Object.freeze({
  resolveAthleteHome,
  withLocalCoach,
  readPackageVersion,
  connectRemoteTransport: async (home: AthleteHome, expectedPort?: number) => {
    try {
      const { port, token } = await readDaemonCoordinates(home);
      if (expectedPort !== undefined && expectedPort !== port) {
        throw new TypeError("daemon peer changed");
      }
      return await connectCoachVerbTransport({
        url: `ws://127.0.0.1:${port}/rpc`,
        token,
      });
    } catch (error) {
      if (error instanceof CoachRemoteError) throw error;
      throw new CoachRemoteError({ kind: "unavailable" });
    }
  },
  serviceRegistrationState: async (): Promise<ServiceRegistrationState> => "unknown",
  startEphemeralDaemon: startEphemeralDaemonProcess,
  delay: (ms: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms)),
  monotonicNow: () => performance.now(),
  resolveExecutablePath,
  createDaemonController,
  readServiceStatus: defaultReadServiceStatus,
  resumeService: defaultResumeService,
  observeDaemonState,
  startEphemeralSuccessor: startEphemeralSuccessorProcess,
  resolveSecondStarter: resolveSecondStarterProduction,
  platform: process.platform,
});

function childEnvironment(
  env: Record<string, string | undefined>,
  home: AthleteHome,
): NodeJS.ProcessEnv {
  const combined: Record<string, string | undefined> = {
    ...process.env,
    ...env,
    ENDURAGENT_HOME: home.root,
    ENDURAGENT_DAEMON_OWNER: undefined,
    ENDURAGENT_HANDOFF_CAPABILITY: undefined,
    ENDURAGENT_STARTER_CONTEXT_FD: "3",
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
  };
  return Object.fromEntries(
    Object.entries(combined).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function starterContextLine(successor?: DesignatedSuccessorInput): string {
  return `${JSON.stringify(
    successor === undefined
      ? { owner: "ephemeral-client-started" }
      : {
          owner: "ephemeral-client-started",
          targetProtocolVersion: successor.targetProtocolVersion,
          handoffCapability: successor.handoffCapability,
        },
  )}\n`;
}

function writeStarterContext(child: ReturnType<typeof spawn>, line: string): Promise<void> {
  const stream = child.stdio[3];
  if (stream === null || typeof (stream as { end?: unknown }).end !== "function") {
    return Promise.reject(new Error("starter context pipe unavailable"));
  }
  return new Promise((resolveWrite, rejectWrite) => {
    const writable = stream as NodeJS.WritableStream;
    const onError = (): void => rejectWrite(new Error("starter context write failed"));
    writable.once("error", onError);
    writable.end(line, "utf8", () => {
      writable.removeListener("error", onError);
      resolveWrite();
    });
  });
}

async function startEphemeralDaemonProcess(input: {
  readonly env: Record<string, string | undefined>;
  readonly home: AthleteHome;
  readonly executablePath?: string;
  readonly successor?: DesignatedSuccessorInput;
}): Promise<{
  readonly disposeAfterFailedStart: () => Promise<void>;
  readonly detachAfterHealthy: () => void;
}> {
  const executablePath = input.executablePath ?? (await resolveExecutablePath());
  let child!: ReturnType<typeof spawn>;
  try {
    child = spawn(executablePath, ["serve"], {
      detached: true,
      env: childEnvironment(input.env, input.home),
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    await writeStarterContext(child, starterContextLine(input.successor));
  } catch {
    try {
      child?.kill("SIGTERM");
    } catch {}
    throw new CoachRemoteError({ kind: "unavailable" });
  }
  return {
    disposeAfterFailedStart: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolveExit) => {
        const finish = (): void => resolveExit();
        child.once("exit", finish);
        child.once("error", finish);
        try {
          child.kill("SIGTERM");
        } catch {
          finish();
        }
      });
    },
    detachAfterHealthy: () => child.unref(),
  };
}

async function startEphemeralSuccessorProcess(input: DesignatedSuccessorInput): Promise<void> {
  const child = await startEphemeralDaemonProcess({
    env: process.env,
    home: input.home,
    executablePath: await resolveExecutablePath(),
    successor: input,
  });
  child.detachAfterHealthy();
}

function resolveLegacySourceRoot(env: Record<string, string | undefined>): string {
  const override = env.CYCLING_COACH_HOME;
  if (override !== undefined && override.length > 0) {
    return expandTilde(override);
  }
  return join(homedir(), ".cycling-coach");
}

function storeNewerThanApp(error: unknown): StoreNewerThanAppError | null {
  if (!(error instanceof CoachStoreWriterError)) return null;
  if (error.code !== "writer-failed" || error.stage !== "run migrations") return null;
  return error.cause instanceof StoreNewerThanAppError ? error.cause : null;
}

const VERB_USAGE =
  "Usage: enduragent <ask|state|analyze|plan week|wellness set> [--json|--stream-json] [--session <key>|--fresh] [--local]";

class InvalidVerbInputError extends Error {}

function explicitAskStdin(argv: readonly string[]): boolean {
  let flagsEnded = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!flagsEnded && token === "--") {
      flagsEnded = true;
      continue;
    }
    if (!flagsEnded && token === "--session") {
      index += 1;
      continue;
    }
    if (!flagsEnded && token.startsWith("-") && token !== "-") continue;
    return token === "-";
  }
  return false;
}

async function readStdinText(input: NodeJS.ReadableStream): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  try {
    for await (const chunk of input as AsyncIterable<unknown>) {
      if (!(chunk instanceof Uint8Array)) throw new InvalidVerbInputError();
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
  } catch {
    throw new InvalidVerbInputError();
  }
  if (text.endsWith("\n")) {
    text = text.slice(0, -1);
    if (text.endsWith("\r")) text = text.slice(0, -1);
  }
  if (text.includes("\0") || !/\S/u.test(text)) throw new InvalidVerbInputError();
  return text;
}

interface ServeStarterContext {
  readonly owner: DaemonOwner;
  readonly handoffCapability?: string;
}

function readStarterContextFd(): Promise<string> {
  return new Promise((resolveContext, rejectContext) => {
    const stream = createReadStream("/dev/null", { fd: 3, autoClose: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("starter context timed out")), 5_000);
    timeout.unref?.();
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stream.removeAllListeners();
      if (error !== undefined) {
        stream.destroy();
        rejectContext(error);
        return;
      }
      try {
        const bytes = Buffer.concat(chunks);
        const newline = bytes.indexOf(0x0a);
        if (newline !== bytes.length - 1 || bytes.indexOf(0x0a, newline + 1) !== -1) {
          throw new TypeError("invalid starter context framing");
        }
        resolveContext(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1)));
      } catch (decodeError) {
        rejectContext(decodeError);
      }
    };
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4_096) {
        finish(new Error("starter context is too large"));
        return;
      }
      chunks.push(chunk);
    });
    stream.once("end", () => finish());
    stream.once("error", () => finish(new Error("starter context read failed")));
  });
}

async function serveStarterContext(
  env: Record<string, string | undefined>,
): Promise<ServeStarterContext> {
  const fd = env.ENDURAGENT_STARTER_CONTEXT_FD;
  const ownerValue = env.ENDURAGENT_DAEMON_OWNER;
  const launchdCapability = env.ENDURAGENT_HANDOFF_CAPABILITY;
  delete env.ENDURAGENT_STARTER_CONTEXT_FD;
  delete env.ENDURAGENT_DAEMON_OWNER;
  delete env.ENDURAGENT_HANDOFF_CAPABILITY;

  if (fd !== undefined) {
    if (fd !== "3" || ownerValue !== undefined || launchdCapability !== undefined) {
      throw new TypeError("invalid starter context source");
    }
    const parsed: unknown = JSON.parse(await readStarterContextFd());
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("invalid starter context");
    }
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const owner = DaemonOwnerSchema.parse(record.owner);
    if (owner !== "ephemeral-client-started") {
      throw new TypeError("invalid starter owner");
    }
    if (keys.length === 1 && keys[0] === "owner") {
      return { owner };
    }
    if (
      keys.length !== 3 ||
      keys[0] !== "handoffCapability" ||
      keys[1] !== "owner" ||
      keys[2] !== "targetProtocolVersion" ||
      record.targetProtocolVersion !== PROTOCOL_VERSION ||
      typeof record.handoffCapability !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(record.handoffCapability)
    ) {
      throw new TypeError("invalid designated starter context");
    }
    return {
      owner,
      handoffCapability: record.handoffCapability,
    };
  }

  if (ownerValue === undefined && launchdCapability === undefined) {
    return { owner: "unmanaged-foreground" };
  }
  const owner = DaemonOwnerSchema.parse(ownerValue);
  if (owner !== "service-managed") throw new TypeError("invalid launchd starter owner");
  if (launchdCapability !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(launchdCapability)) {
    throw new TypeError("invalid launchd handoff capability");
  }
  return launchdCapability === undefined
    ? { owner }
    : { owner, handoffCapability: launchdCapability };
}

function writeContention(
  terminal: Pick<CoachCliTerminal, "stderr">,
  error: CoachStoreWriterError,
): void {
  if (error.contention?.kind === "holder") {
    terminal.stderr.write(
      `Enduragent cannot start: another writer holds this athlete home (pid ${error.contention.pid ?? "unknown"}, port ${error.contention.port}). Stop it or wait, then retry.\n`,
    );
    return;
  }
  if (error.contention?.kind === "foreign") {
    terminal.stderr.write(
      `Enduragent cannot start: 127.0.0.1:${error.contention.port} is held by a foreign process; change or remove the port file at ${error.contention.portFile}, then retry.\n`,
    );
  }
}

function renderLocalResult(
  result: Exclude<LocalCoachRunResult<ExitCode>, { readonly status: "completed" }>,
  terminal: Pick<CoachCliTerminal, "stderr">,
): ExitCode {
  if (result.status === "not-configured") {
    terminal.stderr.write(
      `Enduragent is not configured. Provision ${result.configPath} with provider credentials, then run: enduragent\n`,
    );
    return EXIT_NOT_CONFIGURED;
  }
  if (result.status === "migration-discarded") {
    terminal.stderr.write(
      `Enduragent migration plan ${result.result.manifestDigest} was discarded to ${result.result.archivePath}. Run enduragent again to replan.\n`,
    );
    return result.result.exitCode;
  }
  const manifest =
    result.result.manifestDigest === null ? "" : ` for manifest ${result.result.manifestDigest}`;
  terminal.stderr.write(
    `Enduragent cannot start: legacy migration was refused (${result.result.reason}). Review ${result.result.journalPath}${manifest} and resolve the reported condition before retrying.\n`,
  );
  return result.result.exitCode;
}

async function runWithOwnedTransport(
  transport: CoachVerbTransport,
  request: CoachVerbRequest,
  invocation: CoachCliVerbInvocation,
  terminal: CoachCliTerminal,
): Promise<ExitCode> {
  let exitCode: ExitCode | undefined;
  let primaryError: unknown;
  try {
    exitCode = await runCoachVerb({
      request,
      outputMode: invocation.outputMode,
      terminal,
      transport,
    });
  } catch (error) {
    primaryError = error;
  }
  try {
    await transport.close();
  } catch (error) {
    if (primaryError === undefined && exitCode === EXIT_SUCCESS) {
      terminal.stderr.write("Enduragent could not close the command transport.\n");
      return EXIT_AGENT_ERROR;
    }
    if (primaryError === undefined && exitCode === undefined) primaryError = error;
  }
  if (primaryError !== undefined) throw primaryError;
  return exitCode!;
}

function remoteConnectionFailure(
  error: CoachRemoteError,
  terminal: Pick<CoachCliTerminal, "stderr">,
): ExitCode {
  switch (error.failure.kind) {
    case "unavailable":
      terminal.stderr.write("Enduragent could not reach the local service.\n");
      return EXIT_DAEMON_UNAVAILABLE;
    case "version-mismatch":
      terminal.stderr.write("Enduragent protocol versions do not match; update this client.\n");
      return EXIT_VERSION_MISMATCH;
    case "agent":
      terminal.stderr.write("Enduragent could not complete this command.\n");
      return EXIT_AGENT_ERROR;
    case "detached":
      terminal.stderr.write(
        "Enduragent detached from the running turn; the turn may still complete.\n",
      );
      return EXIT_AGENT_ERROR;
  }
}

function sameAthleteHome(left: AthleteHome, right: AthleteHome): boolean {
  return (
    left.root === right.root &&
    left.storeDir === right.storeDir &&
    left.archiveDir === right.archiveDir &&
    left.configDir === right.configDir
  );
}

function canonicalHome(home: AthleteHome): AthleteHome {
  const canonical = canonicalizeAthleteHome(home);
  return sameAthleteHome(home, canonical) ? home : canonical;
}

function validateSuccessorInput(home: AthleteHome, input: DesignatedSuccessorInput): void {
  if (
    home.root !== input.home.root ||
    input.targetProtocolVersion !== PROTOCOL_VERSION ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.handoffCapability)
  ) {
    throw new TypeError("invalid designated successor");
  }
}

export interface ServiceUpgradeBindingDependencies {
  readonly readStatus: () => Promise<LaunchdServiceStatus>;
  readonly restartInstalled: (input: DesignatedSuccessorInput) => Promise<void>;
  readonly resumeAfterEphemeral: (input: DesignatedSuccessorInput) => Promise<void>;
  readonly startEphemeral: (input: DesignatedSuccessorInput) => Promise<void>;
}

export function createServiceUpgradePort(
  home: AthleteHome,
  dependencies: ServiceUpgradeBindingDependencies,
): ServiceUpgradePort {
  return {
    async isInstalled(inputHome) {
      if (home.root !== inputHome.root) throw new TypeError("athlete home changed");
      const status = await dependencies.readStatus();
      if (status.kind === "registered") return true;
      if (status.kind === "absent") return false;
      throw new Error("service status unavailable");
    },
    async restartInstalledService(input) {
      validateSuccessorInput(home, input);
      await dependencies.restartInstalled(input);
    },
    async kickstartInstalledServiceAfterEphemeral(input) {
      validateSuccessorInput(home, input);
      await dependencies.resumeAfterEphemeral(input);
    },
    async startEphemeralSuccessor(input) {
      validateSuccessorInput(home, input);
      await dependencies.startEphemeral(input);
    },
  };
}

function productionMonotonicTimer(now: () => number): MonotonicTimer {
  return {
    nowMs: now,
    schedule(delayMs, callback) {
      const timeout = setTimeout(callback, Math.max(0, delayMs));
      timeout.unref?.();
      return { cancel: () => clearTimeout(timeout) };
    },
  };
}

function timerDelay(timer: MonotonicTimer, delayMs: number): Promise<void> {
  return new Promise((resolveDelay) => {
    timer.schedule(delayMs, resolveDelay);
  });
}

async function waitForWriterRelease(input: {
  readonly home: AthleteHome;
  readonly incumbent: { readonly port: number; readonly peerVersion: string };
  readonly deadlineMs: number;
  readonly pollIntervalMs: number;
  readonly timer: MonotonicTimer;
}): Promise<WriterReleaseWaitOutcome> {
  while (input.timer.nowMs() < input.deadlineMs) {
    let classified: ReadOnlyPeerClassification;
    try {
      classified = await classifyPeerReadOnly(input.home);
    } catch {
      return { status: "observation-invalid" };
    }
    if (classified.status === "writer-clear") return { status: "released" };
    if (classified.status === "foreign-port") return { status: "observation-invalid" };
    if (
      classified.status === "peer-healthy" &&
      (classified.peer.port !== input.incumbent.port ||
        classified.peer.peerVersion !== input.incumbent.peerVersion)
    ) {
      return { status: "observation-invalid" };
    }
    await timerDelay(
      input.timer,
      Math.min(input.pollIntervalMs, input.deadlineMs - input.timer.nowMs()),
    );
  }
  return { status: "timeout" };
}

class CompatiblePeerObservationError extends Error {
  constructor(
    readonly outcome: Exclude<CompatiblePeerWaitOutcome, { status: "published" | "timeout" }>,
  ) {
    super("compatible peer observation failed");
  }
}

const observationTransport: CoachVerbTransport = {
  kind: "remote",
  request: async () => {
    throw new CoachRemoteError({ kind: "agent" });
  },
  close: async () => {},
};

async function waitForCompatiblePeer(input: {
  readonly home: AthleteHome;
  readonly protocolVersion: number;
  readonly token: string;
  readonly deadlineMs: number;
  readonly pollIntervalMs: number;
  readonly timer: MonotonicTimer;
}): Promise<CompatiblePeerWaitOutcome> {
  let published: Extract<CompatiblePeerWaitOutcome, { status: "published" }> | undefined;
  while (input.timer.nowMs() < input.deadlineMs) {
    try {
      await connectWithBoundedRetry({
        connect: async () => {
          let classified: ReadOnlyPeerClassification;
          try {
            classified = await classifyPeerReadOnly(input.home);
          } catch {
            throw new CompatiblePeerObservationError({ status: "observation-invalid" });
          }
          if (classified.status === "writer-clear" || classified.status === "bound-unresponsive") {
            throw new CoachRemoteError({ kind: "unavailable" });
          }
          if (classified.status === "foreign-port") {
            throw new CompatiblePeerObservationError({ status: "observation-invalid" });
          }
          let handshake: Awaited<ReturnType<typeof observePeerHandshake>>;
          try {
            handshake = await observePeerHandshake({
              port: classified.peer.port,
              token: input.token,
              clientProtocolVersion: input.protocolVersion,
            });
          } catch {
            throw new CompatiblePeerObservationError({ status: "observation-invalid" });
          }
          if (handshake.status === "version-mismatch") {
            throw new CompatiblePeerObservationError({ status: "incompatible", handshake });
          }
          if (
            handshake.clientProtocolVersion !== input.protocolVersion ||
            handshake.serverProtocolVersion !== input.protocolVersion
          ) {
            throw new CompatiblePeerObservationError({ status: "observation-invalid" });
          }
          published = {
            status: "published",
            peer: classified.peer,
            handshake,
          };
          return observationTransport;
        },
        delay: (delayMs) => timerDelay(input.timer, Math.max(input.pollIntervalMs, delayMs)),
        monotonicNow: input.timer.nowMs,
      });
      return published!;
    } catch (error) {
      if (error instanceof CompatiblePeerObservationError) return error.outcome;
      if (!(error instanceof CoachRemoteError) || error.failure.kind !== "unavailable") {
        return { status: "observation-invalid" };
      }
    }
  }
  return { status: "timeout" };
}

function createSecondStarterDependencies(input: {
  readonly home: AthleteHome;
  readonly executablePath: string;
  readonly dependencies: EnduragentDependencies;
}): ResolveSecondStarterDependencies {
  const identity = createLaunchdServiceIdentity({
    home: input.home,
    executablePath: input.executablePath,
  });
  const serviceUpgrade = createServiceUpgradePort(input.home, {
    readStatus: () =>
      input.dependencies.readServiceStatus!({
        home: input.home,
        executablePath: input.executablePath,
      }),
    restartInstalled: async (successor) => {
      await restartLaunchdServiceForUpgrade(identity, successor);
    },
    resumeAfterEphemeral: async (successor) => {
      await resumeLaunchdServiceAfterEphemeral(identity, successor);
    },
    startEphemeral: input.dependencies.startEphemeralSuccessor!,
  });
  return {
    observePeerHandshake,
    openUpgradeControl: openAuthenticatedDaemonControl,
    classifyPeerReadOnly,
    acquireUpgradeFence,
    serviceUpgrade,
    timer: productionMonotonicTimer(input.dependencies.monotonicNow!),
    waitForWriterRelease,
    waitForCompatiblePeer,
  };
}

async function prepareVerb(
  input: RunEnduragentInput,
  invocation: CoachCliVerbInvocation,
  dependencies: EnduragentDependencies,
): Promise<CoachVerbRequest> {
  let stdinText: string | undefined;
  if (invocation.verb.name === "ask" && invocation.verb.input.kind === "stdin") {
    if (input.terminal.isTTY && !explicitAskStdin(input.argv)) {
      throw new InvalidVerbInputError();
    }
    stdinText = await readStdinText(input.terminal.input);
  }
  const chatId =
    invocation.verb.name === "state"
      ? undefined
      : resolveCoachCliSession(invocation.session, dependencies.createFreshId).chatId;
  return createCoachVerbRequest({
    verb: invocation.verb,
    chatId,
    stdinText,
    signal: input.signal,
  });
}

async function serviceRegistrationClass(input: {
  readonly home: AthleteHome;
  readonly executablePath: string;
  readonly dependencies: EnduragentDependencies;
}): Promise<ServiceRegistrationClass> {
  if (
    input.dependencies.serviceRegistrationState !== defaultDependencies.serviceRegistrationState
  ) {
    const state = await input.dependencies.serviceRegistrationState!();
    return state === "present" ? "registered" : state;
  }
  return (
    await input.dependencies.readServiceStatus!({
      home: input.home,
      executablePath: input.executablePath,
    })
  ).kind;
}

async function connectAfterEphemeralStart(input: {
  readonly home: AthleteHome;
  readonly executablePath: string;
  readonly env: Record<string, string | undefined>;
  readonly dependencies: EnduragentDependencies;
}): Promise<CoachVerbTransport> {
  const child = await input.dependencies.startEphemeralDaemon!({
    env: input.env,
    home: input.home,
    executablePath: input.executablePath,
  });
  try {
    const transport = await connectWithBoundedRetry({
      connect: () => input.dependencies.connectRemoteTransport!(input.home),
      delay: input.dependencies.delay!,
      monotonicNow: input.dependencies.monotonicNow!,
    });
    child.detachAfterHealthy();
    return transport;
  } catch (error) {
    await child.disposeAfterFailedStart();
    throw error;
  }
}

async function connectServiceAwareRemote(input: {
  readonly home: AthleteHome;
  readonly env: Record<string, string | undefined>;
  readonly dependencies: EnduragentDependencies;
}): Promise<CoachVerbTransport> {
  let initialVersionMismatch: Extract<CoachRemoteFailure, { kind: "version-mismatch" }> | undefined;
  try {
    return await input.dependencies.connectRemoteTransport!(input.home);
  } catch (error) {
    if (!(error instanceof CoachRemoteError)) throw error;
    if (error.failure.kind === "version-mismatch") {
      initialVersionMismatch = error.failure;
    } else if (error.failure.kind !== "unavailable") {
      throw error;
    }
  }

  const executablePath = await resolveConfiguredExecutable(input.dependencies);
  const registration = await serviceRegistrationClass({
    home: input.home,
    executablePath,
    dependencies: input.dependencies,
  });
  if (initialVersionMismatch !== undefined) {
    let classified: ReadOnlyPeerClassification;
    try {
      classified = await classifyPeerReadOnly(input.home);
    } catch {
      throw new CoachRemoteError(initialVersionMismatch);
    }
    if (classified.status !== "peer-healthy") {
      throw new CoachRemoteError(initialVersionMismatch);
    }
    let coordinates: DaemonCoordinates;
    try {
      coordinates = await readDaemonCoordinates(input.home);
    } catch {
      throw new CoachRemoteError({ kind: "unavailable" });
    }
    if (coordinates.port !== classified.peer.port) {
      throw new CoachRemoteError({ kind: "unavailable" });
    }
    const { token: bearerToken } = coordinates;
    const resolution = await input.dependencies.resolveSecondStarter!(
      {
        caller: "cli-auto-start",
        home: input.home,
        clientProtocolVersion: PROTOCOL_VERSION,
        clientAppVersion: await input.dependencies.readPackageVersion(),
        bearerToken,
        peer: classified.peer,
      },
      createSecondStarterDependencies({
        home: input.home,
        executablePath,
        dependencies: input.dependencies,
      }),
    );
    if (resolution.status === "attach") {
      return input.dependencies.connectRemoteTransport!(input.home, resolution.port);
    }
    if (resolution.status !== "retry-startup") {
      if (resolution.status === "refuse" && resolution.exitCode === EXIT_VERSION_MISMATCH) {
        throw new CoachRemoteError(initialVersionMismatch);
      }
      throw new CoachRemoteError({ kind: "unavailable" });
    }
  }
  const observation = await input.dependencies.observeDaemonState!({ home: input.home });
  const decision = decideServiceAwareAutoStart({
    registration,
    peer: observation.kind,
  });
  if (decision === "attach") {
    if (observation.kind !== "compatible-healthy") {
      throw new CoachRemoteError({ kind: "unavailable" });
    }
    return input.dependencies.connectRemoteTransport!(input.home, observation.peer.port);
  }
  if (decision === "resume-service-then-attach") {
    const resumed = await input.dependencies.resumeService!({
      home: input.home,
      executablePath,
    });
    if (resumed !== "resumed") throw new CoachRemoteError({ kind: "unavailable" });
    return connectWithBoundedRetry({
      connect: () => input.dependencies.connectRemoteTransport!(input.home),
      delay: input.dependencies.delay!,
      monotonicNow: input.dependencies.monotonicNow!,
    });
  }
  if (decision === "spawn-ephemeral") {
    return connectAfterEphemeralStart({
      home: input.home,
      executablePath,
      env: input.env,
      dependencies: input.dependencies,
    });
  }
  if (observation.kind === "version-mismatch") {
    throw new CoachRemoteError(observation.failure);
  }
  throw new CoachRemoteError({ kind: "unavailable" });
}

async function runPreparedVerb(
  input: RunEnduragentInput,
  invocation: CoachCliVerbInvocation,
  request: CoachVerbRequest,
  dependencies: EnduragentDependencies,
): Promise<ExitCode> {
  const home = canonicalHome(dependencies.resolveAthleteHome(input.env));
  const connect = (): Promise<CoachVerbTransport> => dependencies.connectRemoteTransport!(home);
  if (!invocation.local) {
    let transport: CoachVerbTransport;
    try {
      transport = await connectServiceAwareRemote({
        home,
        env: input.env,
        dependencies,
      });
    } catch (error) {
      if (error instanceof CoachRemoteError) {
        return remoteConnectionFailure(error, input.terminal);
      }
      throw error;
    }
    return runWithOwnedTransport(transport, request, invocation, input.terminal);
  }

  const sourceRoot = resolveLegacySourceRoot(input.env);
  try {
    const result = await dependencies.withLocalCoach({
      env: input.env,
      home,
      sourceRoot,
      action: { kind: "resume", isTTY: input.terminal.isTTY },
      operation: async (lifecycle) =>
        runWithOwnedTransport(
          createLocalCoachVerbTransport(lifecycle.engine, serializeBoundaryError),
          request,
          invocation,
          input.terminal,
        ),
    });
    return result.status === "completed" ? result.value : renderLocalResult(result, input.terminal);
  } catch (error) {
    if (!(error instanceof CoachStoreWriterError) || error.code !== "writer-lock-held") {
      throw error;
    }
    let transport: CoachVerbTransport;
    try {
      transport = await connect();
    } catch (remoteError) {
      if (
        remoteError instanceof CoachRemoteError &&
        remoteError.failure.kind === "version-mismatch"
      ) {
        return remoteConnectionFailure(remoteError, input.terminal);
      }
      if (remoteError instanceof CoachRemoteError && remoteError.failure.kind === "unavailable") {
        writeContention(input.terminal, error);
        return EXIT_DAEMON_UNAVAILABLE;
      }
      throw remoteError;
    }
    return runWithOwnedTransport(transport, request, invocation, input.terminal);
  }
}

async function runServeAsSuccessor(input: {
  readonly lifecycle: Parameters<typeof runCoachServe>[0]["lifecycle"];
  readonly home: AthleteHome;
  readonly appVersion: string;
  readonly signal: AbortSignal;
  readonly owner: DaemonOwner;
  readonly authentication: string;
  readonly fence: UpgradeFenceHandle;
  readonly timer: MonotonicTimer;
}): Promise<ExitCode> {
  const { authentication: token } = input;
  const controller = new AbortController();
  const servePromise = runCoachServe({
    lifecycle: input.lifecycle,
    home: input.home,
    appVersion: input.appVersion,
    signal: AbortSignal.any([input.signal, controller.signal]),
    owner: input.owner,
  });
  const stopped = { status: "serve-stopped" } as const;
  const published = await Promise.race([
    waitForCompatiblePeer({
      home: input.home,
      protocolVersion: PROTOCOL_VERSION,
      token,
      deadlineMs: input.timer.nowMs() + 30_000,
      pollIntervalMs: 25,
      timer: input.timer,
    }),
    servePromise.then(() => stopped),
  ]);
  if (published.status !== "published") {
    controller.abort();
    await servePromise.catch(() => {});
    await input.fence.release();
    throw new Error("designated successor did not publish");
  }
  await input.fence.release();
  return servePromise;
}

async function runServeInvocation(input: {
  readonly invocationOwner: DaemonOwner;
  readonly starterCapability?: string;
  readonly runInput: RunEnduragentInput;
  readonly home: AthleteHome;
  readonly sourceRoot: string;
  readonly appVersion: string;
  readonly dependencies: EnduragentDependencies;
}): Promise<ExitCode> {
  const admission =
    input.dependencies.withLocalCoach === defaultDependencies.withLocalCoach
      ? await admitStartupThroughUpgradeFence({
          configDir: input.home.configDir,
          ...(input.starterCapability === undefined
            ? {}
            : { handoffCapability: input.starterCapability }),
        })
      : { status: "clear" as const };
  if (admission.status === "reserved") {
    input.runInput.terminal.stderr.write(admission.message);
    return EXIT_DAEMON_UNAVAILABLE;
  }

  let successor:
    | { readonly fence: UpgradeFenceHandle; readonly authentication: string }
    | undefined;
  while (true) {
    try {
      const result = await input.dependencies.withLocalCoach({
        env: input.runInput.env,
        home: input.home,
        sourceRoot: input.sourceRoot,
        action: { kind: "resume", isTTY: input.runInput.terminal.isTTY },
        operation: async (lifecycle) =>
          successor === undefined
            ? runCoachServe({
                lifecycle,
                home: input.home,
                appVersion: input.appVersion,
                signal: input.runInput.signal,
                owner: input.invocationOwner,
              })
            : runServeAsSuccessor({
                lifecycle,
                home: input.home,
                appVersion: input.appVersion,
                signal: input.runInput.signal,
                owner: input.invocationOwner,
                authentication: successor.authentication,
                fence: successor.fence,
                timer: productionMonotonicTimer(input.dependencies.monotonicNow!),
              }),
      });
      if (result.status !== "completed" && successor !== undefined) {
        await successor.fence.release();
      }
      return result.status === "completed"
        ? result.value
        : renderLocalResult(result, input.runInput.terminal);
    } catch (error) {
      if (!(error instanceof CoachStoreWriterError) || error.code !== "writer-lock-held") {
        if (successor !== undefined) await successor.fence.release().catch(() => {});
        throw error;
      }
      let classified: ReadOnlyPeerClassification;
      try {
        classified = await classifyPeerReadOnly(input.home);
      } catch {
        throw error;
      }
      if (classified.status !== "peer-healthy") throw error;
      const executablePath = await resolveConfiguredExecutable(input.dependencies);
      const coordinates = await readDaemonCoordinates(input.home);
      if (coordinates.port !== classified.peer.port) throw error;
      const { token: bearerToken } = coordinates;
      const resolution = await input.dependencies.resolveSecondStarter!(
        {
          caller: input.invocationOwner === "service-managed" ? "service" : "serve",
          home: input.home,
          clientProtocolVersion: PROTOCOL_VERSION,
          clientAppVersion: input.appVersion,
          bearerToken,
          peer: classified.peer,
        },
        createSecondStarterDependencies({
          home: input.home,
          executablePath,
          dependencies: input.dependencies,
        }),
      );
      if (resolution.status === "retry-startup") continue;
      if (resolution.status === "become-successor") {
        successor = { fence: resolution.fence, authentication: coordinates.token };
        continue;
      }
      if (resolution.status === "defer" || resolution.status === "refuse") {
        input.runInput.terminal.stderr.write(resolution.stderr);
        return resolution.exitCode;
      }
      throw error;
    }
  }
}

async function runDaemonInvocation(input: {
  readonly action: "install" | "status" | "restart";
  readonly runInput: RunEnduragentInput;
  readonly dependencies: EnduragentDependencies;
}): Promise<ExitCode> {
  if (input.dependencies.platform !== "darwin") {
    const unavailableController: CoachDaemonController = {
      supported: false,
      install: async () => {
        throw new Error("unsupported");
      },
      status: async () => {
        throw new Error("unsupported");
      },
      restart: async () => {
        throw new Error("unsupported");
      },
    };
    return runCoachDaemonCommand({
      action: input.action,
      controller: unavailableController,
      terminal: input.runInput.terminal,
    });
  }
  let controller: CoachDaemonController;
  try {
    const home = canonicalHome(input.dependencies.resolveAthleteHome(input.runInput.env));
    const executablePath = await resolveConfiguredExecutable(input.dependencies);
    controller = input.dependencies.createDaemonController!({ home, executablePath });
  } catch {
    input.runInput.terminal.stderr.write("Enduragent could not start.\n");
    return EXIT_AGENT_ERROR;
  }
  return runCoachDaemonCommand({
    action: input.action,
    controller,
    terminal: input.runInput.terminal,
  });
}

export async function runEnduragent(
  input: RunEnduragentInput,
  dependencies?: EnduragentDependencies,
): Promise<ExitCode> {
  const invocation = parseCoachCliInvocation(input.argv);
  if (invocation.kind === "usage" || invocation.kind === "verb-usage") {
    input.terminal.stderr.write(`${invocation.message}\n`);
    return EXIT_USAGE;
  }

  const resolvedDependencies: EnduragentDependencies = {
    ...defaultDependencies,
    ...dependencies,
  };
  try {
    if (invocation.kind === "version") {
      const version = await resolvedDependencies.readPackageVersion();
      input.terminal.stdout.write(`enduragent ${version}\n`);
      return EXIT_SUCCESS;
    }

    if (invocation.kind === "daemon") {
      return runDaemonInvocation({
        action: invocation.action,
        runInput: input,
        dependencies: resolvedDependencies,
      });
    }

    if (invocation.kind === "verb") {
      let request: CoachVerbRequest;
      try {
        request = await prepareVerb(input, invocation, resolvedDependencies);
      } catch (error) {
        if (
          error instanceof InvalidCoachCliSessionError ||
          error instanceof InvalidVerbInputError
        ) {
          input.terminal.stderr.write(`${VERB_USAGE}\n`);
          return EXIT_USAGE;
        }
        if (error instanceof CoachCliSessionStartError) {
          input.terminal.stderr.write("Enduragent could not start a chat session.\n");
          return EXIT_AGENT_ERROR;
        }
        throw error;
      }
      try {
        return await runPreparedVerb(input, invocation, request, resolvedDependencies);
      } catch {
        input.terminal.stderr.write("Enduragent could not complete this command.\n");
        return EXIT_AGENT_ERROR;
      }
    }

    const appVersion =
      invocation.kind === "serve" ? await resolvedDependencies.readPackageVersion() : undefined;
    const home = canonicalHome(resolvedDependencies.resolveAthleteHome(input.env));
    const sourceRoot = resolveLegacySourceRoot(input.env);
    if (invocation.kind === "serve") {
      const starter = await serveStarterContext(input.env);
      return await runServeInvocation({
        invocationOwner: starter.owner,
        ...(starter.handoffCapability === undefined
          ? {}
          : { starterCapability: starter.handoffCapability }),
        runInput: input,
        home,
        sourceRoot,
        appVersion: appVersion!,
        dependencies: resolvedDependencies,
      });
    }
    const result = await resolvedDependencies.withLocalCoach({
      env: input.env,
      home,
      sourceRoot,
      action: { kind: "resume", isTTY: input.terminal.isTTY },
      operation: async (lifecycle) =>
        runCoachRepl({
          engine: lifecycle.engine,
          terminal: input.terminal,
          signal: input.signal,
        }),
    });

    return result.status === "completed" ? result.value : renderLocalResult(result, input.terminal);
  } catch (error) {
    if (storeNewerThanApp(error) !== null) {
      input.terminal.stderr.write(
        "Enduragent cannot start: this athlete store was created by a newer app version. Update Enduragent and retry.\n",
      );
      return EXIT_VERSION_MISMATCH;
    }
    if (
      error instanceof CoachStoreWriterError &&
      error.code === "writer-lock-held" &&
      error.contention?.kind === "holder"
    ) {
      input.terminal.stderr.write(
        `Enduragent cannot start: another writer holds this athlete home (pid ${error.contention.pid ?? "unknown"}, port ${error.contention.port}). Stop it or wait, then retry.\n`,
      );
      return EXIT_DAEMON_UNAVAILABLE;
    }
    if (
      error instanceof CoachStoreWriterError &&
      error.code === "writer-lock-held" &&
      error.contention?.kind === "foreign"
    ) {
      input.terminal.stderr.write(
        `Enduragent cannot start: 127.0.0.1:${error.contention.port} is held by a foreign process; change or remove the port file at ${error.contention.portFile}, then retry.\n`,
      );
      return EXIT_DAEMON_UNAVAILABLE;
    }
    input.terminal.stderr.write("Enduragent could not start.\n");
    return EXIT_AGENT_ERROR;
  }
}

export async function main(): Promise<void> {
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  const onSigterm = (): void => controller.abort();
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    process.exitCode = await runEnduragent({
      argv: process.argv.slice(2),
      env: process.env,
      terminal: {
        input: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        isTTY: process.stdin.isTTY === true,
      },
      signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

async function isDirectExecution(moduleUrl: string, argv1: string | undefined): Promise<boolean> {
  if (argv1 === undefined) return false;
  try {
    const [modulePath, invokedPath] = await Promise.all([
      realpath(fileURLToPath(moduleUrl)),
      realpath(resolve(argv1)),
    ]);
    return modulePath === invokedPath;
  } catch {
    return false;
  }
}

if (await isDirectExecution(import.meta.url, process.argv[1])) {
  await main().catch(() => {
    process.stderr.write("Enduragent could not start.\n");
    process.exitCode = EXIT_AGENT_ERROR;
  });
}
