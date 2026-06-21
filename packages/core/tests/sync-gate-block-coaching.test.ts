import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncMutex } from "../src/concurrency/mutex.js";
import { Cooldown } from "../src/concurrency/cooldown.js";
import { createRunSync } from "../src/reference/sync/run-sync.js";
import { writeErrorState } from "../src/reference/sync/error-state-writer.js";
import { emptyFetched } from "./helpers/reference-fixtures.js";

describe("block_coaching write side (gate-reject mitigation)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "block-coaching-write-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function readErrorState(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(dir, "error_state.json"), "utf-8"));
  }

  it("a HARD gate rejection stamps mitigation:block_coaching on error_state.json", async () => {
    const now = new Date("2026-05-09T14:00:00Z");
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);
    const rejectingGate = vi.fn().mockReturnValue({
      ok: false,
      failures: [{ step: "step1_ftp_source", detail: "FTP source missing on athlete profile" }],
      warnings: [],
    });

    const runSync = createRunSync({
      dataDir: dir,
      mutex: new AsyncMutex(),
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      gate: rejectingGate,
      now: () => now,
    });

    const result = await runSync({ caller: "scheduled" });

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("gate_rejected");

    const errorState = readErrorState();
    // Required-red: without the S3 write the field is absent / undefined here.
    expect(errorState.mitigation).toBe("block_coaching");
    expect(errorState.step).toBe("gate_rejected");
  });

  it("soft warnings still write mitigation:warn_only, never block_coaching", async () => {
    const now = new Date("2026-05-09T14:00:00Z");
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);
    const warningGate = vi.fn().mockReturnValue({
      ok: true,
      failures: [],
      warnings: [{ step: "step6_freshness_24h", detail: "data freshness=stale" }],
      freshness: "stale",
    });

    const runSync = createRunSync({
      dataDir: dir,
      mutex: new AsyncMutex(),
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      gate: warningGate,
      now: () => now,
    });

    const result = await runSync({ caller: "scheduled" });
    expect(result.kind).toBe("ran");

    const errorState = readErrorState();
    expect(errorState.mitigation).toBe("warn_only");
    expect(errorState.mitigation).not.toBe("block_coaching");
  });

  it("a later outer_timeout cycle preserves a prior block_coaching (does not re-open coaching while the cache is still unvalidated)", async () => {
    const now = new Date("2026-05-09T14:00:00Z");

    // Cycle 1: a HARD gate rejection stamps block_coaching.
    const rejectingSync = createRunSync({
      dataDir: dir,
      mutex: new AsyncMutex(),
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: vi.fn().mockResolvedValue(emptyFetched),
      gate: vi.fn().mockReturnValue({
        ok: false,
        failures: [{ step: "step1_ftp_source", detail: "FTP source missing" }],
        warnings: [],
      }),
      now: () => now,
    });
    await rejectingSync({ caller: "scheduled" });
    expect(readErrorState().mitigation).toBe("block_coaching");

    // Cycle 2: a transient outer timeout — the cache was never re-validated, so
    // the corruption-class block must survive the mitigation-less timeout write.
    const timingOutSync = createRunSync({
      dataDir: dir,
      mutex: new AsyncMutex(),
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: vi.fn(() => new Promise<never>(() => {})),
      now: () => now,
      timing: { outerTimeoutMs: 30 },
    });
    const result = await timingOutSync({ caller: "scheduled" });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("outer_timeout");

    const errorState = readErrorState();
    expect(errorState.step).toBe("outer_timeout");
    expect(errorState.mitigation).toBe("block_coaching");
  });

  it("a pre-existing block_coaching survives an outer_timeout cycle: the timeout-path record still carries the block (carry-forward)", async () => {
    const now = new Date("2026-05-09T14:00:00Z");

    // Pre-seed a corruption-class block from an earlier HARD gate rejection.
    await writeErrorState(dir, {
      step: "gate_rejected",
      detail: "FTP source missing",
      mitigation: "block_coaching",
    });
    expect(readErrorState().mitigation).toBe("block_coaching");

    // A later tick times out (hanging fetch). The cache was never re-validated,
    // so the mitigation-less timeout write must NOT demote the block — the
    // timeout path carries the prior block_coaching forward off disk.
    const runSync = createRunSync({
      dataDir: dir,
      mutex: new AsyncMutex(),
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: vi.fn(() => new Promise<never>(() => {})),
      now: () => now,
      timing: { outerTimeoutMs: 30 },
    });

    const result = await runSync({ caller: "scheduled" });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("outer_timeout");

    const errorState = readErrorState();
    expect(errorState.step).toBe("outer_timeout");
    expect(errorState.mitigation).toBe("block_coaching");
  });

  it("a clean sync leaves no error_state.json (the block write never leaks onto the happy path)", async () => {
    const now = new Date("2026-05-09T14:00:00Z");
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);
    const cleanGate = vi.fn().mockReturnValue({
      ok: true,
      failures: [],
      warnings: [],
      freshness: "fresh",
    });

    const runSync = createRunSync({
      dataDir: dir,
      mutex: new AsyncMutex(),
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      gate: cleanGate,
      now: () => now,
    });

    const result = await runSync({ caller: "scheduled" });
    expect(result.kind).toBe("ran");
    expect(existsSync(join(dir, "error_state.json"))).toBe(false);
  });
});
