import type { Activity } from "intervals-icu-api";
import type { ReferenceSportAdapter } from "./sport-adapter.js";
import type { IntervalsActivityType } from "../sport.js";
import { SPORT_FAMILIES } from "./metrics/sport-families.js";

/** Stable, index-free identity for error and warn messages. */
export function adapterIdentity(adapter: ReferenceSportAdapter): string {
  return `adapter[${[...adapter.activityTypes].join(",")}]`;
}

/**
 * Resolve an activity type to its sport family, or `fallback` when the type is
 * unmapped. Callers choose the fallback that fits their question — `undefined`
 * when an unmapped type means "no family", or the raw type when it should stand
 * in as its own family — per the SPORT_FAMILIES convention that each caller owns
 * its default rather than folding one into the table.
 */
function familyOf<F extends string | undefined>(type: string, fallback: F): string | F {
  return Object.hasOwn(SPORT_FAMILIES, type) ? SPORT_FAMILIES[type] : fallback;
}

/**
 * Route by sport family rather than by the strict cycling-only set: an adapter
 * listing only `Ride`/`VirtualRide` still covers gravel/mountain-bike/e-bike
 * rides because the registry already counts those under the same family. The
 * narrower per-metric gates re-narrow internally, so dispatch must match the
 * registry's wider family grouping or the projection would disagree with the
 * authoritative counts.
 */
function adapterCoversType(adapter: ReferenceSportAdapter, type: string): boolean {
  if (adapter.activityTypes.some((t) => t === type)) return true;
  const family = familyOf(type, undefined);
  if (family === undefined) return false;
  return adapter.activityTypes.some((t) => SPORT_FAMILIES[t] === family);
}

export function findAdapterForActivity(
  adapters: readonly ReferenceSportAdapter[],
  activity: Activity,
): ReferenceSportAdapter | null {
  const type = activity.type;
  // `Activity.type` is typed as a required string, but a malformed upstream row
  // can still arrive without it at runtime — so this guard is load-bearing, not
  // dead code; don't strip it. A gap here is silent (never a warn).
  if (type === undefined) return null;
  return adapters.find((a) => adapterCoversType(a, type)) ?? null;
}

/** A selected (activity, adapter) pair — the unit produced by {@link runAdaptersForActivities}. */
export interface AdapterRun {
  readonly activity: Activity;
  readonly adapter: ReferenceSportAdapter;
}

/**
 * Returns selections only — it pairs activities with their covering adapter and
 * does not invoke any adapter hook. Out-of-sport types are skipped silently; an
 * in-sport type with no covering adapter warns once per distinct type per call
 * so a misconfigured adapter array is visible without flooding the log.
 *
 * Intentionally has no in-tree caller yet: this is the selection seam the live
 * activity→metric path will consume to drive per-sport projections. Landed
 * ahead of that consumer so it arrives as an additive call site rather than a
 * new seam — do not remove as unused.
 */
export function runAdaptersForActivities(
  adapters: readonly ReferenceSportAdapter[],
  sportTypes: readonly IntervalsActivityType[],
  activities: readonly Activity[],
): readonly AdapterRun[] {
  const runs: AdapterRun[] = [];
  const warned = new Set<string>();
  const sportFamilies = new Set(sportTypes.map((t) => familyOf(t, t)));
  for (const activity of activities) {
    const type = activity.type;
    if (type === undefined) continue;
    const family = familyOf(type, type);
    const adapter = findAdapterForActivity(adapters, activity);
    if (adapter) {
      runs.push({ activity, adapter });
      continue;
    }
    if (sportFamilies.has(family) && !warned.has(type)) {
      warned.add(type);
      console.warn(
        `Reference: in-sport activity type "${type}" has no covering adapter; skipping its sport-specific metrics.`,
      );
    }
  }
  return runs;
}
