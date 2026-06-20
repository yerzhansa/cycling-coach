import { redactObject, REDACTION_SENTINEL } from "./redact.js";

// Fields on a provider/SDK error that carry the outbound prompt or response
// body — the conversation, the memory-bearing system prompt, the athlete's
// reply text. They are NEVER copied onto the serialized output; this is what
// makes the log file born redacted rather than redacted by a later follow-up.
const DROP_FIELDS = new Set([
  "requestBodyValues",
  "responseBody",
  "payload",
  "body",
  "data",
]);

// Provider/SDK error fields that are safe to keep for diagnosis.
const KEEP_FIELDS = ["statusCode", "url", "provider"] as const;

const MAX_STACK_CHARS = 1000;

function trimStack(stack: unknown): string | undefined {
  if (typeof stack !== "string") return undefined;
  return stack.length > MAX_STACK_CHARS ? stack.slice(0, MAX_STACK_CHARS) : stack;
}

export function serializeError(err: unknown): Record<string, unknown> {
  // Never throw: a circular or exotic error must yield a sentinel object, not
  // crash the logger and so break a chat turn, a sync tick, or startup.
  try {
    if (!(err instanceof Error)) {
      return { value: String(err) };
    }

    const out: Record<string, unknown> = {
      name: err.name,
      message: err.message,
    };

    const stack = trimStack(err.stack);
    if (stack !== undefined) out.stack = stack;

    const record = err as unknown as Record<string, unknown>;
    for (const field of KEEP_FIELDS) {
      const v = record[field];
      if (v !== undefined) out[field] = v;
    }

    // Surviving own-enumerable fields (not the dropped payload class) are run
    // through the recursive key denylist so a nested authorization/token/cookie
    // never lands in the file.
    for (const [key, value] of Object.entries(record)) {
      if (DROP_FIELDS.has(key)) continue;
      if (key === "name" || key === "message" || key === "stack") continue;
      if ((KEEP_FIELDS as readonly string[]).includes(key)) continue;
      const lower = key.toLowerCase();
      if (
        lower.includes("authorization") ||
        lower.includes("api_key") ||
        lower.includes("apikey") ||
        lower.includes("token") ||
        lower.includes("cookie")
      ) {
        out[key] = REDACTION_SENTINEL;
        continue;
      }
      out[key] = redactObject(value);
    }

    return out;
  } catch {
    return { name: "UnserializableError" };
  }
}
