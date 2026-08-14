import { spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSecuritySmokeEnvironment,
  createSecuritySmokeLaunchEnvironment,
} from "../smoke/security-smoke-environment.mjs";
import { createWindowsPackagePlan } from "./windows-package-plan.mjs";

const APP_READY_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 120_000;
const CLEAN_EXIT_TIMEOUT_MS = 30_000;
const LISTENER_TIMEOUT_MS = 500;
const CLEANUP_GRACE_MS = 5_000;
const SECURITY_SMOKE_STAGE_PREFIX = "DESKTOP_SECURITY_STAGE ";
export const SECURITY_SMOKE_SHUTDOWN_STAGES = Object.freeze([
  "stdin-accepted",
  "residency-closed",
  "ipc-closed",
  "telegram-power-closed",
  "telegram-coordinator-closed",
  "daemon-closed",
  "exit-requested",
]);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDirectory, "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const cliEntry = join(repositoryRoot, "packages/coach/dist/enduragent.js");

function checked(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function capture(file, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error("packaged self-test command timed out"));
    }, COMMAND_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

export function observeProcessExit(child) {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", () =>
      rejectExit(new Error("packaged application process observation failed")),
    );
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

function destroyProcessStdio(child) {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

export async function removeWindowsScratch(path, remove = rm) {
  try {
    await remove(path, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  } catch {
    throw new Error("packaged Windows scratch cleanup failed");
  }
}

export function throwPackagedCompletionFailures(bodyFailure, cleanupFailures) {
  const cleanupErrors = cleanupFailures.map(
    (stage) => new Error(`packaged Windows ${stage} cleanup failed`),
  );
  if (bodyFailure !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError(
      [bodyFailure, ...cleanupErrors],
      "packaged Windows verification and cleanup failed",
    );
  }
  if (bodyFailure !== undefined) throw bodyFailure;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "packaged Windows cleanup failed");
  }
}

export function createSecuritySmokeStageObserver() {
  let pending = "";
  let stageIndex = -1;
  let lastStage = "none";
  let invalid = false;
  let resolveFailure;
  let resolveTerminal;
  const failure = new Promise((resolve) => {
    resolveFailure = resolve;
  });
  const terminal = new Promise((resolve) => {
    resolveTerminal = resolve;
  });
  const fail = () => {
    if (invalid) return;
    invalid = true;
    resolveFailure(new Error("packaged Windows shutdown stage evidence was invalid"));
  };
  return Object.freeze({
    write(chunk) {
      if (invalid) return;
      pending += String(chunk);
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith(SECURITY_SMOKE_STAGE_PREFIX)) continue;
        const stage = line.slice(SECURITY_SMOKE_STAGE_PREFIX.length);
        const nextIndex = stageIndex + 1;
        if (stage !== SECURITY_SMOKE_SHUTDOWN_STAGES[nextIndex]) {
          fail();
          return;
        }
        stageIndex = nextIndex;
        lastStage = stage;
        if (stage === "exit-requested") resolveTerminal(stage);
      }
    },
    lastStage: () => lastStage,
    failure,
    terminal,
  });
}

export function requestPackagedShutdown(input) {
  if (input === null || input === undefined || input.destroyed || input.writable === false) {
    return Promise.reject(new Error("packaged Windows shutdown input was unavailable"));
  }
  return new Promise((resolveRequest, rejectRequest) => {
    let settled = false;
    const cleanup = () => input.removeListener("error", fail);
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectRequest(new Error("packaged Windows shutdown request failed"));
    };
    input.once("error", fail);
    try {
      input.end("shutdown\n", (error) => {
        if (settled) return;
        if (error) {
          fail();
          return;
        }
        settled = true;
        cleanup();
        resolveRequest();
      });
    } catch {
      fail();
    }
  });
}

