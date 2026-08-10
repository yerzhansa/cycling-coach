import { randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, rename, rmdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
  HANDOFF_CAPABILITY_BYTES,
  canonicalCapability,
  productionTimer,
  readFrame,
  reserved,
  strictRequest,
  strictResponse,
  type AcquireUpgradeFenceInput,
  type AcquireUpgradeFenceResult,
  type MonotonicTimer,
  type UpgradeFenceAdmission,
} from "./upgrade-fence-protocol.js";
import {
  acquireWindowsUpgradeFence,
  admitStartupThroughWindowsUpgradeFence,
} from "./windows-upgrade-fence.js";

export const UPGRADE_FENCE_SOCKET_NAME = "upgrade.sock" as const;
export {
  HANDOFF_CAPABILITY_BYTES,
  HANDOFF_RESERVED_MESSAGE,
  UPGRADE_FENCE_FRAME_MAX_BYTES,
  UPGRADE_FENCE_IO_TIMEOUT_MS,
} from "./upgrade-fence-protocol.js";
export type {
  AcquireUpgradeFenceInput,
  AcquireUpgradeFenceResult,
  MonotonicTimer,
  ScheduledMonotonicTimer,
  UpgradeFenceAdmission,
  UpgradeFenceHandle,
} from "./upgrade-fence-protocol.js";

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

let staleSequence = 0;

