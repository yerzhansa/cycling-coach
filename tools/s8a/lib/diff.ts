import { canonicalJson } from "./canonical.js";

/** Human-readable divergence report for two multi-line texts: a first-divergence
 *  header, ±3 context lines of each side, then both full texts appended (the
 *  human must see words, not hashes). */
export function textDiff(expectedLabel: string, expected: string, actualLabel: string, actual: string): string {
  const expLines = expected.split("\n");
  const actLines = actual.split("\n");
  const max = Math.max(expLines.length, actLines.length);
  let divergence = -1;
  for (let i = 0; i < max; i++) {
    if (expLines[i] !== actLines[i]) {
      divergence = i;
      break;
    }
  }
  const out: string[] = [];
  if (divergence === -1) {
    out.push("no line-level divergence (texts are identical)");
  } else {
    out.push(`first divergence at line ${divergence + 1}`);
    const context = (lines: string[], label: string) => {
      out.push(`--- ${label} (context) ---`);
      const from = Math.max(0, divergence - 3);
      const to = Math.min(lines.length - 1, divergence + 3);
      for (let i = from; i <= to; i++) {
        out.push(`${i + 1}${i === divergence ? ">" : ":"} ${lines[i] ?? "<absent>"}`);
      }
    };
    context(expLines, expectedLabel);
    context(actLines, actualLabel);
  }
  out.push("", `=== ${expectedLabel} (full) ===`, expected, "", `=== ${actualLabel} (full) ===`, actual, "");
  return out.join("\n");
}

/** Canonical-JSON diff of two values: side-by-side full canonical texts plus the
 *  first diverging canonical line. */
export function jsonDiff(expectedLabel: string, expected: unknown, actualLabel: string, actual: unknown): string {
  return textDiff(expectedLabel, canonicalJson(expected), actualLabel, canonicalJson(actual));
}
