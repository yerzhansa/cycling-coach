import { describe, expect, it } from "vitest";
import {
  appendGarminAttribution,
  GARMIN_DATA_ATTRIBUTION,
} from "../src/agent/garmin-attribution.js";

describe("appendGarminAttribution", () => {
  it.each([
    ["adds an absent footer", "Coaching insight.", `Coaching insight.\n\n${GARMIN_DATA_ATTRIBUTION}`],
    [
      "keeps one footer at the end",
      `Coaching insight.\n\n${GARMIN_DATA_ATTRIBUTION}`,
      `Coaching insight.\n\n${GARMIN_DATA_ATTRIBUTION}`,
    ],
    [
      "moves an exact middle line to the footer",
      `First.\n${GARMIN_DATA_ATTRIBUTION}\nSecond.`,
      `First.\nSecond.\n\n${GARMIN_DATA_ATTRIBUTION}`,
    ],
    [
      "removes repeated exact lines",
      `${GARMIN_DATA_ATTRIBUTION}\nAnswer.\n${GARMIN_DATA_ATTRIBUTION}`,
      `Answer.\n\n${GARMIN_DATA_ATTRIBUTION}`,
    ],
    [
      "deduplicates a CRLF footer",
      `Answer.\r\n${GARMIN_DATA_ATTRIBUTION}\r\n`,
      `Answer.\n\n${GARMIN_DATA_ATTRIBUTION}`,
    ],
    [
      "deduplicates a footer followed only by trailing spaces",
      `Answer.\n\n${GARMIN_DATA_ATTRIBUTION}   `,
      `Answer.\n\n${GARMIN_DATA_ATTRIBUTION}`,
    ],
    [
      "trims only trailing whitespace before the footer",
      "  Keep leading space.  \n\t\n",
      `  Keep leading space.\n\n${GARMIN_DATA_ATTRIBUTION}`,
    ],
    [
      "preserves prose that merely contains the copy",
      `The phrase “${GARMIN_DATA_ATTRIBUTION}” is approved prose.`,
      `The phrase “${GARMIN_DATA_ATTRIBUTION}” is approved prose.\n\n${GARMIN_DATA_ATTRIBUTION}`,
    ],
    ["handles an empty core", "", GARMIN_DATA_ATTRIBUTION],
  ])("%s", (_name, input, expected) => {
    expect(appendGarminAttribution(input)).toBe(expected);
  });
});
