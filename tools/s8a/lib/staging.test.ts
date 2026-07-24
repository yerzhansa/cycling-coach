import { chmodSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { stageHome } from "./staging.js";
import type { S8aScenario } from "./types.js";

const SCENARIO: S8aScenario = {
  id: "staging-permissions",
  tier: "replay",
  description: "Synthetic staging permissions fixture",
  home: {
    memoryMd: "# Synthetic athlete profile\n",
    eventsJsonl: '{"kind":"synthetic"}\n',
    sessions: {
      "synthetic-chat":
        '{"role":"user","content":"Synthetic turn","ts":"1998-07-06T09:00:00.000Z"}\n',
    },
  },
  intervals: {},
  turns: [],
};

describe("stageHome", () => {
  let home: string;

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("provisions exact owner-only directories and files", () => {
    home = mkdtempSync(join(tmpdir(), "s8a-staging-test-"));
    chmodSync(home, 0o755);

    stageHome(home, SCENARIO);

    for (const path of [home, join(home, "memory"), join(home, "sessions")]) {
      const stats = lstatSync(path);
      expect(stats.isDirectory()).toBe(true);
      expect(stats.isSymbolicLink()).toBe(false);
      expect(stats.mode & 0o7777).toBe(0o700);
    }
    for (const path of [
      join(home, "memory", "MEMORY.md"),
      join(home, "memory", "events.jsonl"),
      join(home, "sessions", "synthetic-chat.jsonl"),
    ]) {
      const stats = lstatSync(path);
      expect(stats.isFile()).toBe(true);
      expect(stats.isSymbolicLink()).toBe(false);
      expect(stats.mode & 0o7777).toBe(0o600);
    }
  });
});
