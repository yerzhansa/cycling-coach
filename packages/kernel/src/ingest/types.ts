import type { ActivityRows } from "../store/activity-repository.js";
import type { RawFileRow } from "../store/ports.js";

export const FIT_INGEST_VERSION = 4 as const;

export type FitSourceErrorCode =
  | "decode_failed"
  | "missing_session"
  | "missing_session_start"
  | "missing_session_end"
  | "missing_session_sport"
  | "invalid_date"
  | "invalid_numeric"
  | "invalid_enum"
  | "invalid_activity_offset"
  | "invalid_session_range"
  | "record_unassigned"
  | "record_ambiguous"
  | "record_time_missing"
  | "record_time_nonmonotonic"
  | "lap_slice_invalid"
  | "length_slice_invalid"
  | "active_length_count_mismatch"
  | "developer_identity_invalid"
  | "developer_identity_conflict"
  | "stream_alignment_invalid";

export class FitSourceError extends Error {
  readonly code: FitSourceErrorCode;
  constructor(code: FitSourceErrorCode) {
    super(`FIT source rejected: ${code}`);
    this.name = "FitSourceError";
    this.code = code;
  }
}

export type FitEnumInput = string | number | null;
export type FitJsonValue =
  | null
  | boolean
  | string
  | number
  | readonly FitJsonValue[]
  | { readonly [key: string]: FitJsonValue };

export interface DecodedDeveloperField {
  readonly nativeMessageType: number;
  readonly developer_data_index: number;
  readonly field_definition_number: number;
  readonly field_name: string | null;
  readonly units: string | null;
  readonly value: unknown;
}

export interface DecodedFileId {
  readonly serialNumber: number | null;
  readonly timeCreated: number | null;
  readonly manufacturer: FitEnumInput;
  readonly product: FitEnumInput;
  readonly productName: string | null;
}

export interface DecodedActivity {
  readonly timestamp: number | null;
  readonly localTimestamp: number | null;
  readonly numSessions: number | null;
  readonly type: FitEnumInput;
  readonly event: FitEnumInput;
  readonly eventType: FitEnumInput;
}

export interface DecodedSession {
  readonly sourceIndex: number;
  readonly sport: FitEnumInput;
  readonly subSport: FitEnumInput;
  readonly startTime: number | null;
  readonly timestamp: number | null;
  readonly trigger: FitEnumInput;
  readonly firstLapIndex: number | null;
  readonly numLaps: number | null;
  readonly totalElapsedTime: number | null;
  readonly totalTimerTime: number | null;
  readonly totalMovingTime: number | null;
  readonly totalDistance: number | null;
  readonly developerFields: readonly DecodedDeveloperField[];
}

export interface DecodedLap {
  readonly sourceIndex: number;
  readonly startTime: number | null;
  readonly timestamp: number | null;
  readonly firstLengthIndex: number | null;
  readonly numLengths: number | null;
  readonly numActiveLengths: number | null;
  readonly totalElapsedTime: number | null;
  readonly totalTimerTime: number | null;
  readonly totalDistance: number | null;
  readonly developerFields: readonly DecodedDeveloperField[];
}

export interface DecodedLength {
  readonly sourceIndex: number;
  readonly startTime: number | null;
  readonly timestamp: number | null;
  readonly totalElapsedTime: number | null;
  readonly totalTimerTime: number | null;
  readonly totalStrokes: number | null;
  readonly swimStroke: FitEnumInput;
  readonly lengthType: FitEnumInput;
}

export interface DecodedRecord {
  readonly sourceIndex: number;
  readonly timestamp: number | null;
  readonly positionLat: number | null;
  readonly positionLong: number | null;
  readonly distance: number | null;
  readonly enhancedAltitude: number | null;
  readonly altitude: number | null;
  readonly enhancedSpeed: number | null;
  readonly speed: number | null;
  readonly heartRate: number | null;
  readonly cadence: number | null;
  readonly fractionalCadence: number | null;
  readonly power: number | null;
  readonly temperature: number | null;
  readonly stanceTime: number | null;
  readonly stanceTimeBalance: number | null;
  readonly verticalOscillation: number | null;
  readonly verticalRatio: number | null;
  readonly stepLength: number | null;
  readonly leftRightBalance: number | null;
  readonly respirationRate: number | null;
  readonly developerFields: readonly DecodedDeveloperField[];
  readonly coordinateUnit: "degrees";
}

export interface DecodedEvent {
  readonly sourceIndex: number;
  readonly timestamp: number | null;
  readonly event: FitEnumInput;
  readonly eventType: FitEnumInput;
  readonly data: number | null;
}

export interface DecodedDeveloperDataId {
  readonly developerDataIndex: number;
  readonly applicationId: readonly number[] | null;
}

export interface DecodedFitFile {
  readonly fileIds: readonly DecodedFileId[];
  readonly activity: DecodedActivity | null;
  readonly sessions: readonly DecodedSession[];
  readonly laps: readonly DecodedLap[];
  readonly lengths: readonly DecodedLength[];
  readonly records: readonly DecodedRecord[];
  readonly events: readonly DecodedEvent[];
  readonly developerDataIds: readonly DecodedDeveloperDataId[];
}

export interface MappedFitArtifact {
  readonly rawFile: RawFileRow;
  readonly activity: ActivityRows;
  readonly logicalArchiveEpochSeconds: number;
}
