#!/usr/bin/env tsx
/**
 * Override changesets' SemVer bumps on published binary packages with CalVer
 * (YYYY.M.D[-N]). All other packages (libs, private stub binaries) keep
 * changesets' SemVer bumps.
 *
 * Run after `pnpm exec changeset version` in CI, before `pnpm publish -r`.
 *
 * Currently the only published binary is `cycling-coach`. When `running-coach`
 * or `duathlon-coach` graduate from private stubs to real npm-published
 * binaries, add their names to BINARY_PACKAGES. See ADR-0010.
 *
 * Same-day re-release strategy:
 *   The -N suffix handles multiple binary releases on a single day. The next
 *   available suffix is determined by querying npm for the latest published
 *   version of each binary package (`npm view <pkg> version`), not by reading
 *   the local package.json. The local file is whatever changesets last wrote
 *   to it on this CI run; npm is the source of truth for what already exists.
 *
 *   Example: if 2026.5.1 and 2026.5.1-1 are already on npm and we run again
 *   today, npm view returns "2026.5.1-1" and this script writes "2026.5.1-2"
 *   into the local package.json so `pnpm publish -r` succeeds.
 *
 * Network failure fallback:
 *   If `npm view` fails (registry down, package never published, no network)
 *   or exceeds the 30s execSync timeout, we fall back to today's CalVer base
 *   and log a warning naming the failed package + reason. On a first publish
 *   this is correct; on a subsequent publish with no network the publish step
 *   will fail with a "version already exists" error — surfaced clearly to the
 *   operator rather than silently corrupting state.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BINARY_PACKAGES = ["cycling-coach"];

function todayCalVer(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  return `${y}.${m}.${d}`;
}

function getLatestPublishedVersion(pkg: string): string | null {
  try {
    return execSync(`npm view ${pkg} version`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    }).trim();
  } catch (err) {
    console.warn(
      `npm view ${pkg} failed (${err instanceof Error ? err.message : String(err)}). Falling back to today's CalVer base.`,
    );
    return null;
  }
}

function nextCalVer(pkg: string, base: string): string {
  const latest = getLatestPublishedVersion(pkg);
  if (!latest) return base;
  if (latest === base) return `${base}-1`;
  const m = latest.match(new RegExp(`^${base.replace(/\./g, "\\.")}-(\\d+)$`));
  if (m) return `${base}-${parseInt(m[1], 10) + 1}`;
  return base;
}

const packagesDir = "packages";
const today = todayCalVer();

/**
 * After overriding package.json, rewrite the latest `## <version>` header in
 * CHANGELOG.md so it matches. `changeset version` writes the SemVer header
 * before our override runs, so without this the header lags by one release.
 * Only the FIRST `## ` line is rewritten — historical entries are preserved.
 */
function rewriteChangelogHeader(pkg: string, oldVersion: string, newVersion: string): void {
  const changelogPath = join(packagesDir, pkg, "CHANGELOG.md");
  if (!existsSync(changelogPath)) return;
  const contents = readFileSync(changelogPath, "utf-8");
  const headerNeedle = `## ${oldVersion}`;
  const headerIndex = contents.indexOf(headerNeedle);
  if (headerIndex === -1) {
    console.warn(
      `${pkg}: CHANGELOG.md has no '${headerNeedle}' header to rewrite — leaving as-is`,
    );
    return;
  }
  const updated =
    contents.slice(0, headerIndex) +
    `## ${newVersion}` +
    contents.slice(headerIndex + headerNeedle.length);
  writeFileSync(changelogPath, updated);
  console.log(`${pkg}: CHANGELOG.md header ${oldVersion} → ${newVersion}`);
}

for (const pkg of BINARY_PACKAGES) {
  const pkgJsonPath = join(packagesDir, pkg, "package.json");
  let pkgJson: { version: string; [k: string]: unknown };
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  } catch {
    console.error(`skip: ${pkgJsonPath} not found`);
    continue;
  }
  const oldVersion = pkgJson.version;
  const newVersion = nextCalVer(pkg, today);
  if (newVersion === oldVersion) {
    console.log(`${pkg}: already ${newVersion} (no bump)`);
    continue;
  }
  pkgJson.version = newVersion;
  writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");
  rewriteChangelogHeader(pkg, oldVersion, newVersion);
  console.log(`${pkg}: ${oldVersion} → ${newVersion}`);
}
