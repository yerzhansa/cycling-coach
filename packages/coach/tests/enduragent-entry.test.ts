import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXIT_AGENT_ERROR,
  EXIT_DAEMON_UNAVAILABLE,
  EXIT_SUCCESS,
  EXIT_USAGE,
  type AthleteState,
  type CoachEngine,
} from "@enduragent/coach-contract";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { PORT_FILE_NAME } from "@enduragent/kernel-node/lock";
import {
  runEnduragent,
  type EnduragentDependencies,
  type RunEnduragentInput,
} from "../src/enduragent.js";
import {
  withLocalCoach,
  type LocalCoachLifecycle,
  type LocalCoachRunResult,
  type WithLocalCoachInput,
} from "../src/local-runner.js";
import { CoachStoreWriterError, withCoachStoreWriter } from "../src/runtime.js";

const state: AthleteState = {
  schemaVersion: "3",
  lastUpdated: "2000-01-01T00:00:00.000Z",
  freshness: "fresh",
  degraded: false,
  lastSynced: "2000-01-01T00:00:00.000Z",
  athleteProfile: {},
  currentStatus: {},
  derivedMetrics: {},
  recentActivities: [],
  plannedWorkouts: [],
  wellness: {},
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function capture(): { readonly stream: Writable; read(): string } {
  let value = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        callback();
      },
    }),
    read: () => value,
  };
}

function terminal(
  input = new PassThrough(),
  isTTY = false,
): {
  readonly input: PassThrough;
  readonly stdout: ReturnType<typeof capture>;
  readonly stderr: ReturnType<typeof capture>;
  readonly value: RunEnduragentInput["terminal"];
} {
  const stdout = capture();
  const stderr = capture();
  return {
    input,
    stdout,
    stderr,
    value: { input, stdout: stdout.stream, stderr: stderr.stream, isTTY },
  };
}

function mockEngine(
  implementation: CoachEngine["chat"] = async ({ message }) => ({ text: `${message}-response` }),
): {
  readonly engine: CoachEngine;
  readonly chat: ReturnType<typeof vi.fn<CoachEngine["chat"]>>;
} {
  const chat = vi.fn<CoachEngine["chat"]>(implementation);
  const resetSession = vi.fn<CoachEngine["resetSession"]>(async () => ({
    memoryFlushed: true,
  }));
  const hasSession = vi.fn<CoachEngine["hasSession"]>(async () => ({
    hasSession: false,
  }));
  const getAthleteState = vi.fn<CoachEngine["getAthleteState"]>(async () => state);
  return { engine: { chat, resetSession, hasSession, getAthleteState }, chat };
}

const roots: string[] = [];
let scratch: string;
let home: AthleteHome;
let env: Record<string, string | undefined>;

