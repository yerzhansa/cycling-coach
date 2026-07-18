import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createServer, type Server, type Socket, type AddressInfo } from "node:net";
import { existsSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { claimLockfile, readLockfile } from "./lockfile-body.js";
import { readPortFile, writePortFile } from "./port-file.js";
import { defaultHealthzProbe, isPortBound, type HealthzProbe } from "./healthz-probe.js";

export type WriterContentionDiagnostic =
  | {
      readonly kind: "holder";
      readonly pid: number | null;
      readonly port: number;
    }
  | {
      readonly kind: "foreign";
      readonly port: number;
      readonly portFile: string;
    };

export class WriteLockContentionError extends Error {
  readonly exitCode: number;
  readonly contention: WriterContentionDiagnostic | null;
  constructor(
    message: string,
    exitCode: number,
    contention: WriterContentionDiagnostic | null = null,
  ) {
    super(message);
    this.name = "WriteLockContentionError";
    this.exitCode = exitCode;
    this.contention = contention;
  }
}

export interface AcquireWriteLockOptions {
  readonly configDir: string;
  readonly athleteHome: string;
  readonly version: string;
  readonly probeHealthz?: HealthzProbe;
}

export interface WriterProtocolHandlers {
  readonly request: (request: IncomingMessage, response: ServerResponse) => void;
  readonly upgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

export interface WriterProtocolBinding {
  readonly port: number;
  close(): Promise<void>;
}

export interface WriterProtocolListener {
  bind(handlers: WriterProtocolHandlers): Promise<WriterProtocolBinding>;
}

const inertWriterProtocolBinding: WriterProtocolBinding = Object.freeze({
  port: 0,
  async close() {},
});

export const inertWriterProtocolListener: WriterProtocolListener = Object.freeze({
  async bind() {
    return inertWriterProtocolBinding;
  },
});

export interface WriteLockHandle {
  readonly status: "acquired";
  readonly port: number;
  readonly lockfilePath: string;
  readonly portFilePath: string;
  readonly listener: WriterProtocolListener;
  release(): Promise<void>;
}

export interface PeerHealthyOutcome {
  readonly status: "peer-healthy";
  readonly pid: number | null;
  readonly port: number;
  readonly peerVersion: string;
}

export type AcquireWriteLockResult = WriteLockHandle | PeerHealthyOutcome;

export const LOCKFILE_NAME = "store-writer.lock" as const;
export const PORT_FILE_NAME = "store-writer.port" as const;

function ensureConfigDirSecure(configDir: string): void {
  if (existsSync(configDir)) {
    const mode = statSync(configDir).mode & 0o777;
    if (mode !== 0o700) chmodSync(configDir, 0o700);
  } else {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
}

function bindWriterSocket(): Promise<{ server: Server; sockets: Set<Socket> }> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      socket.resume();
    });
    server.on("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve({ server, sockets }));
  });
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

interface OwnedProtocolServer {
  readonly server: HttpServer;
  readonly sockets: Set<Socket>;
  readonly binding: WriterProtocolBinding;
  forceClose(): Promise<void>;
}

function createProtocolServer(
  handlers: WriterProtocolHandlers,
): Promise<{ readonly server: HttpServer; readonly sockets: Set<Socket>; readonly port: number }> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<Socket>();
    const server = createHttpServer(handlers.request);
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("upgrade", handlers.upgrade);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", onError);
      resolve({ server, sockets, port: (server.address() as AddressInfo).port });
    });
  });
}

function ownProtocolServer(
  server: HttpServer,
  sockets: Set<Socket>,
  port: number,
): OwnedProtocolServer {
  let closePromise: Promise<void> | undefined;
  let force = false;
  const close = (): Promise<void> => {
    closePromise ??= new Promise<void>((resolve, reject) => {
      let callbackSettled = false;
      let callbackError: Error | undefined;
      const settle = (): void => {
        if (!callbackSettled || sockets.size !== 0) return;
        if (callbackError === undefined) resolve();
        else reject(callbackError);
      };
      for (const socket of sockets) socket.once("close", settle);
      server.close((error) => {
        callbackSettled = true;
        callbackError = error;
        settle();
      });
      server.closeAllConnections();
      if (force) {
        for (const socket of sockets) socket.destroy();
      }
      settle();
    });
    return closePromise;
  };
  const binding: WriterProtocolBinding = { port, close };
  return {
    server,
    sockets,
    binding,
    forceClose() {
      force = true;
      for (const socket of sockets) socket.destroy();
      return close();
    },
  };
}

async function bestEffortUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    /* already gone */
  }
}

