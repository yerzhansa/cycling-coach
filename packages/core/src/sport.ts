import type { Tool } from "ai";
import type { z } from "zod";
import type { IntervalsClient } from "./intervals.js";
import type { LLM } from "./llm.js";
import type { MemorySnapshot, MemoryStore } from "./memory.js";
import type { SecretsResolver } from "./secrets/types.js";

// ─── Identity ──────────────────────────────────────────────────────────
/** Closed literal union — adding a sport requires a Core bump. Intentional. */
export type SportId = "cycling" | "running" | "duathlon";

/** intervals.icu activity-type filter values. */
export type IntervalsActivityType = "Ride" | "Run" | "VirtualRide" | "TrailRun";

// ─── Shared kernel ─────────────────────────────────────────────────────
/** Every sport's profile schema must extend this. */
export interface Person {
  weight: number;
  age: number;
  availableDays: number;
}

// ─── Memory section spec (ADR-0003) ────────────────────────────────────
export interface MemorySectionSpec {
  /** Bare for Core (`person`, `goals`); sport-prefixed for sports (`cycling-profile`). */
  name: string;
  /** Description shown to the LLM in section headers + memory_write tool docs. */
  description: string;
  /** Optional Zod schema; when present, Core validates writes. */
  schema?: z.ZodTypeAny;
}

// ─── Tool registration (ADR-0004) ──────────────────────────────────────
export interface ToolRegistration {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  tool: Tool;
}

// ─── Runtime services Core provides to tool factories ──────────────────
/**
 * `intervals` is nullable because intervals.icu is BYOK-optional — users
 * without an intervals API key still run the agent. Sport.tools() filters
 * intervals-bound tools when null.
 */
export interface CoreDeps {
  llm: LLM;
  intervals: IntervalsClient | null;
  memory: MemoryStore;
  secrets: SecretsResolver;
  /** Athlete IANA timezone, resolved by Core. Used so tools see the same
   * "today" the system prompt references. */
  tz: string;
}

// ─── Sport: the plug-point ─────────────────────────────────────────────
export interface Sport {
  readonly id: SportId;

  /** Soul prompt — coaching identity, voice, principles. */
  readonly soul: string;

  /** Skill prompts indexed by skill name (e.g. "build_plan", "assess_workout"). */
  readonly skills: Readonly<Record<string, string>>;

  /** Sport-prefixed memory sections. Core auto-merges shared sections at runtime. */
  readonly memorySections: readonly MemorySectionSpec[];

  /**
   * Phrases the LLM must never drop during compaction. Either:
   *   - a static array of literal tokens (e.g. ["FTP", "VDOT"]), OR
   *   - a function that derives tokens from the current memory state, for
   *     data-bound values like "FTP 247W" or specific bike models.
   * Compaction calls the function (if provided) just before each compaction
   * pass, so the protected list reflects the athlete's current data.
   */
  readonly mustPreserveTokens:
    | readonly string[]
    | ((memory: MemorySnapshot) => readonly string[]);

  /** intervals.icu activity types this sport reads/writes. */
  readonly intervalsActivityTypes: readonly IntervalsActivityType[];

  /** Zod schema for the athlete profile. Drives validation AND wizard prompts. */
  readonly athleteProfileSchema: z.ZodTypeAny;

  /** The one and only method: tools need runtime services. */
  tools(deps: CoreDeps): readonly ToolRegistration[];
}

// ─── Consumer-narrowed slices (interface segregation via Pick) ─────────
/** Slice consumed by the system-prompt builder. */
export type SportPersona = Pick<Sport, "soul" | "skills">;

/** Slice consumed by the memory store factory and the compaction module. */
export type SportMemoryShape = Pick<Sport, "memorySections" | "mustPreserveTokens">;

