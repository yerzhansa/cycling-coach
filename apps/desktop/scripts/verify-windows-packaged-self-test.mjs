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
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  return { child, ready, exited, output: () => ({ stdout, stderr }) };
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

function validateSelfTestTerminal(value) {
  checked(value !== null && typeof value === "object", "self-test terminal was invalid");
  checked(value.type === "self-test-terminal" && value.ok === true, "packaged self-test failed");
  checked(value.runtime?.electron === "43.1.1", "packaged Electron version was unexpected");
  checked(
    typeof value.runtime?.node === "string" && Number(value.runtime.node.split(".")[0]) >= 24,
    "packaged Node version was unexpected",
  );
  checked(Array.isArray(value.suites) && value.suites.length > 0, "packaged suites were absent");
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

async function waitForCleanExit(running, rpcUrl) {
  if (!running.child.stdin.destroyed) running.child.stdin.end("shutdown\n");
  const outcome = await Promise.race([
    running.exited,
    delay(CLEAN_EXIT_TIMEOUT_MS).then(() => undefined),
  ]);
  checked(outcome !== undefined, "packaged Windows application did not stop cleanly");
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
    return Object.freeze({ successExit: 0, secondLaunchExit: 0, suites: terminal.suites });
  } finally {
    if (running !== undefined) {
      const settled = await Promise.race([
        running.exited.then(() => true),
        delay(CLEANUP_GRACE_MS).then(() => false),
      ]);
      if (!settled) {
        running.child.kill("SIGKILL");
        await running.exited;
      }
    }
    await rm(scratch, { recursive: true, force: true });
  }
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
