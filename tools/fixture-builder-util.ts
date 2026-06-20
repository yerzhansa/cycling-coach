// Shared scaffolding for the fully-synthetic golden-fixture builders. The
// blocks here are byte-identical across the builders that import them; folding
// them into one place keeps the calendar math, CLI plumbing, and checksum-write
// in lockstep. Every helper is pure / deterministic — no Math.random, no
// Date.now — so a fixture regenerated through these is reproducible byte for
// byte from its frozen anchor alone.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

/** The two-flag CLI surface every synthetic builder shares. */
export interface FixtureArgs {
  frozenNow: string;
  out: string;
}

/**
 * Parse the shared `--frozen-now` / `--out` flags, defaulting from the caller's
 * own anchor + output path. `--out` is resolved against cwd; an unknown flag or
 * a flag missing its value throws.
 */
export function parseFixtureArgs(
  argv: string[],
  defaults: FixtureArgs,
): FixtureArgs {
  const out: FixtureArgs = { frozenNow: defaults.frozenNow, out: defaults.out };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        throw new Error(`flag ${arg} requires a value`);
      }
      i++;
      return v;
    };
    switch (arg) {
      case "--frozen-now":
        out.frozenNow = next();
        break;
      case "--out":
        out.out = resolve(next());
        break;
      default:
        throw new Error(`unknown flag: ${arg}`);
    }
  }
  return out;
}

/**
 * Python-equivalent calendar math: parse the anchor's date prefix as a UTC date,
 * subtract whole days, format `%Y-%m-%d`. Matches `datetime - timedelta(days=n)`
 * exactly for any anchor (no JS local-time drift).
 */
export function ymdMinus(frozenNow: string, days: number): string {
  const base = new Date(`${frozenNow.slice(0, 10)}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() - days);
  return base.toISOString().slice(0, 10);
}

/**
 * Serialize a fixture to pretty JSON with a trailing newline, write it to `out`,
 * and write the sha256 integrity sidecar (`<hex>  <basename>\n`) alongside it.
 * Logs the byte count + checksum path to stderr.
 */
export function writeFixtureWithChecksum(out: string, fixture: unknown): void {
  const json = `${JSON.stringify(fixture, null, 2)}\n`;
  writeFileSync(out, json);
  const hash = createHash("sha256").update(json).digest("hex");
  writeFileSync(`${out}.sha256`, `${hash}  ${basename(out)}\n`);
  // eslint-disable-next-line no-console
  console.error(`Wrote ${out} (${json.length} bytes), checksum ${out}.sha256`);
}

/**
 * Run `main` only when this module is the process entry point (`tsx tools/...`),
 * not when it is imported by a test. On a thrown error, print the message and
 * exit 1.
 */
export function runFixtureCli(importMetaUrl: string, main: (argv: string[]) => void): void {
  const isCli =
    typeof process !== "undefined" &&
    process.argv[1] !== undefined &&
    importMetaUrl === `file://${process.argv[1]}`;
  if (!isCli) return;
  try {
    main(process.argv.slice(2));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error((err as Error).message);
    process.exit(1);
  }
}
