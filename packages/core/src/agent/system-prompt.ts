import type { SportPersona } from "../sport.js";
import type { Memory } from "../memory/store.js";

// ============================================================================
// SYSTEM PROMPT BUILDER
// ============================================================================

export function buildSystemPrompt(
  persona: SportPersona,
  memory: Memory,
  tz: string = "UTC",
): string {
  const skillsContent = Object.values(persona.skills).join("\n\n---\n\n");
  const context = memory.getContext();

  const parts = [persona.soul];

  if (skillsContent) {
    parts.push("# Domain Knowledge\n\n" + skillsContent);
  }

  if (context) {
    parts.push("# Athlete Context\n\n" + context);
  }

  // Time zone only — never the date. The date goes per-message via
  // appendCurrentTimeLine() so it stays fresh across long sessions and
  // doesn't go stale crossing local midnight. See user-time.ts.
  parts.push(`# Current Date & Time\n\nTime zone: ${tz}`);

  return parts.join("\n\n---\n\n");
}
