import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HANDOFF_RESERVED_MESSAGE,
  UPGRADE_FENCE_FRAME_MAX_BYTES,
  UPGRADE_FENCE_IO_TIMEOUT_MS,
  type AcquireUpgradeFenceResult,
  type MonotonicTimer,
  type ScheduledMonotonicTimer,
} from "../src/daemon/upgrade-fence.js";
import {
  WINDOWS_UPGRADE_FENCE_CLAIM_NAME,
  acquireWindowsUpgradeFence,
  admitStartupThroughWindowsUpgradeFence,
} from "../src/daemon/windows-upgrade-fence.js";

const roots: string[] = [];
const cleanups = new Set<() => Promise<void>>();
const FENCE = Buffer.alloc(16, 11).toString("base64url");
const OTHER_FENCE = Buffer.alloc(16, 12).toString("base64url");

afterEach(async () => {
  const cleanupResults = await Promise.allSettled([...cleanups].map((cleanup) => cleanup()));
  cleanups.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  const failed = cleanupResults.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
});

async function configDir(): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "windows-upgrade-fence-"));
  roots.push(root);
  return join(root, "config");
}

function claimPath(dir: string): string {
  return join(dir, WINDOWS_UPGRADE_FENCE_CLAIM_NAME);
}

async function readClaim(dir: string): Promise<{ readonly fence: string; readonly port: number }> {
  return JSON.parse(await readFile(claimPath(dir), "utf8")) as {
    readonly fence: string;
    readonly port: number;
  };
}

async function writeClaim(
  dir: string,
  claim: { readonly fence: string; readonly port: number },
): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const contents = `${JSON.stringify(claim)}\n`;
  await writeFile(claimPath(dir), contents, { mode: 0o600 });
  return contents;
}

function trackAcquired(result: AcquireUpgradeFenceResult): void {
  if (result.status === "acquired") cleanups.add(() => result.handle.release());
}

class FakeTimer implements MonotonicTimer {
  private now = 0;
  private scheduleCount = 0;
  private readonly scheduleWaiters = new Set<{
    readonly after: number;
    readonly resolve: () => void;
  }>();
  private readonly scheduled = new Set<{
    readonly at: number;
    readonly callback: () => void;
    cancelled: boolean;
  }>();

  nowMs(): number {
    return this.now;
  }

  schedule(delayMs: number, callback: () => void): ScheduledMonotonicTimer {
    const item = { at: this.now + delayMs, callback, cancelled: false };
    this.scheduled.add(item);
    this.scheduleCount += 1;
    for (const waiter of this.scheduleWaiters) {
      if (this.scheduleCount > waiter.after) {
        this.scheduleWaiters.delete(waiter);
        waiter.resolve();
      }
    }
    return {
      cancel: () => {
        item.cancelled = true;
        this.scheduled.delete(item);
      },
    };
  }

  waitForScheduleAfter(count: number): Promise<void> {
    if (this.scheduleCount > count) return Promise.resolve();
    return new Promise((resolve) => this.scheduleWaiters.add({ after: count, resolve }));
  }

  get totalSchedules(): number {
    return this.scheduleCount;
  }

  advance(ms: number): void {
    this.now += ms;
    for (const item of this.scheduled) {
      if (!item.cancelled && item.at <= this.now) {
        this.scheduled.delete(item);
        item.callback();
      }
    }
  }
}

function rawAdmission(port: number, bytes: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.once("error", reject);
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.once("connect", () => socket.end(bytes));
  });
}

interface TestServer {
  readonly port: number;
  close(): Promise<void>;
}

