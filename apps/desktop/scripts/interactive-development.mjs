import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const canonicalDesktopRoot = resolve(scriptDirectory, "..");
const SCRATCH_PREFIX = "enduragent-desktop-development-";
export const DESKTOP_INSPECTION_FIXTURE_ENV = "ENDURAGENT_DESKTOP_INSPECTION_FIXTURE";
export const PLAN_CURRENT_INSPECTION_FIXTURE = "plan-current";
export const TRAINING_CURRENT_INSPECTION_FIXTURE = "training-current";

export function selectInteractiveDevelopmentTemporaryRoot(platform, configuredRoot) {
  return configuredRoot ?? (platform === "darwin" ? "/tmp" : tmpdir());
}

function requiredAbsolutePath(value, name) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new TypeError(`${name} must be absolute`);
  }
  return value;
}

export function createInteractiveDevelopmentPlan(input) {
  if (input.platform !== "darwin") {
    throw new TypeError("interactive desktop development requires macOS");
  }
  const desktopRoot = requiredAbsolutePath(input.desktopRoot, "desktop root");
  const scratchRoot = requiredAbsolutePath(input.scratchRoot, "scratch root");
  const nodeExecutable = requiredAbsolutePath(input.nodeExecutable, "Node executable");
  const packageManagerScript = requiredAbsolutePath(
    input.packageManagerScript,
    "package manager script",
  );
  const athleteHome = join(scratchRoot, "athlete-home");
  const userData = join(scratchRoot, "electron-user-data");
  const environment = { ...input.environment };
  const inspectionFixture = environment[DESKTOP_INSPECTION_FIXTURE_ENV];
  if (
    inspectionFixture !== undefined &&
    inspectionFixture !== PLAN_CURRENT_INSPECTION_FIXTURE &&
    inspectionFixture !== TRAINING_CURRENT_INSPECTION_FIXTURE
  ) {
    throw new TypeError("unknown desktop inspection fixture");
  }
  if (inspectionFixture !== undefined) {
    delete environment.PLAN_QA_SCENARIO;
    delete environment.PLAN_QA_OUTCOME;
  }
  delete environment.ENDURAGENT_ACCEPTANCE_HIDDEN;
  delete environment.ELECTRON_CLI_ARGS;
  Object.assign(environment, {
    ENDURAGENT_HOME: athleteHome,
    ENDURAGENT_DEVELOPMENT_USER_DATA: userData,
    ENDURAGENT_ACCEPTANCE_CREDENTIAL_BACKEND: "memory",
    ENDURAGENT_DISPOSABLE_SAFE_STORAGE_CONTEXT: "1",
  });
  return Object.freeze({
    command: "/usr/bin/caffeinate",
    args: Object.freeze([
      "-dimsu",
      nodeExecutable,
      packageManagerScript,
      "exec",
      ...(inspectionFixture !== undefined
        ? ["tsx", "tests/helpers/plan-inspection-live.ts"]
        : ["electron-vite", "dev"]),
    ]),
    cwd: desktopRoot,
    environment: Object.freeze(environment),
    scratchRoot,
    athleteHome,
    userData,
  });
}

export async function runInteractiveDevelopment(input = {}, dependencies = {}) {
  const platform = input.platform ?? process.platform;
  const packageManagerScript = input.packageManagerScript ?? process.env.npm_execpath;
  if (packageManagerScript === undefined) {
    throw new TypeError("package manager script is unavailable");
  }
  const resolveTemporaryRoot = dependencies.realpath ?? realpath;
  const createTemporaryRoot = dependencies.mkdtemp ?? mkdtemp;
  const createDirectory = dependencies.mkdir ?? mkdir;
  const removeDirectory = dependencies.rm ?? rm;
  const launch = dependencies.spawn ?? spawn;
  const temporaryRoot = await resolveTemporaryRoot(
    selectInteractiveDevelopmentTemporaryRoot(platform, input.temporaryRoot),
  );
  const scratchRoot = await createTemporaryRoot(join(temporaryRoot, SCRATCH_PREFIX));
  try {
    const plan = createInteractiveDevelopmentPlan({
      platform,
      desktopRoot: input.desktopRoot ?? canonicalDesktopRoot,
      scratchRoot,
      nodeExecutable: input.nodeExecutable ?? process.execPath,
      packageManagerScript,
      environment: input.environment ?? process.env,
    });
    await Promise.all([
      createDirectory(plan.athleteHome, { mode: 0o700 }),
      createDirectory(plan.userData, { mode: 0o700 }),
    ]);
    const child = launch(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.environment,
      stdio: "inherit",
    });
    const forwardInterrupt = () => child.kill("SIGINT");
    const forwardTermination = () => child.kill("SIGTERM");
    process.once("SIGINT", forwardInterrupt);
    process.once("SIGTERM", forwardTermination);
    try {
      return await new Promise((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolveExit(code === 0 && signal === null ? 0 : 1));
      });
    } finally {
      process.off("SIGINT", forwardInterrupt);
      process.off("SIGTERM", forwardTermination);
    }
  } finally {
    await removeDirectory(scratchRoot, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv.length !== 2) throw new TypeError("arguments are not supported");
  process.exitCode = await runInteractiveDevelopment();
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write("interactive desktop development failed\n");
    process.exitCode = 1;
  });
}
