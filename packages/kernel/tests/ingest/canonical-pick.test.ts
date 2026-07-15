import { describe, expect, it } from "vitest";
import {
  CANONICAL_PICK_ERROR_MESSAGE,
  CanonicalPickError,
  canonicalPick,
  type Candidate,
  type LogicalSessionGroup,
} from "../../src/ingest/canonical-pick.js";

const digest = (value: string) => value.repeat(64).slice(0, 64);
const channel = (timestamps: readonly number[], values: readonly (number | null)[]) => ({ timestamps: [...timestamps], values: [...values] });
const file = (format: "fit" | "tcx" | "gpx", hash: string, concerns: Candidate["concerns"], ordinal = 0): Candidate => ({
  id: `${format}:${hash}:0:${ordinal}`,
  origin: { kind: "file", format, rawSha256: hash },
  workoutOrdinal: 0,
  sessionOrdinal: ordinal,
  rank: format === "fit" ? 400 : format === "tcx" ? 200 : 100,
  concerns,
});
const ready = (value: number) => ({
  "session.sport": "cycling",
  "session.start_utc": value,
  "session.local_date_key": 20000101,
  "session.is_transition": false,
  "stream:time": channel([value, value + 1], [value, value + 1]),
});
const group = (candidates: readonly Candidate[], metadata: Readonly<Record<string, number | null>> = {}): LogicalSessionGroup => ({ id: "group", candidates, fitSerialByCandidateId: metadata });
const error = (callback: () => unknown, code: keyof typeof CANONICAL_PICK_ERROR_MESSAGE) => {
  expect(callback).toThrowError(CanonicalPickError);
  try { callback(); } catch (caught) {
    expect(caught).toMatchObject({ code, message: CANONICAL_PICK_ERROR_MESSAGE[code] });
  }
};
function permutations<T>(values: readonly T[]): T[][] {
  if (values.length < 2) return [values.slice()];
  return values.flatMap((value, index) => permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [value, ...rest]));
}

