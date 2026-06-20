export const REDACTION_SENTINEL = "[redacted]";

// Substring, case-insensitive: a key like `x-api-key` or `Authorization` matches.
const DENYLIST_KEY_SUBSTRINGS = ["authorization", "api_key", "apikey", "token", "cookie"];

// Bounded so a hostile or cyclic object can never hang the logger.
const MAX_REDACT_DEPTH = 6;

function keyIsDenied(key: string): boolean {
  const lower = key.toLowerCase();
  return DENYLIST_KEY_SUBSTRINGS.some((needle) => lower.includes(needle));
}

// Walks an object/array, replacing the value of any denylisted key with a
// sentinel (kept, not deleted, so the shape stays legible). Cycles are tracked
// via a seen-set and depth is capped; both yield a sentinel rather than recurse
// forever. Primitives pass through untouched — the key denylist is the contract,
// not a value-shape scanner.
export function redactObject(value: unknown): unknown {
  return redactAt(value, 0, new WeakSet<object>());
}

function redactAt(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_REDACT_DEPTH) return REDACTION_SENTINEL;
  if (seen.has(value)) return REDACTION_SENTINEL;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactAt(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = keyIsDenied(key) ? REDACTION_SENTINEL : redactAt(child, depth + 1, seen);
  }
  return out;
}
