import { canonicalJson, toHex, type ArchiveManager, type ArchiveWriteResult } from "@enduragent/kernel/archive";
import {
  XML_QUARANTINE_MESSAGE,
  parseGpx,
  parseTcx,
  xmlSessionsToCandidates,
  type Candidate,
  type XmlFormat,
  type XmlParseReport,
  type XmlQuarantine,
  type XmlQuarantineCode,
  type PrepareFileResult,
  type PreparedFile,
  type DedupCandidateSummary,
} from "@enduragent/kernel/ingest";
import type { CryptoPort } from "@enduragent/kernel/ports";

export interface XmlFileDeps {
  readonly archive: ArchiveManager;
  readonly crypto: CryptoPort;
}

export interface XmlFileSuccess {
  readonly status: "parsed";
  readonly archive: ArchiveWriteResult;
  readonly candidates: readonly Candidate[];
  readonly report: XmlParseReport & { readonly quarantine: null };
}

export interface XmlFileQuarantined {
  readonly status: "quarantined";
  readonly archive: ArchiveWriteResult;
  readonly candidates: readonly [];
  readonly report: XmlParseReport & { readonly sessions: readonly []; readonly quarantine: XmlQuarantine };
}

export type XmlFileResult = XmlFileSuccess | XmlFileQuarantined;

const preparedReports = new WeakMap<object, XmlParseReport>();

export function parseXmlBytes(bytes: Uint8Array, format: "tcx" | "gpx"): XmlParseReport {
  const text = decode(bytes);
  return text === null ? invalidUtf8(format) : format === "tcx" ? parseTcx(text) : parseGpx(text);
}

function invalidUtf8(format: XmlFormat): XmlParseReport & { readonly sessions: readonly []; readonly quarantine: XmlQuarantine } {
  const code: XmlQuarantineCode = "xml.invalid_utf8";
  return {
    format,
    sessions: [],
    quarantine: { code, path: "$", message: XML_QUARANTINE_MESSAGE[code] },
  };
}

function hasForbiddenEncodingSignature(bytes: Uint8Array): boolean {
  const matches = (signature: readonly number[]): boolean =>
    signature.every((value, index) => bytes[index] === value);
  return [
    [0xff, 0xfe], [0xfe, 0xff], [0x00, 0x00, 0xfe, 0xff], [0xff, 0xfe, 0x00, 0x00],
    [0x00, 0x3c, 0x00, 0x3f], [0x3c, 0x00, 0x3f, 0x00], [0x00, 0x00, 0x00, 0x3c], [0x3c, 0x00, 0x00, 0x00],
  ].some(matches);
}

function decode(bytes: Uint8Array): string | null {
  if (hasForbiddenEncodingSignature(bytes)) return null;
  const startsWithUtf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const input = startsWithUtf8Bom ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
  } catch {
    return null;
  }
}

export async function parseXmlFile(
  bytes: Uint8Array,
  format: "tcx" | "gpx",
  deps: XmlFileDeps,
): Promise<XmlFileResult> {
  const prepared = await prepareXmlFile(bytes, format, { crypto: deps.crypto });
  const report = preparedReports.get(prepared as object);
  if (!report) throw new Error("XML preparation report is missing");
  if (prepared.outcome === "quarantined") {
    const failed = report as XmlParseReport & { readonly sessions: readonly []; readonly quarantine: XmlQuarantine };
    const archive = await deps.archive.quarantine(bytes, format, `${canonicalJson(failed.quarantine)}\n`);
    return { status: "quarantined", archive, candidates: [], report: failed };
  }
  const succeeded = report as XmlParseReport & { readonly quarantine: null };
  const archive = await deps.archive.writeArtifact(bytes, format, prepared.value.archive_instant);
  if (archive.address !== prepared.value.expected_address) throw new Error("archive address mismatch");
  return { status: "parsed", archive, candidates: prepared.value.candidates, report: succeeded };
}

export async function prepareXmlFile(
  bytes: Uint8Array,
  format: "tcx" | "gpx",
  deps: { readonly crypto: CryptoPort },
): Promise<PrepareFileResult> {
  const report = parseXmlBytes(bytes, format);
  if (report.quarantine !== null) {
    const result: PrepareFileResult = { outcome: "quarantined", quarantine: { code: report.quarantine.code, message: report.quarantine.message } };
    preparedReports.set(result as object, report);
    return result;
  }
  const succeeded = report as XmlParseReport & { readonly quarantine: null };
  const address = toHex(await deps.crypto.sha256(bytes));
  let instant = succeeded.sessions[0]!.startUtc;
  for (let index = 1; index < succeeded.sessions.length; index += 1) {
    const startUtc = succeeded.sessions[index]!.startUtc;
    if (startUtc < instant) instant = startUtc;
  }
  const candidates = xmlSessionsToCandidates(succeeded, address).map((candidate) => Object.hasOwn(candidate.concerns, "session.sport")
    ? candidate : { ...candidate, concerns: { ...candidate.concerns, "session.sport": "unknown" } });
  const summaries: DedupCandidateSummary[] = candidates.map((candidate, index) => {
    const session = succeeded.sessions[index]!;
    const time = session.channels.time!;
    const duration = session.elapsedS ?? time.timestamps[time.timestamps.length - 1]! - time.timestamps[0]!;
    return {
      candidate_id: candidate.id,
      member_id: address,
      source_kind: format,
      source_session_seq: session.sessionOrdinal,
      sport_family: (candidate.concerns["session.sport"] as string),
      is_transition: false,
      start_utc: session.startUtc,
      duration_s: duration,
      distance_m: session.distanceM,
      file_id_manufacturer: null,
      file_id_serial: null,
      file_id_time_created_utc: null,
    };
  });
  const value: PreparedFile = {
    expected_address: address,
    archive_instant: { epochSeconds: Math.floor(instant) },
    raw_file: { sha256: address, ext: format, bytes: bytes.byteLength, file_id_serial: null,
      file_id_time_created_utc: null, manufacturer: null, product: null },
    candidates,
    summaries,
    repair_events: [],
  };
  const result: PrepareFileResult = { outcome: "prepared", value };
  preparedReports.set(result as object, report);
  return result;
}
