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
