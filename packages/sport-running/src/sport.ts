import { z } from "zod";
import {
  createCoreToolsWithSportConfig,
  createMemoryTools,
  createPureCoreIntervalsTools,
  getEffectiveSections,
  type CoreDeps,
  type MemorySectionSpec,
  type MemorySnapshot,
  type ReferenceSportAdapter,
  type Sport,
  type ToolRegistration,
} from "@enduragent/core";
import soul from "../SOUL.md";
import { skills as skillEntries } from "./skills.generated.js";
import { createRunningTools } from "./tools.js";
import { runningReferenceAdapter } from "./reference/index.js";
import { athleteProfileSchema } from "./schemas.js";

function loadSkills(): Record<string, string> {
  return Object.fromEntries(
    skillEntries.map(({ name, content }) => [`running-${name}`, content]),
  );
}

export const RUNNING_VOCABULARY: readonly string[] = [
  "CS",
  "critical speed",
  "pace",
  "LT1",
  "MMSS",
  "min/km",
];

const memorySections: readonly MemorySectionSpec[] = [
  {
    name: "running-profile",
    description:
      "Critical speed (CS), threshold pace, max HR, resting HR, experience level. " +
      "Body data lives in `person`; this is running-specific physiology.",
  },
  {
    name: "running-equipment",
    description: "Shoes (model, mileage), GPS watch, treadmill, racing flats",
  },
  {
    name: "running-history",
    description:
      "Running-specific injuries (shin splints, IT band, plantar, calf, Achilles), CS/threshold " +
      "test history, recovery patterns from runs. Chronic conditions belong in `medical-history`, not here.",
  },
];

export const runningSport: Sport = {
  id: "running",
  soul,
  skills: loadSkills(),
  sessionClusterGapMinutes: 30,
  memorySections,
  mustPreserveTokens: (memory: MemorySnapshot): readonly string[] => {
    const tokens: string[] = [...RUNNING_VOCABULARY];
    const profile = memory.read("running-profile");
    if (profile) {
      // Preserve the athlete's current CS across compaction. Accepts "CS 4.0",
      // "CS: 4.0 m/s", "critical speed 4.0 m/s". One decimal m/s value; first
      // match only (historical CS values aren't identity-defining).
      const match = profile.match(/\bCS\b[\s:,-]*(\d\.\d{1,2})\s*(?:m\/s)?\b/i);
      if (match) tokens.push(`CS ${match[1]} m/s`);
    }
    return tokens;
  },
  intervalsActivityTypes: ["Run", "TrailRun"],
  athleteProfileSchema,
  tools: (deps: CoreDeps): readonly ToolRegistration[] => {
    const sections = getEffectiveSections(runningSport);
    // Per ADR-0004: compose four tool buckets — memory (Pure-Core), intervals
    // Pure-Core, intervals Core-with-sport-config, and the sport-specific
    // running tools.
    const toolset = {
      ...createMemoryTools(deps.memory, sections),
      ...createPureCoreIntervalsTools(deps.intervals, deps.tz),
      ...createCoreToolsWithSportConfig(deps.intervals, runningSport.intervalsActivityTypes),
      ...createRunningTools(deps.memory, deps.intervals, deps.tz, deps.resolvedCs),
    };
    return Object.entries(toolset).map(([name, t]) => ({
      name,
      description: (t as { description?: string }).description ?? "",
      // Vercel AI SDK wraps the Zod schema into a FlexibleSchema that doesn't
      // expose the raw ZodTypeAny; introspection lives on `tool`.
      inputSchema: z.unknown(),
      tool: t,
    }));
  },
  // Fresh array per call so composing sports (duathlon) can spread it without
  // sharing a mutable reference.
  referenceAdapters: (): readonly ReferenceSportAdapter[] => [runningReferenceAdapter],
};
