import { describe, expect, it } from "vitest";

import { resolvePendings } from "./asserts.js";
import {
  findSupersession,
  isFieldExcused,
  parseSupersessions,
  resolvePending,
  type SupersessionEntry,
} from "./supersessions.js";
import type { PendingHashMismatch } from "./types.js";

const FROM = "aaaaaaaaaaaaaaaa";
const TO = "bbbbbbbbbbbbbbbb";

const entry: SupersessionEntry = {
  id: "S8A-SUP-TEST",
  date: "1998-07-06",
  prRef: "#0",
  lineageVersion: "unversioned",
  fromTemplateHash: FROM,
  toTemplateHash: TO,
  scope: ["system-prompt"],
  reason: "synthetic test entry",
  approvedBy: "operator",
};

function pending(overrides: Partial<PendingHashMismatch> = {}): PendingHashMismatch {
  return {
    ordinal: 0,
    assertId: "A1",
    turn: { chatId: "c1", turnIndex: 0 },
    recordedTemplateHash: FROM,
    detail: "hash mismatch",
    recordedText: "recorded",
    liveText: "live",
    ...overrides,
  };
}

describe("supersession registry", () => {
  it("parses an empty registry to zero entries", () => {
    expect(parseSupersessions("")).toEqual([]);
    expect(parseSupersessions("\n\n")).toEqual([]);
  });

  it("downgrades an exact hash-pair match to WARN", () => {
    const resolution = resolvePending(pending(), TO, [entry]);
    expect(resolution.kind).toBe("warn");
    expect(resolution.entry?.id).toBe("S8A-SUP-TEST");
    expect(resolution.detail).toContain("documented supersession S8A-SUP-TEST");
  });

  it("does NOT suppress a near-miss pair (one hash off)", () => {
    expect(resolvePending(pending(), "cccccccccccccccc", [entry]).kind).toBe("fail");
    expect(
      resolvePending(pending({ recordedTemplateHash: "dddddddddddddddd" }), TO, [entry]).kind,
    ).toBe("fail");
    expect(findSupersession([entry], FROM, "cccccccccccccccc")).toBeUndefined();
  });

  it("fails a PENDING record when the turn wrote no session assistant line", () => {
    const resolution = resolvePending(pending(), null, [entry]);
    expect(resolution.kind).toBe("fail");
    expect(resolution.detail).toContain("no session assistant line");
  });

  it("with the registry disabled (--no-supersessions) an exact-pair entry does NOT downgrade", () => {
    expect(resolvePending(pending(), TO, null).kind).toBe("fail");
  });

  it("resolvePendings joins the live session line and writes the word diff on FAIL", () => {
    const lineage = new Map([["c1", [{ templateHash: TO, assembledHash: "x" }]]]);
    const warned = resolvePendings([pending()], lineage, [entry]);
    expect(warned.failures).toEqual([]);
    expect(warned.warns).toHaveLength(1);

    const failed = resolvePendings([pending()], lineage, null);
    expect(failed.warns).toEqual([]);
    expect(failed.failures).toHaveLength(1);
    expect(failed.failures[0].diffFile).toBe("system-prompt.diff");
    expect(failed.failures[0].diffContent).toContain("recorded");
  });
});

describe("supersession field excuses (A5 scope semantics)", () => {
  it("system-prompt scope excuses templateHash/assembledHash only for matching pairs", () => {
    const baselineLine = { templateHash: FROM, assembledHash: "old" };
    const liveLine = { templateHash: TO, assembledHash: "new" };
    for (const field of ["templateHash", "assembledHash"]) {
      expect(isFieldExcused({ entries: [entry], field, baselineLine, liveLine })).toBe(true);
    }
    const nonMatching = { templateHash: "cccccccccccccccc", assembledHash: "new" };
    expect(
      isFieldExcused({ entries: [entry], field: "templateHash", baselineLine, liveLine: nonMatching }),
    ).toBe(false);
    expect(isFieldExcused({ entries: [entry], field: "model", baselineLine, liveLine })).toBe(false);
  });

  it("ledger:model scope requires callers and touches only model/cost", () => {
    const ledgerEntry: SupersessionEntry = {
      ...entry,
      id: "S8A-SUP-LEDGER",
      scope: ["ledger:model"],
      callers: ["compact"],
    };
    const baselineLine = { caller: "compact", model: "old-model" };
    const liveLine = { caller: "compact", model: "new-model" };
    expect(isFieldExcused({ entries: [ledgerEntry], field: "model", baselineLine, liveLine })).toBe(true);
    expect(isFieldExcused({ entries: [ledgerEntry], field: "cost", baselineLine, liveLine })).toBe(true);
    expect(isFieldExcused({ entries: [ledgerEntry], field: "stopReason", baselineLine, liveLine })).toBe(false);
    const chatLive = { caller: "chat", model: "new-model" };
    expect(isFieldExcused({ entries: [ledgerEntry], field: "model", baselineLine, liveLine: chatLive })).toBe(false);
  });

  it("NO scope can suppress an A2 or A4 failure — the excuse surface only exists for A5 line fields and A1 pendings", () => {
    // A2/A4 failure paths never consult the registry: the assert functions take
    // no registry parameter at all. Pin that structurally by asserting the
    // excuse helper refuses A2/A4-shaped fields regardless of scope.
    const wideEntry: SupersessionEntry = {
      ...entry,
      id: "S8A-SUP-WIDE",
      scope: ["system-prompt", "ledger:model", "memory", "tool-calls"],
      callers: ["chat", "flush", "compact"],
    };
    const baselineLine = { templateHash: FROM, toolName: "memory_write", content: "baseline memory" };
    const liveLine = { templateHash: TO, toolName: "memory_write", content: "live memory" };
    for (const field of ["toolName", "content", "input", "resultCanonical", "role"]) {
      expect(isFieldExcused({ entries: [wideEntry], field, baselineLine, liveLine })).toBe(false);
    }
  });
});
