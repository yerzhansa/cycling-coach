import { randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, rename, unlink } from "node:fs/promises";
import {
  createConnection,
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import { join } from "node:path";
import { writeTempThenPublish } from "@enduragent/kernel-node/lock";
import {
  HANDOFF_CAPABILITY_BYTES,
  UPGRADE_FENCE_IO_TIMEOUT_MS,
  canonicalCapability,
  productionTimer,
  readFrame,
  reserved,
  strictRequest,
  type AcquireUpgradeFenceInput,
  type AcquireUpgradeFenceResult,
  type MonotonicTimer,
  type UpgradeFenceAdmission,
} from "./upgrade-fence-protocol.js";

export const WINDOWS_UPGRADE_FENCE_CLAIM_NAME = "upgrade.fence" as const;

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface WindowsUpgradeFenceClaim {
  readonly fence: string;
  readonly port: number;
}

type ClaimRead =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" }
  | {
      readonly kind: "readable";
      readonly claim: WindowsUpgradeFenceClaim;
      readonly identity: FileIdentity;
    };

type ProbeResult =
  | { readonly kind: "response"; readonly status: "reserved" | "designated" }
  | { readonly kind: "connection-refused" }
  | { readonly kind: "echo-invalid" }
  | { readonly kind: "other-error" };

let staleSequence = 0;

function isErrorCode(error: unknown, codes: readonly string[]): boolean {
  return codes.includes((error as NodeJS.ErrnoException).code ?? "");
}

async function ensureConfigDir(configDir: string): Promise<void> {
  try {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await chmod(configDir, 0o700);
  } catch {
    throw new Error("upgrade fence config directory unavailable");
  }
}

async function identity(path: string): Promise<FileIdentity | undefined> {
  try {
    const metadata = await lstat(path);
    return { dev: metadata.dev, ino: metadata.ino };
  } catch (error) {
    if (isErrorCode(error, ["ENOENT"])) return undefined;
    throw error;
  }
}

function sameIdentity(left: FileIdentity | undefined, right: FileIdentity): boolean {
  return left?.dev === right.dev && left.ino === right.ino;
}

async function unlinkIdentity(path: string, expected: FileIdentity): Promise<boolean> {
  let observed: FileIdentity | undefined;
  try {
    observed = await identity(path);
  } catch (error) {
    if (isErrorCode(error, ["EPERM", "EBUSY", "EACCES"])) return false;
    throw new Error("upgrade fence claim identity unavailable");
  }
  if (!sameIdentity(observed, expected)) return false;
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isErrorCode(error, ["ENOENT"])) return true;
    if (isErrorCode(error, ["EPERM", "EBUSY", "EACCES"])) return false;
    throw new Error("upgrade fence claim unlink failed");
  }
}

async function reclaimStaleClaim(path: string, expected: FileIdentity): Promise<boolean> {
  let observed: FileIdentity | undefined;
  try {
    observed = await identity(path);
  } catch (error) {
    if (isErrorCode(error, ["EPERM", "EBUSY", "EACCES"])) return false;
    throw new Error("upgrade fence claim identity unavailable");
  }
  if (!sameIdentity(observed, expected)) return false;
  staleSequence += 1;
  const stalePath = `${path}.stale.${process.pid}.${staleSequence}`;
  try {
    await rename(path, stalePath);
  } catch (error) {
    if (isErrorCode(error, ["ENOENT", "EEXIST", "EPERM", "EBUSY", "EACCES"])) return false;
    throw new Error("upgrade fence claim reclaim failed");
  }
  return unlinkIdentity(stalePath, expected);
}

function strictClaim(value: unknown): WindowsUpgradeFenceClaim | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "fence" || keys[1] !== "port") return undefined;
  if (typeof record.fence !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(record.fence)) {
    return undefined;
  }
  const decodedFence = Buffer.from(record.fence, "base64url");
  if (decodedFence.length !== 16 || decodedFence.toString("base64url") !== record.fence) {
    return undefined;
  }
  if (
    !Number.isInteger(record.port) ||
    (record.port as number) < 1 ||
    (record.port as number) > 65_535
  ) {
    return undefined;
  }
  return { fence: record.fence, port: record.port as number };
}

