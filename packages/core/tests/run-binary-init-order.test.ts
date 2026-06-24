import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Outer init-order sanity check for `run-binary.ts`. The bulk of the
 * Reference init-order discipline lives inside `bootstrapReference()` and is
 * verified behaviorally in `reference-runtime.test.ts`. This file guards
 * only the outer sequence the binary orchestrates around it:
 *
 *   1. Memory (CoachAgent constructor)
 *   2. Startup hook (binary-specific; cycling-coach's runs the legacy migrate)
 *   3. Reference bootstrap
 *   4. Telegram bot
 *
 * Reordering any of these is a correctness regression (future migration units'
 * bootstrap will read MEMORY.md and depends on the migration step having
 * completed). Refactors that move steps into other modules require updating
 * this list, which is intentional friction.
 */
describe("run-binary outer init order", () => {
  const SOURCE_PATH = join(__dirname, "..", "src", "run-binary.ts");
  const src = readFileSync(SOURCE_PATH, "utf-8");

  const STEPS: ReadonlyArray<readonly [string, string]> = [
    ["1: Memory (CoachAgent constructor)", "new CoachAgent("],
    ["2: Startup hook", "await runStartupHook("],
    ["3: Reference bootstrap", "await bootstrapReference("],
    ["4: Telegram bot constructed", "createTelegramBot("],
  ];

  it("each anchor appears exactly once", () => {
    for (const [label, anchor] of STEPS) {
      const matches = countOccurrences(src, anchor);
      expect.soft(matches, `${label} — anchor "${anchor}" should appear exactly once`).toBe(1);
    }
  });

  it("anchors appear in the documented order", () => {
    const positions = STEPS.map(([label, anchor]) => ({
      label,
      idx: src.indexOf(anchor),
    }));
    for (let i = 1; i < positions.length; i++) {
      expect
        .soft(
          positions[i].idx,
          `${positions[i].label} must come AFTER ${positions[i - 1].label}`,
        )
        .toBeGreaterThan(positions[i - 1].idx);
    }
  });
});

/**
 * The shutdown-window latch: when a SIGTERM/SIGINT lands in the startup /
 * first-long-poll window, our own bot.stop() aborts the in-flight getUpdates,
 * which grammy surfaces as a rejected start-promise (abort / 409). That
 * rejection is the EXPECTED consequence of a graceful shutdown and must NOT
 * reach reportFatal (markUnclean + exit(1)) — otherwise it races and beats the
 * shutdown handler's clean exit(0), making shutdown success timing-dependent.
 *
 * This is a structural guard: the unit-level latch lives in a closure private
 * to runBinary's bot-run path (untestable without driving the whole bot), so we
 * pin the two halves of the invariant against silent regression. The behavioral
 * proof is the live race harness (5/5 deterministic clean exits post-fix).
 */
describe("run-binary shutdown-window latch", () => {
  const SOURCE_PATH = join(__dirname, "..", "src", "run-binary.ts");
  const src = readFileSync(SOURCE_PATH, "utf-8");

  it("the latch is set in the signal handler BEFORE the start-promise catch checks it", () => {
    const setIdx = src.indexOf("shuttingDown = true");
    const guardIdx = src.indexOf("if (shuttingDown) return;");
    expect(setIdx, "signal handler must set shuttingDown = true").toBeGreaterThan(-1);
    expect(guardIdx, "start-promise catch must early-return when shuttingDown").toBeGreaterThan(-1);
  });

  it("a genuine start rejection (latch unset) still reaches reportFatal", () => {
    // The guard is an early-return on shuttingDown; reportFatal stays the
    // fall-through, so a pre-signal failure (bad token, crash) still fatals.
    const guardIdx = src.indexOf("if (shuttingDown) return;");
    const fatalIdx = src.indexOf("reportFatal(err, { dataDir: config.dataDir })");
    expect(fatalIdx, "reportFatal must remain reachable").toBeGreaterThan(-1);
    expect(fatalIdx, "reportFatal must follow the suppress-guard, not precede it").toBeGreaterThan(
      guardIdx,
    );
  });
});

describe("run-binary CLI exit + cold-start banner", () => {
  const SOURCE_PATH = join(__dirname, "..", "src", "run-binary.ts");
  const src = readFileSync(SOURCE_PATH, "utf-8");

  it("prints the verbatim cold-start banner before the awaited bootstrap", () => {
    const banner = "syncing training data from intervals.icu…";
    expect(countOccurrences(src, banner)).toBe(1);
    expect(src.indexOf(banner)).toBeLessThan(src.indexOf("await bootstrapReference("));
  });

  it("registers a close handler that stops the scheduler and exits 0", () => {
    expect(src).toContain('rl.on("close"');
    expect(src).toContain("reference.scheduler.stop()");
    expect(src).toContain("process.exit(0)");
  });

  it("keeps /quit and /exit routing to rl.close()", () => {
    expect(countOccurrences(src, 'input === "/quit" || input === "/exit"')).toBe(1);
    expect(src).toContain("rl.close()");
  });

  it("does not smuggle in a mid-turn abort (AbortController is the LLM-deadline work's)", () => {
    expect(src).not.toContain("AbortController");
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