async function startServer(onSocket: (socket: Socket) => void): Promise<TestServer> {
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    onSocket(socket);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= new Promise<void>((resolve, reject) => {
      for (const socket of sockets) socket.destroy();
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    return closePromise;
  };
  cleanups.add(close);
  return { port, close };
}

async function respondingServer(response: string): Promise<TestServer> {
  return startServer((socket) => {
    socket.once("data", () => socket.end(response));
  });
}

function reservedResponse(fence: string): string {
  return `${JSON.stringify({ fence, status: "reserved" })}\n`;
}

describe("Windows upgrade fence", () => {
  it("matches admission, one-shot capability, release, and permission contracts", async () => {
    const dir = await configDir();
    const acquired = await acquireWindowsUpgradeFence({
      configDir: dir,
      randomBytes: (size) => Buffer.alloc(size, 7),
    });
    trackAcquired(acquired);
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") return;

    const ordinary = await admitStartupThroughWindowsUpgradeFence({ configDir: dir });
    expect(ordinary).toEqual({
      status: "reserved",
      exitCode: 3,
      message: HANDOFF_RESERVED_MESSAGE,
    });
    if (ordinary.status !== "reserved") return;
    expect(Buffer.from(ordinary.message)).toEqual(Buffer.from(HANDOFF_RESERVED_MESSAGE));

    await expect(
      admitStartupThroughWindowsUpgradeFence({
        configDir: dir,
        handoffCapability: Buffer.alloc(32, 8).toString("base64url"),
      }),
    ).resolves.toMatchObject({ status: "reserved" });
    await expect(
      admitStartupThroughWindowsUpgradeFence({
        configDir: dir,
        handoffCapability: acquired.handle.handoffCapability,
      }),
    ).resolves.toEqual({ status: "designated" });
    await expect(
      admitStartupThroughWindowsUpgradeFence({
        configDir: dir,
        handoffCapability: acquired.handle.handoffCapability,
      }),
    ).resolves.toMatchObject({ status: "reserved" });

    if (process.platform !== "win32") {
      expect((await lstat(dir)).mode & 0o777).toBe(0o700);
      expect((await lstat(claimPath(dir))).mode & 0o777).toBe(0o600);
    }

    await acquired.handle.release();
    await acquired.handle.release();
    await expect(admitStartupThroughWindowsUpgradeFence({ configDir: dir })).resolves.toEqual({
      status: "clear",
    });
    await expect(lstat(claimPath(dir))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces byte boundaries and the incomplete-frame monotonic deadline", async () => {
    const dir = await configDir();
    const timer = new FakeTimer();
    const acquired = await acquireWindowsUpgradeFence({ configDir: dir, timer });
    trackAcquired(acquired);
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") return;
    const claim = await readClaim(dir);
    const ordinary = JSON.stringify({ kind: "ordinary-starter" });
    const exact = Buffer.from(`${ordinary.padEnd(UPGRADE_FENCE_FRAME_MAX_BYTES - 1, " ")}\n`);
    expect(exact.length).toBe(UPGRADE_FENCE_FRAME_MAX_BYTES);
    await expect(rawAdmission(claim.port, exact)).resolves.toBe(reservedResponse(claim.fence));

    const oversized = Buffer.from(`${ordinary.padEnd(UPGRADE_FENCE_FRAME_MAX_BYTES, " ")}\n`);
    expect(oversized.length).toBe(UPGRADE_FENCE_FRAME_MAX_BYTES + 1);
    await expect(rawAdmission(claim.port, oversized)).resolves.toBe(reservedResponse(claim.fence));

    const incompleteBytes = Buffer.alloc(UPGRADE_FENCE_FRAME_MAX_BYTES - 1, "é");
    expect(incompleteBytes.length).toBe(UPGRADE_FENCE_FRAME_MAX_BYTES - 1);
    const priorSchedules = timer.totalSchedules;
    const incomplete = rawAdmission(claim.port, incompleteBytes);
    await timer.waitForScheduleAfter(priorSchedules);
    timer.advance(UPGRADE_FENCE_IO_TIMEOUT_MS);
    await expect(incomplete).resolves.toBe(reservedResponse(claim.fence));
  });

  it("does not unlink a replacement claim inode during release", async () => {
    const dir = await configDir();
    const acquired = await acquireWindowsUpgradeFence({ configDir: dir });
    trackAcquired(acquired);
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") return;
    const path = claimPath(dir);
    const moved = `${path}.moved`;
    await rename(path, moved);
    await writeFile(path, "replacement\n", { mode: 0o600 });
    await acquired.handle.release();
    await expect(readFile(path, "utf8")).resolves.toBe("replacement\n");
  });

  it("recovers a claim left behind by a crashed holder and permits a fresh acquisition", async () => {
    const dir = await configDir();
    const holder = await startServer((socket) => socket.resume());
    await writeClaim(dir, { fence: FENCE, port: holder.port });
    await holder.close();
    await expect(lstat(claimPath(dir))).resolves.toBeDefined();

    await expect(admitStartupThroughWindowsUpgradeFence({ configDir: dir })).resolves.toEqual({
      status: "clear",
    });
    await expect(lstat(claimPath(dir))).rejects.toMatchObject({ code: "ENOENT" });

    const acquired = await acquireWindowsUpgradeFence({ configDir: dir });
    trackAcquired(acquired);
    expect(acquired.status).toBe("acquired");
  });

  it("reserves a hung holder after the monotonic deadline without reclaiming its claim", async () => {
    const dir = await configDir();
    const holder = await startServer(() => {});
    const contents = await writeClaim(dir, { fence: FENCE, port: holder.port });
    const timer = new FakeTimer();
    const admission = admitStartupThroughWindowsUpgradeFence({ configDir: dir, timer });
    await timer.waitForScheduleAfter(1);
    timer.advance(UPGRADE_FENCE_IO_TIMEOUT_MS);
    await expect(admission).resolves.toEqual({
      status: "reserved",
      exitCode: 3,
      message: HANDOFF_RESERVED_MESSAGE,
    });
    await expect(readFile(claimPath(dir), "utf8")).resolves.toBe(contents);
  });

  it.each([
    ["garbage", "not-json\n"],
    ["wrong nonce", reservedResponse(OTHER_FENCE)],
    ["status-only response", `${JSON.stringify({ status: "reserved" })}\n`],
  ])("reclaims a port squatter returning %s", async (_name, response) => {
    const dir = await configDir();
    const squatter = await respondingServer(response);
    await writeClaim(dir, { fence: FENCE, port: squatter.port });
    await expect(admitStartupThroughWindowsUpgradeFence({ configDir: dir })).resolves.toEqual({
      status: "clear",
    });
    await expect(lstat(claimPath(dir))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a live claim when the holder returns the correct nonce echo", async () => {
    const dir = await configDir();
    const holder = await respondingServer(reservedResponse(FENCE));
    const contents = await writeClaim(dir, { fence: FENCE, port: holder.port });
    await expect(admitStartupThroughWindowsUpgradeFence({ configDir: dir })).resolves.toEqual({
      status: "reserved",
      exitCode: 3,
      message: HANDOFF_RESERVED_MESSAGE,
    });
    await expect(readFile(claimPath(dir), "utf8")).resolves.toBe(contents);
  });

  it("arbitrates concurrent acquisitions with exactly one winner", async () => {
    const dir = await configDir();
    const results = await Promise.all([
      acquireWindowsUpgradeFence({ configDir: dir }),
      acquireWindowsUpgradeFence({ configDir: dir }),
    ]);
    for (const result of results) trackAcquired(result);
    expect(results.filter((result) => result.status === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result.status === "reserved")).toHaveLength(1);
  });

  it.each([
    ["invalid JSON", "not-json\n"],
    ["wrong keys", `${JSON.stringify({ nonce: FENCE, port: 31_337 })}\n`],
  ])("fails safe on a corrupt claim with %s", async (_name, contents) => {
    const dir = await configDir();
    await mkdir(dir, { recursive: true });
    await writeFile(claimPath(dir), contents, { mode: 0o600 });

    await expect(admitStartupThroughWindowsUpgradeFence({ configDir: dir })).resolves.toEqual({
      status: "reserved",
      exitCode: 3,
      message: HANDOFF_RESERVED_MESSAGE,
    });
    const acquired = await acquireWindowsUpgradeFence({ configDir: dir });
    trackAcquired(acquired);
    expect(acquired).toEqual({
      status: "reserved",
      exitCode: 3,
      message: HANDOFF_RESERVED_MESSAGE,
    });
    await expect(readFile(claimPath(dir), "utf8")).resolves.toBe(contents);
  });
});
