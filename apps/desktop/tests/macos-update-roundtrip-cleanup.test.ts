import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LATEST_SCHEMA_VERSION, LatestJsonSchema } from "@enduragent/kernel/reference/schemas";
import type { VerifiedMacosReleaseArtifacts } from "../scripts/verify-macos-release.mjs";

const harness = vi.hoisted(() => {
  let resolveParentExit!: () => void;
  const parentExit = new Promise<void>((resolve) => {
    resolveParentExit = resolve;
  });
  return {
    children: [] as ChildProcess[],
    closePendingAfterExit: false,
    helperPid: undefined as number | undefined,
    keychainEvents: [] as string[],
    keychainHome: undefined as string | undefined,
    keychainRestoredAfterProcessCleanup: false,
    parentClosed: false,
    parentExit,
    resolveParentExit,
    sensitiveArgument: "updater-cleanup-secret-must-not-appear",
    termMarker: "",
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((
      _command: string,
      _args: readonly string[],
      options: Parameters<typeof actual.spawn>[2],
    ) => {
      const helperCode = [
        'const fs = require("node:fs");',
        'process.on("SIGTERM", () => fs.writeFileSync(process.argv[1], "SIGTERM"));',
        'fs.writeSync(3, "ready");',
        "setInterval(() => undefined, 1_000);",
      ].join("");
      const parentCode = [
        'const { spawn } = require("node:child_process");',
        `const helper = spawn(process.execPath, ["-e", ${JSON.stringify(helperCode)}, process.argv[1], process.argv[2]], { stdio: ["ignore", "inherit", "inherit", "pipe"] });`,
        'helper.stdio[3].once("data", () => {',
        "  process.stdout.write(`helper:${helper.pid}\\n`, () => process.exit(0));",
        "});",
      ].join("");
      const child = actual.spawn(
        process.execPath,
        ["-e", parentCode, harness.termMarker, harness.sensitiveArgument],
        { ...options, stdio: ["ignore", "pipe", "pipe"] },
      );
      harness.keychainEvents.push("spawn");
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        const match = stdout.match(/helper:([1-9][0-9]*)\n/u);
        if (match?.[1] !== undefined) harness.helperPid = Number(match[1]);
      });
      child.once("exit", harness.resolveParentExit);
      child.once("close", () => {
        harness.parentClosed = true;
      });
      harness.children.push(child);
      return child;
    }) as typeof actual.spawn,
  };
});

vi.mock("./helpers/desktop-fixture.ts", () => ({
  connectCdp: vi.fn(),
  reservePort: vi.fn(async () => 31_337),
  waitForPage: vi.fn(async () => {
    await harness.parentExit;
    await new Promise((resolve) => setTimeout(resolve, 150));
    harness.closePendingAfterExit = !harness.parentClosed;
    throw new Error("synthetic updater product failure");
  }),
}));

vi.mock("./fixtures/packaged-telegram/disposable-keychain.ts", () => ({
  prepareDisposableKeychain: vi.fn(
    async (input: { readonly home: string; readonly path: string }) => {
      harness.keychainEvents.push("prepare");
      harness.keychainHome = input.home;
      let restored = false;
      return {
        home: input.home,
        recoveryPath: input.path,
        activate: async () => {
          harness.keychainEvents.push("activate");
        },
        restore: async () => {
          harness.keychainEvents.push("restore");
          const child = harness.children.at(-1);
          const helperPid = harness.helperPid;
          harness.keychainRestoredAfterProcessCleanup =
            child?.stdout?.destroyed === true &&
            child.stderr?.destroyed === true &&
            helperPid !== undefined &&
            !processIsReachable(helperPid);
          restored = true;
        },
        restored: () => restored,
      };
    },
  ),
}));

