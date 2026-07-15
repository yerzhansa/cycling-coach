export type XmlFormat = "tcx" | "gpx";

export type XmlQuarantineCode =
  | "xml.invalid_utf8"
  | "xml.doctype_forbidden"
  | "xml.processing_instruction_forbidden"
  | "xml.parse"
  | "xml.namespace"
  | "xml.missing_required"
  | "xml.duplicate"
  | "xml.invalid_number"
  | "xml.invalid_time"
  | "xml.non_chronological"
  | "xml.invalid_coordinate"
  | "xml.overlap";

export const XML_QUARANTINE_CODES = [
  "xml.invalid_utf8",
  "xml.doctype_forbidden",
  "xml.processing_instruction_forbidden",
  "xml.parse",
  "xml.namespace",
  "xml.missing_required",
  "xml.duplicate",
  "xml.invalid_number",
  "xml.invalid_time",
  "xml.non_chronological",
  "xml.invalid_coordinate",
  "xml.overlap",
] as const satisfies readonly XmlQuarantineCode[];

export const XML_QUARANTINE_MESSAGE = {
  "xml.invalid_utf8": "Input is not valid UTF-8.",
  "xml.doctype_forbidden": "DTD and entity declarations are forbidden.",
  "xml.processing_instruction_forbidden": "Processing instructions are forbidden.",
  "xml.parse": "XML is not well formed.",
  "xml.namespace": "XML namespace or version is not supported.",
  "xml.missing_required": "A required XML value is missing.",
  "xml.duplicate": "An XML value occurs more than once.",
  "xml.invalid_number": "A numeric XML value is invalid.",
  "xml.invalid_time": "An XML time is invalid.",
  "xml.non_chronological": "XML sample times are not strictly increasing.",
  "xml.invalid_coordinate": "An XML coordinate is outside its valid range.",
  "xml.overlap": "XML lap ranges overlap.",
} as const;

export interface XmlQuarantine {
  readonly code: XmlQuarantineCode;
  readonly path: string;
  readonly message: string;
}

export interface XmlChannel {
  readonly timestamps: readonly number[];
  readonly values: readonly (number | null)[];
}

export interface XmlLap {
  readonly lapSeq: number;
  readonly startUtc: number;
  readonly elapsedS: number | null;
  readonly distanceM: number | null;
  readonly firstSampleIndex: number;
  readonly endSampleIndexExclusive: number;
}

export interface XmlSession {
  readonly workoutOrdinal: 0;
  readonly sessionOrdinal: number;
  readonly sport: string | null;
  readonly startUtc: number;
  readonly localDateKey: number;
  readonly elapsedS: number | null;
  readonly distanceM: number | null;
  readonly laps: readonly XmlLap[] | null;
  readonly segmentStartIndices: readonly number[] | null;
  readonly channels: Readonly<Record<string, XmlChannel>>;
}

export interface XmlParseReport<F extends XmlFormat = XmlFormat> {
  readonly format: F;
  readonly sessions: readonly XmlSession[];
  readonly quarantine: XmlQuarantine | null;
}
