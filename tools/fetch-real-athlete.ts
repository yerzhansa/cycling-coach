// Operator CLI for pulling 12 weeks of activities + wellness from
// intervals.icu for the authenticated athlete. Derives an ftp_history
// time series from per-day sportInfo.eftp (cycling only) and writes the
// union to a raw-bundle.json inside a fresh private temp directory
// (operator-only mode 0600; the path is printed on completion). The next
// step (operator-driven) pipes that file through `pnpm exec tsx
// tools/sanitize-fixture.ts <printed path> realistic-athlete --force`
// to produce the committable fixture.
//
// ftp_history caveat: intervals.icu has no public ftp-history endpoint
// (verified against intervals-icu-api@0.1.2 OpenAPI). We synthesize a
// sparse series from WellnessRecord.sportInfo[] entries whose `type` is a
// cycling sport — one point per change in eftp. Source is always
// "estimate"; "test" entries would require manual annotation.
//
// Usage (must be run from project root for pnpm module resolution):
//   INTERVALS_API_KEY=xxxxx pnpm exec tsx tools/fetch-real-athlete.ts

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntervalsClient, snakeCaseKeys } from "intervals-icu-api";

const CYCLING_TYPES = new Set([
  "Ride",
  "VirtualRide",
  "GravelRide",
  "MountainBikeRide",
  "EBikeRide",
  "EMountainBikeRide",
  "TrackRide",
  "Cyclocross",
  "Handcycle",
]);

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function deriveFtpHistory(
  wellness: ReadonlyArray<Record<string, unknown>>,
): Array<{ date: string; ftp: number; source: "estimate" }> {
  const points: Array<{ date: string; ftp: number; source: "estimate" }> = [];
  let lastFtp: number | null = null;
  const sorted = [...wellness].sort((a, b) =>
    String(a.id).localeCompare(String(b.id)),
  );
  for (const day of sorted) {
    const sportInfo = (day.sportInfo as Array<Record<string, unknown>> | null | undefined) ?? [];
    let cyclingEftp: number | null = null;
    for (const si of sportInfo) {
      if (
        typeof si.type === "string" &&
        CYCLING_TYPES.has(si.type) &&
        typeof si.eftp === "number" &&
        Number.isFinite(si.eftp)
      ) {
        cyclingEftp = Math.round(si.eftp);
        break;
      }
    }
    if (cyclingEftp === null) continue;
    if (cyclingEftp === lastFtp) continue;
    points.push({
      date: String(day.id),
      ftp: cyclingEftp,
      source: "estimate",
    });
    lastFtp = cyclingEftp;
  }
  return points;
}

async function main(): Promise<void> {
  const apiKey = process.env.INTERVALS_API_KEY;
  if (!apiKey) {
    console.error(
      "INTERVALS_API_KEY not set. Run as: INTERVALS_API_KEY=xxxxx pnpm exec tsx tools/fetch-real-athlete.ts",
    );
    process.exit(1);
  }

  const client = new IntervalsClient({ apiKey, retry: { maxAttempts: 1 } });

  const today = new Date();
  const oldest = ymd(new Date(today.getTime() - 12 * 7 * 24 * 60 * 60 * 1000));
  const newest = ymd(today);

  console.error(`Fetching activities ${oldest} → ${newest}…`);
  const actResult = await client.activities.list({ oldest, newest });
  if (!actResult.ok) {
    console.error("activities.list failed:", actResult.error);
    process.exit(2);
  }
  // intervals-icu-api auto-camelCases activity responses; the project's
  // ActivitySchema requires snake_case (start_date_local, icu_training_load,
  // ...). Reverse the lib's transform on activities only — wellness already
  // ships in the camelCase mixed shape both schemas agree on.
  const activities = snakeCaseKeys(actResult.value);
  console.error(`  → ${activities.length} activities`);

  console.error(`Fetching wellness ${oldest} → ${newest}…`);
  const wellResult = await client.wellness.list({ oldest, newest });
  if (!wellResult.ok) {
    console.error("wellness.list failed:", wellResult.error);
    process.exit(2);
  }
  const wellness = wellResult.value;
  console.error(`  → ${wellness.length} wellness rows`);

  const ftp_history = deriveFtpHistory(wellness as ReadonlyArray<Record<string, unknown>>);
  console.error(`Derived ${ftp_history.length} ftp_history points from sportInfo.eftp`);

  const bundle = { activities, wellness, ftp_history };
  // The bundle is the raw, unsanitized athlete export — keep it out of the
  // shared world-readable /tmp root: fresh 0700 temp dir, file mode 0600.
  const outDir = mkdtempSync(join(tmpdir(), "raw-bundle-"));
  const outPath = join(outDir, "raw-bundle.json");
  writeFileSync(outPath, JSON.stringify(bundle, null, 2), { mode: 0o600 });
  console.error(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(2);
});
