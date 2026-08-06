import { FIXED, type Palette } from "./palettes.js";

export type Appearance = "light" | "dark" | "system";

export type ResolvedTheme = "light" | "dark";

export const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export function prefersDark(): boolean {
  return typeof matchMedia === "function" && matchMedia(DARK_MEDIA_QUERY).matches;
}

export function resolveTheme(appearance: Appearance): ResolvedTheme {
  if (appearance === "dark") return "dark";
  if (appearance === "light") return "light";
  return prefersDark() ? "dark" : "light";
}

export function paletteCustomProperties(
  palette: Palette,
  theme: ResolvedTheme,
): ReadonlyMap<string, string> {
  const ramp = theme === "dark" ? palette.d : palette.l;
  const fixed = theme === "dark" ? FIXED.d : FIXED.l;
  const controlEdge = theme === "dark" ? "93%" : "85%";
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
    ["--line-2", `color-mix(in srgb, ${ramp.line} ${controlEdge}, ${ramp.ink2})`],
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

export function applyPalette(input: {
  readonly root: HTMLElement;
  readonly palette: Palette;
  readonly appearance: Appearance;
}): ResolvedTheme {
  const theme = resolveTheme(input.appearance);
  input.root.setAttribute("data-theme", theme);
  const style = input.root.style;
  for (const [property, value] of paletteCustomProperties(input.palette, theme)) {
    style.setProperty(property, value);
  }
  return theme;
}
