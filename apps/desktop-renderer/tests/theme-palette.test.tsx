import { describe, expect, it } from "vitest";
import {
  applyPalette,
  resolveTheme,
  type ResolvedTheme,
} from "../src/theme/applyPalette.js";
import { DEFAULT_PALETTE_ID, FIXED, PALETTES, paletteById } from "../src/theme/palettes.js";
import {
  APPEARANCE_STORAGE_KEY,
  PALETTE_STORAGE_KEY,
  readStoredAppearance,
  readStoredPaletteId,
  writeStoredAppearance,
  writeStoredPaletteId,
} from "../src/theme/preferences.js";
import { setPrefersDark } from "./matchmedia.js";

function expectedProperties(paletteId: string, theme: ResolvedTheme): Map<string, string> {
  const palette = paletteById(paletteId);
  const ramp = theme === "dark" ? palette.d : palette.l;
  const fixed = theme === "dark" ? FIXED.d : FIXED.l;
  return new Map([
    ["--bg", ramp.bg],
    ["--rail", ramp.rail],
    ["--surface", ramp.sf],
    ["--surface-2", `color-mix(in srgb, ${ramp.sf} 55%, ${ramp.bg})`],
    ["--sunk", `color-mix(in srgb, ${ramp.rail} 55%, ${ramp.bg})`],
    ["--ink", ramp.ink],
    ["--ink-2", ramp.ink2],
    ["--ink-3", `color-mix(in srgb, ${ramp.ink2} 62%, ${ramp.bg})`],
    ["--line", ramp.line],
    ["--line-2", `color-mix(in srgb, ${ramp.line} 55%, ${ramp.ink2})`],
    ["--brand", ramp.br],
    ["--brand-ink", ramp.bri],
    ["--brand-soft", ramp.soft],
    ["--ok", ramp.ok],
    ["--fitness", fixed.fit],
    ["--fatigue", fixed.fat],
    ["--warn", fixed.warn],
    ["--danger", fixed.dgr],
  ]);
}

describe("palette engine", () => {
  it("ships fourteen palettes with Patrol first", () => {
    expect(PALETTES).toHaveLength(14);
    expect(PALETTES[0].id).toBe("patrol");
    expect(DEFAULT_PALETTE_ID).toBe("patrol");
    expect(new Set(PALETTES.map((palette) => palette.id)).size).toBe(14);
  });

  it("stamps every palette in both themes", () => {
    for (const palette of PALETTES) {
      for (const theme of ["light", "dark"] as const) {
        const root = document.createElement("div");
        const applied = applyPalette({ root, palette, appearance: theme });
        expect(applied).toBe(theme);
        expect(root.getAttribute("data-theme")).toBe(theme);
        for (const [property, value] of expectedProperties(palette.id, theme)) {
          expect(root.style.getPropertyValue(property)).toBe(value);
        }
      }
    }
  });

  it("keeps the chart pair fixed across every palette", () => {
    for (const palette of PALETTES) {
      const light = document.createElement("div");
      applyPalette({ root: light, palette, appearance: "light" });
      expect(light.style.getPropertyValue("--fitness")).toBe("#2E6FA8");
      expect(light.style.getPropertyValue("--fatigue")).toBe("#D97742");
      const dark = document.createElement("div");
      applyPalette({ root: dark, palette, appearance: "dark" });
      expect(dark.style.getPropertyValue("--fitness")).toBe("#4189CC");
      expect(dark.style.getPropertyValue("--fatigue")).toBe("#CF7A44");
    }
  });

  it("resolves the system appearance from the colour-scheme query", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("system")).toBe("light");
    setPrefersDark(true);
    expect(resolveTheme("system")).toBe("dark");
    expect(resolveTheme("light")).toBe("light");
  });
});

describe("theme preferences", () => {
  it("round-trips the palette and appearance through localStorage", () => {
    expect(readStoredPaletteId()).toBe("patrol");
    expect(readStoredAppearance()).toBe("system");

    writeStoredPaletteId("velodrome");
    writeStoredAppearance("dark");

    expect(localStorage.getItem(PALETTE_STORAGE_KEY)).toBe("velodrome");
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe("dark");
    expect(readStoredPaletteId()).toBe("velodrome");
    expect(readStoredAppearance()).toBe("dark");
  });

  it("falls back to the defaults when the stored values are unknown", () => {
    localStorage.setItem(PALETTE_STORAGE_KEY, "synthetic-missing-palette");
    localStorage.setItem(APPEARANCE_STORAGE_KEY, "synthetic-missing-appearance");

    expect(readStoredPaletteId()).toBe("patrol");
    expect(readStoredAppearance()).toBe("system");
  });
});
