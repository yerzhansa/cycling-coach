// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import { describe, expect, it } from "vitest";
import { formatSyncReply } from "../src/reference/sync/format-sync-reply.js";
import type { SyncResult } from "../src/reference/sync/run-sync.js";

const fixedNow = new Date("2026-05-09T14:23:32Z");

describe("formatSyncReply", () => {
  it("formats a successful sync (US-18 shape) with last sync time and refreshed list", () => {
    const r: SyncResult = {
      kind: "ran",
      lastSyncAt: "2026-05-09T14:23:00Z",
      refreshed: ["latest", "history", "intervals", "routes", "ftp_history"],
    };
    const text = formatSyncReply(r, fixedNow);
    expect(text).toContain("Sync");
    expect(text).toContain("Last sync:");
    expect(text).toContain("Refreshed:");
    expect(text).toContain("latest");
    expect(text).toContain("history");
  });

  it("formats the cooldown skip with a per-second retryAfter countdown", () => {
    const r: SyncResult = {
      kind: "skipped",
      reason: "cooldown",
      retryAfterMs: 18_000,
    };
    const text = formatSyncReply(r, fixedNow);
    expect(text).toContain("Just synced");
    expect(text).toContain("18s");
  });

  it("formats the mutex_held skip as 'sync in progress, please retry shortly'", () => {
    const r: SyncResult = {
      kind: "skipped",
      reason: "mutex_held",
    };
    const text = formatSyncReply(r, fixedNow);
    expect(text.toLowerCase()).toContain("sync in progress");
  });

  it("formats an outer-timeout failure as 'I can't reach intervals.icu'", () => {
    const r: SyncResult = {
      kind: "failed",
      reason: "outer_timeout",
      failures: [],
    };
    const text = formatSyncReply(r, fixedNow);
    expect(text.toLowerCase()).toContain("can't reach intervals.icu");
  });

  it("formats a gate_rejected failure as 'I can't reach intervals.icu' (Wave 5 curator may differentiate)", () => {
    const r: SyncResult = {
      kind: "failed",
      reason: "gate_rejected",
      failures: [{ file: "latest", reason: "ftp_source_check: missing FTP" }],
    };
    const text = formatSyncReply(r, fixedNow);
    expect(text.toLowerCase()).toContain("can't reach intervals.icu");
  });

  it("renders a cooldown skip without retryAfterMs as 'Just synced — please wait 0s'", () => {
    const r: SyncResult = { kind: "skipped", reason: "cooldown" };
    const text = formatSyncReply(r, fixedNow);
    expect(text).toContain("0s");
  });
});