beforeEach(async () => {
  scratch = await mkdtemp(join(await realpath(tmpdir()), "enduragent-entry-"));
  roots.push(scratch);
  home = {
    root: join(scratch, "athlete-home"),
    storeDir: join(scratch, "athlete-home", "store"),
    archiveDir: join(scratch, "athlete-home", "archive"),
    configDir: join(scratch, "athlete-home", "config"),
  };
  env = {
    HOME: join(scratch, "home"),
    ENDURAGENT_HOME: home.root,
    CYCLING_COACH_HOME: join(scratch, "legacy-home"),
    XDG_CONFIG_HOME: join(scratch, "xdg-config"),
    XDG_CACHE_HOME: join(scratch, "xdg-cache"),
    TMPDIR: join(scratch, "tmp"),
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
  };
  await Promise.all([
    mkdir(env.HOME!, { recursive: true }),
    mkdir(env.XDG_CONFIG_HOME!, { recursive: true }),
    mkdir(env.XDG_CACHE_HOME!, { recursive: true }),
    mkdir(env.TMPDIR!, { recursive: true }),
  ]);
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("enduragent executable composition", () => {
  it("short-circuits version without resolving or composing", async () => {
    let homeCalls = 0;
    let runnerCalls = 0;
    const dependencies: EnduragentDependencies = {
      resolveAthleteHome: () => {
        homeCalls += 1;
        return home;
      },
      withLocalCoach: async () => {
        runnerCalls += 1;
        return { status: "not-configured", configPath: "unused" };
      },
      readPackageVersion: async () => "0.1.2",
    };
    const io = terminal();
    await expect(
      runEnduragent(
        {
          argv: ["version"],
          env,
          terminal: io.value,
          signal: new AbortController().signal,
        },
        dependencies,
      ),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(io.stdout.read()).toBe("enduragent 0.1.2\n");
    expect(io.stderr.read()).toBe("");
    expect(homeCalls).toBe(0);
    expect(runnerCalls).toBe(0);
  });

  it("short-circuits invalid usage without resolving or composing", async () => {
    let homeCalls = 0;
    let runnerCalls = 0;
    const dependencies: EnduragentDependencies = {
      resolveAthleteHome: () => {
        homeCalls += 1;
        return home;
      },
      withLocalCoach: async () => {
        runnerCalls += 1;
        return { status: "not-configured", configPath: "unused" };
      },
      readPackageVersion: async () => "unused",
    };
    const io = terminal();
    await expect(
      runEnduragent(
        {
          argv: ["unknown"],
          env,
          terminal: io.value,
          signal: new AbortController().signal,
        },
        dependencies,
      ),
    ).resolves.toBe(EXIT_USAGE);
    expect(io.stdout.read()).toBe("");
    expect(io.stderr.read()).toBe("Usage: enduragent [version]\n");
    expect(homeCalls).toBe(0);
    expect(runnerCalls).toBe(0);
  });

  it("renders migration and readiness outcomes with unchanged exit codes", async () => {
    const digestA = "a".repeat(64);
    const digestB = "b".repeat(64);
    const digestC = "c".repeat(64);
    const journalPath = join(home.root, "config", "migration.json");
    const archivePath = join(home.root, "archive", "discarded.json");
    const configPath = join(home.configDir, "config.yaml");
    const rows: ReadonlyArray<{
      readonly result: LocalCoachRunResult<never>;
      readonly exitCode: 0 | 2 | 3 | 4;
      readonly stderr: string;
    }> = [
      {
        result: {
          status: "migration-refused",
          result: {
            status: "refused",
            exitCode: 2,
            journalPath,
            manifestDigest: null,
            reason: "confirmation-required",
            conflictIds: [],
          },
        },
        exitCode: 2,
        stderr: `Enduragent cannot start: legacy migration was refused (confirmation-required). Review ${journalPath} and resolve the reported condition before retrying.\n`,
      },
      {
        result: {
          status: "migration-refused",
          result: {
            status: "refused",
            exitCode: 3,
            journalPath,
            manifestDigest: digestA,
            reason: "source-drift",
            conflictIds: ["synthetic-conflict"],
          },
        },
        exitCode: 3,
        stderr: `Enduragent cannot start: legacy migration was refused (source-drift). Review ${journalPath} for manifest ${digestA} and resolve the reported condition before retrying.\n`,
      },
      {
        result: {
          status: "migration-refused",
          result: {
            status: "refused",
            exitCode: 4,
            journalPath,
            manifestDigest: digestB,
            reason: "invalid-source-config",
            conflictIds: [],
          },
        },
        exitCode: 4,
        stderr: `Enduragent cannot start: legacy migration was refused (invalid-source-config). Review ${journalPath} for manifest ${digestB} and resolve the reported condition before retrying.\n`,
      },
      {
        result: {
          status: "migration-discarded",
          result: {
            status: "discarded",
            exitCode: 0,
            journalPath,
            manifestDigest: digestC,
            archivePath,
          },
        },
        exitCode: 0,
        stderr: `Enduragent migration plan ${digestC} was discarded to ${archivePath}. Run enduragent again to replan.\n`,
      },
      {
        result: { status: "not-configured", configPath },
        exitCode: 4,
        stderr: `Enduragent is not configured. Provision ${configPath} with provider credentials, then run: enduragent\n`,
      },
    ];

    for (const row of rows) {
      let captured: WithLocalCoachInput<unknown> | undefined;
      let operationCalls = 0;
      const runner: EnduragentDependencies["withLocalCoach"] = async <T>(
        input: WithLocalCoachInput<T>,
      ): Promise<LocalCoachRunResult<T>> => {
        captured = input as unknown as WithLocalCoachInput<unknown>;
        return row.result as LocalCoachRunResult<T>;
      };
      const io = terminal(new PassThrough(), true);
      const result = await runEnduragent(
        {
          argv: [],
          env,
          terminal: io.value,
          signal: new AbortController().signal,
        },
        {
          resolveAthleteHome: () => home,
          withLocalCoach: async <T>(
            input: WithLocalCoachInput<T>,
          ): Promise<LocalCoachRunResult<T>> => {
            const value = await runner(input);
            const originalOperation = input.operation;
            captured = {
              ...input,
              operation: async (lifecycle: LocalCoachLifecycle) => {
                operationCalls += 1;
                return originalOperation(lifecycle);
              },
            } as unknown as WithLocalCoachInput<unknown>;
            return value;
          },
          readPackageVersion: async () => "unused",
        },
      );
      expect(result).toBe(row.exitCode);
      expect(io.stdout.read()).toBe("");
      expect(io.stderr.read()).toBe(row.stderr);
      expect(operationCalls).toBe(0);
      expect(captured?.home).toBe(home);
      expect(captured?.sourceRoot).toBe(env.CYCLING_COACH_HOME);
      expect(captured?.action).toEqual({ kind: "resume", isTTY: true });
    }
  });

  it("preserves FIFO and lifecycle close ordering after physical EOF", async () => {
    const trace: string[] = [];
    const first = deferred<{ text: string }>();
    const second = deferred<{ text: string }>();
    const mocked = mockEngine(async ({ message }) => {
      trace.push(`${message}-chat-start`);
      const response = await (message === "first" ? first.promise : second.promise);
      trace.push(`${message}-chat-end`);
      return response;
    });
    const lifecycle = {
      engine: mocked.engine,
      close: async () => {
        trace.push("lifecycle-close");
      },
    };
    const runner: EnduragentDependencies["withLocalCoach"] = async <T>(
      input: WithLocalCoachInput<T>,
    ): Promise<LocalCoachRunResult<T>> => {
      try {
        const value = await input.operation(lifecycle);
        trace.push("repl-return");
        return { status: "completed", value };
      } finally {
        await lifecycle.close();
        trace.push("store-close", "writer-release");
      }
    };
    const io = terminal();
    io.input.once("end", () => trace.push("input-eof"));
    io.input.end("first\nsecond\n");
    const result = runEnduragent(
      {
        argv: [],
        env,
        terminal: io.value,
        signal: new AbortController().signal,
      },
      {
        resolveAthleteHome: () => home,
        withLocalCoach: runner,
        readPackageVersion: async () => "unused",
      },
    );
    await vi.waitFor(() => expect(mocked.chat).toHaveBeenCalledTimes(1));
    first.resolve({ text: "first-response" });
    await vi.waitFor(() => expect(mocked.chat).toHaveBeenCalledTimes(2));
    second.resolve({ text: "second-response" });
    await expect(result).resolves.toBe(EXIT_SUCCESS);
    expect(io.stdout.read()).toBe("first-response\nsecond-response\n");
    for (const [earlier, later] of [
      ["first-chat-start", "first-chat-end"],
      ["first-chat-end", "second-chat-start"],
      ["second-chat-start", "second-chat-end"],
      ["second-chat-end", "repl-return"],
      ["repl-return", "lifecycle-close"],
      ["lifecycle-close", "store-close"],
      ["store-close", "writer-release"],
      ["input-eof", "repl-return"],
    ] as const) {
      expect(trace.indexOf(earlier)).toBeLessThan(trace.indexOf(later));
    }
  });

  it("uses typed writer errors and redacts every other startup failure", async () => {
    const holder = Object.assign(Object.create(CoachStoreWriterError.prototype), {
      name: "CoachStoreWriterError",
      message: "private holder detail",
      code: "writer-lock-held" as const,
      stage: null,
      contention: { kind: "holder" as const, pid: null, port: 43100 },
    }) as CoachStoreWriterError;
    const foreignPortFile = join(home.configDir, "store-writer.port");
    const foreign = Object.assign(Object.create(CoachStoreWriterError.prototype), {
      name: "CoachStoreWriterError",
      message: "private foreign detail",
      code: "writer-lock-held" as const,
      stage: null,
      contention: { kind: "foreign" as const, port: 43101, portFile: foreignPortFile },
    }) as CoachStoreWriterError;
    const failed = Object.assign(Object.create(CoachStoreWriterError.prototype), {
      name: "CoachStoreWriterError",
      message: "private writer detail",
      code: "writer-failed" as const,
      stage: "open store" as const,
      contention: null,
    }) as CoachStoreWriterError;
    const rows = [
      {
        error: holder,
        exitCode: EXIT_DAEMON_UNAVAILABLE,
        stderr:
          "Enduragent cannot start: another writer holds this athlete home (pid unknown, port 43100). Stop it or wait, then retry.\n",
      },
      {
        error: foreign,
        exitCode: EXIT_DAEMON_UNAVAILABLE,
        stderr: `Enduragent cannot start: 127.0.0.1:43101 is held by a foreign process; change or remove the port file at ${foreignPortFile}, then retry.\n`,
      },
      {
        error: failed,
        exitCode: EXIT_AGENT_ERROR,
        stderr: "Enduragent could not start.\n",
      },
      {
        error: new Error("private unrelated detail"),
        exitCode: EXIT_AGENT_ERROR,
        stderr: "Enduragent could not start.\n",
      },
    ];

    for (const row of rows) {
      const io = terminal();
      const result = await runEnduragent(
        {
          argv: [],
          env,
          terminal: io.value,
          signal: new AbortController().signal,
        },
        {
          resolveAthleteHome: () => home,
          withLocalCoach: async <T>(
            input: WithLocalCoachInput<T>,
          ): Promise<LocalCoachRunResult<T>> => {
            void input;
            throw row.error;
          },
          readPackageVersion: async () => "unused",
        },
      );
      expect(result).toBe(row.exitCode);
      expect(io.stdout.read()).toBe("");
      expect(io.stderr.read()).toBe(row.stderr);
    }
  });

  it("reports real contention and drains an in-flight turn before release", async () => {
    const writerAcquired = deferred<void>();
    const releaseWriter = deferred<void>();
    const holdingWriter = withCoachStoreWriter(env, async () => {
      writerAcquired.resolve(undefined);
      await releaseWriter.promise;
    });
    await Promise.race([
      writerAcquired.promise,
      holdingWriter.then(() => Promise.reject(new Error("writer ended early"))),
    ]);
    try {
      const port = Number.parseInt(
        await readFile(join(home.configDir, PORT_FILE_NAME), "utf8"),
        10,
      );
      const io = terminal();
      await expect(
        runEnduragent(
          {
            argv: [],
            env,
            terminal: io.value,
            signal: new AbortController().signal,
          },
          {
            resolveAthleteHome: () => home,
            withLocalCoach,
            readPackageVersion: async () => "unused",
          },
        ),
      ).resolves.toBe(EXIT_DAEMON_UNAVAILABLE);
      expect(io.stdout.read()).toBe("");
      expect(io.stderr.read()).toBe(
        `Enduragent cannot start: another writer holds this athlete home (pid ${process.pid}, port ${port}). Stop it or wait, then retry.\n`,
      );
    } finally {
      releaseWriter.resolve(undefined);
      await holdingWriter;
    }

    const trace: string[] = [];
    const response = deferred<{ text: string }>();
    const mocked = mockEngine(async () => {
      trace.push("turn-start");
      const value = await response.promise;
      trace.push("turn-end");
      return value;
    });
    const controller = new AbortController();
    const io = terminal();
    const runner: EnduragentDependencies["withLocalCoach"] = async <T>(
      input: WithLocalCoachInput<T>,
    ): Promise<LocalCoachRunResult<T>> => {
      const lifecycle = {
        engine: mocked.engine,
        close: async () => {
          trace.push("lifecycle-close");
        },
      };
      try {
        const value = await input.operation(lifecycle);
        trace.push("repl-return");
        return { status: "completed", value };
      } finally {
        await lifecycle.close();
        trace.push("store-close", "writer-release");
      }
    };
    const result = runEnduragent(
      {
        argv: [],
        env,
        terminal: io.value,
        signal: controller.signal,
      },
      {
        resolveAthleteHome: () => home,
        withLocalCoach: runner,
        readPackageVersion: async () => "unused",
      },
    );
    io.input.write("turn\n");
    await vi.waitFor(() => expect(mocked.chat).toHaveBeenCalledTimes(1));
    controller.abort();
    response.resolve({ text: "turn-response" });
    await expect(result).resolves.toBe(EXIT_SUCCESS);
    for (const [earlier, later] of [
      ["turn-start", "turn-end"],
      ["turn-end", "repl-return"],
      ["repl-return", "lifecycle-close"],
      ["lifecycle-close", "store-close"],
      ["store-close", "writer-release"],
    ] as const) {
      expect(trace.indexOf(earlier)).toBeLessThan(trace.indexOf(later));
    }
  });
});
