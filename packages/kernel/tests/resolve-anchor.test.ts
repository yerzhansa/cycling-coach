import { describe, expect, it } from "vitest";
import {
  createCyclingFtpAnchorResolver,
  CYCLING_FTP_STALENESS_DEFAULTS,
  type CyclingFtpStalenessThresholds,
} from "../src/anchors/index.js";
import type {
  AnchorHistoryRow,
  AnchorRepository,
} from "../src/store/ports.js";

const SECONDS_PER_DAY = 86_400;
const BASE_EPOCH_S = 946_684_800;
const MAX_YMD_EPOCH_S = 253_402_300_799;

type ReadCurrentCall = readonly [
  sport: string,
  anchorType: string,
  asOfEpochS: number,
];

class ProgrammableAnchorRepository implements AnchorRepository {
  readonly readCurrentCalls: ReadCurrentCall[] = [];

  constructor(public result: AnchorHistoryRow | undefined) {}

  async insertIfAbsent(_row: AnchorHistoryRow): Promise<boolean> {
    throw new Error("insertIfAbsent must not be called");
  }

  async readCurrent(
    sport: string,
    anchorType: string,
    asOfEpochS: number,
  ): Promise<AnchorHistoryRow | undefined> {
    this.readCurrentCalls.push([sport, anchorType, asOfEpochS]);
    return this.result;
  }
}

function anchorRow(overrides: Partial<AnchorHistoryRow> = {}): AnchorHistoryRow {
  return {
    id: "synthetic-ftp",
    sport: "cycling",
    anchor_type: "ftp",
    value: 250,
    unit: "W",
    valid_from: BASE_EPOCH_S,
    source: "manual-entry",
    confidence: "manual",
    note: null,
    provenance: "synthetic",
    device_id: null,
    hlc_physical_ms: null,
    hlc_counter: null,
    ...overrides,
  };
}

async function resolveAtAge(ageSeconds: number) {
  const repository = new ProgrammableAnchorRepository(anchorRow());
  const resolver = createCyclingFtpAnchorResolver(repository);
  return resolver.resolve({
    effectiveAtEpochS: BASE_EPOCH_S,
    evaluatedAtEpochS: BASE_EPOCH_S + ageSeconds,
  });
}