async function contentionAgainstBound(
  bodyPid: number | undefined,
  boundPort: number,
  portFilePath: string,
  probe: HealthzProbe,
): Promise<PeerHealthyOutcome> {
  const verdict = await probe(boundPort);
  if (verdict.kind === "healthy") {
    return {
      status: "peer-healthy",
      pid: bodyPid ?? null,
      port: boundPort,
      peerVersion: verdict.version,
    };
  }
  if (verdict.kind === "unresponsive") {
    throw new WriteLockContentionError(
      `Another writer already holds this store (pid ${bodyPid ?? "unknown"}); stop that process or wait, then retry.`,
      3,
      { kind: "holder", pid: bodyPid ?? null, port: boundPort },
    );
  }
  throw new WriteLockContentionError(
    `127.0.0.1:${boundPort} is held by a foreign process; change or remove the port file at ${portFilePath} and retry.`,
    3,
    { kind: "foreign", port: boundPort, portFile: portFilePath },
  );
}

export async function acquireWriteLock(
  opts: AcquireWriteLockOptions,
): Promise<AcquireWriteLockResult> {
  const probe = opts.probeHealthz ?? defaultHealthzProbe;
  ensureConfigDirSecure(opts.configDir);
  const lockfilePath = join(opts.configDir, LOCKFILE_NAME);
  const portFilePath = join(opts.configDir, PORT_FILE_NAME);

  const recordedPort = readPortFile(portFilePath);
  if (recordedPort !== null && (await isPortBound(recordedPort))) {
    const body = readLockfile(lockfilePath);
    return contentionAgainstBound(body?.pid, recordedPort, portFilePath, probe);
  }

  const { server, sockets } = await bindWriterSocket();
  const actualPort = (server.address() as AddressInfo).port;
  let released = false;
  let listenerUsed = false;
  let protocol: OwnedProtocolServer | undefined;
  let bindingPromise: Promise<WriterProtocolBinding> | undefined;
  let releasePromise: Promise<void> | undefined;

  const listener: WriterProtocolListener = {
    async bind(handlers): Promise<WriterProtocolBinding> {
      if (released) throw new Error("writer protocol listener is released");
      if (listenerUsed) throw new Error("writer protocol listener is already bound");
      listenerUsed = true;
      bindingPromise = (async () => {
        const created = await createProtocolServer(handlers);
        const owned = ownProtocolServer(created.server, created.sockets, created.port);
        protocol = owned;
        if (released) {
          await owned.forceClose();
          throw new Error("writer protocol listener is released");
        }
        try {
          await writePortFile(portFilePath, created.port);
        } catch (error) {
          await owned.forceClose().catch(() => {});
          throw error;
        }
        if (released) {
          await owned.forceClose();
          throw new Error("writer protocol listener is released");
        }
        return owned.binding;
      })();
      return bindingPromise;
    },
  };

  const claimAndFill = async (): Promise<WriteLockHandle> => {
    await claimLockfile(lockfilePath, {
      pid: process.pid,
      port: actualPort,
      version: opts.version,
      athleteHome: opts.athleteHome,
    });
    await writePortFile(portFilePath, actualPort);
    return {
      status: "acquired",
      port: actualPort,
      lockfilePath,
      portFilePath,
      listener,
      release(): Promise<void> {
        releasePromise ??= (async () => {
          released = true;
          let failure: unknown;
          let protocolClose = protocol?.forceClose();
          try {
            await bindingPromise;
          } catch {}
          try {
            protocolClose ??= protocol?.forceClose();
            await protocolClose;
          } catch (error) {
            failure = error;
          }
          try {
            await closeServer(server, sockets);
          } catch (error) {
            failure ??= error;
          }
          await bestEffortUnlink(lockfilePath);
          await bestEffortUnlink(portFilePath);
          if (failure !== undefined) throw failure;
        })();
        return releasePromise;
      },
    };
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await claimAndFill();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        await closeServer(server, sockets);
        throw err;
      }
      const other = readLockfile(lockfilePath);
      const otherPort = other?.port ?? readPortFile(portFilePath);
      if (otherPort === null) {
        // Corruption backstop — no process ordering produces a claim without a
        // readable port (claims are born with their body via claimLockfile).
        // An unreadable claim is not proven stale, and no timer may prove it:
        // never unlink, never wait.
        await closeServer(server, sockets);
        throw new WriteLockContentionError(
          `The lockfile at ${lockfilePath} is unreadable; remove it and retry.`,
          3,
        );
      }
      if (await isPortBound(otherPort)) {
        await closeServer(server, sockets);
        return contentionAgainstBound(other?.pid, otherPort, portFilePath, probe);
      }
      await bestEffortUnlink(lockfilePath);
      await bestEffortUnlink(portFilePath);
    }
  }

  await closeServer(server, sockets);
  throw new WriteLockContentionError(
    `Another writer won arbitration for this store; stop that process or wait, then retry.`,
    3,
  );
}
