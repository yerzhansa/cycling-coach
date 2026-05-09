/**
 * Resolve the per-binary data directory using the three-tier fallback codified
 * in ADR-0006 (data-dir naming + migration plan):
 *
 *   1. `<BINARY>_HOME` env-var override (e.g., `CYCLING_COACH_HOME`,
 *      `RUNNING_COACH_HOME`). Derived from `binaryName` by uppercasing and
 *      replacing `-` with `_`, then appending `_HOME`. `~` and `~/...` are
 *      expanded.
 *   2. **Legacy `~/.cycling-coach/`** — only when `binaryName === "cycling-coach"`
 *      AND that directory exists on disk. Keeps installed cycling-coach users
 *      on their current path with zero migration. Skipped for any other binary.
 *   3. `~/.enduragent/<dataSubdir>/` — fresh-install canonical path. Subdir is
 *      derived by stripping the `-coach` suffix from `binaryName`
 *      (`cycling-coach` → `cycling`, `running-coach` → `running`,
 *      `duathlon-coach` → `duathlon`). Future binaries that don't follow this
 *      convention can introduce a `getCoachHome(binary: BinaryConfig)` overload.
 *
 * Pure function: does NOT create the directory. Callers create it when they
 * need it.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LEGACY_CYCLING_COACH_BASENAME = ".cycling-coach";

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function getCoachHome(binaryName: string): string {
  const envVar = `${binaryName.toUpperCase().replace(/-/g, "_")}_HOME`;
  const override = process.env[envVar];
  if (override !== undefined && override.length > 0) {
    return expandTilde(override);
  }

  if (binaryName === "cycling-coach") {
    const legacyPath = join(homedir(), LEGACY_CYCLING_COACH_BASENAME);
    if (existsSync(legacyPath)) return legacyPath;
  }

  const subdir = binaryName.replace(/-coach$/, "");
  return join(homedir(), ".enduragent", subdir);
}
