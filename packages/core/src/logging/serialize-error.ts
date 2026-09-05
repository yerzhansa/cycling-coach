import { isNativeError, isProxy } from "node:util/types";
import { redactObject } from "./redact.js";

export function serializeError(err: unknown): Record<string, unknown> {
  try {
    if (isProxy(err)) return { name: "UnserializableError" };
    if (!isNativeError(err)) return { name: "NonError" };
    const out = redactObject(err);
    if (out !== null && typeof out === "object" && !Array.isArray(out)) {
      return { ...out };
    }
    return { name: "UnserializableError" };
  } catch {
    return { name: "UnserializableError" };
  }
}
