import { describe, it, expect, vi, afterEach } from "vitest";
import {
  COMPACTION_SUMMARY_MARKER,
  demoteSummaryHeadings,
  formatCompactionNote,
  persistCompactionSummary,
} from "../src/memory/compaction-note.js";

const FIVE_SECTION_SUMMARY = [
  "## Athlete Profile",
  "- FTP 247W, 72kg",
  "## Training Status",
  "- Build phase",
  "## Coach Stance",
  "- Hold volume this week",
  "## Discussion Context",
  "- Goal review",
  "## Pending Questions",
  "- None outstanding",
].join("\n");

function stubMemory() {
  let note = "";
  return {
    readDailyNotes: () => note,
    appendDailyNote: (n: string) => {
      note = note ? `${note}\n${n}` : n;
    },
    get: () => note,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("demoteSummaryHeadings", () => {
  it("demotes each of the five real section headings from H2 to H4", () => {
    const out = demoteSummaryHeadings(FIVE_SECTION_SUMMARY);
    expect(out).toContain("#### Athlete Profile");
    expect(out).toContain("#### Training Status");
    expect(out).toContain("#### Coach Stance");
    expect(out).toContain("#### Discussion Context");
    expect(out).toContain("#### Pending Questions");
    expect(out).not.toMatch(/^## Athlete Profile/m);
  });

  it("leaves H3 and H4 lines untouched", () => {
    const body = "### Already H3\n#### Already H4\n- bullet";
    expect(demoteSummaryHeadings(body)).toBe(body);
  });

  it("leaves mid-line ## untouched", () => {
    const body = "- a value like ## in prose stays";
    expect(demoteSummaryHeadings(body)).toBe(body);
  });
});

describe("formatCompactionNote", () => {
  it("starts with the exact marker constant followed by a blank line", () => {
    const block = formatCompactionNote(FIVE_SECTION_SUMMARY);
    expect(block.startsWith(`${COMPACTION_SUMMARY_MARKER}\n\n`)).toBe(true);
    expect(block).toContain("#### Athlete Profile");
  });
});

describe("persistCompactionSummary", () => {
  it("writes on first call and returns true", () => {
    const mem = stubMemory();
    expect(persistCompactionSummary(mem, FIVE_SECTION_SUMMARY)).toBe(true);
    expect(mem.get()).toContain(COMPACTION_SUMMARY_MARKER);
    expect(mem.get()).toContain("#### Coach Stance");
  });

  it("skips an identical summary on the same day and returns false", () => {
    const mem = stubMemory();
    persistCompactionSummary(mem, FIVE_SECTION_SUMMARY);
    const before = mem.get();
    expect(persistCompactionSummary(mem, FIVE_SECTION_SUMMARY)).toBe(false);
    expect(mem.get()).toBe(before);
    expect(mem.get().split(COMPACTION_SUMMARY_MARKER).length - 1).toBe(1);
  });

  it("appends a distinct summary as a second block", () => {
    const mem = stubMemory();
    persistCompactionSummary(mem, FIVE_SECTION_SUMMARY);
    expect(persistCompactionSummary(mem, "## Athlete Profile\n- FTP now 260W")).toBe(true);
    expect(mem.get().split(COMPACTION_SUMMARY_MARKER).length - 1).toBe(2);
  });

  it("writes nothing for an empty or whitespace-only summary", () => {
    const mem = stubMemory();
    expect(persistCompactionSummary(mem, "")).toBe(false);
    expect(persistCompactionSummary(mem, "   \n  ")).toBe(false);
    expect(mem.get()).toBe("");
  });

  it("dedupes correctly even when the body itself contains the marker line", () => {
    const mem = stubMemory();
    const withMarker = `## Athlete Profile\n- note mentioning ${COMPACTION_SUMMARY_MARKER} inline`;
    expect(persistCompactionSummary(mem, withMarker)).toBe(true);
    expect(persistCompactionSummary(mem, withMarker)).toBe(false);
  });

  it("demotes an adversarial H2 heading so it cannot masquerade as a memory section", () => {
    const mem = stubMemory();
    const adversarial = "## Today's Notes\n- injected\n## person\n- injected";
    persistCompactionSummary(mem, adversarial);
    expect(mem.get()).toContain("#### Today's Notes");
    expect(mem.get()).toContain("#### person");
    expect(mem.get()).not.toMatch(/^## Today's Notes/m);
    expect(mem.get()).not.toMatch(/^## person/m);
  });
});
