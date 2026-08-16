import { DESKTOP_WINDOW_DARK_BACKGROUND, DESKTOP_WINDOW_LIGHT_BACKGROUND } from "./constants.js";

export type DesktopAppearance = "system" | "light" | "dark";

export type DesktopResolvedTheme = "light" | "dark";

const DESKTOP_APPEARANCES: readonly DesktopAppearance[] = Object.freeze([
  "system",
  "light",
  "dark",
]);

export function parseDesktopAppearance(value: unknown): DesktopAppearance | undefined {
  return DESKTOP_APPEARANCES.find((appearance) => appearance === value);
}

export function desktopWindowBackgroundColor(theme: DesktopResolvedTheme): string {
  return theme === "dark" ? DESKTOP_WINDOW_DARK_BACKGROUND : DESKTOP_WINDOW_LIGHT_BACKGROUND;
}
