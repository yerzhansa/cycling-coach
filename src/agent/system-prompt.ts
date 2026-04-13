import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Memory } from "./memory.js";

// ============================================================================
// SYSTEM PROMPT BUILDER
// ============================================================================

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");

export function buildSystemPrompt(memory: Memory): string {
  const soul = loadSoul();
  const skills = loadSkills();
  const context = memory.getContext();

  const parts = [soul];

  if (skills) {
    parts.push("# Domain Knowledge\n\n" + skills);
  }

  if (context) {
    parts.push("# Athlete Context\n\n" + context);
  }

  parts.push(`# Current Date\n\nToday is ${new Date().toISOString().split("T")[0]}.`);

  return parts.join("\n\n---\n\n");
}

function loadSoul(): string {
  const soulPath = join(PROJECT_ROOT, "SOUL.md");
  return readFileSync(soulPath, "utf-8");
}

function loadSkills(): string {
  const skillsDir = join(PROJECT_ROOT, "skills");
  const files = readdirSync(skillsDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  return files.map((f) => readFileSync(join(skillsDir, f), "utf-8")).join("\n\n---\n\n");
}
