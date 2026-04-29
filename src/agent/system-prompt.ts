import type { SportPersona } from "@cycling-coach/core";
import type { Memory } from "./memory.js";

// ============================================================================
// SYSTEM PROMPT BUILDER
// ============================================================================

export function buildSystemPrompt(persona: SportPersona, memory: Memory): string {
  const skillsContent = Object.values(persona.skills).join("\n\n---\n\n");
  const context = memory.getContext();

  const parts = [persona.soul];

  if (skillsContent) {
    parts.push("# Domain Knowledge\n\n" + skillsContent);
  }

  if (context) {
    parts.push("# Athlete Context\n\n" + context);
  }

  parts.push(`# Current Date\n\nToday is ${new Date().toISOString().split("T")[0]}.`);

  return parts.join("\n\n---\n\n");
}
