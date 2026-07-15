import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTcx } from "../../src/ingest/tcx.js";

const namespace = "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2";
const extension = "http://www.garmin.com/xmlschemas/ActivityExtension/v2";
const fixture = readFileSync("packages/kernel-node/tests/fixtures/ingest/fallback-cycling.tcx", "utf8");
const point = (time: string, extra = "") => `<Trackpoint><Time>${time}</Time>${extra}</Trackpoint>`;
const lap = (start: string, points: string, summary = "") => `<Lap StartTime="${start}">${summary}<Track>${points}</Track></Lap>`;
const activity = (sport: string, laps: string) => `<Activity Sport="${sport}">${laps}</Activity>`;
const document = (activities: string) => `<TrainingCenterDatabase xmlns="${namespace}" xmlns:a="${extension}"><Activities>${activities}</Activities></TrainingCenterDatabase>`;
const rejected = (xml: string, code: string, path?: string) => {
  const report = parseTcx(xml);
  expect(report.sessions).toEqual([]);
  expect(report.quarantine).toMatchObject({ code, ...(path ? { path } : {}) });
};

describe("TCX parser", () => {
  it("parses the committed v2 fixture and every mapped channel", () => {
    const report = parseTcx(fixture);
    expect(report.quarantine).toBeNull();
    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]).toMatchObject({ sport: "cycling", startUtc: 899553600, elapsedS: 2, distanceM: 20, localDateKey: 19980704 });
    expect(Object.keys(report.sessions[0]!.channels)).toEqual(["time", "lat", "lng", "distance", "altitude", "speed", "heart_rate", "cadence", "power"]);
    expect(report.sessions[0]!.channels.power!.values).toEqual([180, 190, 200]);
    expect(report.sessions[0]!.laps).toEqual([{ lapSeq: 0, startUtc: 899553600, elapsedS: 2, distanceM: 20, firstSampleIndex: 0, endSampleIndexExclusive: 3 }]);
  });

  it("maps sports exactly and preserves repeated activities", () => {
    const one = lap("2000-01-01T00:00:00Z", point("2000-01-01T00:00:00Z"));
    const report = parseTcx(document(["Biking", "Running", "Other", "Road Bike", "Biking"].map((sport) => activity(sport, one)).join("")));
    expect(report.sessions.map((session) => session.sport)).toEqual(["cycling", "running", "other", "unknown:Road Bike", "cycling"]);
    expect(report.sessions.map((session) => session.sessionOrdinal)).toEqual([0, 1, 2, 3, 4]);
  });

  it("requires the exact root, activities, laps, tracks, points, and fields", () => {
    rejected(`<TrainingCenterDatabase><Activities/></TrainingCenterDatabase>`, "xml.namespace", "$");
    rejected(`<TrainingCenterDatabase xmlns="urn:wrong"/>`, "xml.namespace", "$");
    rejected(`<TrainingCenterDatabase xmlns="${namespace}"/>`, "xml.missing_required", "$/Activities[0]");
    const validActivity = activity("Biking", lap("2000-01-01T00:00:00Z", point("2000-01-01T00:00:00Z")));
    rejected(`<TrainingCenterDatabase xmlns="${namespace}"><Activities>${validActivity}</Activities><Activities>${validActivity}</Activities></TrainingCenterDatabase>`, "xml.duplicate", "$/Activities[1]");
    rejected(document(""), "xml.missing_required", "$/Activities[0]/Activity[0]");
    rejected(document(`<Activity/>`), "xml.missing_required", "$/Activities[0]/Activity[0]/@Sport");
    rejected(document(`<Activity Sport="Biking"/>`), "xml.missing_required", "$/Activities[0]/Activity[0]/Lap[0]");
    rejected(document(activity("Biking", `<Lap StartTime="2000-01-01T00:00:00Z"/>`)), "xml.missing_required");
  });

  it("enforces position pairs, ranges, and numeric channels", () => {
    const prefix = "2000-01-01T00:00:00Z";
    rejected(document(activity("Biking", lap(prefix, point(prefix, `<Position><LatitudeDegrees>1</LatitudeDegrees></Position>`)))), "xml.missing_required", "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]/Position[0]/LongitudeDegrees[0]");
    rejected(document(activity("Biking", lap(prefix, point(prefix, `<Position><LatitudeDegrees>91</LatitudeDegrees><LongitudeDegrees>0</LongitudeDegrees></Position>`)))), "xml.invalid_coordinate");
    rejected(document(activity("Biking", lap(prefix, point(prefix, `<HeartRateBpm><Value>0</Value></HeartRateBpm>`)))), "xml.invalid_number");
    rejected(document(activity("Biking", lap(prefix, point(prefix, `<Cadence>256</Cadence>`)))), "xml.invalid_number");
    const both = document(activity("Biking", lap(prefix, point(prefix, `<Cadence>80</Cadence><Extensions><a:TPX><a:RunCadence>81</a:RunCadence></a:TPX></Extensions>`))));
    rejected(both, "xml.duplicate");
  });

  it("preserves fractional time and validates civil-time boundaries", () => {
    const report = parseTcx(document(activity("Other", lap("0099-12-31T23:00:00-01:00", point("0100-01-01T00:00:00.123456789Z"), `<TotalTimeSeconds>.5</TotalTimeSeconds><DistanceMeters>1.25</DistanceMeters>`))));
    expect(report.quarantine).toBeNull();
    expect(report.sessions[0]).toMatchObject({ localDateKey: 1000101, elapsedS: 0.5, distanceM: 1.25 });
    expect(report.sessions[0]!.channels.time!.values[0]).toBeCloseTo(-59011459199.87654, 5);
    for (const time of ["0001-01-01T00:00:00+00:01", "9999-12-31T23:59:59-00:01", "1900-02-29T00:00:00Z", "2000-02-30T00:00:00Z", "2000-01-01T00:00:00"] ) {
      rejected(document(activity("Biking", lap(time, point(time)))), "xml.invalid_time");
    }
    for (const time of [
      "0001-01-01T00:00:00Z",
      "0004-02-29T00:00:00Z",
      "0099-12-31T23:59:59Z",
      "0100-03-01T00:00:00Z",
      "1900-03-01T00:00:00Z",
      "2000-02-29T00:00:00Z",
      "9999-12-31T23:59:59Z",
      "2000-01-01T00:30:00+01:00",
      "1999-12-31T23:30:00-01:00",
    ]) {
      expect(parseTcx(document(activity("Biking", lap(time, point(time))))).quarantine).toBeNull();
    }
  });

  it("applies quarantine precedence document-wide before document order", () => {
    const start = "2000-01-01T00:00:00Z";
    const invalidNumber = activity("Biking", lap(start, point(start, "<Cadence>x</Cadence>")));
    const invalidTime = activity("Biking", lap(start, point("not-time")));
    const invalidCoordinate = activity("Biking", lap(start, point(start, "<Position><LatitudeDegrees>91</LatitudeDegrees><LongitudeDegrees>0</LongitudeDegrees></Position>")));
    const overlap = activity("Biking", lap(start, point(start) + point("2000-01-01T00:00:02Z")) + lap("2000-01-01T00:00:01Z", point("2000-01-01T00:00:03Z")));
    rejected(document(invalidNumber + `<Activity>${lap(start, point(start))}</Activity>`), "xml.missing_required", "$/Activities[0]/Activity[1]/@Sport");
    rejected(document(invalidTime + invalidNumber), "xml.invalid_number", "$/Activities[0]/Activity[1]/Lap[0]/Track[0]/Trackpoint[0]/Cadence[0]");
    rejected(document(invalidCoordinate + invalidTime), "xml.invalid_time", "$/Activities[0]/Activity[1]/Lap[0]/Track[0]/Trackpoint[0]/Time[0]");
    rejected(document(overlap + invalidCoordinate), "xml.invalid_coordinate", "$/Activities[0]/Activity[1]/Lap[0]/Track[0]/Trackpoint[0]/Position[0]/LatitudeDegrees[0]");
  });

  it("checks chronology, lap starts, overlap, and aggregate overflow", () => {
    rejected(document(activity("Biking", lap("2000-01-01T00:00:00Z", point("2000-01-01T00:00:01Z") + point("2000-01-01T00:00:01Z")))), "xml.non_chronological");
    rejected(document(activity("Biking", lap("2000-01-01T00:00:02Z", point("2000-01-01T00:00:01Z")))), "xml.non_chronological", "$/Activities[0]/Activity[0]/Lap[0]/@StartTime");
    const overlapping = lap("2000-01-01T00:00:00Z", point("2000-01-01T00:00:00Z") + point("2000-01-01T00:00:02Z")) + lap("2000-01-01T00:00:01Z", point("2000-01-01T00:00:03Z"));
    rejected(document(activity("Biking", overlapping)), "xml.overlap", "$/Activities[0]/Activity[0]/Lap[1]/@StartTime");
    const huge = `<TotalTimeSeconds>1e308</TotalTimeSeconds><DistanceMeters>1e308</DistanceMeters>`;
    const overflow = lap("2000-01-01T00:00:00Z", point("2000-01-01T00:00:00Z"), huge) + lap("2000-01-01T00:00:01Z", point("2000-01-01T00:00:01Z"), huge);
    rejected(document(activity("Biking", overflow)), "xml.invalid_number");
  });

  it("ignores unsupported extension versions without inventing channels", () => {
    const xml = document(activity("Biking", lap("2000-01-01T00:00:00Z", point("2000-01-01T00:00:00Z", `<Extensions><x:TPX xmlns:x="http://www.garmin.com/xmlschemas/ActivityExtension/v1" foreign="allowed"><x:Speed nested="allowed"><x:Unknown bad="still-ignored"/></x:Speed></x:TPX><u:Unknown xmlns:u="urn:other" bad="allowed"><a:TPX bad="ignored"><a:Watts>not-a-number</a:Watts></a:TPX></u:Unknown></Extensions>`))));
    const report = parseTcx(xml);
    expect(report.quarantine).toBeNull();
    expect(report.sessions[0]!.channels).not.toHaveProperty("speed");
    expect(report.sessions[0]!.channels).not.toHaveProperty("power");
  });

  it("covers every required container and leaf with exact missing anchors", () => {
    const time = "2000-01-01T00:00:00Z";
    const cases = [
      [document(activity("Biking", `<Lap StartTime="${time}"><Track/></Lap>`)), "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]"],
      [document(activity("Biking", `<Lap StartTime="${time}"><Track><Trackpoint/></Track></Lap>`)), "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]/Time[0]"],
      [document(activity("Biking", `<Lap><Track>${point(time)}</Track></Lap>`)), "$/Activities[0]/Activity[0]/Lap[0]/@StartTime"],
      [document(activity("Biking", lap(time, point(time, "<Position><LongitudeDegrees>2</LongitudeDegrees></Position>")))), "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]/Position[0]/LatitudeDegrees[0]"],
      [document(activity("Biking", lap(time, point(time, "<Position><LatitudeDegrees>1</LatitudeDegrees></Position>")))), "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]/Position[0]/LongitudeDegrees[0]"],
      [document(activity("Biking", lap(time, point(time, "<HeartRateBpm/>")))), "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]/HeartRateBpm[0]/Value[0]"],
    ] as const;
    for (const [xml, path] of cases) rejected(xml, "xml.missing_required", path);
  });

  it("covers every singleton duplicate at the second occurrence", () => {
    const time = "2000-01-01T00:00:00Z";
    const leaf = (name: string, value: string) => `<${name}>${value}</${name}>`;
    const duplicateCases = [
      [lap(time, point(time), leaf("TotalTimeSeconds", "1") + leaf("TotalTimeSeconds", "2")), "$/Activities[0]/Activity[0]/Lap[0]/TotalTimeSeconds[1]"],
      [lap(time, point(time), leaf("DistanceMeters", "1") + leaf("DistanceMeters", "2")), "$/Activities[0]/Activity[0]/Lap[0]/DistanceMeters[1]"],
      [lap(time, `<Trackpoint>${leaf("Time", time)}${leaf("Time", time)}</Trackpoint>`), "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]/Time[1]"],
      [lap(time, point(time, "<Position><LatitudeDegrees>1</LatitudeDegrees><LongitudeDegrees>2</LongitudeDegrees></Position><Position><LatitudeDegrees>3</LatitudeDegrees><LongitudeDegrees>4</LongitudeDegrees></Position>")), "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]/Position[1]"],
      [lap(time, point(time, leaf("AltitudeMeters", "1") + leaf("AltitudeMeters", "2"))), "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]/AltitudeMeters[1]"],
      [lap(time, point(time, leaf("DistanceMeters", "1") + leaf("DistanceMeters", "2"))), "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]/DistanceMeters[1]"],
      [lap(time, point(time, "<HeartRateBpm><Value>1</Value></HeartRateBpm><HeartRateBpm><Value>2</Value></HeartRateBpm>")), "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]/HeartRateBpm[1]"],
      [lap(time, point(time, leaf("Cadence", "1") + leaf("Cadence", "2"))), "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]/Cadence[1]"],
      [lap(time, point(time, "<Extensions/><Extensions/>")), "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]/Extensions[1]"],
      [lap(time, point(time, "<Position><LatitudeDegrees>1</LatitudeDegrees><LatitudeDegrees>2</LatitudeDegrees><LongitudeDegrees>3</LongitudeDegrees></Position>")), "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]/Position[0]/LatitudeDegrees[1]"],
      [lap(time, point(time, "<Position><LatitudeDegrees>1</LatitudeDegrees><LongitudeDegrees>2</LongitudeDegrees><LongitudeDegrees>3</LongitudeDegrees></Position>")), "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]/Position[0]/LongitudeDegrees[1]"],
      [lap(time, point(time, "<HeartRateBpm><Value>1</Value><Value>2</Value></HeartRateBpm>")), "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]/HeartRateBpm[0]/Value[1]"],
      [lap(time, point(time, "<Extensions><a:TPX/><a:TPX/></Extensions>")), "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]/Extensions[0]/TPX[1]"],
      [lap(time, point(time, "<Extensions><a:TPX><a:Speed>1</a:Speed><a:Speed>2</a:Speed></a:TPX></Extensions>")), "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]/Extensions[0]/TPX[0]/Speed[1]"],
      [lap(time, point(time, "<Extensions><a:TPX><a:RunCadence>1</a:RunCadence><a:RunCadence>2</a:RunCadence></a:TPX></Extensions>")), "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]/Extensions[0]/TPX[0]/RunCadence[1]"],
      [lap(time, point(time, "<Extensions><a:TPX><a:Watts>1</a:Watts><a:Watts>2</a:Watts></a:TPX></Extensions>")), "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]/Extensions[0]/TPX[0]/Watts[1]"],
    ] as const;
    for (const [lapXml, path] of duplicateCases) rejected(document(activity("Biking", lapXml)), "xml.duplicate", path);
  });

  it("validates every numeric grammar and range family before time", () => {
    const time = "2000-01-01T00:00:00Z";
    for (const token of ["", ".", "+1", "1_0", "1x", "NaN", "Infinity", "1e999"]) {
      rejected(document(activity("Biking", lap(time, point(time, `<AltitudeMeters>${token}</AltitudeMeters>`)))), "xml.invalid_number");
    }
    for (const token of ["1.0", "+1", "1e2", "9007199254740992"]) {
      rejected(document(activity("Biking", lap(time, point(time, `<Cadence>${token}</Cadence>`)))), "xml.invalid_number");
    }
    for (const value of ["0", "256"]) rejected(document(activity("Biking", lap(time, point(time, `<HeartRateBpm><Value>${value}</Value></HeartRateBpm>`)))), "xml.invalid_number");
    for (const value of ["-1", "256"]) rejected(document(activity("Biking", lap(time, point(time, `<Cadence>${value}</Cadence>`)))), "xml.invalid_number");
    for (const [name, value] of [["Speed", "-1"], ["Watts", "-1"], ["RunCadence", "256"]] as const) {
      rejected(document(activity("Biking", lap(time, point(time, `<Extensions><a:TPX><a:${name}>${value}</a:${name}></a:TPX></Extensions>`)))), "xml.invalid_number");
    }
    rejected(document(activity("Biking", lap(time, point("bad-time", "<Position><LatitudeDegrees>not-a-number</LatitudeDegrees><LongitudeDegrees>0</LongitudeDegrees></Position>")))), "xml.invalid_number", "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]/Position[0]/LatitudeDegrees[0]");
  });

  it("accepts coordinate boundaries, rejects each just-outside boundary, and normalizes negative zero", () => {
    const time = "2000-01-01T00:00:00Z";
    for (const [lat, lng] of [["-90", "-180"], ["90", "180"], ["-0", "-0"]]) {
      const position = `<Position><LatitudeDegrees>${lat}</LatitudeDegrees><LongitudeDegrees>${lng}</LongitudeDegrees></Position>`;
      const report = parseTcx(document(activity("Biking", lap(time, point(time, position)))));
      expect(report.quarantine).toBeNull();
      expect(Object.is(report.sessions[0]!.channels.lat!.values[0], -0)).toBe(false);
      expect(Object.is(report.sessions[0]!.channels.lng!.values[0], -0)).toBe(false);
    }
    for (const [lat, lng] of [["-90.0001", "0"], ["90.0001", "0"], ["0", "-180.0001"], ["0", "180.0001"]]) {
      rejected(document(activity("Biking", lap(time, point(time, `<Position><LatitudeDegrees>${lat}</LatitudeDegrees><LongitudeDegrees>${lng}</LongitudeDegrees></Position>`)))), "xml.invalid_coordinate");
    }
  });

  it("checks elapsed and distance aggregate overflow independently at the second lap", () => {
    const first = "2000-01-01T00:00:00Z";
    const second = "2000-01-01T00:00:01Z";
    const pair = (summary1: string, summary2: string) => document(activity("Biking", lap(first, point(first), summary1) + lap(second, point(second), summary2)));
    rejected(pair("<TotalTimeSeconds>1e308</TotalTimeSeconds>", "<TotalTimeSeconds>1e308</TotalTimeSeconds>"), "xml.invalid_number", "$/Activities[0]/Activity[0]/Lap[1]/TotalTimeSeconds[0]");
    rejected(pair("<DistanceMeters>1e308</DistanceMeters>", "<DistanceMeters>1e308</DistanceMeters>"), "xml.invalid_number", "$/Activities[0]/Activity[0]/Lap[1]/DistanceMeters[0]");
  });

  it("preserves track/lap order and allows touching lap boundaries without mutating prior results", () => {
    const first = `<Lap StartTime="2000-01-01T00:00:00Z"><Track>${point("2000-01-01T00:00:00Z")}</Track><Track>${point("2000-01-01T00:00:02Z")}</Track></Lap>`;
    const second = lap("2000-01-01T00:00:02Z", point("2000-01-01T00:00:03Z"));
    const xml = document(activity("Biking", first + second));
    const report = parseTcx(xml);
    expect(report.quarantine).toBeNull();
    expect(report.sessions[0]!.channels.time!.values).toEqual([946684800, 946684802, 946684803]);
    expect(report.sessions[0]!.laps?.map((value) => [value.firstSampleIndex, value.endSampleIndexExclusive])).toEqual([[0, 2], [2, 3]]);
    (report.sessions[0]!.channels.time!.values as unknown as number[])[0] = 0;
    expect(parseTcx(xml).sessions[0]!.channels.time!.values[0]).toBe(946684800);
  });

  it("accepts the upper UTC nanosecond boundary and rejects nested children in recognized extension leaves", () => {
    const upper = "9999-12-31T23:59:59.999999999Z";
    expect(parseTcx(document(activity("Biking", lap(upper, point(upper))))).quarantine).toBeNull();
    const time = "2000-01-01T00:00:00Z";
    const direct = document(activity("Biking", lap(time, point(time, "<Extensions><a:TPX><a:Watts>250</a:Watts></a:TPX></Extensions>"))));
    expect(parseTcx(direct).sessions[0]!.channels.power!.values).toEqual([250]);
    const nested = document(activity("Biking", lap(time, point(time, "<Extensions><a:TPX><a:Watts><a:Value>250</a:Value></a:Watts></a:TPX></Extensions>"))));
    rejected(nested, "xml.namespace", "$/Activities[0]/Activity[0]/Lap[0]/Track[0]/Trackpoint[0]/Extensions[0]/TPX[0]/Watts[0]/Value[0]");
  });
});
