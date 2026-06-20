import type { ReferenceSportAdapter } from "@enduragent/core";

// Declarative-only adapter: pace-based zones and decoupling, no Activity-shaped
// compute hooks yet. The running speed-duration curve and DFA validation are
// deferred, so both optional hooks are omitted (contract-valid) and dfaValidated
// stays false until upstream validation lands.
export const runningReferenceAdapter: ReferenceSportAdapter = {
  activityTypes: ["Run", "TrailRun"],
  zoneBasis: "pace",
  decouplingBasis: "pace",
  sustainabilityAnchors: [],
  dfaValidated: false,
  anchorType: "critical-speed",
};
