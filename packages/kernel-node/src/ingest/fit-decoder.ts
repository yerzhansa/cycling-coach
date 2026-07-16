import { Buffer } from "node:buffer";
import FitParser from "fit-file-parser";
import {
  FitSourceError,
  type DecodedDeveloperField,
  type DecodedFitFile,
  type FitEnumInput,
} from "@enduragent/kernel/ingest";

export const FIT_PARSER_OPTIONS = Object.freeze({ force: false, mode: "list" } as const);

export interface FitDecoder {
  decode(bytes: Uint8Array): Promise<DecodedFitFile>;
}

interface PatchedDeveloperEnvelope {
  readonly nativeMessageType: unknown;
  readonly developer_data_index: unknown;
  readonly field_definition_number: unknown;
  readonly field_name: unknown;
  readonly units: unknown;
  readonly value: unknown;
}
type PatchedParserMessage = Record<string, unknown> & {
  readonly developer_fields?: readonly PatchedDeveloperEnvelope[] | null;
};

function object(value: unknown): PatchedParserMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FitSourceError("decode_failed");
  }
  return value as PatchedParserMessage;
}

function family(root: PatchedParserMessage, key: string): PatchedParserMessage[] {
  const value = root[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new FitSourceError("decode_failed");
  return value.map(object);
}

function nullableNumber(message: PatchedParserMessage, key: string): number | null {
  const value = message[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number") throw new FitSourceError("invalid_numeric");
  return value;
}

function enhancedNumber(message: PatchedParserMessage, key: string): number | null {
  const value = message[key];
  if (value === undefined) return null;
  if (typeof value !== "number") throw new FitSourceError("invalid_numeric");
  return value;
}

function nullableString(message: PatchedParserMessage, key: string): string | null {
  const value = message[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new FitSourceError("decode_failed");
  return value;
}

function enumInput(message: PatchedParserMessage, key: string): FitEnumInput {
  const value = message[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new FitSourceError("invalid_enum");
  }
  return value;
}

function fitDate(message: PatchedParserMessage, key: string, integer: boolean): number | null {
  const value = message[key];
  if (value === undefined || value === null) return null;
  let seconds: number;
  if (value instanceof Date) seconds = value.getTime() / 1000;
  else if (typeof value === "string") seconds = Date.parse(value) / 1000;
  else throw new FitSourceError("invalid_date");
  if (!Number.isFinite(seconds) || (integer && !Number.isInteger(seconds))) {
    throw new FitSourceError("invalid_date");
  }
  return seconds;
}

function developerFields(message: PatchedParserMessage): readonly DecodedDeveloperField[] {
  const value = message.developer_fields;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new FitSourceError("decode_failed");
  return value.map((candidate) => {
    const envelope = object(candidate);
    const nativeMessageType = envelope.nativeMessageType;
    const developerIndex = envelope.developer_data_index;
    const fieldNumber = envelope.field_definition_number;
    if (typeof nativeMessageType !== "number" || typeof developerIndex !== "number" || typeof fieldNumber !== "number") {
      throw new FitSourceError("decode_failed");
    }
    const fieldName = envelope.field_name ?? null;
    const units = envelope.units ?? null;
    if ((fieldName !== null && typeof fieldName !== "string") || (units !== null && typeof units !== "string") || envelope.value === undefined) {
      throw new FitSourceError("decode_failed");
    }
    return {
      nativeMessageType,
      developer_data_index: developerIndex,
      field_definition_number: fieldNumber,
      field_name: fieldName,
      units,
      value: envelope.value,
    };
  });
}

function leftRightBalance(message: PatchedParserMessage): number | null {
  const value = message.left_right_balance;
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new FitSourceError("invalid_numeric");
  const keys = Object.keys(value).sort();
  const shape = keys.join(",");
  if (shape !== "right,value" && shape !== "0,right,value") throw new FitSourceError("invalid_numeric");
  const record = value as Record<string, unknown>;
  if (shape === "0,right,value" && record["0"] !== false) throw new FitSourceError("invalid_numeric");
  if (typeof record.right !== "boolean" || typeof record.value !== "number" || !Number.isFinite(record.value) || !Number.isInteger(record.value) || record.value < 0 || record.value > 127) {
    throw new FitSourceError("invalid_numeric");
  }
  return record.value;
}

function adapt(rootValue: unknown): DecodedFitFile {
  const root = object(rootValue);
  const fileIds = family(root, "file_ids").map((m) => ({
    serialNumber: nullableNumber(m, "serial_number"),
    timeCreated: fitDate(m, "time_created", true),
    manufacturer: enumInput(m, "manufacturer"),
    product: enumInput(m, "product"),
    productName: nullableString(m, "product_name"),
  }));
  const activityValue = root.activity;
  const activityMessage = activityValue === undefined || activityValue === null ? null : object(activityValue);
  const activity = activityMessage === null ? null : {
    timestamp: fitDate(activityMessage, "timestamp", true),
    localTimestamp: fitDate(activityMessage, "local_timestamp", true),
    numSessions: nullableNumber(activityMessage, "num_sessions"),
    type: enumInput(activityMessage, "type"),
    event: enumInput(activityMessage, "event"),
    eventType: enumInput(activityMessage, "event_type"),
  };
  const sessions = family(root, "sessions").map((m, sourceIndex) => ({
    sourceIndex,
    sport: enumInput(m, "sport"), subSport: enumInput(m, "sub_sport"),
    startTime: fitDate(m, "start_time", true), timestamp: fitDate(m, "timestamp", true),
    trigger: enumInput(m, "trigger"), firstLapIndex: nullableNumber(m, "first_lap_index"),
    numLaps: nullableNumber(m, "num_laps"), totalElapsedTime: nullableNumber(m, "total_elapsed_time"),
    totalTimerTime: nullableNumber(m, "total_timer_time"), totalMovingTime: nullableNumber(m, "total_moving_time"),
    totalDistance: nullableNumber(m, "total_distance"), developerFields: developerFields(m),
  }));
  const laps = family(root, "laps").map((m, sourceIndex) => ({
    sourceIndex, startTime: fitDate(m, "start_time", true), timestamp: fitDate(m, "timestamp", true),
    firstLengthIndex: nullableNumber(m, "first_length_index"), numLengths: nullableNumber(m, "num_lengths"),
    numActiveLengths: nullableNumber(m, "num_active_lengths"), totalElapsedTime: nullableNumber(m, "total_elapsed_time"),
    totalTimerTime: nullableNumber(m, "total_timer_time"), totalDistance: nullableNumber(m, "total_distance"),
    developerFields: developerFields(m),
  }));
  const lengths = family(root, "lengths").map((m, sourceIndex) => ({
    sourceIndex, startTime: fitDate(m, "start_time", true), timestamp: fitDate(m, "timestamp", true),
    totalElapsedTime: nullableNumber(m, "total_elapsed_time"), totalTimerTime: nullableNumber(m, "total_timer_time"),
    totalStrokes: nullableNumber(m, "total_strokes"), swimStroke: enumInput(m, "swim_stroke"), lengthType: enumInput(m, "length_type"),
  }));
  const records = family(root, "records").map((m, sourceIndex) => ({
    sourceIndex, timestamp: fitDate(m, "timestamp", false), positionLat: nullableNumber(m, "position_lat"),
    positionLong: nullableNumber(m, "position_long"), distance: nullableNumber(m, "distance"),
    enhancedAltitude: enhancedNumber(m, "enhanced_altitude"), altitude: nullableNumber(m, "altitude"),
    enhancedSpeed: enhancedNumber(m, "enhanced_speed"), speed: nullableNumber(m, "speed"),
    heartRate: nullableNumber(m, "heart_rate"), cadence: nullableNumber(m, "cadence"),
    fractionalCadence: nullableNumber(m, "fractional_cadence"), power: nullableNumber(m, "power"),
    temperature: nullableNumber(m, "temperature"), stanceTime: nullableNumber(m, "stance_time"),
    stanceTimeBalance: nullableNumber(m, "stance_time_balance"), verticalOscillation: nullableNumber(m, "vertical_oscillation"),
    verticalRatio: nullableNumber(m, "vertical_ratio"), stepLength: nullableNumber(m, "step_length"),
    leftRightBalance: leftRightBalance(m), respirationRate: nullableNumber(m, "respiration_rate"),
    developerFields: developerFields(m), coordinateUnit: "degrees" as const,
  }));
  const events = family(root, "events").map((m, sourceIndex) => ({
    sourceIndex, timestamp: fitDate(m, "timestamp", true), event: enumInput(m, "event"),
    eventType: enumInput(m, "event_type"), data: nullableNumber(m, "data"),
  }));
  const developerDataIds = family(root, "developer_data_ids").map((m) => {
    const index = nullableNumber(m, "developer_data_index");
    if (index === null) throw new FitSourceError("decode_failed");
    const app = m.application_id;
    if (app !== undefined && app !== null && !Array.isArray(app)) throw new FitSourceError("decode_failed");
    return { developerDataIndex: index, applicationId: app == null ? null : [...app] as number[] };
  });
  return { fileIds, activity, sessions, laps, lengths, records, events, developerDataIds };
}

export function createFitDecoder(): FitDecoder {
  return {
    async decode(bytes) {
      const parser = new FitParser(FIT_PARSER_OPTIONS);
      let parsed: unknown;
      try {
        parsed = await parser.parseAsync(Buffer.from(bytes));
      } catch {
        throw new FitSourceError("decode_failed");
      }
      return adapt(parsed);
    },
  };
}
