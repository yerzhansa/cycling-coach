import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson, type ArchiveManager } from "@enduragent/kernel/archive";
import { XML_QUARANTINE_CODES, XML_QUARANTINE_MESSAGE, type XmlQuarantineCode } from "@enduragent/kernel/ingest";
import { parseXmlBytes, parseXmlFile } from "../src/ingest/xml-file.js";

const encoder = new TextEncoder();
const digest = "ab".repeat(32);
const tcxNamespace = "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2";
const gpxNamespace = "http://www.topografix.com/GPX/1/1";
const point = (time: string, extra = "") => `<Trackpoint><Time>${time}</Time>${extra}</Trackpoint>`;
const lap = (start: string, points: string) => `<Lap StartTime="${start}"><Track>${points}</Track></Lap>`;
const tcx = (body: string) => `<TrainingCenterDatabase xmlns="${tcxNamespace}"><Activities>${body}</Activities></TrainingCenterDatabase>`;
const activity = (laps: string) => `<Activity Sport="Biking">${laps}</Activity>`;
const gpx = `<gpx xmlns="${gpxNamespace}" version="1.1"><trk><trkseg><trkpt lat="1" lon="2"><time>2000-01-01T00:00:00.25Z</time></trkpt></trkseg></trk></gpx>`;

interface ArchiveProbe {
  readonly archive: ArchiveManager;
  readonly events: string[];
  readonly reasons: string[];
  readonly instants: number[];
}

function archiveProbe(options: { writeFailure?: boolean; quarantineFailure?: boolean } = {}): ArchiveProbe {
  const events: string[] = [];
  const reasons: string[] = [];
  const instants: number[] = [];
  let firstReason: string | null = null;
  const archive: ArchiveManager = {
    async writeArtifact(_bytes, ext, when) {
      events.push(`write:${ext}`);
      instants.push(when.epochSeconds);
      if (options.writeFailure) throw new Error("write failed");
      return { address: digest, relPath: `2000/01/${digest}.${ext}`, deduped: false };
    },
    async quarantine(_bytes, ext, reason) {
      events.push(`quarantine:${ext}`);
      if (options.quarantineFailure) throw new Error("quarantine failed");
      firstReason ??= reason;
      reasons.push(firstReason);
      return { address: digest, relPath: `quarantine/${digest}.${ext}`, deduped: reasons.length > 1 };
    },
    async writeSnapshot() { throw new Error("unused"); },
    async readArtifact() { throw new Error("unused"); },
    async readSnapshot() { throw new Error("unused"); },
    async has() { return false; },
  };
  return { archive, events, reasons, instants };
}

async function rejected(raw: string | Uint8Array, format: "tcx" | "gpx" = "tcx") {
  const probe = archiveProbe();
  const bytes = typeof raw === "string" ? encoder.encode(raw) : raw;
  const result = await parseXmlFile(bytes, format, { archive: probe.archive });
  expect(result.status).toBe("quarantined");
  if (result.status !== "quarantined") throw new Error("expected quarantine");
  expect(result.candidates).toEqual([]);
  expect(probe.events).toEqual([`quarantine:${format}`]);
  expect(probe.reasons).toEqual([`${canonicalJson(result.report.quarantine)}\n`]);
  return result.report.quarantine;
}

