// W1 scope: the port bind, lockfile write/read-back, per-home port file, case (b)
// reclaim, and RO-open are real behavior tested here end-to-end. Cases (a)/(c)/(d)
// are proven by branch selection against an injected /healthz test double; the full
// four-case matrix against a real daemon /healthz responder arms at W8.

import { mkdtempSync, realpathSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import {
  createServer as createHttpServer,
  get as httpGet,
  type Server as HttpServer,
} from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireWriteLock,
  WriteLockContentionError,
  readLockfile,
  LOCKFILE_NAME,
  PORT_FILE_NAME,
  type HealthzProbe,
  type WriteLockHandle,
  type AcquireWriteLockResult,
} from "../src/lock/index.js";
import { writePortFile, readPortFile } from "../src/lock/port-file.js";
import { claimLockfile } from "../src/lock/lockfile-body.js";
import { defaultHealthzProbe, classifyHealthzResponse } from "../src/lock/healthz-probe.js";

const tempDirs: string[] = [];
const heldHandles: WriteLockHandle[] = [];
const netServers: Server[] = [];
const httpServers: HttpServer[] = [];

function freshDir(prefix = "lock-"): string {
  const d = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  tempDirs.push(d);
  return d;
}

const hasLoopback = await new Promise<boolean>((resolve) => {
  const server = createServer();
  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPERM") {
      process.stderr.write("SKIP_MARKER loopback-listen EPERM lock.test\n");
    }
    resolve(false);
  });
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    server.close(() => resolve(true));
  });
});

function isHandle(r: AcquireWriteLockResult): r is WriteLockHandle {
  return r.status === "acquired";
}

function trackHandle(r: AcquireWriteLockResult): WriteLockHandle {
  if (!isHandle(r)) throw new Error(`expected acquired, got ${r.status}`);
  heldHandles.push(r);
  return r;
}

