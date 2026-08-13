export type SessionTimezoneSource = "auto" | "user";

export type DesktopSessionTimezoneNotice =
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "reconcile"; stored: string; host: string }>;

export const NO_SESSION_TIMEZONE_NOTICE: DesktopSessionTimezoneNotice = Object.freeze({
  status: "none",
});

export const SESSION_TIMEZONE_SOURCE_FILE_NAME = "session-timezone-source.json" as const;

export function parseSessionTimezoneSource(value: unknown): SessionTimezoneSource | undefined {
  return value === "auto" || value === "user" ? value : undefined;
}

export function parseSessionTimezoneNotice(value: unknown): DesktopSessionTimezoneNotice {
  if (typeof value !== "object" || value === null) return NO_SESSION_TIMEZONE_NOTICE;
  const candidate = value as Record<string, unknown>;
  if (candidate.status !== "reconcile") return NO_SESSION_TIMEZONE_NOTICE;
  const stored = candidate.stored;
  const host = candidate.host;
  if (typeof stored !== "string" || typeof host !== "string") return NO_SESSION_TIMEZONE_NOTICE;
  if (stored.length === 0 || host.length === 0) return NO_SESSION_TIMEZONE_NOTICE;
  return { status: "reconcile", stored, host };
}