describe("XML byte ingest", () => {
  it("shares exact byte/parser results through the pure no-archive seam", async () => {
    for (const [format, source] of [["tcx", tcx(activity(lap("2000-01-01T00:00:00Z", point("2000-01-01T00:00:00Z"))))], ["gpx", gpx]] as const) {
      const bytes = encoder.encode(source);
      const pure = parseXmlBytes(bytes, format);
      const probe = archiveProbe();
      const wrapped = await parseXmlFile(bytes, format, { archive: probe.archive });
      expect(wrapped.report).toEqual(pure);
      expect(probe.events).toEqual([`write:${format}`]);
    }
    const invalid = parseXmlBytes(new Uint8Array([0xff]), "tcx");
    expect(invalid.quarantine?.code).toBe("xml.invalid_utf8");
  });
  it("archives valid UTF-8 BOM input before returning candidates", async () => {
    const fixture = new Uint8Array(readFileSync("packages/kernel-node/tests/fixtures/ingest/fallback-cycling.tcx"));
    const bytes = new Uint8Array(fixture.length + 3);
    bytes.set([0xef, 0xbb, 0xbf]);
    bytes.set(fixture, 3);
    const probe = archiveProbe();
    const result = await parseXmlFile(bytes, "tcx", { archive: probe.archive });
    expect(result.status).toBe("parsed");
    expect(probe.events).toEqual(["write:tcx"]);
    expect(probe.instants).toEqual([899553600]);
    if (result.status === "parsed") expect(result.candidates[0]).toMatchObject({ id: `tcx:${digest}:0:0`, rank: 200 });
  });

  it("rejects malformed UTF-8 and every UTF-16/32 signature", async () => {
    const cases = [
      [0xff], [0xff, 0xfe], [0xfe, 0xff], [0x00, 0x00, 0xfe, 0xff], [0xff, 0xfe, 0x00, 0x00],
      [0x00, 0x3c, 0x00, 0x3f], [0x3c, 0x00, 0x3f, 0x00], [0x00, 0x00, 0x00, 0x3c], [0x3c, 0x00, 0x00, 0x00],
    ];
    for (const bytes of cases) expect(await rejected(new Uint8Array(bytes))).toEqual({ code: "xml.invalid_utf8", path: "$", message: "Input is not valid UTF-8." });
  });

  it("enforces the exact declaration boundary and security scan", async () => {
    const validBody = tcx(activity(lap("2000-01-01T00:00:00Z", point("2000-01-01T00:00:00Z"))));
    for (const declaration of [
      '<?xml version="1.0"?>',
      "<?xml version = '1.0' encoding = 'utf-8'?>",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    ]) {
      const probe = archiveProbe();
      await expect(parseXmlFile(encoder.encode(declaration + validBody), "tcx", { archive: probe.archive })).resolves.toMatchObject({ status: "parsed" });
    }
    expect((await rejected('<?xml version="1.0" encoding="UTF-16"?>' + validBody)).code).toBe("xml.invalid_utf8");
    expect((await rejected("<?xml?>" + validBody)).code).toBe("xml.parse");
    for (const prefix of ["<?xml-stylesheet?>", "<?xmlfoo?>", "<?XML version=\"1.0\"?>", " <?xml version=\"1.0\"?>", '<?xml version="1.0"?><?xml version="1.0"?>']) {
      expect((await rejected(prefix + validBody)).code).toBe("xml.processing_instruction_forbidden");
    }
    expect((await rejected("<?xml")).code).toBe("xml.parse");
    const encoded = encoder.encode(validBody);
    const doubleBom = new Uint8Array(encoded.length + 6);
    doubleBom.set([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]);
    doubleBom.set(encoded, 6);
    expect(await rejected(doubleBom)).toEqual({ code: "xml.parse", path: "$", message: "XML is not well formed." });
    for (const token of ["<!DOCTYPE", "<!ENTITY"]) {
      expect((await rejected(validBody.replace("<Activities>", `<Activities><!--${token}-->`))).code).toBe("xml.doctype_forbidden");
      expect((await rejected(validBody.replace("<Activities>", `<Activities><![CDATA[${token}]]>`))).code).toBe("xml.doctype_forbidden");
    }
    expect((await rejected(validBody.replace("<Activities>", "<Activities><!--<?pi?>-->"))).code).toBe("xml.processing_instruction_forbidden");
  });

  it("classifies parser recovery and repeated attributes as parse failures", async () => {
    expect((await rejected(`<TrainingCenterDatabase xmlns="${tcxNamespace}"><Activities>`)).code).toBe("xml.parse");
    expect((await rejected(`<TrainingCenterDatabase xmlns="${tcxNamespace}"><Activities/><Activities attr="1" attr="2"/></TrainingCenterDatabase>`)).code).toBe("xml.parse");
  });

  it("covers every XML quarantine code with exact DTOs", async () => {
    const start = "2000-01-01T00:00:00Z";
    const validActivity = activity(lap(start, point(start)));
    const cases: readonly [{ code: XmlQuarantineCode; path: string; message: string }, string | Uint8Array][] = [
      [{ code: "xml.invalid_utf8", path: "$", message: "Input is not valid UTF-8." }, new Uint8Array([0xff])],
      [{ code: "xml.doctype_forbidden", path: "$", message: "DTD and entity declarations are forbidden." }, `<!DOCTYPE x>${tcx(validActivity)}`],
      [{ code: "xml.processing_instruction_forbidden", path: "$", message: "Processing instructions are forbidden." }, `<?pi?>${tcx(validActivity)}`],
      [{ code: "xml.parse", path: "$", message: "XML is not well formed." }, `<TrainingCenterDatabase xmlns="${tcxNamespace}">`],
      [{ code: "xml.namespace", path: "$", message: "XML namespace or version is not supported." }, `<TrainingCenterDatabase xmlns="urn:wrong"/>`],
      [{ code: "xml.missing_required", path: "$/Activities[0]", message: "A required XML value is missing." }, `<TrainingCenterDatabase xmlns="${tcxNamespace}"/>`],
      [{ code: "xml.duplicate", path: "$/Activities[1]", message: "An XML value occurs more than once." }, `<TrainingCenterDatabase xmlns="${tcxNamespace}"><Activities>${validActivity}</Activities><Activities>${validActivity}</Activities></TrainingCenterDatabase>`],
      [{ code: "xml.invalid_number", path: "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]/Cadence[0]", message: "A numeric XML value is invalid." }, tcx(activity(lap(start, point(start, "<Cadence>x</Cadence>"))))],
      [{ code: "xml.invalid_time", path: "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]/Time[0]", message: "An XML time is invalid." }, tcx(activity(lap(start, point("not-time"))))],
      [{ code: "xml.non_chronological", path: "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[1]/Time[0]", message: "XML sample times are not strictly increasing." }, tcx(activity(lap(start, point(start) + point(start))))],
      [{ code: "xml.invalid_coordinate", path: "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]/Position[0]/LatitudeDegrees[0]", message: "An XML coordinate is outside its valid range." }, tcx(activity(lap(start, point(start, "<Position><LatitudeDegrees>91</LatitudeDegrees><LongitudeDegrees>0</LongitudeDegrees></Position>"))))],
      [{ code: "xml.overlap", path: "$/Activities[0]/Activity[0]/Lap[1]/@StartTime", message: "XML lap ranges overlap." }, tcx(activity(lap(start, point(start) + point("2000-01-01T00:00:02Z")) + lap("2000-01-01T00:00:01Z", point("2000-01-01T00:00:03Z"))))],
    ];
    const executed: string[] = [];
    for (const [expected, raw] of cases) {
      const dto = await rejected(raw);
      expect(dto).toEqual(expected);
      expect(dto.message).toBe(XML_QUARANTINE_MESSAGE[expected.code]);
      executed.push(dto.code);
    }
    expect([...new Set(executed)].sort()).toEqual([...XML_QUARANTINE_CODES].sort());
    expect([...new Set(executed)].sort()).toEqual(Object.keys(XML_QUARANTINE_MESSAGE).sort());
  });

  it("keeps a value-free quarantine reason and preserves the first reason", async () => {
    const unique = "UNIQUE_BAD_TOKEN_839201";
    const raw = tcx(activity(lap("2000-01-01T00:00:00Z", point("2000-01-01T00:00:00Z", `<Position><LatitudeDegrees>${unique}</LatitudeDegrees><LongitudeDegrees>-127.123456</LongitudeDegrees></Position>`))));
    const probe = archiveProbe();
    const first = await parseXmlFile(encoder.encode(raw), "tcx", { archive: probe.archive });
    await parseXmlFile(encoder.encode(raw.replace(unique, "OTHER_BAD_TOKEN")), "tcx", { archive: probe.archive });
    expect(first.status).toBe("quarantined");
    expect(probe.reasons).toHaveLength(2);
    expect(probe.reasons[1]).toBe(probe.reasons[0]);
    for (const sourceValue of [unique, "OTHER_BAD_TOKEN", "-127.123456", "2000-01-01T00:00:00Z", "xml parser"]) {
      expect(probe.reasons[0]).not.toContain(sourceValue);
    }
  });

  it("propagates archive failures and dispatches only by the supplied format", async () => {
    const validTcx = tcx(activity(lap("2000-01-01T00:00:00Z", point("2000-01-01T00:00:00Z"))));
    await expect(parseXmlFile(encoder.encode(validTcx), "tcx", { archive: archiveProbe({ writeFailure: true }).archive })).rejects.toThrow("write failed");
    await expect(parseXmlFile(encoder.encode("<bad>"), "tcx", { archive: archiveProbe({ quarantineFailure: true }).archive })).rejects.toThrow("quarantine failed");
    expect((await rejected(gpx, "tcx")).code).toBe("xml.namespace");
    const probe = archiveProbe();
    const result = await parseXmlFile(encoder.encode(gpx), "gpx", { archive: probe.archive });
    expect(result.status).toBe("parsed");
    expect(probe.instants).toEqual([946684800]);
  });

  it("finds the earliest instant iteratively for a large bounded session set", async () => {
    const source = readFileSync("packages/kernel-node/src/ingest/xml-file.ts", "utf8");
    expect(source).not.toMatch(/Math\.min\s*\(\s*\.\.\./);
    const later = activity(lap("2000-01-01T00:00:00Z", point("2000-01-01T00:00:00Z")));
    const earliest = activity(lap("1999-01-01T00:00:00Z", point("1999-01-01T00:00:00Z")));
    const activities = later + earliest + later.repeat(2_046);
    const probe = archiveProbe();
    const result = await parseXmlFile(encoder.encode(tcx(activities)), "tcx", { archive: probe.archive });
    expect(result.status).toBe("parsed");
    if (result.status !== "parsed") throw new Error("expected parse");
    expect(result.report.sessions).toHaveLength(2_048);
    expect(result.candidates).toHaveLength(2_048);
    expect(probe.instants).toEqual([915148800]);
  });
});
