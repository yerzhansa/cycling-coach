import { describe, expect, it } from "vitest";
import { verifyStoryCoverage, type CoverageEntry } from "./coverage.js";

const coverage = [
  { id: "desktop--settings", kind: "ready" },
  { id: "plan--question", kind: "pending", dependency: "Owning Plan change must land first." },
] satisfies readonly CoverageEntry[];

function index(...ids: readonly string[]) {
  return {
    v: 5,
    entries: Object.fromEntries(
      ids.map((id) => [id, { id, type: "story", title: "Desktop", name: "Settings" }]),
    ),
  };
}

describe("Storybook coverage", () => {
  it("requires the complete ready catalogue even when running a subset", () => {
    const entries = [
      ...coverage,
      { id: "desktop--training", kind: "ready" },
    ] satisfies readonly CoverageEntry[];
    expect(
      verifyStoryCoverage(index("desktop--settings", "desktop--training"), entries, [
        "desktop--settings",
      ]),
    ).toEqual({
      readyIds: ["desktop--settings", "desktop--training"],
      selectedIds: ["desktop--settings"],
      pending: [{ id: "plan--question", dependency: "Owning Plan change must land first." }],
    });
    expect(() =>
      verifyStoryCoverage(index("desktop--settings"), entries, ["desktop--settings"]),
    ).toThrow("missing: desktop--training");
  });

  it("rejects unregistered stories and missing ready stories", () => {
    expect(() => verifyStoryCoverage(index("desktop--settings", "unregistered"), coverage)).toThrow(
      "unregistered: unregistered",
    );
    expect(() => verifyStoryCoverage(index("different"), coverage)).toThrow(
      "missing: desktop--settings",
    );
  });

  it("exempts only the explicitly named Coverage/Pending report", () => {
    const valid = index("desktop--settings");
    const entries = {
      ...valid.entries,
      "coverage--pending": {
        id: "coverage--pending",
        type: "story",
        title: "Coverage",
        name: "Pending",
      },
    };
    expect(verifyStoryCoverage({ ...valid, entries }, coverage).readyIds).toEqual([
      "desktop--settings",
    ]);
    expect(() =>
      verifyStoryCoverage(
        {
          ...valid,
          entries: {
            ...entries,
            "coverage--pending": { ...entries["coverage--pending"], title: "Plan" },
          },
        },
        coverage,
      ),
    ).toThrow("only the Coverage/Pending");
    expect(() =>
      verifyStoryCoverage(index("desktop--settings", "coverage--other"), coverage),
    ).toThrow("unregistered: coverage--other");
  });

  it("never counts or selects pending work as executable coverage", () => {
    const mislabeled: { id: string; kind: "ready"; dependency: string } = {
      id: "desktop--settings",
      kind: "ready",
      dependency: "Still blocked",
    };
    expect(() => verifyStoryCoverage(index("desktop--settings"), [mislabeled])).toThrow(
      "ready scenario carries a pending dependency",
    );
    expect(() =>
      verifyStoryCoverage(index("desktop--settings", "plan--question"), coverage),
    ).toThrow("pending scenarios have executable stories");
    expect(() =>
      verifyStoryCoverage(index("desktop--settings"), coverage, ["plan--question"]),
    ).toThrow("pending scenario cannot be selected");
    expect(() =>
      verifyStoryCoverage(index("desktop--settings"), [
        { id: "plan", kind: "pending", dependency: " " },
      ]),
    ).toThrow("lacks a dependency");
  });

  it("rejects duplicate identities, empty coverage and empty or duplicate selections", () => {
    expect(() =>
      verifyStoryCoverage(index("desktop--settings"), [coverage[0], coverage[0]]),
    ).toThrow("duplicates");
    expect(() => verifyStoryCoverage(index("desktop--settings"), [])).toThrow("must not be empty");
    expect(() => verifyStoryCoverage(index("desktop--settings"), coverage, [])).toThrow(
      "must not be empty",
    );
    expect(() =>
      verifyStoryCoverage(index("desktop--settings"), coverage, [
        "desktop--settings",
        "desktop--settings",
      ]),
    ).toThrow("duplicates");
    expect(() => verifyStoryCoverage(index("desktop--settings"), coverage, ["typo"])).toThrow(
      "unknown scenario",
    );
    expect(() => verifyStoryCoverage(index(), coverage)).toThrow("must not be empty");
  });

  it("validates external index identities instead of trusting JSON types", () => {
    expect(() => verifyStoryCoverage(null, coverage)).toThrow("Storybook v5");
    expect(() => verifyStoryCoverage({ v: 5, entries: [] }, coverage)).toThrow("Storybook v5");
    expect(() =>
      verifyStoryCoverage(
        { v: 5, entries: { alias: { id: "desktop--settings", type: "story" } } },
        coverage,
      ),
    ).toThrow("entry identity");
    expect(() =>
      verifyStoryCoverage(
        {
          v: 5,
          entries: { "desktop--settings": { id: "desktop--settings", type: "future-type" } },
        },
        coverage,
      ),
    ).toThrow("entry type");
  });

  it("does not count generated documentation pages as executable scenarios", () => {
    const valid = index("desktop--settings");
    expect(
      verifyStoryCoverage(
        {
          ...valid,
          entries: { ...valid.entries, "desktop--docs": { id: "desktop--docs", type: "docs" } },
        },
        coverage,
      ).readyIds,
    ).toEqual(["desktop--settings"]);
  });
});