describe("createCyclingFtpAnchorResolver", () => {
  it("returns the exact missing result and delegates once when no row is effective", async () => {
    const repository = new ProgrammableAnchorRepository(undefined);
    const resolver = createCyclingFtpAnchorResolver(repository);

    await expect(resolver.resolve({
      effectiveAtEpochS: BASE_EPOCH_S,
      evaluatedAtEpochS: BASE_EPOCH_S,
    })).resolves.toEqual({
      kind: "missing",
      refusal: "missing-cycling-ftp-anchor",
    });
    expect(repository.readCurrentCalls).toEqual([
      ["cycling", "ftp", BASE_EPOCH_S],
    ]);
  });

  it("returns the same missing result when the repository has only a future row", async () => {
    const repository = new ProgrammableAnchorRepository(undefined);
    const resolver = createCyclingFtpAnchorResolver(repository);

    const result = await resolver.resolve({
      effectiveAtEpochS: BASE_EPOCH_S,
      evaluatedAtEpochS: BASE_EPOCH_S + 1,
    });

    expect(result).toEqual({
      kind: "missing",
      refusal: "missing-cycling-ftp-anchor",
    });
    expect(Object.keys(result)).toEqual(["kind", "refusal"]);
    expect(repository.readCurrentCalls).toEqual([
      ["cycling", "ftp", BASE_EPOCH_S],
    ]);
  });

  it("maps a current row at age zero and exposes frozen defaults", async () => {
    const repository = new ProgrammableAnchorRepository(anchorRow());
    const resolver = createCyclingFtpAnchorResolver(repository);

    await expect(resolver.resolve({
      effectiveAtEpochS: BASE_EPOCH_S,
      evaluatedAtEpochS: BASE_EPOCH_S,
    })).resolves.toEqual({
      kind: "ftp",
      watts: 250,
      validFrom: "2000-01-01",
      source: "manual-entry",
      confidence: "manual",
      ageDays: 0,
      stalenessBand: "fresh",
      stale: false,
    });
    expect(Object.isFrozen(CYCLING_FTP_STALENESS_DEFAULTS)).toBe(true);
    expect(Object.keys(CYCLING_FTP_STALENESS_DEFAULTS)).toEqual([
      "freshMaxDays",
      "agingMaxDays",
      "staleMaxDays",
    ]);
  });

  it("classifies exactly 42 days as fresh", async () => {
    await expect(resolveAtAge(42 * SECONDS_PER_DAY)).resolves.toMatchObject({
      kind: "ftp",
      stalenessBand: "fresh",
      stale: false,
    });
  });

  it("classifies 42 days plus one second as aging", async () => {
    await expect(resolveAtAge(42 * SECONDS_PER_DAY + 1)).resolves.toMatchObject({
      kind: "ftp",
      stalenessBand: "aging",
      stale: true,
    });
  });

  it("classifies exactly 90 days as aging", async () => {
    await expect(resolveAtAge(90 * SECONDS_PER_DAY)).resolves.toMatchObject({
      kind: "ftp",
      stalenessBand: "aging",
      stale: true,
    });
  });

  it("classifies 90 days plus one second as stale", async () => {
    await expect(resolveAtAge(90 * SECONDS_PER_DAY + 1)).resolves.toMatchObject({
      kind: "ftp",
      stalenessBand: "stale",
      stale: true,
    });
  });

  it("classifies exactly 180 days as stale", async () => {
    await expect(resolveAtAge(180 * SECONDS_PER_DAY)).resolves.toMatchObject({
      kind: "ftp",
      stalenessBand: "stale",
      stale: true,
    });
  });

  it("keeps watts exposed beyond 180 days without adding a refusal", async () => {
    const result = await resolveAtAge(180 * SECONDS_PER_DAY + 1);

    expect(result).toMatchObject({
      kind: "ftp",
      watts: 250,
      stalenessBand: "very-stale",
      stale: true,
    });
    expect("refusal" in result).toBe(false);
  });

  it("maps separately selected platform and manual rows without reinterpretation", async () => {
    const platformRepository = new ProgrammableAnchorRepository(anchorRow({
      id: "platform-ftp",
      value: 245,
      source: "connector",
      confidence: "platform",
    }));
    const manualRepository = new ProgrammableAnchorRepository(anchorRow({
      id: "manual-ftp",
      value: 255,
      source: "athlete-entry",
      confidence: "manual",
    }));

    await expect(createCyclingFtpAnchorResolver(platformRepository).resolve({
      effectiveAtEpochS: BASE_EPOCH_S,
      evaluatedAtEpochS: BASE_EPOCH_S,
    })).resolves.toMatchObject({
      kind: "ftp",
      watts: 245,
      source: "connector",
      confidence: "platform",
    });
    await expect(createCyclingFtpAnchorResolver(manualRepository).resolve({
      effectiveAtEpochS: BASE_EPOCH_S,
      evaluatedAtEpochS: BASE_EPOCH_S,
    })).resolves.toMatchObject({
      kind: "ftp",
      watts: 255,
      source: "athlete-entry",
      confidence: "manual",
    });
    expect(platformRepository.readCurrentCalls).toEqual([
      ["cycling", "ftp", BASE_EPOCH_S],
    ]);
    expect(manualRepository.readCurrentCalls).toEqual([
      ["cycling", "ftp", BASE_EPOCH_S],
    ]);
  });

  it("uses all three injected staleness boundaries", async () => {
    const repository = new ProgrammableAnchorRepository(anchorRow());
    const resolver = createCyclingFtpAnchorResolver(repository, {
      thresholds: {
        freshMaxDays: 7,
        agingMaxDays: 14,
        staleMaxDays: 21,
      },
    });
    const cases = [
      [7 * SECONDS_PER_DAY + 1, "aging"],
      [14 * SECONDS_PER_DAY + 1, "stale"],
      [21 * SECONDS_PER_DAY + 1, "very-stale"],
    ] as const;

    for (const [ageSeconds, stalenessBand] of cases) {
      await expect(resolver.resolve({
        effectiveAtEpochS: BASE_EPOCH_S,
        evaluatedAtEpochS: BASE_EPOCH_S + ageSeconds,
      })).resolves.toMatchObject({
        kind: "ftp",
        stalenessBand,
        stale: true,
      });
    }
    expect(repository.readCurrentCalls).toHaveLength(3);
  });

  it("rejects every invalid threshold set during factory construction", () => {
    const fields: readonly (keyof CyclingFtpStalenessThresholds)[] = [
      "freshMaxDays",
      "agingMaxDays",
      "staleMaxDays",
    ];
    const invalidValues = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      1.5,
    ];
    const invalidThresholds: Partial<CyclingFtpStalenessThresholds>[] = [];

    for (const field of fields) {
      for (const value of invalidValues) {
        invalidThresholds.push({
          ...CYCLING_FTP_STALENESS_DEFAULTS,
          [field]: value,
        });
      }
    }
    invalidThresholds.push(
      { freshMaxDays: 42, agingMaxDays: 42, staleMaxDays: 180 },
      { freshMaxDays: 42, agingMaxDays: 180, staleMaxDays: 180 },
      { freshMaxDays: 91, agingMaxDays: 90, staleMaxDays: 180 },
      { freshMaxDays: 42, agingMaxDays: 181, staleMaxDays: 180 },
    );

    for (const thresholds of invalidThresholds) {
      const repository = new ProgrammableAnchorRepository(anchorRow());
      expect(() => createCyclingFtpAnchorResolver(repository, {
        thresholds,
      })).toThrow(RangeError);
      expect(repository.readCurrentCalls).toHaveLength(0);
    }
  });

  it("validates both epochs, ordering, and the upper date boundary", async () => {
    const invalidValues = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      MAX_YMD_EPOCH_S + 1,
    ];
    const invalidInputs = invalidValues.flatMap((value) => [
      { effectiveAtEpochS: value, evaluatedAtEpochS: BASE_EPOCH_S },
      { effectiveAtEpochS: BASE_EPOCH_S, evaluatedAtEpochS: value },
    ]);
    invalidInputs.push({
      effectiveAtEpochS: BASE_EPOCH_S + 1,
      evaluatedAtEpochS: BASE_EPOCH_S,
    });

    for (const input of invalidInputs) {
      const repository = new ProgrammableAnchorRepository(anchorRow());
      const resolver = createCyclingFtpAnchorResolver(repository);
      await expect(resolver.resolve(input)).rejects.toBeInstanceOf(RangeError);
      expect(repository.readCurrentCalls).toHaveLength(0);
    }

    const repository = new ProgrammableAnchorRepository(anchorRow({
      valid_from: MAX_YMD_EPOCH_S,
    }));
    const resolver = createCyclingFtpAnchorResolver(repository);
    await expect(resolver.resolve({
      effectiveAtEpochS: MAX_YMD_EPOCH_S,
      evaluatedAtEpochS: MAX_YMD_EPOCH_S,
    })).resolves.toMatchObject({
      kind: "ftp",
      validFrom: "9999-12-31",
    });
  });

  it("rejects malformed repository rows with TypeError", async () => {
    const malformedRows = [
      anchorRow({ confidence: "unsupported" }),
      ...[
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        -1,
        99.5,
        Number.MAX_SAFE_INTEGER + 1,
        MAX_YMD_EPOCH_S + 1,
        101,
      ].map((valid_from) => anchorRow({ valid_from })),
    ];

    for (const row of malformedRows) {
      const repository = new ProgrammableAnchorRepository(row);
      const resolver = createCyclingFtpAnchorResolver(repository);
      await expect(resolver.resolve({
        effectiveAtEpochS: 100,
        evaluatedAtEpochS: 200,
      })).rejects.toBeInstanceOf(TypeError);
      expect(repository.readCurrentCalls).toHaveLength(1);
    }
  });
});
