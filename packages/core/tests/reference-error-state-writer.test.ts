// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ERROR_STATE_SCHEMA_VERSION,
  ErrorStateSchema,
} from "../src/reference/schemas/error-state.js";
import { writeErrorState } from "../src/reference/sync/error-state-writer.js";

describe("writeErrorState", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reference-error-state-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes error_state.json with step, detail, phase, schema_version, and ISO ts", async () => {
    await writeErrorState(dir, {
      step: "outer_timeout",
      phase: "writing_cache",
      detail: "fetch hung past 2-min budget",
    });

    const raw = readFileSync(join(dir, "error_state.json"), "utf-8");
    const parsed = ErrorStateSchema.parse(JSON.parse(raw));
    expect(parsed.step).toBe("outer_timeout");
    expect(parsed.phase).toBe("writing_cache");
    expect(parsed.detail).toBe("fetch hung past 2-min budget");
    expect(parsed.schema_version).toBe(ERROR_STATE_SCHEMA_VERSION);
    expect(new Date(parsed.ts).toString()).not.toBe("Invalid Date");
  });

  it("omits phase when not supplied (gate-failure path)", async () => {
    await writeErrorState(dir, {
      step: "gate_rejected",
      detail: "ftp_source_missing",
    });

    const raw = readFileSync(join(dir, "error_state.json"), "utf-8");
    const parsed = ErrorStateSchema.parse(JSON.parse(raw));
    expect(parsed.step).toBe("gate_rejected");
    expect(parsed.phase).toBeUndefined();
  });
});

describe("ErrorStateSchema (forward-design)", () => {
  it("accepts the Wave 4 fields (caller, gate_check, expected, observed, mitigation)", () => {
    // Wave 4's sync-gate writers will populate these fields. Wave 1b
    // doesn't write them, but the on-disk schema accepts them now so
    // Wave 4 doesn't need a schema_version bump. Locks in field names so
    // a typo (e.g. `gate-check` vs `gate_check`) gets caught even before
    // Wave 4 writes its first sample.
    const wave4Sample = {
      schema_version: ERROR_STATE_SCHEMA_VERSION,
      step: "gate_rejected",
      detail: "FTP source missing on athlete profile",
      ts: new Date().toISOString(),
      caller: "scheduled",
      gate_check: "ftp_source_check",
      expected: { source: "test" },
      observed: { source: null },
      mitigation: "warn_only",
    };
    const parsed = ErrorStateSchema.parse(wave4Sample);
    expect(parsed.caller).toBe("scheduled");
    expect(parsed.gate_check).toBe("ftp_source_check");
    expect(parsed.mitigation).toBe("warn_only");
  });

  it("rejects unknown fields (.strict() boundary)", () => {
    // Forward-compat hard line: unrecognized fields are rejected so a
    // typo in a future writer fails loud instead of silently persisting.
    expect(() =>
      ErrorStateSchema.parse({
        schema_version: ERROR_STATE_SCHEMA_VERSION,
        step: "gate_rejected",
        detail: "x",
        ts: new Date().toISOString(),
        future_field_typo: "nope",
      }),
    ).toThrow();
  });
});
