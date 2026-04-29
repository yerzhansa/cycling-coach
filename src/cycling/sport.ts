import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type {
  CoreDeps,
  MemorySectionSpec,
  MemorySnapshot,
  Sport,
  ToolRegistration,
} from "@cycling-coach/core";
import type { Memory } from "../agent/memory.js";
import { createTools } from "../agent/tools.js";
import { athleteProfileSchema } from "./schemas.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");

function loadSoul(): string {
  return readFileSync(join(PROJECT_ROOT, "SOUL.md"), "utf-8");
}

function loadSkills(): Record<string, string> {
  const skillsDir = join(PROJECT_ROOT, "skills");
  return Object.fromEntries(
    readdirSync(skillsDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => [f.replace(/\.md$/, ""), readFileSync(join(skillsDir, f), "utf-8")]),
  );
}

const CYCLING_VOCABULARY: readonly string[] = [
  "FTP",
  "W/kg",
  "Coggan",
  "VO2max",
  "watts",
  "sweet spot",
  "TTE",
];

const memorySections: readonly MemorySectionSpec[] = [
  { name: "profile", description: "FTP, weight, age, experience level, max HR, resting HR, W/kg" },
  { name: "schedule", description: "Training days, weekly availability, scheduling preferences" },
  { name: "goals", description: "Target events, FTP targets, race dates, milestones" },
  { name: "equipment", description: "Bikes, trainer, power meter, head unit, indoor setup" },
  { name: "health", description: "Injuries, sleep patterns, recovery needs, HRV, resting HR" },
  { name: "preferences", description: "Indoor/outdoor, coaching style, cross-training" },
  { name: "notes", description: "Anything else important" },
];

export const cyclingSport: Sport = {
  id: "cycling",
  soul: loadSoul(),
  skills: loadSkills(),
  memorySections,
  mustPreserveTokens: (_memory: MemorySnapshot): readonly string[] => CYCLING_VOCABULARY,
  intervalsActivityTypes: ["Ride", "VirtualRide"],
  athleteProfileSchema,
  tools: (deps: CoreDeps): readonly ToolRegistration[] => {
    // Phase 1A cast: deps.memory is MemoryStore (interface); the legacy
    // createTools signature still wants the concrete Memory class because of
    // private fields. Memory structurally satisfies MemoryStore at runtime.
    // Commit 6 widens createTools/createMemoryReadTool to MemoryStore.
    const toolset = createTools(deps.memory as unknown as Memory, deps.intervals);
    return Object.entries(toolset).map(([name, t]) => ({
      name,
      description: (t as { description?: string }).description ?? "",
      // Vercel AI SDK wraps the original Zod schema into FlexibleSchema; the raw
      // ZodTypeAny is not recoverable from the Tool object. Commit 8 redefines
      // each tool with explicit registration metadata so this placeholder goes
      // away. No Core consumer reads ToolRegistration.inputSchema in commit 3.
      inputSchema: z.unknown(),
      tool: t,
    }));
  },
};