async function identity(path: string): Promise<FileIdentity | undefined> {
  try {
    const metadata = await lstat(path);
    return { dev: metadata.dev, ino: metadata.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function sameIdentity(left: FileIdentity | undefined, right: FileIdentity): boolean {
  return left?.dev === right.dev && left.ino === right.ino;
}

async function unlinkIdentity(path: string, expected: FileIdentity): Promise<void> {
  if (!sameIdentity(await identity(path), expected)) return;
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function reclaimStaleSocket(path: string, expected: FileIdentity): Promise<boolean> {
  if (!sameIdentity(await identity(path), expected)) return false;
  staleSequence += 1;
  const stalePath = `${path}.stale.${process.pid}.${staleSequence}`;
  try {
    await rename(path, stalePath);
  } catch (error) {
    if (["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
  await unlinkIdentity(stalePath, expected);
  return true;
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function requestAdmission(
  socketPath: string,
  request: { readonly kind: "ordinary-starter" }
    | { readonly kind: "designated-successor"; readonly handoffCapability: string },
  timer: MonotonicTimer,
): Promise<"reserved" | "designated"> {
  const socket = createConnection(socketPath);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const response = readFrame(socket, timer);
    socket.end(`${JSON.stringify(request)}\n`);
    const parsed = strictResponse(JSON.parse(await response));
    if (parsed === undefined) throw new Error("invalid response");
    return parsed;
  } finally {
    socket.destroy();
  }
}

async function ensureConfigDir(configDir: string): Promise<void> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700);
}

export async function acquireUpgradeFence(
  input: AcquireUpgradeFenceInput,
): Promise<AcquireUpgradeFenceResult> {
  if ((input.platform ?? process.platform) === "win32") return acquireWindowsUpgradeFence(input);
  await ensureConfigDir(input.configDir);
  const socketPath = join(input.configDir, UPGRADE_FENCE_SOCKET_NAME);
  const timer = input.timer ?? productionTimer();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const capabilityBytes = Buffer.from(
      (input.randomBytes ?? cryptoRandomBytes)(HANDOFF_CAPABILITY_BYTES),
    );
    if (capabilityBytes.length !== HANDOFF_CAPABILITY_BYTES) {
      throw new Error("upgrade fence capability generation failed");
    }
    let consumed = false;
    const sockets = new Set<Socket>();
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.once("error", () => socket.destroy());
      void readFrame(socket, timer).then((raw) => {
        let request: ReturnType<typeof strictRequest>;
        try {
          request = strictRequest(JSON.parse(raw));
        } catch {
          request = undefined;
        }
        let status: "reserved" | "designated" = "reserved";
        if (request?.kind === "designated-successor" && !consumed) {
          const received = canonicalCapability(request.handoffCapability);
          const matches =
            received !== undefined
            && received.length === capabilityBytes.length
            && timingSafeEqual(received, capabilityBytes);
          received?.fill(0);
          if (matches) {
            consumed = true;
            status = "designated";
          }
        }
        socket.end(`${JSON.stringify({ status })}\n`);
      }).catch(() => socket.end(`${JSON.stringify({ status: "reserved" })}\n`));
    });
    const stagingDir = await mkdtemp(join(input.configDir, ".u"));
    const stagingPath = join(stagingDir, "s");
    let stagingIdentity: FileIdentity | undefined;
    let ownedIdentity: FileIdentity | undefined;
    let publicationError: unknown;
    try {
      await listen(server, stagingPath);
      stagingIdentity = await identity(stagingPath);
      if (stagingIdentity === undefined) {
        throw new Error("upgrade fence socket identity unavailable");
      }
      await link(stagingPath, socketPath);
      if (!sameIdentity(await identity(socketPath), stagingIdentity)) {
        throw new Error("upgrade fence socket identity unavailable");
      }
      await chmod(socketPath, 0o600);
      ownedIdentity = stagingIdentity;
      await unlinkIdentity(stagingPath, stagingIdentity);
      await rmdir(stagingDir);
    } catch (error) {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      if (stagingIdentity !== undefined) {
        await unlinkIdentity(socketPath, stagingIdentity);
        await unlinkIdentity(stagingPath, stagingIdentity);
      }
      await rmdir(stagingDir);
      publicationError = error;
    }
    if (publicationError !== undefined) {
      const code = (publicationError as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        capabilityBytes.fill(0);
        throw publicationError;
      }
      const observed = await identity(socketPath);
      if (observed === undefined) {
        capabilityBytes.fill(0);
        continue;
      }
      try {
        await requestAdmission(socketPath, { kind: "ordinary-starter" }, timer);
        capabilityBytes.fill(0);
        return reserved();
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== "ECONNREFUSED") {
          capabilityBytes.fill(0);
          return reserved();
        }
      }
      if (!(await reclaimStaleSocket(socketPath, observed))) {
        capabilityBytes.fill(0);
        return reserved();
      }
      capabilityBytes.fill(0);
      continue;
    }
    if (ownedIdentity === undefined) {
      throw new Error("upgrade fence socket identity unavailable");
    }
    const handoffCapability = capabilityBytes.toString("base64url");
    let releasePromise: Promise<void> | undefined;
    return {
      status: "acquired",
      handle: {
        socketPath,
        handoffCapability,
        release() {
          releasePromise ??= (async () => {
            for (const socket of sockets) socket.destroy();
            await closeServer(server);
            await unlinkIdentity(socketPath, ownedIdentity);
            capabilityBytes.fill(0);
          })();
          return releasePromise;
        },
      },
    };
  }
  return reserved();
}

export async function admitStartupThroughUpgradeFence(input: {
  readonly configDir: string;
  readonly handoffCapability?: string;
  readonly timer?: MonotonicTimer;
  readonly platform?: NodeJS.Platform;
}): Promise<UpgradeFenceAdmission> {
  if ((input.platform ?? process.platform) === "win32") return admitStartupThroughWindowsUpgradeFence(input);
  await ensureConfigDir(input.configDir);
  const socketPath = join(input.configDir, UPGRADE_FENCE_SOCKET_NAME);
  const timer = input.timer ?? productionTimer();
  const request = input.handoffCapability === undefined
    ? { kind: "ordinary-starter" as const }
    : {
        kind: "designated-successor" as const,
        handoffCapability: input.handoffCapability,
      };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const status = await requestAdmission(socketPath, request, timer);
      return status === "designated" ? { status: "designated" } : reserved();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { status: "clear" };
      if (code === "EINVAL" || code === "ENAMETOOLONG") {
        throw new Error(
          `Enduragent cannot start: upgrade fence socket path is too long for a Unix socket on this platform: ${socketPath}`,
        );
      }
      if (code !== "ECONNREFUSED") return reserved();
      const observed = await identity(socketPath);
      if (observed === undefined) return { status: "clear" };
      if (!(await reclaimStaleSocket(socketPath, observed))) return reserved();
    }
  }
  return reserved();
}
