import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "../src/agent/chat-store.js";
import { makeSummaryMessage } from "../src/agent/history-limit.js";
import { createMemoryQueryTool } from "../src/agent/tools.js";
import { Memory } from "../src/memory/store.js";
import { ProvenanceMetadata } from "../src/memory/provenance-metadata.js";
import { contentDigest, getMessageProvenance, setMessageProvenance } from "../src/provenance.js";

const GARMIN = { garmin: true, nonGarmin: false, unknown: false };
const UNKNOWN = { garmin: false, nonGarmin: false, unknown: true };

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function memoryQueryResult(
  memory: Memory,
  input: { from: string; to: string; query?: string },
): Promise<string> {
  return (await createMemoryQueryTool(memory).execute!(input, {} as never)) as string;
}

describe("chat history provenance metadata", () => {
  it("round-trips assistant and summary metadata through overwrite", () => {
    const dir = tempDir("cc-chat-provenance-");
    try {
      const store = new ChatStore(dir);
      store.appendMessage("chat", "assistant", "Garmin answer.", {
        templateHash: "template",
        assembledHash: "assembled",
        provider: "test",
        model: "test",
        provenance: GARMIN,
      });
      const loaded = store.load("chat").messages;
      expect(getMessageProvenance(loaded[0])).toEqual(GARMIN);

      const summary = makeSummaryMessage("summary", GARMIN);
      store.overwriteHistory("chat", [summary, ...loaded]);
      const rewritten = store.load("chat").messages;
      expect(getMessageProvenance(rewritten[0])).toEqual(GARMIN);
      expect(getMessageProvenance(rewritten[1])).toEqual(GARMIN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats legacy records, user messages, and missing metadata as unknown", () => {
    const dir = tempDir("cc-chat-legacy-");
    try {
      const sessions = join(dir, "sessions");
      mkdirSync(sessions, { recursive: true });
      writeFileSync(
        join(sessions, "legacy.jsonl"),
        [
          JSON.stringify({
            role: "user",
            content: "Garmin claim",
            ts: "1998-05-09T00:00:00Z",
            provenance: GARMIN,
          }),
          JSON.stringify({
            role: "assistant",
            content: "Legacy answer",
            ts: "1998-05-09T00:00:01Z",
          }),
        ].join("\n") + "\n",
      );
      const messages = new ChatStore(dir).load("legacy").messages;
      expect(messages.map(getMessageProvenance)).toEqual([UNKNOWN, UNKNOWN]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a valid message with malformed optional provenance as unknown", () => {
    const dir = tempDir("cc-chat-malformed-provenance-");
    try {
      const sessions = join(dir, "sessions");
      mkdirSync(sessions, { recursive: true });
      const line = JSON.stringify({
        role: "assistant",
        content: "Still usable",
        ts: "1998-05-09T00:00:01Z",
        provenance: { garmin: true },
      });
      writeFileSync(join(sessions, "chat.jsonl"), line + "\n");

      const store = new ChatStore(dir);
      const messages = store.load("chat").messages;

      expect(messages).toEqual([{ role: "assistant", content: "Still usable" }]);
      expect(getMessageProvenance(messages[0])).toEqual(UNKNOWN);
      expect(readFileSync(join(sessions, "chat.jsonl"), "utf8")).toBe(line + "\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not infer provenance by scanning summary text", () => {
    const message = setMessageProvenance(
      makeSummaryMessage("GARMIN_CONNECT and the exact footer are only text", UNKNOWN),
      UNKNOWN,
    );
    expect(getMessageProvenance(message)).toEqual(UNKNOWN);
  });
});

describe("memory, daily-note, plan, and ledger digest binding", () => {
  it("keeps an earlier section's provenance after appending another section", () => {
    const dir = tempDir("cc-memory-append-provenance-");
    try {
      const memory = new Memory(dir, "UTC");
      memory.writeSection("garmin", "Garmin fact", "chat-tool", GARMIN);
      memory.writeSection("polar", "Polar fact", "chat-tool", {
        garmin: false,
        nonGarmin: true,
        unknown: false,
      });

      expect(memory.getContextWithProvenance().provenance).toEqual({
        garmin: true,
        nonGarmin: true,
        unknown: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails malformed sidecar entries closed without losing valid siblings", () => {
    const dir = tempDir("cc-memory-malformed-metadata-");
    try {
      const memoryDir = join(dir, "memory");
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(
        join(memoryDir, ".source-provenance.json"),
        JSON.stringify({
          version: 1,
          entries: {
            nullish: null,
            numeric: 42,
            missing_digest: { provenance: GARMIN },
            valid: { digest: contentDigest("valid content"), provenance: GARMIN },
          },
        }),
      );
      const metadata = new ProvenanceMetadata(memoryDir);

      for (const key of ["nullish", "numeric", "missing_digest"]) {
        expect(metadata.read(key, "anything")).toEqual(UNKNOWN);
        expect(metadata.matches(key, "anything")).toBe(false);
      }
      expect(metadata.read("valid", "valid content")).toEqual(GARMIN);
      expect(metadata.matches("valid", "valid content")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns written provenance and degrades manual section edits to unknown", () => {
    const dir = tempDir("cc-memory-provenance-");
    try {
      const memory = new Memory(dir, "UTC");
      memory.runWithWriteProvenance(GARMIN, () =>
        memory.writeSection("person", "FTP 250 W", "chat-tool"),
      );
      expect(memory.getContextWithProvenance().provenance.garmin).toBe(true);

      const path = join(dir, "memory", "MEMORY.md");
      writeFileSync(path, readFileSync(path, "utf8").replace("250", "251"));
      expect(memory.getContextWithProvenance().provenance).toEqual(UNKNOWN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("moves and unions section provenance through chained renames", () => {
    const dir = tempDir("cc-memory-rename-provenance-");
    try {
      const memory = new Memory(dir, "UTC");
      memory.writeSection("legacy-profile", "Garmin fact", "chat-tool", GARMIN);
      memory.writeSection("profile", "Polar fact", "chat-tool", {
        garmin: false,
        nonGarmin: true,
        unknown: false,
      });

      expect(
        memory.renameSections([
          ["legacy-profile", "profile"],
          ["profile", "athlete-profile"],
        ]),
      ).toEqual(["merged", "renamed"]);
      expect(memory.getContextWithProvenance().provenance).toEqual({
        garmin: true,
        nonGarmin: true,
        unknown: false,
      });

      const metadata = JSON.parse(
        readFileSync(join(dir, "memory", ".source-provenance.json"), "utf8"),
      ) as { entries: Record<string, unknown> };
      expect(metadata.entries["memory:legacy-profile"]).toBeUndefined();
      expect(metadata.entries["memory:profile"]).toBeUndefined();
      expect(metadata.entries["memory:athlete-profile"]).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not count a metadata-bearing section hidden by the context cap", () => {
    const dir = tempDir("cc-memory-context-cap-");
    try {
      const memory = new Memory(dir, "UTC");
      memory.writeSection("person", "x".repeat(200), "chat-tool", UNKNOWN);
      memory.writeSection("training", "Garmin-derived fact", "chat-tool", GARMIN);

      expect(memory.getContextWithProvenance({ maxChars: 80 }).provenance).toEqual(UNKNOWN);
      expect(memory.getContextWithProvenance({ maxChars: 1_000 }).provenance).toEqual({
        garmin: true,
        nonGarmin: false,
        unknown: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not count a Garmin daily-note line hidden by the context cap", () => {
    const dir = tempDir("cc-memory-daily-context-cap-");
    try {
      const memory = new Memory(dir, "UTC");
      memory.appendDailyNote("x".repeat(200), undefined, UNKNOWN);
      memory.appendDailyNote("Garmin note beyond the cap", undefined, GARMIN);

      expect(memory.getContextWithProvenance({ maxChars: 80 }).provenance).toEqual(UNKNOWN);
      expect(memory.getContextWithProvenance({ maxChars: 1_000 }).provenance).toEqual({
        garmin: true,
        nonGarmin: false,
        unknown: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("degrades daily-note, plan, and ledger mismatches independently", async () => {
    const dir = tempDir("cc-memory-artifacts-");
    try {
      const memory = new Memory(dir, "UTC");
      memory.appendDailyNote("Recovered well", "1998-05-09", GARMIN);
      memory.savePlan({ name: "Base" }, "chat-tool", GARMIN);
      memory.appendEvent(
        { date: "1998-05-09", kind: "decision", text: "Ride easy", source: "flush" },
        GARMIN,
      );
      const rideEasyInput = {
        from: "1998-05-09",
        to: "1998-05-09",
        query: "Ride easy",
      };
      expect(
        memory.provenanceForToolRead(
          "memory_query",
          rideEasyInput,
          await memoryQueryResult(memory, rideEasyInput),
        ).garmin,
      ).toBe(true);
      expect(memory.provenanceForToolRead("plan_load", {}).garmin).toBe(true);

      writeFileSync(join(dir, "memory", "1998-05-09.md"), "Manually changed");
      writeFileSync(join(dir, "plans", "current-plan.json"), JSON.stringify({ name: "Manual" }));
      const ledgerPath = join(dir, "memory", "events.jsonl");
      writeFileSync(ledgerPath, readFileSync(ledgerPath, "utf8").replace("Ride easy", "Ride hard"));

      const allInput = { from: "1998-05-09", to: "1998-05-09" };
      expect(
        memory.provenanceForToolRead(
          "memory_query",
          allInput,
          await memoryQueryResult(memory, allInput),
        ),
      ).toEqual(UNKNOWN);
      expect(memory.provenanceForToolRead("plan_load", {})).toEqual(UNKNOWN);
      const rideHardInput = {
        from: "1998-05-09",
        to: "1998-05-09",
        query: "Ride hard",
      };
      expect(
        memory.provenanceForToolRead(
          "memory_query",
          rideHardInput,
          await memoryQueryResult(memory, rideHardInput),
        ),
      ).toEqual(UNKNOWN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unions only daily-note lines returned by a filtered query", async () => {
    const dir = tempDir("cc-memory-daily-filter-");
    try {
      const memory = new Memory(dir, "UTC");
      memory.appendDailyNote("Garmin recovery note", "1998-05-09", GARMIN);
      memory.appendDailyNote("Polar recovery note", "1998-05-09", {
        garmin: false,
        nonGarmin: true,
        unknown: false,
      });

      const polarInput = {
        from: "1998-05-09",
        to: "1998-05-09",
        query: "Polar",
      };
      expect(
        memory.provenanceForToolRead(
          "memory_query",
          polarInput,
          await memoryQueryResult(memory, polarInput),
        ),
      ).toEqual({ garmin: false, nonGarmin: true, unknown: false });
      const allInput = { from: "1998-05-09", to: "1998-05-09" };
      expect(
        memory.provenanceForToolRead(
          "memory_query",
          allInput,
          await memoryQueryResult(memory, allInput),
        ),
      ).toEqual({ garmin: true, nonGarmin: true, unknown: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not count a Garmin note hidden by memory-query truncation", async () => {
    const dir = tempDir("cc-memory-query-cap-");
    try {
      const memory = new Memory(dir, "UTC");
      memory.appendDailyNote("x".repeat(21_000), "1998-05-09", UNKNOWN);
      memory.appendDailyNote("Garmin note beyond the cap", "1998-05-10", GARMIN);
      const input = { from: "1998-05-09", to: "1998-05-10" };
      const result = await memoryQueryResult(memory, input);

      expect(result).toContain("[truncated");
      expect(memory.provenanceForToolRead("memory_query", input, result)).toEqual(UNKNOWN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