async function resolvesWithin<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`operation did not resolve within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function occupyPort(): Promise<{ port: number; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer();
    netServers.push(server);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("no addr");
      resolve({ port: addr.port, server });
    });
  });
}

function knownFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("no addr");
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

function httpResponder(body: string): Promise<{ port: number; server: HttpServer }> {
  return new Promise((resolve) => {
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
    httpServers.push(server);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("no addr");
      resolve({ port: addr.port, server });
    });
  });
}

afterEach(async () => {
  for (const h of heldHandles.splice(0)) {
    try {
      await h.release();
    } catch {
      /* best effort */
    }
  }
  for (const s of netServers.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const s of httpServers.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe.skipIf(!hasLoopback)("acquireWriteLock", () => {
  it("(bind) port-bind singleton is authoritative", async () => {
    const configDir = freshDir();
    const result = trackHandle(
      await acquireWriteLock({ configDir, athleteHome: "/home/a", version: "1.0.0" }),
    );
    expect(result.status).toBe("acquired");

    const onDisk = readLockfile(join(configDir, LOCKFILE_NAME));
    expect(onDisk).toEqual({
      pid: process.pid,
      port: result.port,
      version: "1.0.0",
      athleteHome: "/home/a",
    });
    expect(readPortFile(join(configDir, PORT_FILE_NAME))).toBe(result.port);

    await expect(
      new Promise((_resolve, reject) => {
        const s = createServer();
        s.on("error", reject);
        s.listen({ host: "127.0.0.1", port: result.port });
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });

    await result.release();
    heldHandles.length = 0;
    expect(readLockfile(join(configDir, LOCKFILE_NAME))).toBeNull();
    expect(readPortFile(join(configDir, PORT_FILE_NAME))).toBeNull();
    const rebound = await new Promise<Server>((resolve, reject) => {
      const s = createServer();
      s.on("error", reject);
      s.listen({ host: "127.0.0.1", port: result.port }, () => resolve(s));
    });
    netServers.push(rebound);
    await new Promise<void>((resolve) => rebound.close(() => resolve()));
    netServers.pop();
    const rebind = await acquireWriteLock({ configDir, athleteHome: "/home/a", version: "1.0.0" });
    trackHandle(rebind);
    expect(rebind.status).toBe("acquired");
  });

  it("(release) resolves after a real contention probe", async () => {
    const configDir = freshDir();
    const holder = trackHandle(
      await acquireWriteLock({ configDir, athleteHome: "/home/a", version: "1.0.0" }),
    );

    await expect(
      acquireWriteLock({ configDir, athleteHome: "/home/a", version: "1.0.0" }),
    ).rejects.toBeInstanceOf(WriteLockContentionError);

    heldHandles.length = 0;
    await expect(resolvesWithin(holder.release())).resolves.toBeUndefined();
  });

  it("(release) resolves while a connected peer socket is still open", async () => {
    const configDir = freshDir();
    const holder = trackHandle(
      await acquireWriteLock({ configDir, athleteHome: "/home/a", version: "1.0.0" }),
    );
    const peer = await new Promise<Socket>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: holder.port });
      const onError = (err: Error): void => reject(err);
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        resolve(socket);
      });
    });
    const peerClosed = new Promise<void>((resolve) => peer.once("close", () => resolve()));
    peer.on("error", () => {});

    expect(peer.destroyed).toBe(false);
    heldHandles.length = 0;
    const release = holder.release();
    try {
      await expect(resolvesWithin(release)).resolves.toBeUndefined();
      await expect(resolvesWithin(peerClosed)).resolves.toBeUndefined();
      expect(peer.destroyed).toBe(true);
    } finally {
      peer.destroy();
      await release;
    }
  });

  it("binds health and upgrades on a separate published protocol socket", async () => {
    const configDir = freshDir();
    const holder = trackHandle(
      await acquireWriteLock({ configDir, athleteHome: "/home/a", version: "1.0.0" }),
    );
    const initialPort = readPortFile(join(configDir, PORT_FILE_NAME));
    expect(initialPort).toBe(holder.port);

    const binding = await holder.listener.bind({
      request(_request, response) {
        response.statusCode = 200;
        response.end("ready\n");
      },
      upgrade(_request, socket) {
        socket.destroy();
      },
    });
    expect(binding.port).not.toBe(holder.port);
    expect(readPortFile(join(configDir, PORT_FILE_NAME))).toBe(binding.port);
    await expect(new Promise<string>((resolve, reject) => {
      httpGet(`http://127.0.0.1:${binding.port}/healthz`, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve(body));
      }).once("error", reject);
    })).resolves.toBe("ready\n");

    const raw = createConnection({ host: "127.0.0.1", port: holder.port });
    await new Promise<void>((resolve, reject) => {
      raw.once("error", reject);
      raw.once("connect", () => {
        raw.write("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        const timer = setTimeout(() => {
          raw.destroy();
          resolve();
        }, 50);
        raw.once("data", () => {
          clearTimeout(timer);
          reject(new Error("raw authority socket emitted protocol bytes"));
        });
      });
    });

    await expect(holder.listener.bind({
      request() {},
      upgrade() {},
    })).rejects.toThrow("already bound");
    await binding.close();
    await expect(new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: holder.port });
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
    })).resolves.toBeUndefined();
  });

  it("(a) healthy peer returns peer-healthy without binding", async () => {
    const configDir = freshDir();
    const { port } = await occupyPort();
    await writePortFile(join(configDir, PORT_FILE_NAME), port);
    await claimLockfile(join(configDir, LOCKFILE_NAME), {
      pid: 777,
      port,
      version: "8.8.8",
      athleteHome: "/home/a",
    });
    const lockBefore = readFileSync(join(configDir, LOCKFILE_NAME), "utf-8");

    const probe: HealthzProbe = async () => ({ kind: "healthy", version: "9.9.9" });
    const result = await acquireWriteLock({
      configDir,
      athleteHome: "/home/a",
      version: "1.0.0",
      probeHealthz: probe,
    });
    expect(result).toEqual({ status: "peer-healthy", pid: 777, port, peerVersion: "9.9.9" });
    expect(readFileSync(join(configDir, LOCKFILE_NAME), "utf-8")).toBe(lockBefore);
  });

  it("(b) stale lockfile with free port reclaims without probing", async () => {
    const configDir = freshDir();
    const freePort = await knownFreePort();
    await writePortFile(join(configDir, PORT_FILE_NAME), freePort);
    await claimLockfile(join(configDir, LOCKFILE_NAME), {
      pid: process.pid,
      port: freePort,
      version: "0.0.1",
      athleteHome: "/home/a",
    });

    const throwingProbe: HealthzProbe = async () => {
      throw new Error("probe must not be consulted on case (b)");
    };
    const result = trackHandle(
      await acquireWriteLock({
        configDir,
        athleteHome: "/home/a",
        version: "1.0.0",
        probeHealthz: throwingProbe,
      }),
    );
    expect(result.status).toBe("acquired");
    expect(result.port).not.toBe(freePort);

    const reclaimed = readLockfile(join(configDir, LOCKFILE_NAME));
    expect(reclaimed?.pid).toBe(process.pid);
    expect(reclaimed?.port).toBe(result.port);
    expect(readPortFile(join(configDir, PORT_FILE_NAME))).toBe(result.port);
  });

  it("(c) bound port + unresponsive /healthz refuses exit 3 naming the pid", async () => {
    const configDir = freshDir();
    const { port } = await occupyPort();
    await writePortFile(join(configDir, PORT_FILE_NAME), port);
    await claimLockfile(join(configDir, LOCKFILE_NAME), {
      pid: 424242,
      port,
      version: "0.0.1",
      athleteHome: "/home/a",
    });

    const probe: HealthzProbe = async () => ({ kind: "unresponsive" });
    let caught: unknown;
    try {
      await acquireWriteLock({ configDir, athleteHome: "/home/a", version: "1.0.0", probeHealthz: probe });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WriteLockContentionError);
    expect((caught as WriteLockContentionError).exitCode).toBe(3);
    expect((caught as WriteLockContentionError).message).toContain("424242");
    expect((caught as WriteLockContentionError).contention).toEqual({
      kind: "holder",
      pid: 424242,
      port,
    });
  });

  it("(d) foreign process refuses exit 3 naming the port file", async () => {
    const configDir = freshDir();
    const { port } = await occupyPort();
    const portFilePath = join(configDir, PORT_FILE_NAME);
    await writePortFile(portFilePath, port);

    const probe: HealthzProbe = async () => ({ kind: "foreign" });
    let caught: unknown;
    try {
      await acquireWriteLock({ configDir, athleteHome: "/home/a", version: "1.0.0", probeHealthz: probe });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WriteLockContentionError);
    expect((caught as WriteLockContentionError).exitCode).toBe(3);
    expect((caught as WriteLockContentionError).message).toContain(portFilePath);
    expect((caught as WriteLockContentionError).contention).toEqual({
      kind: "foreign",
      port,
      portFile: portFilePath,
    });
  });

  it("(RO-open) read-only open works beside the write-lock holder over WAL", async () => {
    const dbDir = freshDir("db-");
    const dbPath = join(dbDir, "store.db");
    const seed = new DatabaseSync(dbPath);
    seed.exec("PRAGMA journal_mode = WAL");
    seed.exec("CREATE TABLE t(x INTEGER)");
    seed.exec("INSERT INTO t VALUES (42)");
    seed.close();

    const configDir = freshDir();
    trackHandle(await acquireWriteLock({ configDir, athleteHome: "/home/a", version: "1.0.0" }));

    const ro = new DatabaseSync(dbPath, { readOnly: true });
    const row = ro.prepare("SELECT x FROM t").get() as { x: number };
    expect(row.x).toBe(42);
    ro.close();
  });

  it("(two-homes) two athlete homes acquire distinct ports without collision", async () => {
    const configDirA = freshDir();
    const configDirB = freshDir();
    const a = trackHandle(
      await acquireWriteLock({ configDir: configDirA, athleteHome: "/home/a", version: "1.0.0" }),
    );
    const b = trackHandle(
      await acquireWriteLock({ configDir: configDirB, athleteHome: "/home/b", version: "1.0.0" }),
    );
    expect(a.port).not.toBe(b.port);
    expect(readPortFile(join(configDirA, PORT_FILE_NAME))).toBe(a.port);
    expect(readPortFile(join(configDirB, PORT_FILE_NAME))).toBe(b.port);
  });

  it("(same-dir) two acquirers on one configDir yield exactly one winner", async () => {
    const configDir = freshDir();
    trackHandle(await acquireWriteLock({ configDir, athleteHome: "/home/a", version: "1.0.0" }));

    const probe: HealthzProbe = async () => ({ kind: "unresponsive" });
    let caught: unknown;
    try {
      await acquireWriteLock({ configDir, athleteHome: "/home/a", version: "1.0.0", probeHealthz: probe });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WriteLockContentionError);
    expect((caught as WriteLockContentionError).exitCode).toBe(3);
  });

  it("(race) two concurrent acquirers on one fresh configDir yield exactly one winner, every time", async () => {
    const probe: HealthzProbe = async () => ({ kind: "unresponsive" });
    for (let i = 0; i < 25; i++) {
      const configDir = freshDir();
      const opts = { configDir, athleteHome: "/home/a", version: "1.0.0", probeHealthz: probe };

      const settled = await Promise.allSettled([acquireWriteLock(opts), acquireWriteLock(opts)]);

      const winners = settled.filter(
        (s): s is PromiseFulfilledResult<AcquireWriteLockResult> =>
          s.status === "fulfilled" && s.value.status === "acquired",
      );
      const losers = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0].reason).toBeInstanceOf(WriteLockContentionError);
      expect((losers[0].reason as WriteLockContentionError).exitCode).toBe(3);
      await trackHandle(winners[0].value).release();
      heldHandles.length = 0;
    }
  });

  it("(race, mid-fill) a live claim without a port file is never unlinked", async () => {
    const configDir = freshDir();
    const { port } = await occupyPort();
    const lockfilePath = join(configDir, LOCKFILE_NAME);
    await claimLockfile(lockfilePath, {
      pid: 555001,
      port,
      version: "1.0.0",
      athleteHome: "/home/a",
    });
    const lockBefore = readFileSync(lockfilePath, "utf-8");

    const probe: HealthzProbe = async () => ({ kind: "unresponsive" });
    let caught: unknown;
    try {
      await acquireWriteLock({ configDir, athleteHome: "/home/a", version: "1.0.0", probeHealthz: probe });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WriteLockContentionError);
    expect((caught as WriteLockContentionError).exitCode).toBe(3);
    expect((caught as WriteLockContentionError).message).toContain("555001");
    expect(readFileSync(lockfilePath, "utf-8")).toBe(lockBefore);
    expect(readdirSync(configDir).filter((n) => n.includes(".tmp."))).toEqual([]);
  });

  it("(b-variant) a crash artifact claim naming a free port is reclaimed without probing", async () => {
    const configDir = freshDir();
    const freePort = await knownFreePort();
    await claimLockfile(join(configDir, LOCKFILE_NAME), {
      pid: 555002,
      port: freePort,
      version: "0.0.1",
      athleteHome: "/home/a",
    });

    const throwingProbe: HealthzProbe = async () => {
      throw new Error("probe must not be consulted for a free-port artifact");
    };
    const result = trackHandle(
      await acquireWriteLock({
        configDir,
        athleteHome: "/home/a",
        version: "1.0.0",
        probeHealthz: throwingProbe,
      }),
    );
    expect(result.status).toBe("acquired");
    const replaced = readLockfile(join(configDir, LOCKFILE_NAME));
    expect(replaced?.pid).toBe(process.pid);
    expect(replaced?.port).toBe(result.port);
  });

  it("(corrupt-claim) an unreadable claim refuses exit 3 naming the file, never unlinks it", async () => {
    for (const garbage of ["", "not json {{{"]) {
      const configDir = freshDir();
      const lockfilePath = join(configDir, LOCKFILE_NAME);
      writeFileSync(lockfilePath, garbage);

      let caught: unknown;
      try {
        await acquireWriteLock({ configDir, athleteHome: "/home/a", version: "1.0.0" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(WriteLockContentionError);
      expect((caught as WriteLockContentionError).exitCode).toBe(3);
      expect((caught as WriteLockContentionError).message).toContain(lockfilePath);
      expect(readFileSync(lockfilePath, "utf-8")).toBe(garbage);
    }
  });

  it("(default-probe) the real probe classifier resolves healthy/foreign/unresponsive", async () => {
    const coach = await httpResponder(
      JSON.stringify({ service: "enduragent-store-writer", version: "1.2.3" }),
    );
    expect(await defaultHealthzProbe(coach.port)).toEqual({ kind: "healthy", version: "1.2.3" });

    const foreign = await httpResponder("hello");
    expect(await defaultHealthzProbe(foreign.port)).toEqual({ kind: "foreign" });

    const freePort = await knownFreePort();
    expect(await defaultHealthzProbe(freePort)).toEqual({ kind: "unresponsive" });
  });

  it("(classify) classifyHealthzResponse maps coach/foreign/garbage bodies", () => {
    expect(
      classifyHealthzResponse(200, JSON.stringify({ service: "enduragent-store-writer", version: "2.0.0" })),
    ).toEqual({ kind: "healthy", version: "2.0.0" });
    expect(classifyHealthzResponse(200, JSON.stringify({ service: "other", version: "2.0.0" }))).toEqual({
      kind: "foreign",
    });
    expect(classifyHealthzResponse(200, "not-json-garbage")).toEqual({ kind: "foreign" });
  });

  it("keeps the two-argument contention constructor compatible", () => {
    const error = new WriteLockContentionError("synthetic contention", 3);
    expect(error.exitCode).toBe(3);
    expect(error.contention).toBeNull();
  });
});
