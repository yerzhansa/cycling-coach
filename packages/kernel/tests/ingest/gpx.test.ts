import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGpx } from "../../src/ingest/gpx.js";

const gpx11 = "http://www.topografix.com/GPX/1/1";
const gpx10 = "http://www.topografix.com/GPX/1/0";
const extension = "http://www.garmin.com/xmlschemas/TrackPointExtension/v1";
const fixture = readFileSync("packages/kernel-node/tests/fixtures/ingest/fallback-cycling.gpx", "utf8");
const point = (time: string, attributes = `lat="1" lon="2"`, body = "") => `<trkpt ${attributes}>${body}<time>${time}</time></trkpt>`;
const document = (namespace: string, version: string, body: string, attributes = "") => `<gpx xmlns="${namespace}" xmlns:x="${extension}" version="${version}" ${attributes}>${body}</gpx>`;
const track = (segments: string) => `<trk>${segments}</trk>`;
const segment = (points: string) => `<trkseg>${points}</trkseg>`;
const rejected = (xml: string, code: string, path?: string) => {
  const report = parseGpx(xml);
  expect(report.sessions).toEqual([]);
  expect(report.quarantine).toMatchObject({ code, ...(path ? { path } : {}) });
};

describe("GPX parser", () => {
  it("parses the committed fixture without fabricating unsupported concerns", () => {
    const report = parseGpx(fixture);
    expect(report.quarantine).toBeNull();
    expect(report.sessions[0]).toMatchObject({ sport: null, elapsedS: null, distanceM: null, laps: null, segmentStartIndices: [0], localDateKey: 19980704 });
    expect(Object.keys(report.sessions[0]!.channels)).toEqual(["time", "lat", "lng", "altitude", "heart_rate", "cadence"]);
    for (const name of ["distance", "speed", "power"]) expect(report.sessions[0]!.channels).not.toHaveProperty(name);
  });

  it("accepts only coupled 1.0 and 1.1 namespace/version pairs", () => {
    for (const [namespace, version] of [[gpx11, "1.1"], [gpx10, "1.0"]]) {
      expect(parseGpx(document(namespace, version, track(segment(point("2000-01-01T00:00:00Z"))))).quarantine).toBeNull();
    }
    rejected(document(gpx11, "1.0", track(segment(point("2000-01-01T00:00:00Z")))), "xml.namespace", "$/@version");
    rejected(document(gpx10, "1.1", track(segment(point("2000-01-01T00:00:00Z")))), "xml.namespace", "$/@version");
    rejected(`<gpx xmlns="${gpx11}"></gpx>`, "xml.namespace", "$/@version");
    rejected(`<gpx xmlns="${gpx11}" x:version="1.1" xmlns:x="urn:x"></gpx>`, "xml.namespace", "$/@version");
  });

  it("requires tracks, segments, points, coordinates, and time", () => {
    rejected(document(gpx11, "1.1", ""), "xml.missing_required", "$/trk[0]");
    rejected(document(gpx11, "1.1", track("")), "xml.missing_required", "$/trk[0]/trkseg[0]");
    rejected(document(gpx11, "1.1", track(segment(""))), "xml.missing_required", "$/trk[0]/trkseg[0]/trkpt[0]");
    rejected(document(gpx11, "1.1", track(segment(point("2000-01-01T00:00:00Z", `lat="1"`)))), "xml.missing_required", "$/trk[0]/trkseg[0]/trkpt[0]/@lon");
    rejected(document(gpx11, "1.1", track(segment(`<trkpt lat="1" lon="2"/>`))), "xml.missing_required", "$/trk[0]/trkseg[0]/trkpt[0]/time[0]");
    rejected(document(gpx11, "1.1", track(segment(point("2000-01-01T00:00:00Z", `x:lat="1" lon="2"`)))), "xml.namespace");
  });

  it("preserves track/segment order and aligned optional values", () => {
    const first = segment(point("2000-01-01T00:00:00Z", undefined, "<ele>3</ele>"));
    const second = segment(point("2000-01-01T00:00:01Z") + point("2000-01-01T00:00:02Z", undefined, `<extensions><x:TrackPointExtension><x:hr>120</x:hr><x:cad>80</x:cad></x:TrackPointExtension></extensions>`));
    const report = parseGpx(document(gpx11, "1.1", track(first + second) + track(segment(point("2000-01-02T00:00:00Z")))));
    expect(report.sessions.map((session) => session.sessionOrdinal)).toEqual([0, 1]);
    expect(report.sessions[0]!.segmentStartIndices).toEqual([0, 1]);
    expect(report.sessions[0]!.channels.altitude!.values).toEqual([3, null, null]);
    expect(report.sessions[0]!.channels.heart_rate!.values).toEqual([null, null, 120]);
  });

  it("enforces coordinate, numeric, and chronology contracts", () => {
    rejected(document(gpx11, "1.1", track(segment(point("2000-01-01T00:00:00Z", `lat="91" lon="2"`)))), "xml.invalid_coordinate");
    rejected(document(gpx11, "1.1", track(segment(point("2000-01-01T00:00:00Z", `lat="1" lon="181"`)))), "xml.invalid_coordinate");
    rejected(document(gpx11, "1.1", track(segment(point("2000-01-01T00:00:00Z", `lat="x" lon="2"`)))), "xml.invalid_number");
    rejected(document(gpx11, "1.1", track(segment(point("2000-01-01T00:00:00Z") + point("2000-01-01T00:00:00Z")))), "xml.non_chronological");
  });

  it("classifies repeated qualified attributes as parse failures", () => {
    rejected(`<gpx xmlns="${gpx11}" version="1.1" version="1.1"/>`, "xml.parse", "$");
    rejected(document(gpx11, "1.1", track(segment(`<trkpt lat="1" lat="2" lon="3"><time>2000-01-01T00:00:00Z</time></trkpt>`))), "xml.parse", "$");
  });

  it("ignores waypoints, routes, and unsupported extensions", () => {
    const unsupported = point("2000-01-01T00:00:00Z", undefined, `<extensions><u:TrackPointExtension xmlns:u="urn:other" foreign="allowed"><u:hr nested="allowed"><x:cad bad="ignored">not-a-number</x:cad></u:hr></u:TrackPointExtension><u:Unknown xmlns:u="urn:unknown" bad="allowed"><x:TrackPointExtension bad="ignored"><x:hr>0</x:hr></x:TrackPointExtension></u:Unknown></extensions>`);
    const report = parseGpx(document(gpx11, "1.1", `<wpt lat="0" lon="0"/><rte><rtept lat="0" lon="0"/></rte>${track(segment(unsupported))}`));
    expect(report.quarantine).toBeNull();
    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]!.channels).not.toHaveProperty("heart_rate");
  });

  it("rejects wrong roots, unqualified documents, and unsupported core namespaces", () => {
    rejected(`<not-gpx xmlns="${gpx11}" version="1.1"/>`, "xml.namespace", "$");
    rejected(`<gpx version="1.1"><trk/></gpx>`, "xml.namespace", "$");
    rejected(`<gpx xmlns="http://www.topografix.com/GPX/1/2" version="1.2"/>`, "xml.namespace", "$");
    rejected(`<gpx xmlns="${gpx11}" version="1.1" x:version="1.1" xmlns:x="urn:x"/>`, "xml.namespace", "$/@version");
  });

  it("covers every GPX singleton duplicate at its second occurrence", () => {
    const time = "2000-01-01T00:00:00Z";
    const cases = [
      [`<trkpt lat="1" lon="2"><time>${time}</time><time>${time}</time></trkpt>`, "$/trk[0]/trkseg[0]/trkpt[0]/time[1]"],
      [`<trkpt lat="1" lon="2"><ele>1</ele><ele>2</ele><time>${time}</time></trkpt>`, "$/trk[0]/trkseg[0]/trkpt[0]/ele[1]"],
      [`<trkpt lat="1" lon="2"><extensions/><extensions/><time>${time}</time></trkpt>`, "$/trk[0]/trkseg[0]/trkpt[0]/extensions[1]"],
      [`<trkpt lat="1" lon="2"><extensions><x:TrackPointExtension/><x:TrackPointExtension/></extensions><time>${time}</time></trkpt>`, "$/trk[0]/trkseg[0]/trkpt[0]/extensions[0]/TrackPointExtension[1]"],
      [`<trkpt lat="1" lon="2"><extensions><x:TrackPointExtension><x:hr>1</x:hr><x:hr>2</x:hr></x:TrackPointExtension></extensions><time>${time}</time></trkpt>`, "$/trk[0]/trkseg[0]/trkpt[0]/extensions[0]/TrackPointExtension[0]/hr[1]"],
      [`<trkpt lat="1" lon="2"><extensions><x:TrackPointExtension><x:cad>1</x:cad><x:cad>2</x:cad></x:TrackPointExtension></extensions><time>${time}</time></trkpt>`, "$/trk[0]/trkseg[0]/trkpt[0]/extensions[0]/TrackPointExtension[0]/cad[1]"],
    ] as const;
    for (const [pointXml, path] of cases) rejected(document(gpx11, "1.1", track(segment(pointXml))), "xml.duplicate", path);
  });

  it("covers coordinate grammar and every coordinate boundary", () => {
    const time = "2000-01-01T00:00:00Z";
    for (const token of ["", ".", "+1", "1_0", "1x", "NaN", "Infinity", "1e999"]) {
      rejected(document(gpx11, "1.1", track(segment(point(time, `lat="${token}" lon="0"`)))), "xml.invalid_number", "$/trk[0]/trkseg[0]/trkpt[0]/@lat");
    }
    for (const [lat, lon] of [["-90", "-180"], ["90", "180"], ["-0", "-0"]]) {
      const report = parseGpx(document(gpx11, "1.1", track(segment(point(time, `lat="${lat}" lon="${lon}"`)))));
      expect(report.quarantine).toBeNull();
      expect(Object.is(report.sessions[0]!.channels.lat!.values[0], -0)).toBe(false);
      expect(Object.is(report.sessions[0]!.channels.lng!.values[0], -0)).toBe(false);
    }
    for (const [lat, lon] of [["-90.0001", "0"], ["90.0001", "0"], ["0", "-180.0001"], ["0", "180.0001"]]) {
      rejected(document(gpx11, "1.1", track(segment(point(time, `lat="${lat}" lon="${lon}"`)))), "xml.invalid_coordinate");
    }
  });

  it("validates mapped extensions, ignores wrong namespaces, and rejects nested recognized leaves", () => {
    const time = "2000-01-01T00:00:00Z";
    for (const [name, value] of [["hr", "0"], ["hr", "256"], ["cad", "-1"], ["cad", "256"], ["cad", "1.5"]] as const) {
      const body = `<extensions><x:TrackPointExtension><x:${name}>${value}</x:${name}></x:TrackPointExtension></extensions>`;
      rejected(document(gpx11, "1.1", track(segment(point(time, undefined, body)))), "xml.invalid_number");
    }
    const wrongNamespace = `<extensions><y:TrackPointExtension xmlns:y="urn:wrong"><y:hr>0</y:hr><y:cad>999</y:cad></y:TrackPointExtension></extensions>`;
    const ignored = parseGpx(document(gpx11, "1.1", track(segment(point(time, undefined, wrongNamespace)))));
    expect(ignored.quarantine).toBeNull();
    expect(ignored.sessions[0]!.channels).not.toHaveProperty("heart_rate");
    for (const leaves of [
      "<hr>120</hr><cad>80</cad>",
      '<y:hr xmlns:y="urn:wrong">120</y:hr><y:cad xmlns:y="urn:wrong">80</y:cad>',
    ]) {
      const body = `<extensions><x:TrackPointExtension>${leaves}</x:TrackPointExtension></extensions>`;
      const report = parseGpx(document(gpx11, "1.1", track(segment(point(time, undefined, body)))));
      expect(report.quarantine).toBeNull();
      expect(report.sessions[0]!.channels).not.toHaveProperty("heart_rate");
      expect(report.sessions[0]!.channels).not.toHaveProperty("cadence");
    }
    const direct = `<extensions><x:TrackPointExtension><x:hr>120</x:hr></x:TrackPointExtension></extensions>`;
    expect(parseGpx(document(gpx11, "1.1", track(segment(point(time, undefined, direct))))).sessions[0]!.channels.heart_rate!.values).toEqual([120]);
    const nested = `<extensions><x:TrackPointExtension><x:hr><x:Value>120</x:Value></x:hr></x:TrackPointExtension></extensions>`;
    rejected(document(gpx11, "1.1", track(segment(point(time, undefined, nested)))), "xml.namespace", "$/trk[0]/trkseg[0]/trkpt[0]/extensions[0]/TrackPointExtension[0]/hr[0]/Value[0]");
  });

  it("accepts the upper UTC nanosecond boundary and exercises civil-time rejection", () => {
    const upper = "9999-12-31T23:59:59.999999999Z";
    expect(parseGpx(document(gpx11, "1.1", track(segment(point(upper))))).quarantine).toBeNull();
    for (const time of ["1900-02-29T00:00:00Z", "2000-02-30T00:00:00Z", "0001-01-01T00:00:00+00:01", "9999-12-31T23:59:59-00:01", "2000-01-01T00:00:00"]) {
      rejected(document(gpx11, "1.1", track(segment(point(time)))), "xml.invalid_time");
    }
  });

  it("preserves segment boundary chronology and keeps parse results independent", () => {
    const xml = document(gpx11, "1.1", track(segment(point("2000-01-01T00:00:00Z")) + segment(point("2000-01-01T00:00:01Z"))));
    const report = parseGpx(xml);
    expect(report.quarantine).toBeNull();
    expect(report.sessions[0]!.segmentStartIndices).toEqual([0, 1]);
    (report.sessions[0]!.segmentStartIndices as unknown as number[])[0] = 99;
    (report.sessions[0]!.channels.time!.values as unknown as number[])[0] = 99;
    expect(parseGpx(xml).sessions[0]).toMatchObject({ segmentStartIndices: [0, 1], channels: { time: { values: [946684800, 946684801] } } });
    const reversed = document(gpx11, "1.1", track(segment(point("2000-01-01T00:00:01Z")) + segment(point("2000-01-01T00:00:00Z"))));
    rejected(reversed, "xml.non_chronological", "$/trk[0]/trkseg[1]/trkpt[0]/time[0]");
  });
});
