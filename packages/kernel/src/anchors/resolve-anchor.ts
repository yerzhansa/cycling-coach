import type { AnchorRepository } from "../store/ports.js";

export type AnchorConfidence = "manual" | "platform" | "fit";

export type CyclingFtpStalenessBand =
  | "fresh"
  | "aging"
  | "stale"
  | "very-stale";

export interface CyclingFtpStalenessThresholds {
  readonly freshMaxDays: number;
  readonly agingMaxDays: number;
  readonly staleMaxDays: number;
}

// Product display defaults, not validated physiological safety boundaries.
export const CYCLING_FTP_STALENESS_DEFAULTS: Readonly<CyclingFtpStalenessThresholds> = Object.freeze({
  freshMaxDays: 42,
  agingMaxDays: 90,
  staleMaxDays: 180,
});

export interface CyclingFtpAnchorResolverOptions {
  readonly thresholds?: Partial<CyclingFtpStalenessThresholds>;
}

export interface ResolveCyclingFtpAnchorInput {
  readonly effectiveAtEpochS: number;
  readonly evaluatedAtEpochS: number;
}

export interface ResolvedCyclingFtpAnchor {
  readonly kind: "ftp";
  readonly watts: number;
  readonly validFrom: string;
  readonly source: string;
  readonly confidence: AnchorConfidence;
  readonly ageDays: number;
  readonly stalenessBand: CyclingFtpStalenessBand;
  readonly stale: boolean;
}

export interface MissingCyclingFtpAnchor {
  readonly kind: "missing";
  readonly refusal: "missing-cycling-ftp-anchor";
}

export type CyclingFtpAnchorResult =
  | ResolvedCyclingFtpAnchor
  | MissingCyclingFtpAnchor;

export interface CyclingFtpAnchorResolver {
  resolve(input: ResolveCyclingFtpAnchorInput): Promise<CyclingFtpAnchorResult>;
}

const SECONDS_PER_DAY = 86_400;
const MAX_YMD_EPOCH_S = 253_402_300_799;

function isValidThreshold(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function isValidEpoch(value: number): boolean {
  return Number.isFinite(value)
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_YMD_EPOCH_S;
}

function isAnchorConfidence(value: string): value is AnchorConfidence {
  return value === "manual" || value === "platform" || value === "fit";
}

export function createCyclingFtpAnchorResolver(
  repository: AnchorRepository,
  options?: CyclingFtpAnchorResolverOptions,
): CyclingFtpAnchorResolver {
  const thresholds = {
    ...CYCLING_FTP_STALENESS_DEFAULTS,
    ...options?.thresholds,
  };

  if (
    !isValidThreshold(thresholds.freshMaxDays)
    || !isValidThreshold(thresholds.agingMaxDays)
    || !isValidThreshold(thresholds.staleMaxDays)
    || thresholds.freshMaxDays >= thresholds.agingMaxDays
    || thresholds.agingMaxDays >= thresholds.staleMaxDays
  ) {
    throw new RangeError("Invalid cycling FTP staleness thresholds");
  }

  return {
    async resolve(input: ResolveCyclingFtpAnchorInput): Promise<CyclingFtpAnchorResult> {
      if (
        !isValidEpoch(input.effectiveAtEpochS)
        || !isValidEpoch(input.evaluatedAtEpochS)
        || input.evaluatedAtEpochS < input.effectiveAtEpochS
      ) {
        throw new RangeError("Invalid cycling FTP anchor epochs");
      }

      const row = await repository.readCurrent("cycling", "ftp", input.effectiveAtEpochS);
      if (row === undefined) {
        return { kind: "missing", refusal: "missing-cycling-ftp-anchor" };
      }

      if (
        !isAnchorConfidence(row.confidence)
        || !isValidEpoch(row.valid_from)
        || row.valid_from > input.effectiveAtEpochS
      ) {
        throw new TypeError("Malformed cycling FTP anchor repository row");
      }

      const elapsedSeconds = input.evaluatedAtEpochS - row.valid_from;
      const ageDays = elapsedSeconds / SECONDS_PER_DAY;
      let stalenessBand: CyclingFtpStalenessBand;

      if (ageDays <= thresholds.freshMaxDays) {
        stalenessBand = "fresh";
      } else if (ageDays <= thresholds.agingMaxDays) {
        stalenessBand = "aging";
      } else if (ageDays <= thresholds.staleMaxDays) {
        stalenessBand = "stale";
      } else {
        stalenessBand = "very-stale";
      }

      return {
        kind: "ftp",
        watts: row.value,
        validFrom: new Date(row.valid_from * 1_000).toISOString().slice(0, 10),
        source: row.source,
        confidence: row.confidence,
        ageDays,
        stalenessBand,
        stale: stalenessBand !== "fresh",
      };
    },
  };
}
