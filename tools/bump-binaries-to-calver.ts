#!/usr/bin/env tsx
/**
 * Override changesets' SemVer bumps on binary packages with CalVer (YYYY.M.D[-N]).
 * Library packages (@enduragent/*) keep changesets' SemVer bumps.
 *
 * Run after `pnpm exec changeset version` in CI, before `pnpm publish -r`.
 *
 * The -N suffix handles same-day re-release: if today's date already matches an
 * existing tag, the script bumps the suffix (2026.5.1 → 2026.5.1-1 → 2026.5.1-2).
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BINARY_PACKAGES = ["cycling-coach", "running-coach", "duathlon-coach"];

function todayCalVer(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  return `${y}.${m}.${d}`;
}

function nextSuffix(current: string, base: string): string {
  // current looks like "2026.5.1" or "2026.5.1-2". If base matches the date
  // part, increment suffix.
  if (current === base) return `${base}-1`;
  const m = current.match(new RegExp(`^${base.replace(/\./g, "\\.")}-(\\d+)$`));
  if (m) return `${base}-${parseInt(m[1], 10) + 1}`;
  return base;
}

const packagesDir = "packages";
const today = todayCalVer();

for (const pkg of BINARY_PACKAGES) {
  const pkgJsonPath = join(packagesDir, pkg, "package.json");
  let pkgJson: { version: string; [k: string]: unknown };
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  } catch {
    console.error(`skip: ${pkgJsonPath} not found`);
    continue;
  }
  const newVersion = nextSuffix(pkgJson.version, today);
  if (newVersion === pkgJson.version) {
    console.log(`${pkg}: already ${newVersion} (no bump)`);
    continue;
  }
  pkgJson.version = newVersion;
  writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");
  console.log(`${pkg}: ${pkgJson.version}`);
}
