import { spawn, type ChildProcess } from "node:child_process";

export const KEYCHAIN_HELPER_OPERATIONS = [
  "probe",
  "read-key",
  "create-key",
  "delete-key",
] as const;

export const KEYCHAIN_HELPER_ERROR_CODES = [
  "not-team-signed",
  "item-not-found",
  "keychain-locked",
  "duplicate-item",
  "unreadable-item",
  "unknown",
] as const;

export type KeychainHelperOperation = (typeof KEYCHAIN_HELPER_OPERATIONS)[number];
export type KeychainHelperErrorCode = (typeof KEYCHAIN_HELPER_ERROR_CODES)[number];

export const KEYCHAIN_CREDENTIAL_SERVICE = "icu.enduragent.desktop" as const;
export const KEYCHAIN_CREDENTIAL_SERVICE_DEV = "icu.enduragent.desktop.dev" as const;
export const KEYCHAIN_CREDENTIAL_ACCOUNT = "credential-encryption-key-v1" as const;
export const KEYCHAIN_TEAM_IDENTIFIER = "FA494ACVTF" as const;
export const KEYCHAIN_KEY_BYTES = 32;

export const KEYCHAIN_HELPER_DEADLINE_MS = 5_000;
export const KEYCHAIN_HELPER_MAX_RESPONSE_BYTES = 8_192;

export interface KeychainHelperRequest {
  readonly op: KeychainHelperOperation;
  readonly service: string;
}

export type KeychainHelperResponse =
  | {
      readonly ok: true;
      readonly op: "probe";
      readonly teamIdentifier: string;
    }
  | {
      readonly ok: true;
      readonly op: "read-key" | "create-key";
      readonly key: string;
    }
  | {
      readonly ok: true;
      readonly op: "delete-key";
      readonly deleted: boolean;
    }
  | {
      readonly ok: false;
      readonly code: KeychainHelperErrorCode;
    };

export interface KeychainHelperTransport {
  send(request: KeychainHelperRequest): Promise<KeychainHelperResponse>;
}

export type KeychainHelperSpawn = (command: string, args: readonly string[]) => ChildProcess;

export interface KeychainHelperTransportOptions {
  readonly helperPath: string;
  readonly deadlineMs?: number;
  readonly maxResponseBytes?: number;
  readonly spawnHelper?: KeychainHelperSpawn;
}

const UNKNOWN_RESPONSE: KeychainHelperResponse = { ok: false, code: "unknown" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorCode(value: unknown): value is KeychainHelperErrorCode {
  return (
    typeof value === "string" && (KEYCHAIN_HELPER_ERROR_CODES as readonly string[]).includes(value)
  );
}

function decodedKeyBytes(value: unknown): number {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return -1;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded.length : -1;
}

export function parseKeychainHelperResponse(line: string): KeychainHelperResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return UNKNOWN_RESPONSE;
  }
  if (!isRecord(parsed)) return UNKNOWN_RESPONSE;
  if (parsed.ok === false) {
    return isErrorCode(parsed.code) ? { ok: false, code: parsed.code } : UNKNOWN_RESPONSE;
  }
  if (parsed.ok !== true) return UNKNOWN_RESPONSE;
  if (parsed.op === "probe") {
    return typeof parsed.teamIdentifier === "string"
      ? { ok: true, op: "probe", teamIdentifier: parsed.teamIdentifier }
      : UNKNOWN_RESPONSE;
  }
  if (parsed.op === "read-key" || parsed.op === "create-key") {
    return decodedKeyBytes(parsed.key) === KEYCHAIN_KEY_BYTES
      ? { ok: true, op: parsed.op, key: parsed.key as string }
      : UNKNOWN_RESPONSE;
  }
  if (parsed.op === "delete-key") {
    return typeof parsed.deleted === "boolean"
      ? { ok: true, op: "delete-key", deleted: parsed.deleted }
      : UNKNOWN_RESPONSE;
  }
  return UNKNOWN_RESPONSE;
}

export function createKeychainHelperTransport(
  options: KeychainHelperTransportOptions,
): KeychainHelperTransport {
  const deadlineMs = options.deadlineMs ?? KEYCHAIN_HELPER_DEADLINE_MS;
  const maxResponseBytes = options.maxResponseBytes ?? KEYCHAIN_HELPER_MAX_RESPONSE_BYTES;
  const spawnHelper =
    options.spawnHelper ??
    ((command, args) => spawn(command, [...args], { stdio: ["pipe", "pipe", "ignore"] }));
  return {
    send(request: KeychainHelperRequest): Promise<KeychainHelperResponse> {
      return new Promise<KeychainHelperResponse>((resolve) => {
        let child: ChildProcess;
        try {
          child = spawnHelper(options.helperPath, []);
        } catch {
          resolve(UNKNOWN_RESPONSE);
          return;
        }
        let settled = false;
        let received = "";
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (response: KeychainHelperResponse): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          try {
            child.kill("SIGKILL");
          } catch {}
          resolve(response);
        };
        timer = setTimeout(() => finish(UNKNOWN_RESPONSE), deadlineMs);
        timer.unref?.();
        child.once("error", () => finish(UNKNOWN_RESPONSE));
        child.once("close", () => {
          const newline = received.indexOf("\n");
          finish(parseKeychainHelperResponse(newline < 0 ? received : received.slice(0, newline)));
        });
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          received += chunk;
          if (Buffer.byteLength(received, "utf8") > maxResponseBytes) {
            finish(UNKNOWN_RESPONSE);
            return;
          }
          const newline = received.indexOf("\n");
          if (newline >= 0) finish(parseKeychainHelperResponse(received.slice(0, newline)));
        });
        child.stdin?.on("error", () => {});
        child.stdin?.end(`${JSON.stringify(request)}\n`);
      });
    },
  };
}
