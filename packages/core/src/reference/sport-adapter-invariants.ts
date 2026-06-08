import type { ReferenceSportAdapter } from "./sport-adapter.js";
import type { IntervalsActivityType } from "../sport.js";
import { ReferenceConfigError } from "./errors.js";
import { adapterIdentity } from "./sport-adapter-dispatcher.js";

/**
 * No two adapters in a sport's array may claim the same activity type, so each
 * activity routes to exactly one adapter. Offenders are named by their stable
 * identity, never by array position — positions shift as adapters are spread
 * for composing sports.
 */
export function assertDisjointCoverage(adapters: readonly ReferenceSportAdapter[]): void {
  const owner = new Map<string, ReferenceSportAdapter>();
  for (const adapter of adapters) {
    for (const type of adapter.activityTypes) {
      const prior = owner.get(type);
      if (prior !== undefined && prior !== adapter) {
        throw new ReferenceConfigError(
          `Reference adapter coverage overlaps on "${type}": ${adapterIdentity(prior)} and ${adapterIdentity(adapter)} both claim it.`,
        );
      }
      owner.set(type, adapter);
    }
  }
}

/**
 * Every activity type an adapter literally declares must be one the sport reads;
 * an adapter claiming a type outside `sport.intervalsActivityTypes` is a
 * misconfiguration. This checks the raw declared types, deliberately distinct
 * from the family-aware dispatch membership.
 */
export function assertSubsetCoverage(
  adapters: readonly ReferenceSportAdapter[],
  sportTypes: readonly IntervalsActivityType[],
): void {
  const declared = new Set<string>(sportTypes as readonly string[]);
  const strays: string[] = [];
  for (const adapter of adapters) {
    for (const type of adapter.activityTypes) {
      if (!declared.has(type)) {
        strays.push(`"${type}" (${adapterIdentity(adapter)})`);
      }
    }
  }
  if (strays.length > 0) {
    throw new ReferenceConfigError(
      `Reference adapter declares activity types outside the sport's set: ${strays.join(", ")}.`,
    );
  }
}
