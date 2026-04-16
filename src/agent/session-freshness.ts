// ============================================================================
// SESSION FRESHNESS
// ============================================================================

export function resolveDailyResetAtMs(hour: number): number {
  const now = new Date();
  const today = new Date(now);
  today.setHours(hour, 0, 0, 0);

  // If current time is before the reset hour, use yesterday's reset time
  if (now.getTime() < today.getTime()) {
    today.setDate(today.getDate() - 1);
  }

  return today.getTime();
}

export function evaluateSessionFreshness(params: {
  lastMessageTime: string | null;
  dailyResetHour: number;
  idleMinutes: number;
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
  const dailyResetAt = resolveDailyResetAtMs(params.dailyResetHour);
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
