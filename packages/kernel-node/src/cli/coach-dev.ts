import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveAthleteHome } from "@enduragent/kernel-node/home";
import { acquireWriteLock, WriteLockContentionError } from "@enduragent/kernel-node/lock";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { importFilesWithReport } from "@enduragent/kernel-node/ingest";
import type { ImportReport } from "@enduragent/kernel/ingest";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";

const USAGE = "Usage: coach-dev import --report <path>...\n";
const WRITER_VERSION = "coach-dev-import/1";

type CliResult = {
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly stdout: string;
  readonly stderr: string;
};

const defaultDeps = {
  resolveAthleteHome,
  acquireWriteLock,
  mkdir,
  chmod,
  openSqliteStorage,
  runMigrations,
  importFilesWithReport,
};

type CoachDevDependencies = typeof defaultDeps;

type FailureStage =
  | "resolve home"
  | "acquire lock"
  | "create store directory"
  | "secure store directory"
  | "open store"
  | "run migrations"
  | "import files"
  | "close store"
  | "release lock";

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

  let home: ReturnType<CoachDevDependencies["resolveAthleteHome"]>;
  try {
    home = deps.resolveAthleteHome(env);
  } catch {
    return importFailed("resolve home");
  }

  let lockResult: Awaited<ReturnType<CoachDevDependencies["acquireWriteLock"]>>;
  try {
    lockResult = await deps.acquireWriteLock({
      configDir: home.configDir,
      athleteHome: home.root,
      version: WRITER_VERSION,
    });
  } catch (error) {
    if (error instanceof WriteLockContentionError) return writerLockHeld();
    return importFailed("acquire lock");
  }

  if (lockResult.status === "peer-healthy") return writerLockHeld();

  let failureStage: FailureStage | undefined;
  let report: ImportReport | undefined;
  let store: ReturnType<CoachDevDependencies["openSqliteStorage"]> | undefined;

  try {
    try {
      try {
        await deps.mkdir(home.storeDir, { recursive: true, mode: 0o700 });
      } catch {
        failureStage = "create store directory";
      }

      if (failureStage === undefined) {
        try {
          await deps.chmod(home.storeDir, 0o700);
        } catch {
          failureStage = "secure store directory";
        }
      }

      if (failureStage === undefined) {
        try {
          store = deps.openSqliteStorage(join(home.storeDir, "store.db"));
        } catch {
          failureStage = "open store";
        }
      }

      if (failureStage === undefined && store !== undefined) {
        try {
          await deps.runMigrations(store, MIGRATIONS);
        } catch {
          failureStage = "run migrations";
        }
      }

      if (failureStage === undefined && store !== undefined) {
        try {
          report = await deps.importFilesWithReport({
            inputPaths,
            archiveDir: home.archiveDir,
            store,
          });
        } catch {
          failureStage = "import files";
        }
      }
    } finally {
      if (store !== undefined) {
        try {
          await store.close();
        } catch {
          failureStage ??= "close store";
        }
      }
    }
  } finally {
    try {
      await lockResult.release();
    } catch {
      failureStage ??= "release lock";
    }
  }

  if (failureStage !== undefined) return importFailed(failureStage);
  return success(report!);
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  const result = await runCoachDev(process.argv.slice(2), process.env);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
