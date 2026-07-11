import { createServer, type Server, type AddressInfo } from "node:net";
import { existsSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { claimLockfile, readLockfile } from "./lockfile-body.js";
import { readPortFile, writePortFile } from "./port-file.js";
import { defaultHealthzProbe, isPortBound, type HealthzProbe } from "./healthz-probe.js";

export class WriteLockContentionError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "WriteLockContentionError";
    this.exitCode = exitCode;
  }
}

export interface AcquireWriteLockOptions {
  readonly configDir: string;
  readonly athleteHome: string;
  readonly version: string;
  readonly probeHealthz?: HealthzProbe;
}

export interface WriteLockHandle {
  readonly status: "acquired";
  readonly port: number;
  readonly lockfilePath: string;
  readonly portFilePath: string;
  release(): Promise<void>;
}

export interface PeerHealthyOutcome {
  readonly status: "peer-healthy";
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

function bindWriterSocket(): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve(server));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

async function bestEffortUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    /* already gone */
  }
}

function contentionAgainstBound(
  bodyPid: number | undefined,
  boundPort: number,
  portFilePath: string,
  probe: HealthzProbe,
): Promise<PeerHealthyOutcome | never> {
  return probe(boundPort).then((verdict) => {
    if (verdict.kind === "healthy") {
      return { status: "peer-healthy", port: boundPort, peerVersion: verdict.version };
    }
    if (verdict.kind === "unresponsive") {
      throw new WriteLockContentionError(
        `Another writer already holds this store (pid ${bodyPid ?? "unknown"}); stop that process or wait, then retry.`,
        3,
      );
    }
    throw new WriteLockContentionError(
      `127.0.0.1:${boundPort} is held by a foreign process; change or remove the port file at ${portFilePath} and retry.`,
      3,
    );
  });
}

export async function acquireWriteLock(opts: AcquireWriteLockOptions): Promise<AcquireWriteLockResult> {
  const probe = opts.probeHealthz ?? defaultHealthzProbe;
  ensureConfigDirSecure(opts.configDir);
  const lockfilePath = join(opts.configDir, LOCKFILE_NAME);
  const portFilePath = join(opts.configDir, PORT_FILE_NAME);

  const recordedPort = readPortFile(portFilePath);
  if (recordedPort !== null && (await isPortBound(recordedPort))) {
    const body = readLockfile(lockfilePath);
    return contentionAgainstBound(body?.pid, recordedPort, portFilePath, probe);
  }

  const server = await bindWriterSocket();
  const actualPort = (server.address() as AddressInfo).port;

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
      release: async (): Promise<void> => {
        await closeServer(server);
        await bestEffortUnlink(lockfilePath);
        await bestEffortUnlink(portFilePath);
      },
    };
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await claimAndFill();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        await closeServer(server);
        throw err;
      }
      const other = readLockfile(lockfilePath);
      const otherPort = other?.port ?? readPortFile(portFilePath);
      if (otherPort === null) {
        // Corruption backstop — no process ordering produces a claim without a
        // readable port (claims are born with their body via claimLockfile).
        // An unreadable claim is not proven stale, and no timer may prove it:
        // never unlink, never wait.
        await closeServer(server);
        throw new WriteLockContentionError(
          `The lockfile at ${lockfilePath} is unreadable; remove it and retry.`,
          3,
        );
      }
      if (await isPortBound(otherPort)) {
        await closeServer(server);
        return contentionAgainstBound(other?.pid, otherPort, portFilePath, probe);
      }
      await bestEffortUnlink(lockfilePath);
      await bestEffortUnlink(portFilePath);
    }
  }

  await closeServer(server);
  throw new WriteLockContentionError(
    `Another writer won arbitration for this store; stop that process or wait, then retry.`,
    3,
  );
}
