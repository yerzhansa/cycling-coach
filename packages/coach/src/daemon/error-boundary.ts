import { REDACTION_SENTINEL, redactObject, serializeError } from "@enduragent/core";
import { JsonValueSchema, type JsonValue } from "@enduragent/coach-contract";

export type BoundaryErrorPayload = Readonly<Record<string, JsonValue>>;

const BOUNDARY_FREE_TEXT_FIELDS = new Set(["message", "stack", "value", "url", "provider"]);

function suppressBoundaryFreeText(value: unknown): JsonValue {
  if (value === REDACTION_SENTINEL) return REDACTION_SENTINEL;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : REDACTION_SENTINEL;
  }
  if (typeof value === "string") return REDACTION_SENTINEL;
  if (Array.isArray(value)) return value.map(suppressBoundaryFreeText);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, suppressBoundaryFreeText(child)]),
    );
  }
  return REDACTION_SENTINEL;
}

export function serializeBoundaryError(error: unknown): BoundaryErrorPayload {
  try {
    const serialized = serializeError(error);
    const diagnostics: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(serialized)) {
      if (key === "name" || BOUNDARY_FREE_TEXT_FIELDS.has(key)) continue;
      diagnostics[key] = value;
    }
    const redacted = suppressBoundaryFreeText(redactObject(diagnostics));
    const name =
      serialized.name === "UnserializableError"
        ? "UnserializableError"
        : error instanceof Error
          ? "Error"
          : "NonError";
    return JsonValueSchema.parse({
      name,
      ...(redacted as Record<string, JsonValue>),
    }) as BoundaryErrorPayload;
  } catch {
    return { name: "UnserializableError" };
  }
}
