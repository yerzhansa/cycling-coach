import { isNativeError, isProxy } from "node:util/types";

export const REDACTION_SENTINEL = "[redacted]";

const DENYLIST_KEY_SUBSTRINGS = [
  "authorization",
  "api_key",
  "api-key",
  "apikey",
  "token",
  "cookie",
  "password",
  "secret",
];
const DROP_FIELDS = new Set(["requestBodyValues", "responseBody", "payload", "body", "data"]);
const FREE_TEXT_FIELD = /(?:message|stack|url|uri)$/i;
const ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "AggregateError",
  "AbortError",
  "APICallError",
  "SecretResolutionError",
]);
const ERROR_CODES = new Set([
  "ENOENT", "EACCES", "EPERM", "EEXIST", "EROFS", "ENOSPC", "EIO", "EINVAL", "ENOTDIR",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ABORT_ERR",
  "EMPTY", "EXIT_NONZERO", "TIMEOUT", "OVERFLOW",
]);
const MAX_REDACT_DEPTH = 6;

export function keyIsDenied(key: string): boolean {
  const lower = key.toLowerCase();
  return DENYLIST_KEY_SUBSTRINGS.some((needle) => lower.includes(needle));
}

function redactText(value: string): string {
  return value
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, REDACTION_SENTINEL)
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, REDACTION_SENTINEL)
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[a-z\d_-]+/gi, REDACTION_SENTINEL);
}

export function redactObject(value: unknown): unknown {
  try {
    return redactAt(value, 0, new WeakSet<object>());
  } catch {
    return REDACTION_SENTINEL;
  }
}

function redactAt(value: unknown, depth: number, seen: WeakSet<object>, errorText = false): unknown {
  if (typeof value === "string") return errorText ? REDACTION_SENTINEL : redactText(value);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : REDACTION_SENTINEL;
  if (typeof value !== "object") return REDACTION_SENTINEL;
  if (isProxy(value) || depth >= MAX_REDACT_DEPTH || seen.has(value)) return REDACTION_SENTINEL;
  seen.add(value);

  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let index = 0; index < Math.min(value.length, 64); index++) {
      const descriptor = descriptors[String(index)];
      out.push(
        descriptor && "value" in descriptor
          ? redactAt(descriptor.value, depth + 1, seen, errorText)
          : REDACTION_SENTINEL,
      );
    }
    if (value.length > 64) out.push(REDACTION_SENTINEL);
    return out;
  }

  const out: Record<string, unknown> = Object.create(null);
  const isError = isNativeError(value);
  if (isError) {
    const prototype = Object.getPrototypeOf(value);
    const name = descriptors.name ?? (prototype !== null && !isProxy(prototype)
      ? Object.getOwnPropertyDescriptor(prototype, "name") : undefined);
    out.name = name && "value" in name && ERROR_NAMES.has(name.value) ? name.value : "Error";
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (DROP_FIELDS.has(key) || key === "toJSON") continue;
    if (!descriptor.enumerable && !(isError && ["name", "code", "statusCode"].includes(key)))
      continue;
    if (isError && key === "name") continue;
    if (isError && key === "code" && "value" in descriptor && ERROR_CODES.has(descriptor.value)) {
      out.code = descriptor.value;
      continue;
    }
    out[key] =
      keyIsDenied(key) ||
      FREE_TEXT_FIELD.test(key) ||
      (key === "err" && !isNativeError(descriptor.value)) ||
      !("value" in descriptor)
        ? REDACTION_SENTINEL
        : redactAt(descriptor.value, depth + 1, seen, errorText || isError);
  }
  return out;
}
