import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("tray popover markup", () => {
  it("has the exact passive CSP and semantic two-card identity", async () => {
    const html = await readFile(resolve(root, "tray.html"), "utf8");
    expect(html).toContain(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(html).toContain('aria-label="Enduragent menu bar status"');
    expect(html).toContain('aria-label="Enduragent is running"');
    expect(html).toContain('aria-labelledby="residency-heading"');
    expect(html.match(/<article class="rail-card">/gu)).toHaveLength(2);
    for (const copy of [
      "Cycling coach",
      "Ready when you are",
      "Residency",
      "Running in the menu bar",
      "Window",
      "Close it without quitting",
    ])
      expect(html).toContain(copy);
    expect(html).not.toMatch(/<(?:button|a|form|input|canvas|svg)\b/iu);
    expect(html).not.toMatch(/\s(?:style|on\w+)=/iu);
    expect(html).not.toMatch(/<script(?![^>]+src=)/iu);
  });

  it("keeps script and styling passive and local", async () => {
    const [html, script, css] = await Promise.all([
      readFile(resolve(root, "tray.html"), "utf8"),
      readFile(resolve(root, "src/tray.ts"), "utf8"),
      readFile(resolve(root, "src/tray.css"), "utf8"),
    ]);
    const source = `${html}\n${script}\n${css}`;
    expect(css).toContain("prefers-color-scheme: dark");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("transition: none");
    expect(script).not.toMatch(/^\s*import\b/mu);
    expect(script).toContain('event.key === "Escape"');
    expect(source).not.toMatch(
      /fetch\s*\(|WebSocket|ipcRenderer|contextBridge|localStorage|sessionStorage|console\.|@enduragent\/|https?:|[?#]token/iu,
    );
    expect(source).not.toMatch(
      /\b(?:Fitness|Fatigue|Load|Intensity|workout|wellness|plan|spend|onboarding|chat)\b/iu,
    );
    expect(html).not.toMatch(/>\s*Form\s*</iu);
  });
});
