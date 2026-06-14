import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt } from "../src/agent/system-prompt.js";
import { Memory } from "../src/memory/store.js";
import type { SportPersona } from "../src/sport.js";

const persona: SportPersona = {
  soul: "# Cycling Coach\n\nYou are a cycling coach.",
  skills: { example: "# Example Skill\n\nSome cycling content." },
};

function makeFakeMemory(context = ""): Memory {
  return { getContext: () => context } as unknown as Memory;
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cc-promptstable-"));
  // The disk seam stamps each section with todayInTZ; pin the clock so the
  // only variable under test is assembly determinism, not the calendar.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-11T08:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("consecutive builds are byte-identical", () => {
  it("builds against the same fake-memory context byte-identically", () => {
    const a = buildSystemPrompt(persona, makeFakeMemory("FTP 247W, 72kg"));
    const b = buildSystemPrompt(persona, makeFakeMemory("FTP 247W, 72kg"));
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("builds against the same real on-disk Memory byte-identically", () => {
    const m = new Memory(dataDir);
    m.writeSection("Goals", "Lift FTP to 280W by August");
    const a = buildSystemPrompt(persona, m);
    const b = buildSystemPrompt(persona, m);
    expect(a).toBe(b);
    expect(a).toContain("# Athlete Context");
  });
});

describe("write/read round-trip preserves prefix bytes", () => {
  it("is byte-identical across a re-write of the same content under the pinned clock", () => {
    const m = new Memory(dataDir);
    m.writeSection("Goals", "Lift FTP to 280W by August");
    const before = buildSystemPrompt(persona, m);
    m.writeSection("Goals", "Lift FTP to 280W by August");
    const after = buildSystemPrompt(persona, m);
    expect(after).toBe(before);
  });

  it("is byte-identical across a fresh Memory reading the same dataDir", () => {
    const m1 = new Memory(dataDir);
    m1.writeSection("Goals", "Lift FTP to 280W by August");
    const first = buildSystemPrompt(persona, m1);
    const m2 = new Memory(dataDir);
    const second = buildSystemPrompt(persona, m2);
    expect(second).toBe(first);
  });
});
