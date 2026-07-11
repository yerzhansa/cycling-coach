import { describe, expect, it } from "vitest";
import { canonicalizeTable } from "../src/store/dump.js";
import type { Row } from "../src/store/ports.js";

describe("INV-2 canonical dump (armed with real ingest at W2)", () => {
  const rowA: Row = {
    id: "a1",
    sport: "cycling",
    anchor_type: "ftp",
    value: 250.5,
    unit: "W",
    valid_from: 1000,
    source: "manual",
    confidence: "manual",
    note: null,
    provenance: "manual",
    device_id: null,
    hlc_physical_ms: null,
    hlc_counter: null,
  };
  const rowB: Row = {
    id: "a2",
    sport: "cycling",
    anchor_type: "ftp",
    value: 260,
    unit: "W",
    valid_from: 2000,
    source: "manual",
    confidence: "manual",
    note: null,
    provenance: "manual",
    device_id: null,
    hlc_physical_ms: null,
    hlc_counter: null,
  };

  it("emits a table header and one line per row, stable across calls", () => {
    const out = canonicalizeTable("anchor_history", [rowA, rowB]);
    expect(out.startsWith("# anchor_history")).toBe(true);
    expect(out.split("\n")).toHaveLength(3);
    expect(canonicalizeTable("anchor_history", [rowA, rowB])).toBe(out);
  });

  it("normalizes column key order inside a row", () => {
    const scrambled: Row = {
      value: 250.5,
      id: "a1",
      sport: "cycling",
      anchor_type: "ftp",
      unit: "W",
      valid_from: 1000,
      source: "manual",
      confidence: "manual",
      note: null,
      provenance: "manual",
      device_id: null,
      hlc_physical_ms: null,
      hlc_counter: null,
    };
    expect(canonicalizeTable("anchor_history", [scrambled])).toBe(
      canonicalizeTable("anchor_history", [rowA]),
    );
  });

  it("renders a BLOB column via the ['b', ...] tag", () => {
    const row: Row = { data: new Uint8Array([1, 2, 3]) };
    const out = canonicalizeTable("raw_file", [row]);
    expect(out).toContain(`"data":["b","010203"]`);
  });
});
