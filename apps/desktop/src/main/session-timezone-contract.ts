export type SessionTimezoneMode = "follow" | "fixed";

export type DesktopSessionTimezoneNotice =
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "reconcile"; stored: string; host: string }>;

export type DesktopSessionTimezoneSetting =
  | Readonly<{ status: "unavailable" }>
  | Readonly<{ status: "environment-managed"; timezone: string }>
  | Readonly<{ status: "editable"; mode: SessionTimezoneMode | null; host: string | null }>;

export const NO_SESSION_TIMEZONE_NOTICE: DesktopSessionTimezoneNotice = Object.freeze({
  status: "none",
});

export const UNAVAILABLE_SESSION_TIMEZONE_SETTING: DesktopSessionTimezoneSetting = Object.freeze({
  status: "unavailable",
});

export const SESSION_TIMEZONE_MODE_FILE_NAME = "session-timezone-mode.json" as const;

export function parseSessionTimezoneMode(value: unknown): SessionTimezoneMode | undefined {
  return value === "follow" || value === "fixed" ? value : undefined;
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

export function parseSessionTimezoneSetting(value: unknown): DesktopSessionTimezoneSetting {
  if (typeof value !== "object" || value === null) return UNAVAILABLE_SESSION_TIMEZONE_SETTING;
  const candidate = value as Record<string, unknown>;
  if (candidate.status === "environment-managed") {
    const timezone = candidate.timezone;
    if (typeof timezone !== "string" || timezone.length === 0) {
      return UNAVAILABLE_SESSION_TIMEZONE_SETTING;
    }
    return { status: "environment-managed", timezone };
  }
  if (candidate.status !== "editable") return UNAVAILABLE_SESSION_TIMEZONE_SETTING;
  const host = candidate.host;
  if (host !== null && (typeof host !== "string" || host.length === 0)) {
    return UNAVAILABLE_SESSION_TIMEZONE_SETTING;
  }
  const mode = candidate.mode === null ? null : parseSessionTimezoneMode(candidate.mode);
  if (mode === undefined) return UNAVAILABLE_SESSION_TIMEZONE_SETTING;
  return { status: "editable", mode, host };
}