describe("canonical concern selection", () => {
  it("is invariant across every permutation and fills only absent concerns", () => {
    const fit = file("fit", digest("a"), { ...ready(10), "session.distance_m": 0, "lap[]": [{ lap_seq: 0, start_utc: 10, elapsed_s: 1, timer_s: null, distance_m: 0, summary_json: null }], "stream:power": channel([10, 11], [200, 210]) });
    const tcx = file("tcx", digest("b"), { ...ready(10), "session.distance_m": 5, "stream:heart_rate": channel([10, 11], [120, 121]) });
    const gpx = file("gpx", digest("c"), { "session.start_utc": 10, "session.local_date_key": 20000101, "session.is_transition": false, "session.summary_json": '{"segmentStartIndices":[0]}', "stream:time": channel([10, 11], [10, 11]), "stream:lat": channel([10, 11], [1, 2]) });
    const platform: Candidate = { id: `platform_api:${digest("d")}:0:0`, origin: { kind: "platform", source: "intervals-icu", sourceRecordId: digest("d"), persistedQualityRank: 300 }, workoutOrdinal: 0, sessionOrdinal: 0, rank: 300, concerns: { ...ready(10), "session.sub_sport": "road" } };
    const expected = canonicalPick(group([fit, tcx, platform, gpx], { [fit.id]: 7 }));
    for (const order of permutations([fit, tcx, platform, gpx])) expect(canonicalPick(group(order, { [fit.id]: 7 }))).toEqual(expected);
    expect(expected.winners.find((winner) => winner.concern === "session.distance_m")).toMatchObject({ candidateId: fit.id, value: 0 });
    expect(expected.winners.find((winner) => winner.concern === "session.sub_sport")?.candidateId).toBe(platform.id);
    expect(expected.winners.map((winner) => winner.concern).slice(0, 3)).toEqual(["stream:time", "lap[]", "session.distance_m"]);
    expect(expected.materialization).toEqual({ status: "ready" });
  });

  it("scans every stream presentation and reports mismatches in canonical order", () => {
    const high = file("tcx", digest("a"), { ...ready(10), "stream:power": channel([10, 11], [1, 2]) });
    const low = file("gpx", digest("b"), { ...ready(10), "stream:power": channel([10, 12], [3, 4]), "stream:lat": channel([10, 12], [1, 1]) });
    const result = canonicalPick(group([low, high]));
    expect(result.winners.find((winner) => winner.concern === "stream:power")?.candidateId).toBe(high.id);
    expect(result.diagnostics).toEqual([
      { code: "arbitration.timeline_mismatch", candidateId: low.id, concern: "stream:lat" },
      { code: "arbitration.timeline_mismatch", candidateId: low.id, concern: "stream:power" },
    ]);
  });

  it("uses FIT channel count, present serial, serial number, then code-point ID", () => {
    const a = file("fit", digest("a"), { ...ready(1) });
    const b = file("fit", digest("b"), { ...ready(1), "stream:power": channel([1, 2], [1, 2]) });
    const c = file("fit", digest("c"), { ...ready(1), "session.sub_sport": "road" });
    const result = canonicalPick(group([a, b, c], { [a.id]: null, [b.id]: 9, [c.id]: 1 }));
    expect(result.winners.find((winner) => winner.concern === "session.sport")?.candidateId).toBe(b.id);
    expect(result.winners.find((winner) => winner.concern === "session.sub_sport")?.candidateId).toBe(c.id);
    const codePointSummary = `{"\uE000":1,"\u{10000}":2}`;
    const summaryCandidate = file("tcx", digest("e"), { ...ready(1), "session.summary_json": codePointSummary });
    expect(canonicalPick(group([summaryCandidate])).materialization).toEqual({ status: "ready" });
  });

  it("deduplicates identical IDs and rejects conflicting presentations", () => {
    const candidate = file("tcx", digest("a"), ready(1));
    expect(canonicalPick(group([candidate, structuredClone(candidate)])).winners).toHaveLength(5);
    error(() => canonicalPick(group([candidate, { ...candidate, concerns: { ...candidate.concerns, "session.sport": "running" } }])), "canonical.same_id_conflict");

    const changedOrigin = { ...candidate, origin: { ...candidate.origin, rawSha256: digest("b") } };
    const changedOrdinal = { ...candidate, sessionOrdinal: 1 };
    const changedRank = { ...candidate, rank: 100 as const };
    error(() => canonicalPick(group([candidate, changedOrigin])), "canonical.id_invalid");
    error(() => canonicalPick(group([candidate, changedOrdinal])), "canonical.id_invalid");
    error(() => canonicalPick(group([candidate, changedRank])), "canonical.rank_invalid");

    const platformId = digest("d");
    const platform: Candidate = {
      id: `platform_api:${platformId}:0:0`,
      origin: { kind: "platform", source: "intervals-icu", sourceRecordId: platformId, persistedQualityRank: 300 },
      workoutOrdinal: 0,
      sessionOrdinal: 0,
      rank: 300,
      concerns: ready(1),
    };
    error(() => canonicalPick(group([platform, {
      ...platform,
      origin: { kind: "platform", source: "intervals-icu", sourceRecordId: platformId, persistedQualityRank: 200 },
    }])), "canonical.origin_invalid");
  });

  it("requires exact FIT metadata", () => {
    const fitCandidate = file("fit", digest("a"), ready(1));
    error(() => canonicalPick(group([fitCandidate])), "canonical.fit_metadata_invalid");
    error(() => canonicalPick(group([fitCandidate], { [fitCandidate.id]: -1 })), "canonical.fit_metadata_invalid");
    error(() => canonicalPick(group([fitCandidate], { [fitCandidate.id]: 1, extra: null })), "canonical.fit_metadata_invalid");
    error(() => canonicalPick(group([fitCandidate, structuredClone(fitCandidate)], { [fitCandidate.id]: Number.NaN })), "canonical.fit_metadata_invalid");
    error(() => canonicalPick(group([fitCandidate, structuredClone(fitCandidate)], { [fitCandidate.id]: -0 })), "canonical.fit_metadata_invalid");
    const tcx = file("tcx", digest("b"), ready(1));
    error(() => canonicalPick(group([tcx], { [tcx.id]: 1 })), "canonical.fit_metadata_invalid");
  });

  it("validates the exact platform origin before candidate rank", () => {
    const id = digest("d");
    const origin = { kind: "platform", source: "intervals-icu", sourceRecordId: id, persistedQualityRank: 300 } as const;
    const candidate: Candidate = { id: `platform_api:${id}:0:0`, origin, workoutOrdinal: 0, sessionOrdinal: 0, rank: 300, concerns: ready(1) };
    expect(canonicalPick(group([candidate])).materialization).toEqual({ status: "ready" });
    const invalid = [
      { kind: "platform", source: "intervals-icu", sourceRecordId: id },
      { ...origin, persistedQualityRank: undefined },
      { ...origin, persistedQualityRank: "300" },
      { ...origin, persistedQualityRank: Number.NaN },
      { ...origin, persistedQualityRank: -0 },
      { ...origin, persistedQualityRank: 301 },
      { ...origin, persistedQualityRank: 200 },
      { ...origin, extra: true },
    ];
    for (const changed of invalid) error(() => canonicalPick(group([{ ...candidate, origin: changed as never }])), "canonical.origin_invalid");
    error(() => canonicalPick(group([{ ...candidate, rank: 400 }])), "canonical.rank_invalid");
  });

  it("emits every invariant error class with fixed value-free messages", () => {
    const candidate = file("tcx", digest("a"), ready(1));
    error(() => canonicalPick({} as LogicalSessionGroup), "canonical.group_invalid");
    error(() => canonicalPick(group([{ ...candidate, extra: true } as never])), "canonical.candidate_invalid");
    error(() => canonicalPick(group([{ ...candidate, id: "wrong" }])), "canonical.id_invalid");
    error(() => canonicalPick(group([{ ...candidate, origin: { kind: "file", format: "tcx", rawSha256: "X" } }])), "canonical.origin_invalid");
    error(() => canonicalPick(group([{ ...candidate, rank: 300 }])), "canonical.rank_invalid");
    error(() => canonicalPick(group([{ ...candidate, concerns: { ...candidate.concerns, unknown: 1 } }])), "canonical.concern_invalid");
  });

  it("deeply validates arrays, summaries, channels, and container shape", () => {
    const base = file("tcx", digest("a"), ready(1));
    const cases: Candidate["concerns"][] = [
      { ...ready(1), "session.start_utc": -0 },
      { ...ready(1), "session.local_date_key": 19000229 },
      { ...ready(1), "session.summary_json": '{"b":1,"a":2}' },
      { ...ready(1), "lap[]": [{ lap_seq: 0, start_utc: 1, elapsed_s: -1, timer_s: null, distance_m: null, summary_json: null }] },
      { ...ready(1), "swim_length[]": [{ lap_seq: 0, length_seq: 0, start_utc: null, elapsed_s: null, timer_s: null, distance_m: null, strokes: null, stroke_type: null, length_type: null }] },
      { ...ready(1), "stream:power": channel([1, 1], [1, 2]) },
      { ...ready(1), "stream:lat": channel([1, 2], [91, 0]) },
      { ...ready(1), "stream:watts": channel([1, 2], [1, 2]) },
    ];
    for (const concerns of cases) error(() => canonicalPick(group([{ ...base, concerns }])), "canonical.concern_invalid");
    const sparse: unknown[] = [1]; sparse.length = 2;
    error(() => canonicalPick(group([{ ...base, concerns: { ...ready(1), "stream:power": { timestamps: [1, 2], values: sparse } } as never }])), "canonical.concern_invalid");
    const getter = Object.defineProperty({}, "id", { enumerable: true, get() { throw new Error("getter invoked"); } });
    error(() => canonicalPick(group([getter as Candidate])), "canonical.candidate_invalid");
  });

  it("reports missing readiness reasons in fixed order without mutating inputs", () => {
    const candidate = file("gpx", digest("a"), { "stream:lat": channel([1], [1]) });
    const input = group([candidate]);
    const before = structuredClone(input);
    expect(canonicalPick(input).materialization).toEqual({ status: "not_materializable", reasons: ["missing_session_sport", "missing_session_start_utc", "missing_session_local_date_key", "missing_session_is_transition", "missing_stream_time"] });
    expect(input).toEqual(before);
  });

  it("rejects every forbidden group, candidate, origin, concern, and metadata container shape", () => {
    const candidate = file("tcx", digest("a"), ready(1));
    const symbol = Symbol("hidden");
    const nullPrototype = Object.assign(Object.create(null), group([candidate]));
    expect(canonicalPick(nullPrototype).groupId).toBe("group");

    const groupCases: unknown[] = [null, [], new Date(), { id: "", candidates: [candidate], fitSerialByCandidateId: {} }, { id: "group", candidates: [], fitSerialByCandidateId: {} }];
    const symbolGroup = group([candidate]) as LogicalSessionGroup & { [symbol]: boolean };
    symbolGroup[symbol] = true;
    groupCases.push(symbolGroup);
    for (const value of groupCases) error(() => canonicalPick(value as LogicalSessionGroup), "canonical.group_invalid");

    const getterCandidate = Object.defineProperty({}, "id", { enumerable: true, get() { throw new Error("must not run"); } });
    const candidateCases: unknown[] = [null, [], new Date(), { ...candidate, extra: true }, getterCandidate];
    const symbolCandidate = { ...candidate } as Candidate & { [symbol]: boolean };
    symbolCandidate[symbol] = true;
    candidateCases.push(symbolCandidate);
    for (const value of candidateCases) error(() => canonicalPick(group([value as Candidate])), "canonical.candidate_invalid");

    const originGetter = Object.defineProperty({}, "kind", { enumerable: true, get() { throw new Error("must not run"); } });
    for (const origin of [null, [], new Date(), originGetter, { ...candidate.origin, extra: true }]) {
      error(() => canonicalPick(group([{ ...candidate, origin: origin as never }])), "canonical.origin_invalid");
    }
    const concernsGetter = Object.defineProperty({}, "session.sport", { enumerable: true, get() { throw new Error("must not run"); } });
    for (const concerns of [null, [], new Date(), concernsGetter]) {
      error(() => canonicalPick(group([{ ...candidate, concerns: concerns as never }])), "canonical.concern_invalid");
    }
    const metadataGetter = Object.defineProperty({}, candidate.id, { enumerable: true, get() { throw new Error("must not run"); } });
    error(() => canonicalPick(group([file("fit", digest("f"), ready(1))], metadataGetter as never)), "canonical.fit_metadata_invalid");
  });

  it("rejects sparse, accessor, symbol, and extra-property arrays without invoking getters", () => {
    const base = file("tcx", digest("a"), ready(1));
    const badArrays: unknown[] = [];
    const sparse = [1]; sparse.length = 2;
    const extra = [1]; Object.defineProperty(extra, "extra", { enumerable: true, value: true });
    const accessor: unknown[] = [1]; Object.defineProperty(accessor, "0", { enumerable: true, get() { throw new Error("must not run"); } });
    const symbol = [1] as unknown[] & { [key: symbol]: boolean }; symbol[Symbol("x")] = true;
    badArrays.push(sparse, extra, accessor, symbol);
    for (const values of badArrays) {
      error(() => canonicalPick(group([{ ...base, concerns: { ...ready(1), "stream:power": { timestamps: [1, 2], values } } as never }])), "canonical.concern_invalid");
    }
    const candidates = [base]; candidates.length = 2;
    error(() => canonicalPick({ id: "group", candidates, fitSerialByCandidateId: {} }), "canonical.group_invalid");
  });

  it("covers scalar, summary, lap, length, channel, and developer-channel schema failures", () => {
    const base = file("tcx", digest("a"), ready(1));
    const lap = { lap_seq: 0, start_utc: 1, elapsed_s: 1, timer_s: null, distance_m: 1, summary_json: null };
    const length = { lap_seq: 0, length_seq: 0, start_utc: 1, elapsed_s: 1, timer_s: null, distance_m: 1, strokes: 1, stroke_type: "free", length_type: "active" };
    const bad: Candidate["concerns"][] = [
      { ...ready(1), "session.sport": "" },
      { ...ready(1), "session.start_utc": Number.NaN },
      { ...ready(1), "session.elapsed_s": -1 },
      { ...ready(1), "session.tz_offset_s": 1.5 },
      { ...ready(1), "session.local_date_key": 20000230 },
      { ...ready(1), "session.is_transition": 0 as never },
      { ...ready(1), "session.summary_json": "\ufeff{}" },
      { ...ready(1), "session.summary_json": "{ }" },
      { ...ready(1), "session.summary_json": "{}\n" },
      { ...ready(1), "session.summary_json": "[]" },
      { ...ready(1), "session.summary_json": '{"a":-0}' },
      { ...ready(1), "lap[]": [{ ...lap, extra: true } as never] },
      { ...ready(1), "lap[]": [lap, { ...lap }] },
      { ...ready(1), "lap[]": [{ ...lap, start_utc: -0 }] },
      { ...ready(1), "lap[]": [{ ...lap, elapsed_s: -1 }] },
      { ...ready(1), "swim_length[]": [length] },
      { ...ready(1), "lap[]": [lap], "swim_length[]": [{ ...length, lap_seq: 1 }] },
      { ...ready(1), "lap[]": [lap], "swim_length[]": [length, { ...length }] },
      { ...ready(1), "lap[]": [lap], "swim_length[]": [{ ...length, strokes: -1 }] },
      { ...ready(1), "lap[]": [lap], "swim_length[]": [{ ...length, stroke_type: "" }] },
      { ...ready(1), "stream:power": channel([], []) },
      { ...ready(1), "stream:power": channel([1, 2], [1]) },
      { ...ready(1), "stream:power": channel([1, 2], [null, null]) },
      { ...ready(1), "stream:power": channel([1, 2], [1, Number.POSITIVE_INFINITY]) },
      { ...ready(1), "stream:power": channel([1, 2], [1, -0]) },
      { ...ready(1), "stream:time": channel([1, 2], [1, 3]) },
      { ...ready(1), "stream:heart_rate": channel([1, 2], [0, 120]) },
      { ...ready(1), "stream:cadence": channel([1, 2], [1.5, 2]) },
      { ...ready(1), "stream:distance": channel([1, 2], [-1, 2]) },
      { ...ready(1), "stream:unknown": channel([1, 2], [1, 2]) },
      { ...ready(1), "stream:dev:idx-2:1:0:field": channel([1, 2], [1, 2]) },
      { ...ready(1), "stream:dev:idx-9007199254740992:9007199254740992:0:field": channel([1, 2], [1, 2]) },
    ];
    for (const concerns of bad) error(() => canonicalPick(group([{ ...base, concerns }])), "canonical.concern_invalid");
    const validDeveloper = { ...ready(1), "stream:dev:idx-2:2:0:field%20name": channel([1, 2], [1, 2]) };
    expect(canonicalPick(group([{ ...base, concerns: validDeveloper }])).winners).toHaveLength(6);
  });

  it("validates every platform-origin and rank near miss with the required precedence", () => {
    const sourceRecordId = digest("d");
    const origin = { kind: "platform", source: "intervals-icu", sourceRecordId, persistedQualityRank: 300 } as const;
    const candidate: Candidate = { id: `platform_api:${sourceRecordId}:0:0`, origin, workoutOrdinal: 0, sessionOrdinal: 0, rank: 300, concerns: ready(1) };
    for (const changed of [
      {},
      { kind: undefined, source: "intervals-icu", sourceRecordId, persistedQualityRank: 300 },
      { ...origin, kind: "unknown" },
      { ...origin, source: "unknown" },
      { ...origin, sourceRecordId: digest("A") },
      { ...origin, persistedQualityRank: null },
      { ...origin, persistedQualityRank: Number.POSITIVE_INFINITY },
    ]) error(() => canonicalPick(group([{ ...candidate, origin: changed as never }])), "canonical.origin_invalid");
    for (const rank of [undefined, "300", Number.NaN, Number.POSITIVE_INFINITY, -0, 301, 400]) {
      error(() => canonicalPick(group([{ ...candidate, rank: rank as never }])), "canonical.rank_invalid");
    }
  });

  it("applies the complete FIT tie ladder and non-FIT code-point ID ordering", () => {
    const a = file("fit", digest("a"), { ...ready(1), "stream:power": channel([1, 2], [1, 2]) });
    const b = file("fit", digest("b"), { ...ready(1), "stream:power": channel([1, 2], [1, 2]) });
    const c = file("fit", digest("c"), { ...ready(1) });
    const d = file("fit", digest("d"), { ...ready(1), "stream:power": channel([1, 2], [1, 2]) });
    const metadata = { [a.id]: 5, [b.id]: 3, [c.id]: 1, [d.id]: null };
    const result = canonicalPick(group([d, c, a, b], metadata));
    expect(result.winners.find((winner) => winner.concern === "session.sport")?.candidateId).toBe(b.id);

    const nullA = file("fit", digest("e"), { ...ready(2), "stream:power": channel([2, 3], [1, 2]) });
    const nullB = file("fit", digest("f"), { ...ready(2), "stream:power": channel([2, 3], [1, 2]) });
    const lexical = canonicalPick(group([nullB, nullA], { [nullA.id]: null, [nullB.id]: null }));
    expect(lexical.winners.find((winner) => winner.concern === "session.sport")?.candidateId).toBe(nullA.id);
  });

  it("uses code-point ID order for reversed equal-rank TCX and GPX presentations", () => {
    for (const format of ["tcx", "gpx"] as const) {
      const lowId = file(format, digest("1"), ready(1));
      const highId = file(format, digest("f"), ready(1));
      const reversed = canonicalPick(group([highId, lowId]));
      const forward = canonicalPick(group([lowId, highId]));
      expect(reversed.winners.find((winner) => winner.concern === "session.sport")?.candidateId).toBe(lowId.id);
      expect(reversed).toEqual(forward);
    }
  });

  it("canonicalizes equivalent same-ID winner values independently of object insertion order", () => {
    const forwardLap = {
      lap_seq: 0,
      start_utc: 1,
      elapsed_s: 2,
      timer_s: null,
      distance_m: 3,
      summary_json: null,
    };
    const reverseLap = {
      summary_json: null,
      distance_m: 3,
      timer_s: null,
      elapsed_s: 2,
      start_utc: 1,
      lap_seq: 0,
    };
    const first = file("tcx", digest("a"), { ...ready(1), "lap[]": [forwardLap] });
    const second: Candidate = { ...first, concerns: { ...ready(1), "lap[]": [reverseLap] } };
    const forward = canonicalPick(group([first, second]));
    const reverse = canonicalPick(group([second, first]));
    expect(forward).toEqual(reverse);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reverse));
    const value = forward.winners.find((winner) => winner.concern === "lap[]")!.value as unknown as readonly Record<string, unknown>[];
    expect(Object.keys(value[0]!)).toEqual(["distance_m", "elapsed_s", "lap_seq", "start_utc", "summary_json", "timer_s"]);
    expect(value).not.toBe(first.concerns["lap[]"]);
  });

  it("fills false, zero, unknown strings, and whole arrays atomically without partial sample merge", () => {
    const high = file("tcx", digest("a"), {
      ...ready(10),
      "session.sport": "unknown:high",
      "session.distance_m": 0,
      "session.is_transition": false,
      "lap[]": [{ lap_seq: 0, start_utc: 10, elapsed_s: null, timer_s: null, distance_m: 0, summary_json: null }],
      "stream:power": channel([10, 11], [null, 200]),
    });
    const low = file("gpx", digest("b"), {
      ...ready(10),
      "session.sport": "running",
      "session.distance_m": 9,
      "session.is_transition": true,
      "lap[]": [{ lap_seq: 0, start_utc: 10, elapsed_s: 9, timer_s: 9, distance_m: 9, summary_json: null }],
      "stream:power": channel([10, 11], [100, null]),
    });
    const result = canonicalPick(group([low, high]));
    for (const concern of ["session.sport", "session.distance_m", "session.is_transition", "lap[]", "stream:power"]) {
      expect(result.winners.find((winner) => winner.concern === concern)?.candidateId).toBe(high.id);
    }
    expect(result.winners.find((winner) => winner.concern === "stream:power")?.value).toEqual(channel([10, 11], [null, 200]));
  });

  it("selects time first, scans every later presentation, and orders mismatch diagnostics by concern then candidate", () => {
    const high = file("tcx", digest("a"), { ...ready(10), "stream:power": channel([10, 11], [1, 2]) });
    const middle = file("gpx", digest("b"), { ...ready(20), "stream:power": channel([20, 21], [3, 4]), "stream:lat": channel([20, 21], [1, 2]) });
    const low = file("gpx", digest("c"), { ...ready(30), "stream:power": channel([30, 31], [5, 6]), "stream:lat": channel([30, 31], [3, 4]) }, 1);
    const result = canonicalPick(group([low, middle, high]));
    expect(result.winners[0]).toMatchObject({ concern: "stream:time", candidateId: high.id });
    expect(result.diagnostics).toEqual([
      { code: "arbitration.timeline_mismatch", candidateId: middle.id, concern: "stream:lat" },
      { code: "arbitration.timeline_mismatch", candidateId: low.id, concern: "stream:lat" },
      { code: "arbitration.timeline_mismatch", candidateId: middle.id, concern: "stream:power" },
      { code: "arbitration.timeline_mismatch", candidateId: low.id, concern: "stream:power" },
    ]);
    const noTime = file("gpx", digest("e"), { "session.sport": "cycling", "session.start_utc": 1, "session.local_date_key": 20000101, "session.is_transition": false, "stream:lat": channel([1], [1]) });
    const absent = canonicalPick(group([noTime]));
    expect(absent.winners).not.toContainEqual(expect.objectContaining({ concern: "stream:lat" }));
    expect(absent.diagnostics).toEqual([{ code: "arbitration.timeline_mismatch", candidateId: noTime.id, concern: "stream:lat" }]);
    expect(absent.materialization).toEqual({ status: "not_materializable", reasons: ["missing_stream_time"] });
  });
});
