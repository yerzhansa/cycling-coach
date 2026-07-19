import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createConnection, createServer } from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  HEALTHZ_SERVICE_MARKER,
  LOCKFILE_NAME,
  PORT_FILE_NAME,
} from "@enduragent/kernel-node/lock";

const binary = fileURLToPath(new URL("../dist/enduragent.js", import.meta.url));
const fetchStub = fileURLToPath(new URL("./fixtures/serve-fetch-stub.mjs", import.meta.url));
const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loopbackAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPERM") {
        process.stderr.write("SKIP_MARKER loopback-listen EPERM first-run-serve\n");
      }
      resolve(false);
    });
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function unixConnectAvailable(): Promise<boolean> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "serve-unix-probe-"));
  try {
    return await new Promise((resolve) => {
      const socket = createConnection(join(root, "absent.sock"));
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EPERM") {
          process.stderr.write("SKIP_MARKER unix-connect EPERM first-run-serve\n");
          resolve(false);
          return;
        }
        resolve(error.code === "ENOENT");
      });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const hasSockets = await loopbackAvailable() && await unixConnectAvailable();

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function childExit(child: ChildProcessWithoutNullStreams): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

describe.skipIf(!hasSockets)("first-run serve process", () => {
  it("boots a fresh home through /healthz and shuts down cleanly", async () => {
    const scratchRoot = process.platform === "darwin" ? "/private/tmp" : await realpath(tmpdir());
    const scratch = await mkdtemp(join(scratchRoot, "ea-serve-"));
    roots.push(scratch);
    const home = join(scratch, "athlete-home");
    const configDir = join(home, "config");
    await mkdir(home, { mode: 0o700 });
    await Promise.all([
      mkdir(configDir, { mode: 0o700 }),
      mkdir(join(scratch, "home"), { recursive: true }),
      mkdir(join(scratch, "cache"), { recursive: true }),
      mkdir(join(scratch, "tmp"), { recursive: true }),
    ]);
    await writeFile(join(configDir, "config.yaml"), [
      "data_source: store",
      `data_dir: ${JSON.stringify(home)}`,
      "llm:",
      "  provider: anthropic",
      "  model: synthetic",
      "  api_key: synthetic",
      "intervals:",
      "  api_key: synthetic",
      "  athlete_id: synthetic",
      "session:",
      "  timezone: UTC",
      "",
    ].join("\n"));

    const child = spawn(process.execPath, [binary, "serve"], {
      env: {
        ...process.env,
        HOME: join(scratch, "home"),
        XDG_CONFIG_HOME: join(scratch, "config-home"),
        XDG_CACHE_HOME: join(scratch, "cache"),
        TMPDIR: join(scratch, "tmp"),
        ENDURAGENT_HOME: home,
        CYCLING_COACH_HOME: join(scratch, "legacy-home"),
        NODE_OPTIONS: `--disable-warning=ExperimentalWarning --import=${fetchStub}`,
        FORCE_COLOR: undefined,
        CLICOLOR_FORCE: undefined,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    const exited = childExit(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });

    const deadline = Date.now() + 15_000;
    let health: Response | undefined;
    while (Date.now() < deadline && health === undefined) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`serve exited before healthz: ${child.exitCode}/${child.signalCode}\n${stdout}${stderr}`);
      }
      try {
        const port = Number((await readFile(join(configDir, PORT_FILE_NAME), "utf8")).trim());
        if (Number.isInteger(port) && port > 0) {
          const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
            signal: AbortSignal.timeout(500),
          });
          if (response.status === 200) health = response;
        }
      } catch {}
      if (health === undefined) await delay(25);
    }
    if (health === undefined) {
      throw new Error(`serve did not publish healthz\n${stdout}${stderr}`);
    }
    await expect(health.json()).resolves.toMatchObject({
      service: HEALTHZ_SERVICE_MARKER,
      version: "0.0.1",
    });

    child.kill("SIGTERM");
    const result = await Promise.race([
      exited,
      delay(5_000).then(() => ({ code: null, signal: "SIGKILL" as const })),
    ]);
    if (result.signal === "SIGKILL") child.kill("SIGKILL");
    children.delete(child);
    expect(result).toEqual({ code: 0, signal: null });
    expect(stdout).toBe("");
    expect(stderr).not.toContain("coach store writer is already active");
    await expect(readFile(join(configDir, PORT_FILE_NAME), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(configDir, LOCKFILE_NAME), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 25_000);
});
