import type { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { TextDecoder } from "node:util";
import { EXIT_DAEMON_UNAVAILABLE } from "@enduragent/coach-contract";

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
  readonly platform?: NodeJS.Platform;
}

export type AcquireUpgradeFenceResult =
  | { readonly status: "acquired"; readonly handle: UpgradeFenceHandle }
  | {
      readonly status: "reserved";
      readonly exitCode: 3;
      readonly message: typeof HANDOFF_RESERVED_MESSAGE;
    };

const decoder = new TextDecoder("utf-8", { fatal: true });

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

export { canonicalCapability, productionTimer, readFrame, reserved, strictRequest, strictResponse };
