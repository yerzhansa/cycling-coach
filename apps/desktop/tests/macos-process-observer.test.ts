import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMacosApplicationProcessObserver,
  type MacosProcessIdentity,
} from "../scripts/verify-updater-round-trip.mjs";

const roots: string[] = [];
const children: ChildProcess[] = [];
const externalPids: number[] = [];

function processIsReachable(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitUntil(probe: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("process observer test timed out");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || !processIsReachable(child.pid)) return;
  child.kill("SIGKILL");
  await waitUntil(() => !processIsReachable(child.pid as number), 1_000).catch(() => undefined);
}

async function stopProcess(pid: number): Promise<void> {
  if (!processIsReachable(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  await waitUntil(() => !processIsReachable(pid), 1_000).catch(() => undefined);
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
  await Promise.all(externalPids.splice(0).map(stopProcess));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("macOS application process observer", () => {
  it("rejects a bundle PID that is reused across the lsof observation", async () => {
    const observations: readonly (readonly MacosProcessIdentity[])[] = [
      [{ pid: 500, parentPid: 1, startedAt: "Sun Aug 9 16:00:00 2026" }],
      [{ pid: 500, parentPid: 1, startedAt: "Sun Aug 9 16:00:01 2026" }],
    ];
    let index = 0;
    const signaled: number[] = [];
    const observer = createMacosApplicationProcessObserver(
      "/private/tmp/process-observer/Enduragent.app",
      {
        observeBundleProcesses: async () => ({ bundlePids: [500], mainPids: [500] }),
        readProcessTable: async () => observations[Math.min(index++, observations.length - 1)],
        signalProcess: (pid) => signaled.push(pid),
      },
    );

    await expect(observer.observe()).rejects.toThrow(
      "application process observation changed while reading",
    );
    expect(signaled).toEqual([]);
    await observer.close();
  });

  it("retains a reparented descendant but drops a reused PID before signaling", async () => {
    const application = "/private/tmp/process-observer/Enduragent.app";
    let table: readonly MacosProcessIdentity[] = [
      { pid: 101, parentPid: 1, startedAt: "Sun Aug 9 16:00:00 2026" },
    ];
    const signaled: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const observer = createMacosApplicationProcessObserver(application, {
      observeBundleProcesses: async () => ({ bundlePids: [], mainPids: [] }),
      readProcessTable: async () => table,
      signalProcess: (pid, signal) => signaled.push({ pid, signal }),
      trackingIntervalMs: 60_000,
    });

    const root = await observer.trackRoot(101);
    table = [
      { pid: 101, parentPid: 1, startedAt: "Sun Aug 9 16:00:00 2026" },
      { pid: 102, parentPid: 101, startedAt: "Sun Aug 9 16:00:01 2026" },
      { pid: 103, parentPid: 102, startedAt: "Sun Aug 9 16:00:02 2026" },
    ];
    expect((await observer.freezeRoot(root)).map((identity) => identity.pid)).toEqual([
      101, 102, 103,
    ]);

    table = [
      { pid: 101, parentPid: 1, startedAt: "Sun Aug 9 16:00:00 2026" },
      { pid: 102, parentPid: 101, startedAt: "Sun Aug 9 16:00:01 2026" },
      { pid: 103, parentPid: 102, startedAt: "Sun Aug 9 16:00:02 2026" },
      { pid: 202, parentPid: 103, startedAt: "Sun Aug 9 16:00:03 2026" },
    ];
    expect((await observer.observe()).ownedPids).toEqual([101, 102, 103]);

    table = [
      { pid: 102, parentPid: 1, startedAt: "Sun Aug 9 16:00:01 2026" },
      { pid: 103, parentPid: 1, startedAt: "Sun Aug 9 16:01:02 2026" },
    ];
    expect(await observer.observe()).toMatchObject({ ownedPids: [102] });
    expect(await observer.signalAll("SIGTERM")).toBe(true);
    expect(signaled).toEqual([{ pid: 102, signal: "SIGTERM" }]);
    await observer.close();
  });

  it.skipIf(process.platform !== "darwin")(
    "finds and terminates a real out-of-bundle grandchild after its parent exits",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "updater-process-observer-"));
      roots.push(root);
      const application = join(root, "Enduragent.app");
      const marker = join(root, "grandchild-terminated.txt");
      await mkdir(application, { mode: 0o700 });

      const helperCode = [
        'const fs = require("node:fs");',
        'process.on("SIGTERM", () => { fs.writeFileSync(process.argv[1], "SIGTERM"); process.exit(0); });',
        "setInterval(() => undefined, 1_000);",
      ].join("");
      const parentCode = [
        'const { spawn } = require("node:child_process");',
        `const helper = spawn(process.execPath, ["-e", ${JSON.stringify(helperCode)}, process.argv[1]], { stdio: "ignore" });`,
        "process.stdout.write(`${helper.pid}\\n`, () => setTimeout(() => process.exit(0), 750));",
      ].join("");
      const parent = spawn(process.execPath, ["-e", parentCode, marker], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      children.push(parent);
      await new Promise<void>((resolve, reject) => {
        parent.once("spawn", resolve);
        parent.once("error", reject);
      });
      const parentPid = parent.pid as number;
      let output = "";
      parent.stdout?.setEncoding("utf8");
      parent.stdout?.on("data", (chunk: string) => {
        output += chunk;
      });

      const observer = createMacosApplicationProcessObserver(application);
      try {
        const parentExit = new Promise<void>((resolve) => parent.once("exit", () => resolve()));
        await observer.trackRoot(parentPid);
        let helperPid = 0;
        await waitUntil(() => {
          const match = /^(\d+)\n$/u.exec(output);
          if (match?.[1] === undefined) return false;
          helperPid = Number(match[1]);
          if (!externalPids.includes(helperPid)) externalPids.push(helperPid);
          return true;
        });

        await parentExit;
        const afterParentExit = await observer.observe();
        expect(afterParentExit.bundlePids).toEqual([]);
        expect(afterParentExit.ownedPids).toContain(helperPid);

        await observer.freezeAll();
        expect(await observer.signalAll("SIGTERM")).toBe(true);
        await waitUntil(() => !processIsReachable(helperPid));
        expect(await readFile(marker, "utf8")).toBe("SIGTERM");
      } finally {
        await observer.close();
      }
    },
  );
});