vi.mock("./fixtures/packaged-telegram/acceptance-deadline.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./fixtures/packaged-telegram/acceptance-deadline.ts")>();
  return {
    ...actual,
    runAcceptanceCommand: vi.fn(async (command: string, args: readonly string[]) => {
      if (command !== "/usr/bin/ditto") throw new Error("unexpected updater test command");
      const destination = args.at(-1);
      if (destination === undefined) throw new Error("missing updater test destination");
      await mkdir(args[0] === "-x" ? join(destination, "Enduragent.app") : destination, {
        recursive: true,
        mode: 0o700,
      });
      return {
        code: 0,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      };
    }),
  };
});

import {
  MACOS_UPDATER_ROUND_TRIP_FEED_URL,
  runMacosUpdaterRoundTrip,
} from "../scripts/verify-updater-round-trip.mjs";

const roots: string[] = [];

function processIsReachable(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function stopProcess(pid: number | undefined): Promise<void> {
  if (pid === undefined || !processIsReachable(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  const deadline = Date.now() + 1_000;
  while (processIsReachable(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
}

afterEach(async () => {
  await Promise.all(harness.children.map(stopChild));
  await stopProcess(harness.helperPid);
  harness.children.length = 0;
  harness.keychainEvents.length = 0;
  harness.keychainHome = undefined;
  harness.keychainRestoredAfterProcessCleanup = false;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createArtifacts(
  root: string,
  version: string,
  marker: string,
): Promise<VerifiedMacosReleaseArtifacts> {
  const directory = join(root, marker);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const names = {
    dmg: `Enduragent-${version}-arm64.dmg`,
    zip: `Enduragent-${version}-arm64.zip`,
    blockmap: `Enduragent-${version}-arm64.zip.blockmap`,
    metadata: "latest-mac.yml" as const,
  };
  const paths = {
    dmg: join(directory, names.dmg),
    zip: join(directory, names.zip),
    blockmap: join(directory, names.blockmap),
    metadata: join(directory, names.metadata),
  };
  const zip = Buffer.from(`synthetic-${marker}-zip`);
  await Promise.all([
    writeFile(paths.dmg, `synthetic-${marker}-dmg`),
    writeFile(paths.zip, zip),
    writeFile(paths.blockmap, `synthetic-${marker}-blockmap`),
    writeFile(paths.metadata, `version: ${version}\n`),
  ]);
  return {
    version,
    names,
    paths,
    sizes: {
      dmg: Buffer.byteLength(`synthetic-${marker}-dmg`),
      zip: zip.length,
      blockmap: Buffer.byteLength(`synthetic-${marker}-blockmap`),
    },
    dmgSha512: createHash("sha512").update(`synthetic-${marker}-dmg`).digest("base64"),
    zipSha512: createHash("sha512").update(zip).digest("base64"),
  };
}

describe("macOS updater failure cleanup", () => {
  it("closes inherited pipes and force-kills an observed helper after its parent exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "updater-cleanup-test-"));
    roots.push(root);
    harness.termMarker = join(root, "helper-term.txt");
    const baselineArtifacts = await createArtifacts(root, "0.1.0", "baseline");
    const candidateArtifacts = await createArtifacts(root, "0.1.1", "candidate");
    const scratchPath = join(root, "scratch");
    await mkdir(scratchPath, { mode: 0o700 });
    const scratchStat = await lstat(scratchPath);
    const startedAt = Date.now();

    let failure: unknown;
    try {
      await runMacosUpdaterRoundTrip(
        {
          baselineVersion: "0.1.0",
          candidateVersion: "0.1.1",
          baselineEnvelope: join(root, "baseline-envelope"),
          candidateEnvelope: join(root, "candidate-envelope"),
          evidencePath: join(root, "evidence.json"),
        },
        {
          platform: "darwin",
          arch: "arm64",
          mode: "steady",
          verifyArtifacts: async (_envelope, version) =>
            version === "0.1.0" ? baselineArtifacts : candidateArtifacts,
          createScratch: async () => ({
            path: scratchPath,
            identity: { dev: scratchStat.dev, ino: scratchStat.ino, mode: scratchStat.mode },
          }),
          inspectApplication: async (application) => {
            const candidate = application.includes("/candidate/");
            const codeDirectorySha256 = (candidate ? "b" : "a").repeat(64);
            return {
              version: candidate ? "0.1.1" : "0.1.0",
              enduragentDesktopRelease: true,
              feedUrl: MACOS_UPDATER_ROUND_TRIP_FEED_URL,
              bundleIdentifier: "icu.enduragent.desktop",
              teamIdentifier: "FA494ACVTF",
              designatedRequirementSha256: "c".repeat(64),
              codeDirectorySha256,
              cdHash: codeDirectorySha256.slice(0, 40),
            };
          },
          observeProcesses: async () => {
            const helperPid = harness.helperPid;
            return helperPid !== undefined && processIsReachable(helperPid)
              ? { bundlePids: [helperPid], mainPids: [] }
              : { bundlePids: [], mainPids: [] };
          },
        },
      );
    } catch (error) {
      failure = error;
    }

    const child = harness.children.at(-1);
    const helperPid = harness.helperPid;
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(harness.sensitiveArgument);
    expect(child).toBeDefined();
    expect(child?.exitCode).toBe(0);
    expect(child?.signalCode).toBeNull();
    expect(harness.closePendingAfterExit).toBe(true);
    expect(harness.parentClosed).toBe(true);
    expect(child?.stdout?.destroyed).toBe(true);
    expect(child?.stderr?.destroyed).toBe(true);
    expect(helperPid).toBeDefined();
    expect(await readFile(harness.termMarker, "utf8")).toBe("SIGTERM");
    expect(processIsReachable(helperPid as number)).toBe(false);
    expect(harness.keychainEvents).toEqual(["prepare", "activate", "spawn", "restore"]);
    expect(harness.keychainHome).toBe(join(scratchPath, "home"));
    expect(harness.keychainRestoredAfterProcessCleanup).toBe(true);
    const latestPath = join(scratchPath, "athlete/data/latest.json");
    const latestStat = await lstat(latestPath);
    expect(latestStat.isFile()).toBe(true);
    expect(latestStat.mode & 0o777).toBe(0o600);
    const expectedLatest = {
      metadata: {
        schema_version: LATEST_SCHEMA_VERSION,
        last_updated: "2000-01-01T00:00:00.000Z",
        freshness: "fresh",
      },
      athlete_profile: null,
      current_status: null,
      derived_metrics: {},
      recent_activities: [],
      planned_workouts: [],
      wellness_data: null,
    } as const;
    const latestBytes = await readFile(latestPath, "utf8");
    expect(latestBytes).toBe(`${JSON.stringify(expectedLatest)}\n`);
    expect(LatestJsonSchema.parse(JSON.parse(latestBytes))).toStrictEqual(expectedLatest);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(1_800);
    expect(elapsed).toBeLessThan(4_500);
  });

  it("pins updater transitions to exit instead of inherited-pipe close", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../scripts/verify-updater-round-trip.mjs", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("const initialExit = observeRoundTripChildExit(initialChild);");
    expect(source).toContain(
      "const verificationExit = observeRoundTripChildExit(verificationChild);",
    );
    expect(source).toMatch(
      /"baseline application update exit",\s*initialExit,\s*\{ timeoutMs: transitionTimeoutMs \}/u,
    );
    expect(source).toMatch(
      /"candidate persistence verification shutdown",\s*verificationExit,\s*\{ timeoutMs: shutdownTimeoutMs \}/u,
    );
    expect(source).not.toMatch(
      /"(?:baseline application update exit|candidate persistence verification shutdown)",\s*\w+Lifecycle\.terminal/u,
    );
    expect(source).toContain("const rendererRpcTimeoutMs = 30_000;");
    expect(source).toContain("}, input.timeoutMs);");
    expect(source).toContain("timeoutMs + rendererDebuggerTimeoutSlackMs");
    expect(source).not.toContain("}, 10000);");
  });
});
