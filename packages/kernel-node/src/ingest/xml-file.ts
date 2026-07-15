import { canonicalJson, type ArchiveManager, type ArchiveWriteResult } from "@enduragent/kernel/archive";
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
} from "@enduragent/kernel/ingest";

export interface XmlFileDeps {
  readonly archive: ArchiveManager;
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
  const report = parseXmlBytes(bytes, format);
  if (report.quarantine !== null) {
    const failed = report as XmlParseReport & { readonly sessions: readonly []; readonly quarantine: XmlQuarantine };
    const archive = await deps.archive.quarantine(bytes, format, `${canonicalJson(failed.quarantine)}\n`);
    return { status: "quarantined", archive, candidates: [], report: failed };
  }
  const succeeded = report as XmlParseReport & { readonly quarantine: null };
  let instant = succeeded.sessions[0]!.startUtc;
  for (let index = 1; index < succeeded.sessions.length; index += 1) {
    const startUtc = succeeded.sessions[index]!.startUtc;
    if (startUtc < instant) instant = startUtc;
  }
  const archive = await deps.archive.writeArtifact(bytes, format, { epochSeconds: Math.floor(instant) });
  const candidates = xmlSessionsToCandidates(succeeded, archive.address);
  return { status: "parsed", archive, candidates, report: succeeded };
}
