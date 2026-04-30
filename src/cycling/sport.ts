import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  createMemoryTools,
  getEffectiveSections,
  type CoreDeps,
  type MemorySectionSpec,
  type MemorySnapshot,
  type Sport,
  type ToolRegistration,
} from "@enduragent/core";
import { createCyclingTools } from "./tools.js";
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

export const CYCLING_VOCABULARY: readonly string[] = [
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
  mustPreserveTokens: (memory: MemorySnapshot): readonly string[] => {
    const tokens: string[] = [...CYCLING_VOCABULARY];
    const profile = memory.read("cycling-profile");
    if (profile) {
      // \bFTP\b prevents matching "SoftPlate" etc. Separator class accepts FTP 247,
      // FTP: 247, FTP, 247, FTP - 247. Unit optional. Digit range 2-3 (50-999W)
      // rejects 4-digit year collisions like "FTP test 2024-06: 240W" → matches 240,
      // not 2024. Trailing \b ensures we don't capture "FTP 247abc". First match
      // only — historical FTPs aren't identity-defining and would balloon
      // false-positive surface.
      const match = profile.match(/\bFTP\b[\s:,-]*(\d{2,3})\s*[wW]?\b/);
      if (match) tokens.push(`FTP ${match[1]}W`);
    }
    return tokens;
  },
  intervalsActivityTypes: ["Ride", "VirtualRide"],
  athleteProfileSchema,
  tools: (deps: CoreDeps): readonly ToolRegistration[] => {
    const sections = getEffectiveSections(cyclingSport);
    const toolset = {
      ...createMemoryTools(deps.memory, sections),
      ...createCyclingTools(deps.memory, deps.intervals),
    };
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
