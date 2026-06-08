import type { ReferenceSportAdapter } from "@enduragent/core";

// Frozen tuple so callers get element identity; equals the cycling
// sustainability-anchor durations the Reference layer's capability metrics use.
export const CYCLING_SUSTAINABILITY_ANCHORS = [
  300, 600, 1200, 1800, 3600, 5400, 7200,
] as const;

// Declarative-only seam. The optional projection hooks (computeDfa/
// computePowerCurve) are omitted: they delegate to the parity-green capability
// metrics over live data, which has no runtime source until the activity-stream
// bridge lands. Omitting them is contract-valid — both hooks are optional.
export const cyclingReferenceAdapter: ReferenceSportAdapter = {
  activityTypes: ["Ride", "VirtualRide"],
  zoneBasis: "power",
  decouplingBasis: "power",
  sustainabilityAnchors: CYCLING_SUSTAINABILITY_ANCHORS,
  dfaValidated: true,
};
