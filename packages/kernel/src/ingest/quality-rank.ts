import type { FileFormat } from "./canonical-pick.js";

export const QUALITY_RANK = {
  GPX: 100,
  TCX: 200,
  PLATFORM_API: 300,
  FIT: 400,
} as const;

export type QualityRank = (typeof QUALITY_RANK)[keyof typeof QUALITY_RANK];

export function assertQualityRank(value: number): QualityRank {
  if (
    value !== QUALITY_RANK.GPX &&
    value !== QUALITY_RANK.TCX &&
    value !== QUALITY_RANK.PLATFORM_API &&
    value !== QUALITY_RANK.FIT
  ) {
    throw new RangeError(`unknown quality rank: ${value}`);
  }
  return value;
}

export function qualityRankForFile(format: FileFormat): QualityRank {
  if (format === "gpx") return QUALITY_RANK.GPX;
  if (format === "tcx") return QUALITY_RANK.TCX;
  return QUALITY_RANK.FIT;
}
