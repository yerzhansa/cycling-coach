// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import { describe, expect, it } from "vitest";
import { formatSyncReply } from "../src/reference/sync/format-sync-reply.js";
import type { SyncResult } from "../src/reference/sync/run-sync.js";

const fixedNow = new Date("2026-05-09T14:23:32Z");

describe("formatSyncReply", () => {
  it("formats a successful sync (US-18 shape) with last sync time, refreshed list, and no failures", () => {
    const r: SyncResult = {
      ok: true,
      lastSyncAt: "2026-05-09T14:23:00Z",
      refreshed: ["latest", "history", "intervals", "routes", "ftp_history"],
      failures: [],
    };
    const text = formatSyncReply(r, fixedNow);
    expect(text).toContain("Sync");
    expect(text).toContain("Last sync:");
    expect(text).toContain("Refreshed:");
    expect(text).toContain("latest");
    expect(text).toContain("history");
    expect(text).not.toContain("Failures");
  });

  it("includes a Failures line when at least one file failed", () => {
    const r: SyncResult = {
      ok: true,
      lastSyncAt: "2026-05-09T14:23:00Z",
      refreshed: ["latest", "history", "intervals"],
      failures: [{ file: "routes", reason: "intervals.icu_503" }],
    };
    const text = formatSyncReply(r, fixedNow);
    expect(text).toContain("Refreshed:");
    expect(text).toContain("Failures:");
    expect(text).toContain("routes");
    expect(text).toContain("intervals.icu_503");
  });

  it("formats the cooldown skip with a per-second retryAfter countdown", () => {
    const r: SyncResult = {
      ok: true,
      refreshed: [],
      failures: [],
      skipped: "cooldown",
      retryAfterMs: 18_000,
    };
    const text = formatSyncReply(r, fixedNow);
    expect(text).toContain("Just synced");
    expect(text).toContain("18s");
  });

  it("formats the mutex_held skip as 'sync in progress, please retry shortly'", () => {
    const r: SyncResult = {
      ok: true,
      refreshed: [],
      failures: [],
      skipped: "mutex_held",
    };
    const text = formatSyncReply(r, fixedNow);
    expect(text.toLowerCase()).toContain("sync in progress");
  });

  it("formats an outer-timeout failure as 'I can't reach intervals.icu' with last good sync if known", () => {
    const r: SyncResult = {
      ok: false,
      lastSyncAt: "2026-05-09T13:45:00Z",
      refreshed: [],
      failures: [],
    };
    const text = formatSyncReply(r, fixedNow);
    expect(text.toLowerCase()).toContain("can't reach intervals.icu");
    expect(text).toContain("Last good sync:");
  });
});
