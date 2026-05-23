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

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}
