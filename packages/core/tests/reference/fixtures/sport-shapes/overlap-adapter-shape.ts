// INTENTIONALLY INVALID negative fixture: two adapters both claim "Ride", which
// violates the disjoint-coverage invariant the dispatcher enforces at boot. This
// shape exists so the dispatcher's collision detector has a concrete misconfig to
// reject; it must never be wired into a real sport.
import type { IntervalsActivityType, ReferenceSportAdapter, Sport } from "../../../../src/index.js";

export const overlapAdapterShape: Pick<
  Sport,
  "id" | "intervalsActivityTypes" | "referenceAdapters"
> = {
  id: "cycling",
  intervalsActivityTypes: ["Ride", "VirtualRide"] as readonly IntervalsActivityType[],
  referenceAdapters: (): readonly ReferenceSportAdapter[] => [
    {
      activityTypes: ["Ride"],
      zoneBasis: "power",
      decouplingBasis: "power",
      sustainabilityAnchors: [],
      dfaValidated: true,
      anchorType: "ftp",
    },
    {
      activityTypes: ["Ride"],
      zoneBasis: "power",
      decouplingBasis: "power",
      sustainabilityAnchors: [],
      dfaValidated: true,
      anchorType: "ftp",
    },
  ],
};
