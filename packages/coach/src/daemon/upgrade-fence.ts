import { randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, rename, rmdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { TextDecoder } from "node:util";
import { EXIT_DAEMON_UNAVAILABLE } from "@enduragent/coach-contract";

export const UPGRADE_FENCE_SOCKET_NAME = "upgrade.sock" as const;
export const HANDOFF_CAPABILITY_BYTES = 32 as const;
export const UPGRADE_FENCE_FRAME_MAX_BYTES = 4_096 as const;
export const UPGRADE_FENCE_IO_TIMEOUT_MS = 5_000 as const;
export const HANDOFF_RESERVED_MESSAGE =
  "Enduragent cannot start: an authenticated upgrade handoff already reserves this athlete home.\n";

export interface ScheduledMonotonicTimer {
  cancel(): void;
}

export interface MonotonicTimer {
  nowMs(): number;
  schedule(delayMs: number, callback: () => void): ScheduledMonotonicTimer;
}

export type UpgradeFenceAdmission =
  | { readonly status: "clear" }
  | { readonly status: "designated" }
  | {
      readonly status: "reserved";
      readonly exitCode: 3;
      readonly message: typeof HANDOFF_RESERVED_MESSAGE;
    };

export interface UpgradeFenceHandle {
  readonly socketPath: string;
  readonly handoffCapability: string;
  release(): Promise<void>;
}

export interface AcquireUpgradeFenceInput {
  readonly configDir: string;
  readonly randomBytes?: (size: number) => Buffer;
  readonly timer?: MonotonicTimer;
}

export type AcquireUpgradeFenceResult =
  | { readonly status: "acquired"; readonly handle: UpgradeFenceHandle }
  | {
      readonly status: "reserved";
      readonly exitCode: 3;
      readonly message: typeof HANDOFF_RESERVED_MESSAGE;
    };

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
let staleSequence = 0;

function productionTimer(): MonotonicTimer {
  return {
    nowMs: () => performance.now(),
    schedule(delayMs, callback) {
      const handle = setTimeout(callback, Math.max(0, delayMs));
      handle.unref?.();
      return { cancel: () => clearTimeout(handle) };
    },
  };
}

function reserved(): Extract<UpgradeFenceAdmission, { status: "reserved" }> {
  return {
    status: "reserved",
    exitCode: EXIT_DAEMON_UNAVAILABLE,
    message: HANDOFF_RESERVED_MESSAGE,
  };
}

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

function readFrame(socket: Socket, timer: MonotonicTimer): Promise<string> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    let settled = false;
    const deadline = timer.schedule(UPGRADE_FENCE_IO_TIMEOUT_MS, () => finish(new Error("timeout")));
    const cleanup = (): void => {
      deadline.cancel();
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const finish = (error?: Error, value?: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve(value!);
      else reject(error);
    };
    const onError = (): void => finish(new Error("io"));
    const onClose = (): void => finish(new Error("closed"));
    const onData = (chunk: Buffer): void => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > UPGRADE_FENCE_FRAME_MAX_BYTES) {
        finish(new Error("oversized"));
        return;
      }
      const newline = bytes.indexOf(0x0a);
      if (newline === -1) return;
      if (newline !== bytes.length - 1 || bytes.indexOf(0x0a, newline + 1) !== -1) {
        finish(new Error("trailing"));
        return;
      }
      try {
        finish(undefined, decoder.decode(bytes.subarray(0, -1)));
      } catch {
        finish(new Error("encoding"));
      }
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function canonicalCapability(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length !== HANDOFF_CAPABILITY_BYTES
    || decoded.toString("base64url") !== value
  ) {
    return undefined;
  }
  return decoded;
}

function strictRequest(value: unknown):
  | { readonly kind: "ordinary-starter" }
  | { readonly kind: "designated-successor"; readonly handoffCapability: string }
  | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length === 1 && keys[0] === "kind" && record.kind === "ordinary-starter") {
    return { kind: "ordinary-starter" };
  }
  if (
    keys.length === 2
    && keys[0] === "handoffCapability"
    && keys[1] === "kind"
    && record.kind === "designated-successor"
    && typeof record.handoffCapability === "string"
  ) {
    return { kind: "designated-successor", handoffCapability: record.handoffCapability };
  }
  return undefined;
}

function strictResponse(value: unknown): "reserved" | "designated" | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 1 && keys[0] === "status"
    && (record.status === "reserved" || record.status === "designated")
    ? record.status
    : undefined;
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
}): Promise<UpgradeFenceAdmission> {
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
