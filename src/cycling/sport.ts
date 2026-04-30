import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  getEffectiveSections,
  type CoreDeps,
  type MemorySectionSpec,
  type MemorySnapshot,
  type Sport,
  type ToolRegistration,
} from "@cycling-coach/core";
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
  {
    name: "cycling-profile",
    description:
      "FTP (watts), max HR, resting HR, W/kg ratio, experience level. " +
      "Body data lives in `person`; this is cycling-specific physiology.",
  },
  {
    name: "cycling-equipment",
    description: "Bikes, trainer, power meter, head unit, indoor setup",
  },
  {
    name: "cycling-history",
    description:
      "Cycling-specific injuries (knee, lower back, fit issues), FTP test history, " +
      "recovery patterns from rides, ride-related sleep/HRV trends. " +
      "Chronic conditions belong in `medical-history`, not here.",
  },
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
    const toolset = createTools(deps.memory, deps.intervals, getEffectiveSections(cyclingSport));
    return Object.entries(toolset).map(([name, t]) => ({
      name,
      description: (t as { description?: string }).description ?? "",
      // Vercel AI SDK wraps the Zod schema into a FlexibleSchema that
      // doesn't expose the raw ZodTypeAny; introspection lives on `tool`.
      inputSchema: z.unknown(),
      tool: t,
    }));
  },
};
