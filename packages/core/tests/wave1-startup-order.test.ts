// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Wave-1 init-order acceptance test (F5 / PRD Decision 13 / ADR-0011).
 *
 * The 7-step init sequence in `run-binary.ts` is load-bearing:
 *   1. Construct Memory (via `new CoachAgent`).
 *   2. Run startup hook (binary-specific; cycling-coach migrates legacy sections).
 *   3. Construct Reference services — `new AsyncMutex`, `createRunSync`,
 *      `new Scheduler` — without registering any timer (two-phase scheduler).
 *   4. Await first `runSync({ caller: "scheduled" })`. Best-effort; failure logs.
 *   5. Lazy `Person.units` bootstrap (no-op in Wave 1; site exists for Wave 6).
 *   5b. `scheduler.start()` — registers periodic timer using now-current
 *       `.scheduler.json` (which step 4 just rewrote on success).
 *   6. Open Telegram channel (or CLI loop).
 *
 * Reordering ANY of these is a correctness regression — the cold-start
 * tick-vs-first-sync race re-emerges, half-migrated memory becomes
 * observable, etc. This test pins the order at the source-text level so a
 * reorder PR fails CI before reviewers have to spot it.
 */
describe("run-binary 7-step init sequence (Wave 1b acceptance)", () => {
  const SOURCE_PATH = join(__dirname, "..", "src", "run-binary.ts");
  const src = readFileSync(SOURCE_PATH, "utf-8");

  // Anchor on substrings unique to each step. Each must exist exactly once.
  const STEPS: ReadonlyArray<readonly [string, string]> = [
    ["1: Memory (CoachAgent constructor)", "new CoachAgent("],
    ["2: Startup hook", "await runStartupHook("],
    ["3a: Reference mutex constructed", "const refMutex = new AsyncMutex()"],
    ["3b: createRunSync factory", "const runSync = createRunSync("],
    ["3c: Scheduler constructed (NO timer registered)", "const scheduler = new Scheduler("],
    ["4: First runSync awaited", 'await runSync({ caller: "scheduled" })'],
    ["5b: scheduler.start() AFTER first runSync", "scheduler.start();"],
    ["6: Telegram bot constructed", "createTelegramBot("],
  ];

  it("each anchor appears exactly once in run-binary.ts source", () => {
    for (const [label, anchor] of STEPS) {
      const matches = countOccurrences(src, anchor);
      expect.soft(matches, `${label} — anchor "${anchor}" should appear exactly once`).toBe(1);
    }
  });

  it("anchors appear in the order specified by Decision 13 + ADR-0011", () => {
    const positions = STEPS.map(([label, anchor]) => {
      const idx = src.indexOf(anchor);
      expect.soft(idx, `${label} — anchor "${anchor}" must be present`).toBeGreaterThanOrEqual(0);
      return { label, idx };
    });

    for (let i = 1; i < positions.length; i++) {
      const prev = positions[i - 1];
      const curr = positions[i];
      expect
        .soft(
          curr.idx,
          `${curr.label} must come AFTER ${prev.label} (got ${curr.idx} vs ${prev.idx})`,
        )
        .toBeGreaterThan(prev.idx);
    }
  });

  it("Reference services are NOT constructed before runStartupHook (memory-migration must precede)", () => {
    const startupHookIdx = src.indexOf("await runStartupHook(");
    const mutexIdx = src.indexOf("new AsyncMutex()");
    expect(startupHookIdx).toBeGreaterThan(0);
    expect(mutexIdx).toBeGreaterThan(0);
    expect(mutexIdx).toBeGreaterThan(startupHookIdx);
  });

  it("scheduler.start() is NOT called before the first runSync resolves (two-phase scheduler per ADR-0011)", () => {
    const firstSyncIdx = src.indexOf('await runSync({ caller: "scheduled" })');
    const schedulerStartIdx = src.indexOf("scheduler.start();");
    expect(firstSyncIdx).toBeGreaterThan(0);
    expect(schedulerStartIdx).toBeGreaterThan(0);
    expect(schedulerStartIdx).toBeGreaterThan(firstSyncIdx);
  });

  it("Telegram bot is opened LAST — after every Reference step", () => {
    const createTelegramIdx = src.indexOf("createTelegramBot(");
    const schedulerStartIdx = src.indexOf("scheduler.start();");
    expect(createTelegramIdx).toBeGreaterThan(0);
    expect(createTelegramIdx).toBeGreaterThan(schedulerStartIdx);
  });

  it("first runSync is wrapped in try/catch so its failure does NOT crash the binary (best-effort init)", () => {
    // The pattern is: try { await runSync(...) } catch { console.warn(...) }
    const tryIdx = src.indexOf("try {\n    await runSync(");
    const catchIdx = src.indexOf("} catch (err) {", tryIdx);
    expect(tryIdx).toBeGreaterThan(0);
    expect(catchIdx).toBeGreaterThan(tryIdx);
  });
});

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}
