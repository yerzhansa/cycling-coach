import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { METRIC_REGISTRY } from "./registry.js";

// Inverse coverage. The parity gate warns when a snapshot on disk has no
// METRIC_REGISTRY entry, but nothing asserts the other direction — that every
// compute* function shipped in a metric module is actually wired into the
// registry. Without this, a contributor can port a metric, forget to register
// it, and still ship green CI: the new metric is simply never checked.
//
// Discovery is filesystem-driven (the same readdirSync(METRICS_DIR) walk as
// tests/reference-strict-schemas.test.ts) so a NEW metric module —
// capability.ts, compliance.ts, … — is picked up automatically. A hardcoded
// module list would silently exempt the next file added, recreating the very
// gap this test exists to close.
const METRICS_DIR = dirname(fileURLToPath(import.meta.url));
const COMPUTE_EXPORT_RE = /^export\s+(?:async\s+)?(?:function|const)\s+(compute[A-Z][A-Za-z0-9_]*)\b/gm;

function exportedComputeFns(): Array<readonly [string, string]> {
  const found: Array<readonly [string, string]> = [];
  for (const entry of readdirSync(METRICS_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name === "index.ts") continue;
    if (entry.name.endsWith(".test.ts")) continue;
    const source = readFileSync(resolve(METRICS_DIR, entry.name), "utf-8");
    for (const match of source.matchAll(COMPUTE_EXPORT_RE)) {
      found.push([entry.name, match[1]]);
    }
  }
  return found;
}

describe("METRIC_REGISTRY inverse coverage", () => {
  it("registers every compute* function exported from a metric module", () => {
    // Each registry entry holds the imported function directly, so its `.name`
    // is the declared export name — compare against that rather than function
    // identity, which sidesteps any ESM module-instance mismatch.
    const registeredNames = new Set(
      Object.values(METRIC_REGISTRY).map((entry) => entry.compute.name),
    );

    const exported = exportedComputeFns();
    const unregistered = exported
      .filter(([, name]) => !registeredNames.has(name))
      .map(([file, name]) => `${file}: ${name}`);

    // Vacuity guard: discovery must find at least the registered set, or the
    // assertion below would pass trivially on an empty list.
    expect(exported.length).toBeGreaterThanOrEqual(registeredNames.size);
    expect(unregistered).toEqual([]);
  });
});
