import { describe, expect, it } from "vitest";
import {
  GARMIN_DATA_ATTRIBUTION,
  renderGarminAttribution,
} from "../src/agent/garmin-attribution.js";
import {
  EMPTY_PROVENANCE,
  classifyActivity,
  classifyActivities,
  classifyTrustedSource,
  unionProvenance,
} from "../src/provenance.js";

const GARMIN = { garmin: true, nonGarmin: false, unknown: false };
const NON_GARMIN = { garmin: false, nonGarmin: true, unknown: false };
const UNKNOWN = { garmin: false, nonGarmin: false, unknown: true };

describe("strict source provenance", () => {
  it.each([
    ["GARMIN_CONNECT", GARMIN],
    ["POLAR", NON_GARMIN],
    ["SUUNTO", NON_GARMIN],
    ["COROS", NON_GARMIN],
    ["WAHOO", NON_GARMIN],
    ["ZWIFT", NON_GARMIN],
    ["ZEPP", NON_GARMIN],
    ["CONCEPT2", NON_GARMIN],
    ["HUAWEI", NON_GARMIN],
    ["garmin_connect", UNKNOWN],
    ["STRAVA", UNKNOWN],
    ["UPLOAD", UNKNOWN],
    ["MANUAL", UNKNOWN],
    ["OAUTH_CLIENT", UNKNOWN],
    ["DROPBOX", UNKNOWN],
    [undefined, UNKNOWN],
    [null, UNKNOWN],
    [42, UNKNOWN],
    ["UNRECOGNIZED", UNKNOWN],
  ])("maps exact source %j", (source, expected) => {
    expect(classifyTrustedSource(source)).toEqual(expected);
  });

  it("does not inspect nested fields, device names, prose, names, or tags", () => {
    expect(
      classifyActivity({
        source: "UPLOAD",
        deviceName: "Garmin Edge",
        device_name: "Garmin",
        name: "GARMIN_CONNECT ride",
        tags: ["GARMIN_CONNECT"],
        provider: { source: "GARMIN_CONNECT" },
      }),
    ).toEqual(UNKNOWN);
    expect(classifyActivity({ activity: { source: "GARMIN_CONNECT" } })).toEqual(UNKNOWN);
  });

  it("unions mixed flags monotonically and keeps empty distinct", () => {
    expect(classifyActivities([])).toEqual(EMPTY_PROVENANCE);
    expect(classifyActivities([{ source: "POLAR" }, {}, { source: "GARMIN_CONNECT" }])).toEqual({
      garmin: true,
      nonGarmin: true,
      unknown: true,
    });
    expect(unionProvenance(UNKNOWN, GARMIN, NON_GARMIN, EMPTY_PROVENANCE)).toEqual({
      garmin: true,
      nonGarmin: true,
      unknown: true,
    });
  });
});

describe("renderGarminAttribution", () => {
  it.each([
    ["confirmed Garmin", GARMIN, `Answer.\n\n${GARMIN_DATA_ATTRIBUTION}`],
    ["confirmed non-Garmin", NON_GARMIN, "Answer."],
    ["unknown", UNKNOWN, "Answer."],
    ["empty", EMPTY_PROVENANCE, "Answer."],
  ])("renders for %s only", (_name, provenance, expected) => {
    expect(renderGarminAttribution("Answer.", provenance)).toBe(expected);
  });

  it("leaves unrelated whitespace unchanged without confirmed Garmin provenance", () => {
    expect(renderGarminAttribution("Answer.  \r\n", UNKNOWN)).toBe("Answer.  \r\n");
  });

  it("does not turn an empty reply into an attribution-only reply", () => {
    expect(renderGarminAttribution("", GARMIN)).toBe("");
    expect(renderGarminAttribution(GARMIN_DATA_ATTRIBUTION, GARMIN)).toBe("");
  });

  it.each([
    [
      `First.\n ${GARMIN_DATA_ATTRIBUTION} \nSecond.\n${GARMIN_DATA_ATTRIBUTION}`,
      `First.\nSecond.\n\n${GARMIN_DATA_ATTRIBUTION}`,
      GARMIN,
    ],
    [`First.\r\n${GARMIN_DATA_ATTRIBUTION}\r\nSecond.`, "First.\r\nSecond.", UNKNOWN],
    [
      `The phrase “${GARMIN_DATA_ATTRIBUTION}” remains prose.`,
      `The phrase “${GARMIN_DATA_ATTRIBUTION}” remains prose.`,
      UNKNOWN,
    ],
  ])(
    "removes exact standalone lines and preserves unrelated prose",
    (input, expected, provenance) => {
      expect(renderGarminAttribution(input, provenance)).toBe(expected);
    },
  );
});
