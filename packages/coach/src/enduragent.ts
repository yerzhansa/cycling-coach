#!/usr/bin/env node
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXIT_AGENT_ERROR,
  EXIT_DAEMON_UNAVAILABLE,
  EXIT_NOT_CONFIGURED,
  EXIT_SUCCESS,
  EXIT_USAGE,
  type ExitCode,
} from "@enduragent/coach-contract";
import {
  parseCoachCliInvocation,
  runCoachRepl,
  type CoachCliTerminal,
} from "@enduragent/coach-cli";
import { expandTilde, resolveAthleteHome, type AthleteHome } from "@enduragent/kernel-node/home";
import {
  withLocalCoach,
  type LocalCoachRunResult,
  type WithLocalCoachInput,
} from "./local-runner.js";
import { CoachStoreWriterError } from "./runtime.js";

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
});

function resolveLegacySourceRoot(env: Record<string, string | undefined>): string {
  const override = env.CYCLING_COACH_HOME;
  if (override !== undefined && override.length > 0) {
    return expandTilde(override);
  }
  return join(homedir(), ".cycling-coach");
}

export async function runEnduragent(
  input: RunEnduragentInput,
  dependencies?: EnduragentDependencies,
): Promise<ExitCode> {
  const invocation = parseCoachCliInvocation(input.argv);
  if (invocation.kind === "usage") {
    input.terminal.stderr.write(`${invocation.message}\n`);
    return EXIT_USAGE;
  }

  const resolvedDependencies = dependencies ?? defaultDependencies;
  try {
    if (invocation.kind === "version") {
      const version = await resolvedDependencies.readPackageVersion();
      input.terminal.stdout.write(`enduragent ${version}\n`);
      return EXIT_SUCCESS;
    }

    const home = resolvedDependencies.resolveAthleteHome(input.env);
    const sourceRoot = resolveLegacySourceRoot(input.env);
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

    if (result.status === "completed") return result.value;
    if (result.status === "not-configured") {
      input.terminal.stderr.write(
        `Enduragent is not configured. Provision ${result.configPath} with provider credentials, then run: enduragent\n`,
      );
      return EXIT_NOT_CONFIGURED;
    }
    if (result.status === "migration-discarded") {
      input.terminal.stderr.write(
        `Enduragent migration plan ${result.result.manifestDigest} was discarded to ${result.result.archivePath}. Run enduragent again to replan.\n`,
      );
      return result.result.exitCode;
    }
    const manifest =
      result.result.manifestDigest === null ? "" : ` for manifest ${result.result.manifestDigest}`;
    input.terminal.stderr.write(
      `Enduragent cannot start: legacy migration was refused (${result.result.reason}). Review ${result.result.journalPath}${manifest} and resolve the reported condition before retrying.\n`,
    );
    return result.result.exitCode;
  } catch (error) {
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
