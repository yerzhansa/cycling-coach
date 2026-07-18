import { randomUUID } from "node:crypto";
import type { CoachCliSessionSelection } from "./args.js";

export const DEFAULT_CLI_SESSION_KEY = "cli:default" as const;

export type ResolvedCoachCliSession =
  | { readonly kind: "default"; readonly chatId: "cli:default" }
  | { readonly kind: "named"; readonly chatId: string }
  | { readonly kind: "fresh"; readonly chatId: string };

export class InvalidCoachCliSessionError extends Error {
  readonly kind = "invalid-named-session" as const;

  constructor() {
    super("Invalid CLI session key");
    this.name = "InvalidCoachCliSessionError";
  }
}

export class CoachCliSessionStartError extends Error {
  readonly kind = "fresh-session-start-failed" as const;

  constructor() {
    super("CLI session start failed");
    this.name = "CoachCliSessionStartError";
  }
}

export function normalizeNamedSessionKey(raw: string): string {
  const normalized = raw.trim().normalize("NFC");
  if (
    normalized.length < 1 ||
    normalized.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)
  ) {
    throw new InvalidCoachCliSessionError();
  }
  return `cli:${normalized}`;
}

export function resolveCoachCliSession(
  selection: CoachCliSessionSelection,
  createFreshId: () => string = randomUUID,
): ResolvedCoachCliSession {
  if (selection.kind === "default") {
    return { kind: "default", chatId: DEFAULT_CLI_SESSION_KEY };
  }
  if (selection.kind === "named") {
    return { kind: "named", chatId: normalizeNamedSessionKey(selection.key) };
  }
  let id: string;
  try {
    id = createFreshId();
  } catch {
    throw new CoachCliSessionStartError();
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw new CoachCliSessionStartError();
  }
  return { kind: "fresh", chatId: `cli:fresh:${id}` };
}