function launchApplication(executable, args, environment) {
  const child = spawn(executable, args, {
    cwd: dirname(executable),
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let pending = "";
  let resolveReady;
  let rejectReady;
  const stages = createSecuritySmokeStageObserver();
  const ready = new Promise((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const readyTimer = setTimeout(
    () => rejectReady(new Error("packaged Windows application was not ready")),
    APP_READY_TIMEOUT_MS,
  );
  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    stages.write(text);
    stdout += text;
    pending += text;
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("DESKTOP_SECURITY_READY ")) continue;
      clearTimeout(readyTimer);
      try {
        resolveReady(JSON.parse(line.slice("DESKTOP_SECURITY_READY ".length)));
      } catch {
        rejectReady(new Error("packaged Windows readiness frame was invalid"));
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = observeProcessExit(child);
  return { child, ready, exited, stages, output: () => ({ stdout, stderr }) };
}

function parseSingleJsonLine(result, label) {
  checked(result.code === 0 && result.signal === null, `${label} exited unsuccessfully`);
  checked(result.stderr === "", `${label} wrote an error stream`);
  const lines = result.stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  checked(lines.length === 1 && result.stdout.endsWith("\n"), `${label} output was not one line`);
  try {
    return JSON.parse(lines[0]);
  } catch {
    throw new Error(`${label} output was invalid`);
  }
}

function validateReadyFrame(value) {
  checked(value !== null && typeof value === "object", "packaged readiness was invalid");
  checked(value.url === "enduragent://app/index.html", "packaged renderer URL was invalid");
  checked(typeof value.rpcUrl === "string", "packaged readiness omitted the RPC address");
  const rpc = new URL(value.rpcUrl);
  checked(
    rpc.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(rpc.hostname),
    "packaged RPC address was not loopback",
  );
  for (const field of [
    "noNodeGlobals",
    "rpcConnected",
    "blockedOffPort",
    "syncChipPresent",
    "credentialStatusesMetadataOnly",
    "tokenAbsentInRendererSurfaces",
  ]) {
    checked(value[field] === true, `packaged security assertion failed at ${field}`);
  }
  checked(Array.isArray(value.bridgeKeys) && value.bridgeKeys.length > 0, "preload bridge was absent");
  return value;
}

export function validateSelfTestTerminal(value) {
  checked(value !== null && typeof value === "object", "self-test terminal was invalid");
  checked(value.type === "self-test-terminal" && value.ok === true, "packaged self-test failed");
  checked(value.runtime?.electron === "43.1.1", "packaged Electron version was unexpected");
  checked(
    typeof value.runtime?.node === "string" && Number(value.runtime.node.split(".")[0]) >= 24,
    "packaged Node version was unexpected",
  );
  const suites = value.suites;
  checked(
    suites !== null &&
      typeof suites === "object" &&
      !Array.isArray(suites) &&
      JSON.stringify(Object.keys(suites).sort()) === JSON.stringify(["differential", "parity"]),
    "packaged self-test suites were invalid",
  );
  for (const name of ["parity", "differential"]) {
    const suite = suites[name];
    checked(
      suite !== null &&
        typeof suite === "object" &&
        !Array.isArray(suite) &&
        JSON.stringify(Object.keys(suite).sort()) === JSON.stringify(["cases", "passed"]) &&
        Number.isSafeInteger(suite.cases) &&
        suite.cases > 0,
      "packaged self-test suite counts were invalid",
    );
    checked(suite.passed === suite.cases, "packaged self-test suites did not pass");
  }
  return value;
}

export function validatePackagedSecondLaunch(result, privateValues) {
  checked(
    result.code === 0 && result.signal === null,
    "packaged second launch exited unsuccessfully",
  );
  const output = `${result.stdout}${result.stderr}`;
  checked(
    !output.includes("DESKTOP_SECURITY_READY"),
    "packaged second launch emitted a readiness marker",
  );
  checked(
    privateValues.every((value) => value.length > 0 && !output.includes(value)),
    "packaged second launch output exposed private data",
  );
  return result;
}

function listenerClosed(url) {
  const target = new URL(url);
  return new Promise((resolveClosed) => {
    const socket = connect({ host: target.hostname, port: Number(target.port) });
    const timer = setTimeout(() => {
      socket.destroy();
      resolveClosed(false);
    }, LISTENER_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolveClosed(false);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolveClosed(true);
    });
  });
}

export async function waitForPackagedApplicationExit(
  running,
  timeoutMilliseconds = CLEAN_EXIT_TIMEOUT_MS,
) {
  let timeout;
  const deadline = new Promise((resolveTimeout) => {
    timeout = setTimeout(() => resolveTimeout({ type: "timeout" }), timeoutMilliseconds);
  });
  try {
    const outcome = await Promise.race([
      Promise.all([
        requestPackagedShutdown(running.child.stdin),
        running.stages.terminal,
        running.exited,
      ]).then(([, , result]) => ({ type: "exit", result })),
      running.stages.failure.then((error) => ({ type: "failure", error })),
      deadline,
    ]);
    if (outcome.type === "failure") throw outcome.error;
    if (outcome.type === "timeout") {
      throw new Error(
        `packaged Windows application did not stop cleanly; last stage=${running.stages.lastStage()}`,
      );
    }
    checked(
      running.stages.lastStage() === "exit-requested",
      `packaged Windows shutdown evidence was incomplete; last stage=${running.stages.lastStage()}`,
    );
    return outcome.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForCleanExit(running, rpcUrl) {
  const outcome = await waitForPackagedApplicationExit(running);
  destroyProcessStdio(running.child);
  checked(
    outcome.code === 0 && outcome.signal === null,
    "packaged Windows application exited unsuccessfully",
  );
  const deadline = performance.now() + CLEAN_EXIT_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (await listenerClosed(rpcUrl)) return;
    await delay(LISTENER_TIMEOUT_MS);
  }
  throw new Error("packaged Windows RPC listener remained active");
}

export async function runWindowsPackagedSelfTest(input = {}) {
  checked(process.platform === "win32", "packaged Windows self-test requires Windows");
  checked(process.arch === "x64", "packaged Windows self-test requires x64 Node");
  const plan = await createWindowsPackagePlan({ desktopRoot });
  const executable = input.executable ?? plan.executablePath;
  checked(typeof executable === "string" && resolve(executable) === executable, "executable must be absolute");
  const base = await realpath(tmpdir());
  const scratch = await mkdtemp(join(base, "eaw-"));
  const security = createSecuritySmokeEnvironment(scratch);
  const localAppData = join(scratch, "local-app-data");
  const launchEnvironment = {
    ...createSecuritySmokeLaunchEnvironment(process.env, security, process.platform),
    ENDURAGENT_ACCEPTANCE_HIDDEN: "1",
    LOCALAPPDATA: localAppData,
    USERPROFILE: security.operatorHome,
  };
  let running;
  let bodyFailure;
  let result;
  try {
    await Promise.all([
      mkdir(security.configDirectory, { recursive: true }),
      mkdir(security.operatorHome, { recursive: true }),
      mkdir(security.electronUserData, { recursive: true }),
      mkdir(localAppData, { recursive: true }),
    ]);
    await writeFile(
      join(security.configDirectory, "config.yaml"),
      [
        "data_source: store",
        `data_dir: ${JSON.stringify(security.athleteHome)}`,
        "llm:",
        "  provider: anthropic",
        "  model: synthetic",
        "  api_key: synthetic",
        "intervals:",
        "  api_key: ''",
        "  athlete_id: '0'",
        "session:",
        "  timezone: UTC",
        "",
      ].join("\n"),
    );
    const launchArguments = ["--desktop-security-smoke", ...security.extraArguments];
    running = launchApplication(executable, launchArguments, launchEnvironment);
    const ready = validateReadyFrame(await running.ready);
    const token = (await readFile(join(security.configDirectory, "daemon.token"), "utf8")).trim();
    const second = await capture(executable, launchArguments, {
      cwd: dirname(executable),
      env: launchEnvironment,
    });
    validatePackagedSecondLaunch(second, [security.athleteHome, token]);
    const command = await capture(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", cliEntry, "self-test"],
      { cwd: repositoryRoot, env: launchEnvironment },
    );
    const terminal = validateSelfTestTerminal(parseSingleJsonLine(command, "self-test"));
    checked(
      !command.stdout.includes(token) && !command.stdout.includes(security.athleteHome),
      "self-test output exposed private data",
    );
    await waitForCleanExit(running, ready.rpcUrl);
    result = Object.freeze({ successExit: 0, secondLaunchExit: 0, suites: terminal.suites });
  } catch (error) {
    bodyFailure = error;
  }
  const cleanupFailures = [];
  if (running !== undefined) {
    try {
      try {
        const settled = await Promise.race([
          running.exited.then(() => true),
          delay(CLEANUP_GRACE_MS).then(() => false),
        ]);
        if (!settled) {
          running.child.kill("SIGKILL");
          await running.exited;
        }
      } finally {
        destroyProcessStdio(running.child);
      }
    } catch {
      cleanupFailures.push("process");
    }
  }
  try {
    await removeWindowsScratch(scratch);
  } catch {
    cleanupFailures.push("scratch");
  }
  throwPackagedCompletionFailures(bodyFailure, cleanupFailures);
  return result;
}

async function main() {
  checked(
    process.argv.length === 2 ||
      (process.argv.length === 4 && process.argv[2] === "--executable"),
    "arguments are not supported",
  );
  const result = await runWindowsPackagedSelfTest({
    executable: process.argv.length === 4 ? resolve(process.argv[3]) : undefined,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
