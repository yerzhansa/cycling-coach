import { createRequire } from "node:module";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  SELF_TEST_RUNNER_FILE,
  SELF_TEST_SCHEMA_VERSION,
  SELF_TEST_TERMINAL_TYPE,
  SelfTestRpcResultSchema,
  type CoachSelfTestOperations,
  type SelfTestRpcResult,
} from "@enduragent/coach-contract";

export interface PackagedSelfTestDependencies {
  readonly resourcesPath: () => unknown;
  readonly loadCommonJsModule: (absolutePath: string) => unknown;
}

const loadModule = createRequire(import.meta.url);

const defaultDependencies: PackagedSelfTestDependencies = {
  resourcesPath: () =>
    (process as NodeJS.Process & { readonly resourcesPath?: unknown }).resourcesPath,
  loadCommonJsModule: (absolutePath) => loadModule(absolutePath),
};

function runnerError(): SelfTestRpcResult {
  return {
    schemaVersion: SELF_TEST_SCHEMA_VERSION,
    type: SELF_TEST_TERMINAL_TYPE,
    ok: false,
    error: { code: "RUNNER_ERROR", message: "packaged self-test failed" },
  };
}

function contained(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function execute(dependencies: PackagedSelfTestDependencies): Promise<SelfTestRpcResult> {
  try {
    const resourcesPath = dependencies.resourcesPath();
    if (typeof resourcesPath !== "string" || !isAbsolute(resourcesPath)) return runnerError();
    const directory = join(resourcesPath, "self-test");
    const runnerPath = join(directory, SELF_TEST_RUNNER_FILE);
    const stat = await lstat(runnerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return runnerError();
    const [realDirectory, realRunner] = await Promise.all([
      realpath(directory),
      realpath(runnerPath),
    ]);
    if (!contained(realDirectory, realRunner)) return runnerError();
    const loaded = dependencies.loadCommonJsModule(realRunner);
    if (
      loaded === null ||
      (typeof loaded !== "object" && typeof loaded !== "function") ||
      Object.keys(loaded).length !== 1 ||
      Object.keys(loaded)[0] !== "runSelfTest"
    ) {
      return runnerError();
    }
    const runSelfTest = (loaded as { readonly runSelfTest?: unknown }).runSelfTest;
    if (typeof runSelfTest !== "function") return runnerError();
    return SelfTestRpcResultSchema.parse(runSelfTest({ resourcesPath }));
  } catch {
    return runnerError();
  }
}

export function createPackagedSelfTestOperation(
  dependencies: Partial<PackagedSelfTestDependencies> = {},
): CoachSelfTestOperations["selfTest"] {
  const resolved = { ...defaultDependencies, ...dependencies };
  let inFlight: Promise<SelfTestRpcResult> | undefined;
  return async (onEvent) => {
    onEvent?.({ phase: "started", completed: 0, total: 1 });
    inFlight ??= execute(resolved).finally(() => {
      inFlight = undefined;
    });
    const result = await inFlight;
    onEvent?.({ phase: "completed", completed: 1, total: 1 });
    return result;
  };
}
