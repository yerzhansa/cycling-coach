import FakeTimers from "@sinonjs/fake-timers";

// Synthetic epoch: one full Gregorian cycle back (same weekday and leap
// structure), so no committed fixture ever carries a current-era date.
export const FROZEN_NOW = "1998-07-06T09:00:00.000Z";
export const FROZEN_NOW_MS = Date.parse(FROZEN_NOW);

// Date ONLY — timers stay real: the fetch stack, AbortSignal.timeout, and the
// summarization race all need live timers to make progress.
export function installFrozenClock(nowIso: string = FROZEN_NOW) {
  return FakeTimers.install({ now: Date.parse(nowIso), toFake: ["Date"] });
}
