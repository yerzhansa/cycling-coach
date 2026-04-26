export type ExecSecretRef = { source: "exec"; command: string; args?: string[] };
export type EnvSecretRef = { source: "env"; var: string };
export type SecretRef = ExecSecretRef | EnvSecretRef;

export type SecretResolutionErrorCode =
  | "ENOENT"
  | "EXIT_NONZERO"
  | "TIMEOUT"
  | "EMPTY"
  | "OVERFLOW"
  | "INVALID_REF";

export class SecretResolutionError extends Error {
  readonly code: SecretResolutionErrorCode;
  constructor(code: SecretResolutionErrorCode, message: string) {
    super(message);
    this.name = "SecretResolutionError";
    this.code = code;
  }
}

const ALLOWED_KEYS_EXEC = new Set(["source", "command", "args"]);
const ALLOWED_KEYS_ENV = new Set(["source", "var"]);

export function isSecretRef(value: unknown): value is SecretRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;

  if (obj.source === "exec") {
    for (const key of Object.keys(obj)) {
      if (!ALLOWED_KEYS_EXEC.has(key)) return false;
    }
    if (typeof obj.command !== "string" || obj.command.length === 0) return false;
    if (obj.args !== undefined) {
      if (!Array.isArray(obj.args)) return false;
      for (const a of obj.args) {
        if (typeof a !== "string") return false;
      }
    }
    return true;
  }

  if (obj.source === "env") {
    for (const key of Object.keys(obj)) {
      if (!ALLOWED_KEYS_ENV.has(key)) return false;
    }
    if (typeof obj.var !== "string" || obj.var.length === 0) return false;
    return true;
  }

  return false;
}