async function readClaim(path: string): Promise<ClaimRead> {
  let before: FileIdentity | undefined;
  try {
    before = await identity(path);
  } catch {
    return { kind: "unreadable" };
  }
  if (before === undefined) return { kind: "absent" };
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { kind: "unreadable" };
  }
  let after: FileIdentity | undefined;
  try {
    after = await identity(path);
  } catch {
    return { kind: "unreadable" };
  }
  if (!sameIdentity(after, before)) return { kind: "unreadable" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unreadable" };
  }
  const claim = strictClaim(parsed);
  return claim === undefined
    ? { kind: "unreadable" }
    : { kind: "readable", claim, identity: before };
}

function windowsStrictResponse(
  value: unknown,
  expectedFence: string,
): "reserved" | "designated" | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.length === 2 &&
    keys[0] === "fence" &&
    keys[1] === "status" &&
    record.fence === expectedFence &&
    (record.status === "reserved" || record.status === "designated")
    ? record.status
    : undefined;
}

function waitForConnection(socket: Socket, timer: MonotonicTimer): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const deadline = timer.schedule(UPGRADE_FENCE_IO_TIMEOUT_MS, () =>
      finish(new Error("upgrade fence connection timeout")),
    );
    const cleanup = (): void => {
      deadline.cancel();
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onConnect = (): void => finish();
    const onError = (error: Error): void => finish(error);
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

async function requestAdmission(
  claim: WindowsUpgradeFenceClaim,
  request:
    | { readonly kind: "ordinary-starter" }
    | { readonly kind: "designated-successor"; readonly handoffCapability: string },
  timer: MonotonicTimer,
): Promise<ProbeResult> {
  const socket = createConnection({ host: "127.0.0.1", port: claim.port });
  try {
    try {
      await waitForConnection(socket, timer);
    } catch (error) {
      return isErrorCode(error, ["ECONNREFUSED"])
        ? { kind: "connection-refused" }
        : { kind: "other-error" };
    }
    let raw: string;
    try {
      const response = readFrame(socket, timer);
      socket.end(`${JSON.stringify(request)}\n`);
      raw = await response;
    } catch {
      return { kind: "other-error" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { kind: "echo-invalid" };
    }
    const status = windowsStrictResponse(parsed, claim.fence);
    return status === undefined ? { kind: "echo-invalid" } : { kind: "response", status };
  } finally {
    socket.destroy();
  }
}

function createFenceServer(
  fence: string,
  capabilityBytes: Buffer,
  timer: MonotonicTimer,
): { readonly server: Server; readonly sockets: Set<Socket> } {
  let consumed = false;
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("error", () => socket.destroy());
    void readFrame(socket, timer)
      .then((raw) => {
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
            received !== undefined &&
            received.length === capabilityBytes.length &&
            timingSafeEqual(received, capabilityBytes);
          received?.fill(0);
          if (matches) {
            consumed = true;
            status = "designated";
          }
        }
        socket.end(`${JSON.stringify({ fence, status })}\n`);
      })
      .catch(() => socket.end(`${JSON.stringify({ fence, status: "reserved" })}\n`));
  });
  return { server, sockets };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (): void => reject(new Error("upgrade fence listener unavailable"));
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("upgrade fence listener unavailable"));
        return;
      }
      resolve((address as AddressInfo).port);
    });
  });
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

