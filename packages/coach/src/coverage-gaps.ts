import type { CoverageGapEvidence } from "@enduragent/kernel/store";

export function coverageGapsWithinWindow(input: {
  readonly evidence: CoverageGapEvidence;
  readonly oldest: string;
  readonly newest: string;
}): CoverageGapEvidence {
  return {
    datedLocalDates: input.evidence.datedLocalDates.filter(
      (date) => date >= input.oldest && date <= input.newest,
    ),
    undatedCount: input.evidence.undatedCount,
  };
}
