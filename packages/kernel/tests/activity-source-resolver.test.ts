import { describe, expect, it } from "vitest";
import {
  ActivitySourceResolutionError,
  createTrustedActivitySourceResolver,
  type Row,
  type SqlReadStore,
} from "../src/store/index.js";

const SESSION = "a".repeat(64);
const REVISION = "b".repeat(64);

function storeWith(rows: readonly Row[]) {
  const calls: Array<{ readonly sql: string; readonly params: readonly unknown[] }> = [];
  const store: Pick<SqlReadStore, "all"> = {
    async all(sql, params = []) {
      calls.push({ sql, params });
      return [...rows];
    },
  };
  return { calls, store };
}

describe("trusted activity source resolver", () => {
  it("resolves one selected Intervals.icu activity revision", async () => {
    const { calls, store } = storeWith([{ external_id: "i42", revision_id: REVISION }]);
    const result = await createTrustedActivitySourceResolver(store).resolve({
      canonicalActivityId: SESSION,
    });

    expect(result).toEqual({
      kind: "resolved",
      providerActivityId: "i42",
      sourceRevision: REVISION,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toEqual([SESSION]);
    expect(calls[0]!.sql).toContain("JOIN source_record_current");
    expect(calls[0]!.sql).toContain("JOIN source_artifact");
    expect(calls[0]!.sql).toContain("LIMIT 2");
  });

  it("returns bounded unavailable reasons for missing and ambiguous linkage", async () => {
    await expect(createTrustedActivitySourceResolver(storeWith([]).store).resolve({
      canonicalActivityId: SESSION,
    })).resolves.toEqual({ kind: "unavailable", reason: "not_found" });
    await expect(createTrustedActivitySourceResolver(storeWith([
      { external_id: "i42", revision_id: REVISION },
      { external_id: "i43", revision_id: "c".repeat(64) },
    ]).store).resolve({ canonicalActivityId: SESSION }))
      .resolves.toEqual({ kind: "unavailable", reason: "ambiguous" });
  });

  it("rejects invalid canonical IDs before querying", async () => {
    const { calls, store } = storeWith([]);
    await expect(createTrustedActivitySourceResolver(store).resolve({ canonicalActivityId: "provider-id" }))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [{ external_id: "", revision_id: REVISION }],
    [{ external_id: "line\nbreak", revision_id: REVISION }],
    [{ external_id: "i42", revision_id: "not-a-revision" }],
  ])("fails closed on malformed trusted rows", async (row) => {
    await expect(createTrustedActivitySourceResolver(storeWith([row]).store).resolve({
      canonicalActivityId: SESSION,
    })).rejects.toBeInstanceOf(ActivitySourceResolutionError);
  });
});
