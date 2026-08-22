import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyPalette,
  paletteCustomProperties,
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

const NON_PALETTE_TOKENS = new Set([
  "--r",
  "--r-chip",
  "--r-ctl",
  "--r-card",
  "--r-pill",
  "--r-lg",
  "--r-xl",
  "--ctl-h",
  "--ctl-h-sm",
  "--ctl-h-lg",
  "--ctl-px",
  "--ctl-px-sm",
  "--ctl-px-lg",
  "--inset",
  "--row-inset",
  "--font-size-xs",
  "--line-height-xs",
  "--font-size-sm",
  "--line-height-sm",
  "--font-size-prose",
  "--line-height-prose",
  "--font-size-lg",
  "--line-height-lg",
  "--font-size-xl",
  "--line-height-xl",
  "--weight-regular",
  "--weight-medium",
  "--weight-semibold",
  "--tracking-ui",
  "--scrollbar-w",
  "--scrollbar-thumb",
  "--scrollbar-thumb-hover",
  "--elev-1",
  "--elev-2",
  "--elev-3",
  "--elev-4",
  "--scrim",
  "--tint",
  "--chevron",
]);

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort(
    (left, right) => right - left,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

function mixHex(first: string, firstWeight: number, second: string): string {
  const channels = [1, 3, 5].map((start) => {
    const firstChannel = Number.parseInt(first.slice(start, start + 2), 16);
    const secondChannel = Number.parseInt(second.slice(start, start + 2), 16);
    return Math.round(firstChannel * firstWeight + secondChannel * (1 - firstWeight));
  });
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function readTokenSheet(): Promise<string> {
  return readFile(resolve(import.meta.dirname, "..", "src", "theme", "tokens.css"), "utf8");
}

function blockDeclarations(source: string, selector: string): Map<string, string> {
  const start = source.indexOf(`${selector} {`);
  const body = source.slice(start, source.indexOf("}", start));
  const declarations = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu))
    declarations.set(match[1], match[2].trim());
  return declarations;
}

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
    ["--ink-3", `color-mix(in srgb, ${ramp.ink2} 78%, ${ramp.sf})`],
    ["--line", ramp.line],
    ["--line-2", `color-mix(in srgb, ${ramp.line} 25%, ${ramp.ink2})`],
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
  it("ships thirteen palettes with Patrol first", () => {
    expect(PALETTES).toHaveLength(13);
    expect(PALETTES[0].id).toBe("patrol");
    expect(DEFAULT_PALETTE_ID).toBe("patrol");
    expect(new Set(PALETTES.map((palette) => palette.id)).size).toBe(13);
  });

  it("defines the Cobalt palette in light and dark appearances", () => {
    expect(paletteById("cobalt")).toEqual({
      id: "cobalt",
      name: "Cobalt",
      l: {
        bg: "#fcfcfc",
        rail: "#fafafa",
        sf: "#ffffff",
        ink: "#27272a",
        ink2: "#71717a",
        line: "#e4e4e7",
        br: "#1b4ed8",
        bri: "#ffffff",
        soft: "#f4f4f5",
        ok: "#047857",
      },
      d: {
        bg: "#0a0a0a",
        rail: "#000000",
        sf: "#111111",
        ink: "#f5f5f5",
        ink2: "#a3a3a3",
        line: "#1a1a1a",
        br: "#366ffb",
        bri: "#0a0a0a",
        soft: "#141414",
        ok: "#34d399",
      },
    });
  });

  it("keeps Cobalt text and status colours readable in both appearances", () => {
    const palette = paletteById("cobalt");
    for (const ramp of [palette.l, palette.d]) {
      expect(contrastRatio(ramp.ink, ramp.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(ramp.ink2, ramp.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(ramp.br, ramp.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(ramp.bri, ramp.br)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(ramp.ok, ramp.bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps compact copy and control edges readable in every appearance", () => {
    for (const palette of PALETTES) {
      for (const ramp of [palette.l, palette.d]) {
        const setupBackgrounds = [ramp.bg, ramp.sf, mixHex(ramp.rail, 0.55, ramp.bg)];
        for (const background of setupBackgrounds) {
          expect(contrastRatio(ramp.ink2, background)).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrastRatio(mixHex(ramp.ink2, 0.78, ramp.sf), ramp.sf)).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(mixHex(ramp.line, 0.25, ramp.ink2), ramp.sf)).toBeGreaterThanOrEqual(
          3,
        );
      }
    }
  });

  it("stamps every palette in both themes", () => {
    for (const palette of PALETTES) {
      for (const theme of ["light", "dark"] as const) {
        const root = document.createElement("div");
        const applied = applyPalette({ root, palette, appearance: theme });
        expect(applied).toBe(theme);
        expect(root.getAttribute("data-theme")).toBe(theme);
        const expected = expectedProperties(palette.id, theme);
        for (const [property, value] of expected) {
          expect(root.style.getPropertyValue(property)).toBe(value);
        }
        expect([...root.style].sort()).toEqual([...expected.keys()].sort());
      }
    }
  });

  it("gives every palette a complete opaque ramp in both themes", () => {
    const hex = /^#[0-9a-f]{6}$/u;
    const invalid: string[] = [];
    for (const palette of PALETTES) {
      expect(palette.name.length).toBeGreaterThan(0);
      for (const ramp of [palette.l, palette.d]) {
        const entries = Object.entries(ramp);
        expect(entries).toHaveLength(10);
        for (const [key, value] of entries)
          if (!hex.test(value)) invalid.push(`${palette.id}.${key}=${value}`);
      }
      expect(palette.l).not.toEqual(palette.d);
    }
    expect(invalid).toEqual([]);
  });

  it("replaces every stamped property when the palette changes", () => {
    const root = document.createElement("div");
    const stale: string[] = [];
    for (const theme of ["light", "dark"] as const) {
      for (const palette of PALETTES) {
        applyPalette({ root, palette, appearance: theme });
        for (const [property, value] of paletteCustomProperties(palette, theme))
          if (root.style.getPropertyValue(property) !== value)
            stale.push(`${palette.id} ${theme} ${property}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it("bakes the default palette into the static token sheet", async () => {
    const sheet = await readTokenSheet();
    const fallback = paletteById(DEFAULT_PALETTE_ID);
    for (const [selector, theme] of [
      [":root", "light"],
      [':root[data-theme="dark"]', "dark"],
    ] as const) {
      const declared = blockDeclarations(sheet, selector);
      for (const [property, value] of paletteCustomProperties(fallback, theme))
        expect(
          `${selector} ${property}: ${declared.get(property)?.toLowerCase() ?? "absent"}`,
        ).toBe(`${selector} ${property}: ${value.toLowerCase()}`);
    }
  });

  it("declares the Primer type, radius, control, and resting-surface values", async () => {
    const declared = blockDeclarations(await readTokenSheet(), ":root");
    expect(
      Object.fromEntries(
        [
          "--font-size-xs",
          "--line-height-xs",
          "--font-size-sm",
          "--line-height-sm",
          "--font-size-prose",
          "--line-height-prose",
          "--font-size-lg",
          "--line-height-lg",
          "--font-size-xl",
          "--line-height-xl",
          "--weight-regular",
          "--weight-medium",
          "--weight-semibold",
          "--tracking-ui",
          "--r-chip",
          "--r-ctl",
          "--r-card",
          "--r-pill",
          "--ctl-h-sm",
          "--ctl-h",
          "--ctl-h-lg",
          "--elev-1",
        ].map((property) => [property, declared.get(property)]),
      ),
    ).toEqual({
      "--font-size-xs": "12px",
      "--line-height-xs": "16px",
      "--font-size-sm": "14px",
      "--line-height-sm": "20px",
      "--font-size-prose": "16px",
      "--line-height-prose": "24px",
      "--font-size-lg": "20px",
      "--line-height-lg": "28px",
      "--font-size-xl": "24px",
      "--line-height-xl": "32px",
      "--weight-regular": "400",
      "--weight-medium": "500",
      "--weight-semibold": "600",
      "--tracking-ui": "0",
      "--r-chip": "3px",
      "--r-ctl": "6px",
      "--r-card": "12px",
      "--r-pill": "9999px",
      "--ctl-h-sm": "28px",
      "--ctl-h": "32px",
      "--ctl-h-lg": "40px",
      "--elev-1": "0 0 #0000",
    });
  });

  it("covers the whole colour vocabulary declared in the token sheet", async () => {
    const tokens = await readTokenSheet();
    const declarations = blockDeclarations(tokens, ":root");
    const declared = [...declarations.keys()].filter(
      (property) => !property.startsWith("--f-") && !NON_PALETTE_TOKENS.has(property),
    );
    const stamped = new Set(paletteCustomProperties(PALETTES[0], "light").keys());
    const unresolved = declared.filter((property) => {
      if (stamped.has(property)) return false;
      const reference = declarations.get(property)?.match(/^var\((--[\w-]+)\)$/u)?.[1];
      return !reference || (!stamped.has(reference) && !NON_PALETTE_TOKENS.has(reference));
    });

    expect(declared.length).toBeGreaterThan(0);
    expect(unresolved).toEqual([]);
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
