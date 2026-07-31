export interface ClockPort {
  /** Wall-clock Unix epoch milliseconds. Never persist this on a content-addressed derived row. */
  now(): number;
  /** Monotonic non-decreasing millisecond counter for timeouts and durations; never persisted. */
  monotonicNow(): number;
}
