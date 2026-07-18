import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ImportReport } from "@enduragent/kernel/ingest";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { resolveAthleteHome } from "../home/index.js";
import type { AthleteHome } from "../home/index.js";
import { importFilesWithReport } from "../ingest/index.js";
import {
  acquireWriteLock,
  WriteLockContentionError,
  type WriterProtocolListener,
  type WriterContentionDiagnostic,
} from "../lock/index.js";
import { openSqliteStorage } from "../sqlite/index.js";

const USAGE = "Usage: coach-dev import --report <path>...\n";
type CliResult = {
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly stdout: string;
  readonly stderr: string;
};

const defaultWriterDeps = {
  resolveAthleteHome,
  acquireWriteLock,
  mkdir,
  chmod,
  openSqliteStorage,
  runMigrations,
};

const defaultDeps = {
  ...defaultWriterDeps,
  importFilesWithReport,
};

type CoachDevDependencies = typeof defaultDeps;

type FailureStage = Exclude<CoachDevWriterFailureStage, "invoke operation"> | "import files";

export type CoachDevWriterFailureStage =
  | "resolve home"
  | "acquire lock"
  | "run pre-open operation"
  | "create store directory"
  | "secure store directory"
  | "open store"
  | "run migrations"
  | "invoke operation"
  | "close store"
  | "release lock";

export interface CoachDevWriterContext {
  readonly home: AthleteHome;
  readonly store: ReturnType<typeof openSqliteStorage>;
  readonly listener: WriterProtocolListener;
}

export interface RunCoachDevWriterOptions<T> {
  readonly env: Record<string, string | undefined>;
  readonly writerVersion: string;
  readonly beforeStoreOpen?: (home: AthleteHome) => Promise<void>;
  readonly operation: (context: CoachDevWriterContext) => Promise<T>;
}

export type CoachDevWriterResult<T> =
  | { readonly status: "completed"; readonly value: T }
  | { readonly status: "writer-lock-held"; readonly contention: WriterContentionDiagnostic }
  | { readonly status: "failed"; readonly stage: CoachDevWriterFailureStage; readonly cause?: unknown };

export type CoachDevWriterDependencies = typeof defaultWriterDeps;

function help(): CliResult {
  return { exitCode: 0, stdout: USAGE, stderr: "" };
}

function usageError(): CliResult {
  return {
    exitCode: 2,
    stdout: "",
    stderr: `usage_error: expected "import --report <path>..."\n${USAGE}`,
  };
}

function writerLockHeld(): CliResult {
  const message = "Another writer is active; stop it or wait, then retry.";
  return {
    exitCode: 3,
    stdout: `${JSON.stringify(
      {
        schema_version: 1,
        error: { code: "writer_lock_held", message },
      },
      null,
      2,
    )}\n`,
    stderr: `writer_lock_held: ${message}\n`,
  };
}

function importFailed(stage: FailureStage): CliResult {
  return {
    exitCode: 1,
    stdout: `${JSON.stringify(
      {
        schema_version: 1,
        error: {
          code: "import_failed",
          message: "Import failed; see stderr.",
        },
      },
      null,
      2,
    )}\n`,
    stderr: `import_failed: ${stage} failed\n`,
  };
}

function success(report: ImportReport): CliResult {
  return {
    exitCode: 0,
    stdout: `${JSON.stringify(report, null, 2)}\n`,
    stderr: "",
  };
}

function failedWriterResult<T>(stage: CoachDevWriterFailureStage, cause: unknown): CoachDevWriterResult<T> {
  const result: { status: "failed"; stage: CoachDevWriterFailureStage; cause?: unknown } = { status: "failed", stage };
  Object.defineProperty(result, "cause", { value: cause, enumerable: false, writable: false, configurable: true });
  return result;
}