export async function acquireWindowsUpgradeFence(
  input: AcquireUpgradeFenceInput,
): Promise<AcquireUpgradeFenceResult> {
  await ensureConfigDir(input.configDir);
  const claimPath = join(input.configDir, WINDOWS_UPGRADE_FENCE_CLAIM_NAME);
  const timer = input.timer ?? productionTimer();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const capabilityBytes = Buffer.from(
      (input.randomBytes ?? cryptoRandomBytes)(HANDOFF_CAPABILITY_BYTES),
    );
    if (capabilityBytes.length !== HANDOFF_CAPABILITY_BYTES) {
      throw new Error("upgrade fence capability generation failed");
    }
    let retained = false;
    let server: Server | undefined;
    let sockets: Set<Socket> | undefined;
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (server === undefined || sockets === undefined) return Promise.resolve();
      closePromise ??= closeServer(server, sockets);
      return closePromise;
    };
    try {
      const fence = cryptoRandomBytes(16).toString("base64url");
      ({ server, sockets } = createFenceServer(fence, capabilityBytes, timer));
      const port = await listen(server);
      try {
        await writeTempThenPublish(
          claimPath,
          `${JSON.stringify({ fence, port })}\n`,
          (tempPath: string, targetPath: string) => link(tempPath, targetPath),
        );
      } catch (error) {
        await close();
        if (!isErrorCode(error, ["EEXIST"])) {
          throw new Error("upgrade fence claim publication failed");
        }
        const other = await readClaim(claimPath);
        if (other.kind === "absent") continue;
        if (other.kind === "unreadable") return reserved();
        const probe = await requestAdmission(other.claim, { kind: "ordinary-starter" }, timer);
        if (probe.kind === "response") return reserved();
        if (probe.kind !== "connection-refused" && probe.kind !== "echo-invalid") {
          return reserved();
        }
        try {
          if (!(await reclaimStaleClaim(claimPath, other.identity))) return reserved();
        } catch {
          return reserved();
        }
        continue;
      }
      let ownedIdentity: FileIdentity | undefined;
      try {
        ownedIdentity = await identity(claimPath);
      } catch {
        throw new Error("upgrade fence claim identity unavailable");
      }
      if (ownedIdentity === undefined) {
        throw new Error("upgrade fence claim identity unavailable");
      }
      const handoffCapability = capabilityBytes.toString("base64url");
      let releasePromise: Promise<void> | undefined;
      retained = true;
      return {
        status: "acquired",
        handle: {
          socketPath: claimPath,
          handoffCapability,
          release() {
            releasePromise ??= (async () => {
              try {
                await close();
                await unlinkIdentity(claimPath, ownedIdentity);
              } finally {
                capabilityBytes.fill(0);
              }
            })();
            return releasePromise;
          },
        },
      };
    } finally {
      if (!retained) {
        await close();
        capabilityBytes.fill(0);
      }
    }
  }
  return reserved();
}

export async function admitStartupThroughWindowsUpgradeFence(input: {
  readonly configDir: string;
  readonly handoffCapability?: string;
  readonly timer?: MonotonicTimer;
  readonly platform?: NodeJS.Platform;
}): Promise<UpgradeFenceAdmission> {
  await ensureConfigDir(input.configDir);
  const claimPath = join(input.configDir, WINDOWS_UPGRADE_FENCE_CLAIM_NAME);
  const timer = input.timer ?? productionTimer();
  const request =
    input.handoffCapability === undefined
      ? { kind: "ordinary-starter" as const }
      : {
          kind: "designated-successor" as const,
          handoffCapability: input.handoffCapability,
        };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const other = await readClaim(claimPath);
    if (other.kind === "absent") return { status: "clear" };
    if (other.kind === "unreadable") return reserved();
    const probe = await requestAdmission(other.claim, request, timer);
    if (probe.kind === "response") {
      return probe.status === "designated" ? { status: "designated" } : reserved();
    }
    if (probe.kind !== "connection-refused" && probe.kind !== "echo-invalid") {
      return reserved();
    }
    try {
      if (!(await reclaimStaleClaim(claimPath, other.identity))) return reserved();
    } catch {
      return reserved();
    }
  }
  return reserved();
}
