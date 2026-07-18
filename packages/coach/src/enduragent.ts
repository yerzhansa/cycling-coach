#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DaemonOwnerSchema,
  EXIT_AGENT_ERROR,
  EXIT_DAEMON_UNAVAILABLE,
  EXIT_NOT_CONFIGURED,
  EXIT_SUCCESS,
  EXIT_USAGE,
  EXIT_VERSION_MISMATCH,
  type DaemonOwner,
  type ExitCode,
} from "@enduragent/coach-contract";
import {
  CoachCliSessionStartError,
  CoachRemoteError,
  InvalidCoachCliSessionError,
  connectCoachVerbTransport,
  connectRemoteCoachTransport,
  createCoachVerbRequest,
  createLocalCoachVerbTransport,
  parseCoachCliInvocation,
  resolveCoachCliSession,
  runCoachRepl,
  runCoachVerb,
  type CoachCliTerminal,
  type CoachCliVerbInvocation,
  type CoachVerbRequest,
  type CoachVerbTransport,
  type ServiceRegistrationState,
} from "@enduragent/coach-cli";
import { expandTilde, resolveAthleteHome, type AthleteHome } from "@enduragent/kernel-node/home";
import { PORT_FILE_NAME } from "@enduragent/kernel-node/lock";
import { StoreNewerThanAppError } from "@enduragent/kernel/store";
import {
  withLocalCoach,
  type LocalCoachRunResult,
  type WithLocalCoachInput,
} from "./local-runner.js";
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
  readonly connectRemoteTransport?: (home: AthleteHome) => Promise<CoachVerbTransport>;
  readonly serviceRegistrationState?: () => Promise<ServiceRegistrationState>;
  readonly startEphemeralDaemon?: (input: {
    readonly env: Record<string, string | undefined>;
    readonly home: AthleteHome;
  }) => Promise<{
    readonly disposeAfterFailedStart: () => Promise<void>;
    readonly detachAfterHealthy: () => void;
  }>;
  readonly delay?: (ms: number) => Promise<void>;
  readonly monotonicNow?: () => number;
  readonly createFreshId?: () => string;
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

const defaultDependencies: EnduragentDependencies = Object.freeze({
  resolveAthleteHome,
  withLocalCoach,
  readPackageVersion,
  connectRemoteTransport: async (home: AthleteHome) => {
    try {
      const [rawPort, rawToken] = await Promise.all([
        readFile(join(home.configDir, PORT_FILE_NAME), "utf8"),
        readFile(join(home.configDir, "daemon.token"), "utf8"),
      ]);
      const port = Number(rawPort.trim());
      const token = rawToken.endsWith("\n") ? rawToken.slice(0, -1) : "";
      if (!Number.isInteger(port) || port < 1 || port > 65_535 || token.length === 0) {
        throw new TypeError("invalid daemon coordinates");
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
});

function childEnvironment(
  env: Record<string, string | undefined>,
  home: AthleteHome,
): NodeJS.ProcessEnv {
  const combined: Record<string, string | undefined> = {
    ...process.env,
    ...env,
    ENDURAGENT_HOME: home.root,
    ENDURAGENT_DAEMON_OWNER: "ephemeral-client-started",
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
  };
  return Object.fromEntries(
    Object.entries(combined).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

async function startEphemeralDaemonProcess(input: {
  readonly env: Record<string, string | undefined>;
  readonly home: AthleteHome;
}): Promise<{
  readonly disposeAfterFailedStart: () => Promise<void>;
  readonly detachAfterHealthy: () => void;
}> {
  const entry = process.argv[1];
  if (entry === undefined) throw new CoachRemoteError({ kind: "unavailable" });
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [entry, "serve"], {
      detached: true,
      env: childEnvironment(input.env, input.home),
      stdio: "ignore",
    });
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
  } catch {
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

function daemonOwner(env: Record<string, string | undefined>): DaemonOwner {
  const parsed = DaemonOwnerSchema.safeParse(env.ENDURAGENT_DAEMON_OWNER);
  return parsed.success ? parsed.data : "unmanaged-foreground";
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

async function runPreparedVerb(
  input: RunEnduragentInput,
  invocation: CoachCliVerbInvocation,
  request: CoachVerbRequest,
  dependencies: EnduragentDependencies,
): Promise<ExitCode> {
  const home = dependencies.resolveAthleteHome(input.env);
  const connect = (): Promise<CoachVerbTransport> => dependencies.connectRemoteTransport!(home);
  if (!invocation.local) {
    let transport: CoachVerbTransport;
    try {
      transport = await connectRemoteCoachTransport({
        connect,
        serviceRegistrationState: dependencies.serviceRegistrationState!,
        startEphemeralDaemon: () => dependencies.startEphemeralDaemon!({ env: input.env, home }),
        delay: dependencies.delay!,
        monotonicNow: dependencies.monotonicNow!,
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
          createLocalCoachVerbTransport(lifecycle.engine),
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
    const home = resolvedDependencies.resolveAthleteHome(input.env);
    const sourceRoot = resolveLegacySourceRoot(input.env);
    const result = await resolvedDependencies.withLocalCoach({
      env: input.env,
      home,
      sourceRoot,
      action: { kind: "resume", isTTY: input.terminal.isTTY },
      operation: async (lifecycle) =>
        invocation.kind === "serve"
          ? runCoachServe({
              lifecycle,
              home,
              appVersion: appVersion!,
              signal: input.signal,
              owner: daemonOwner(input.env),
            })
          : runCoachRepl({
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