export async function runCoachDevWriter<T>(
  options: RunCoachDevWriterOptions<T>,
  deps: CoachDevWriterDependencies = defaultWriterDeps,
): Promise<CoachDevWriterResult<T>> {
  let home: AthleteHome;
  try {
    home = deps.resolveAthleteHome(options.env);
  } catch (error) {
    return failedWriterResult("resolve home", error);
  }

  let lockResult: Awaited<ReturnType<CoachDevWriterDependencies["acquireWriteLock"]>>;
  try {
    lockResult = await deps.acquireWriteLock({
      configDir: home.configDir,
      athleteHome: home.root,
      version: options.writerVersion,
    });
  } catch (error) {
    if (error instanceof WriteLockContentionError) {
      if (error.contention !== null) {
        return { status: "writer-lock-held", contention: error.contention };
      }
      return failedWriterResult("acquire lock", error);
    }
    if (error instanceof Error && error.name === "WriteLockContentionError") {
      const contention = (error as Error & {
        readonly contention?: WriterContentionDiagnostic | null;
      }).contention;
      if (contention !== undefined && contention !== null) {
        return { status: "writer-lock-held", contention };
      }
      return failedWriterResult("acquire lock", error);
    }
    return failedWriterResult("acquire lock", error);
  }

  if (lockResult.status === "peer-healthy") {
    return {
      status: "writer-lock-held",
      contention: { kind: "holder", pid: lockResult.pid, port: lockResult.port },
    };
  }

  let failureStage: CoachDevWriterFailureStage | undefined;
  let failureCause: unknown;
  let value!: T;
  let store: ReturnType<CoachDevWriterDependencies["openSqliteStorage"]> | undefined;

  try {
    try {
      try {
        if (options.beforeStoreOpen !== undefined) {
          try {
            await options.beforeStoreOpen(home);
          } catch (error) {
            failureStage = "run pre-open operation";
            failureCause = error;
          }
        }

        if (failureStage === undefined) {
          await deps.mkdir(home.storeDir, { recursive: true, mode: 0o700 });
        }
      } catch (error) {
        failureStage = "create store directory";
        failureCause = error;
      }

      if (failureStage === undefined) {
        try {
          await deps.chmod(home.storeDir, 0o700);
        } catch (error) {
          failureStage = "secure store directory";
          failureCause = error;
        }
      }

      if (failureStage === undefined) {
        try {
          store = deps.openSqliteStorage(join(home.storeDir, "store.db"));
        } catch (error) {
          failureStage = "open store";
          failureCause = error;
        }
      }

      if (failureStage === undefined && store !== undefined) {
        try {
          await deps.runMigrations(store, MIGRATIONS);
        } catch (error) {
          failureStage = "run migrations";
          failureCause = error;
        }
      }

      if (failureStage === undefined && store !== undefined) {
        try {
          value = await options.operation({ home, store, listener: lockResult.listener });
        } catch (error) {
          failureStage = "invoke operation";
          failureCause = error;
        }
      }
    } finally {
      if (store !== undefined) {
        try {
          await store.close();
        } catch (error) {
          if (failureStage === undefined) {
            failureStage = "close store";
            failureCause = error;
          }
        }
      }
    }
  } finally {
    try {
      await lockResult.release();
    } catch (error) {
      if (failureStage === undefined) {
        failureStage = "release lock";
        failureCause = error;
      }
    }
  }

  if (failureStage !== undefined) return failedWriterResult(failureStage, failureCause);
  return { status: "completed", value };
}

export async function runCoachDev(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  deps: CoachDevDependencies = defaultDeps,
): Promise<CliResult> {
  if (
    (argv.length === 1 && argv[0] === "--help") ||
    (argv.length === 2 && argv[0] === "import" && argv[1] === "--help")
  ) {
    return help();
  }

  const inputPaths = argv.slice(2);
  if (
    argv[0] !== "import" ||
    argv[1] !== "--report" ||
    inputPaths.length === 0 ||
    inputPaths.some((path) => path.length === 0 || path.startsWith("-"))
  ) {
    return usageError();
  }

  const result = await runCoachDevWriter(
    {
      env,
      writerVersion: "coach-dev-import/1",
      operation: ({ home, store }) =>
        deps.importFilesWithReport({ inputPaths, archiveDir: home.archiveDir, store }),
    },
    deps,
  );

  if (result.status === "writer-lock-held") return writerLockHeld();
  if (result.status === "failed") {
    return importFailed(result.stage === "invoke operation" ? "import files" : result.stage);
  }
  return success(result.value);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runCoachDev(process.argv.slice(2), process.env);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
