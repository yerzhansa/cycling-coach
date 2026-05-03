import { todayInTZ } from "./user-time.js";

// ============================================================================
// SESSION FRESHNESS
// ============================================================================

/**
 * Compute the most recent occurrence of `hour:00` in the athlete's TZ as a
 * UTC ms timestamp. If the current moment is before today's reset hour
 * (athlete-local), returns yesterday's reset hour. DST transition may shift
 * by ~1h on the changeover day — acceptable for daily-reset semantics.
 */
export function resolveDailyResetAtMs(hour: number, tz: string = "UTC"): number {
  const now = new Date();
  const todayResetMs = resetHourMs(tz, hour, now);
  if (now.getTime() < todayResetMs) {
    return resetHourMs(tz, hour, new Date(todayResetMs - 86_400_000));
  }
  return todayResetMs;
}

function resetHourMs(tz: string, hour: number, anchor: Date): number {
  const ymd = todayInTZ(tz, anchor);
  const [y, m, d] = ymd.split("-").map(Number);
  // Treat the wall-clock {y, m, d, hour, 0, 0} in tz as if it were UTC, then
  // subtract the TZ offset at that moment to get the true UTC ms.
  const naive = Date.UTC(y, m - 1, d, hour, 0, 0);
  return naive - tzOffsetMs(tz, new Date(naive));
}

function tzOffsetMs(tz: string, when: Date): number {
  const parts: Record<string, string> = {};
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  for (const p of dtf.formatToParts(when)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  const asUTC = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour % 24,
    +parts.minute,
    +parts.second,
  );
  return asUTC - when.getTime();
}

export function evaluateSessionFreshness(params: {
  lastMessageTime: string | null;
  dailyResetHour: number;
  idleMinutes: number;
  tz?: string;
}): { fresh: boolean; reason?: "daily" | "idle" } {
  // No history = fresh (new session)
  if (!params.lastMessageTime) {
    return { fresh: true };
  }

  const updatedAt = new Date(params.lastMessageTime).getTime();
  if (Number.isNaN(updatedAt)) {
    return { fresh: false, reason: "daily" };
  }
  const now = Date.now();

  // Daily: stale if last message before most recent reset hour
  const dailyResetAt = resolveDailyResetAtMs(params.dailyResetHour, params.tz);
  if (updatedAt < dailyResetAt) {
    return { fresh: false, reason: "daily" };
  }

  // Idle: stale if idle timeout exceeded (only when enabled)
  if (params.idleMinutes > 0) {
    const idleExpiresAt = updatedAt + params.idleMinutes * 60_000;
    if (now > idleExpiresAt) {
      return { fresh: false, reason: "idle" };
    }
  }

  return { fresh: true };
}
