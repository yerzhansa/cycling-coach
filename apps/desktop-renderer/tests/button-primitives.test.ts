import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buttonVariants } from "../src/components/ui/button.js";
import { cn } from "../src/lib/utils.js";
import * as buttons from "../src/ui/shared/buttons.js";

const themeRoot = resolve(import.meta.dirname, "..", "src", "theme");

function classes(value: string): ReadonlyArray<string> {
  return value.split(" ").filter((entry) => entry.length > 0);
}

function channel(component: number): number {
  const ratio = component / 255;
  return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((value >> 16) & 0xff) +
    0.7152 * channel((value >> 8) & 0xff) +
    0.0722 * channel(value & 0xff)
  );
}

function contrast(one: string, two: string): number {
  const a = luminance(one);
  const b = luminance(two);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function hexValues(source: string, token: string): ReadonlyArray<string> {
  return [...source.matchAll(new RegExp(`--${token}:\\s*(#[0-9a-f]{6})`, "gu"))].map(
    (match) => match[1] ?? "",
  );
}

describe("button primitives", () => {
  it("keeps the legacy bridge on the shadcn variant map", () => {
    expect(buttons.BUTTON_SOLID_SM).toBe(cn(buttonVariants({ variant: "default", size: "sm" })));
    expect(buttons.BUTTON_OUTLINE_SM).toBe(cn(buttonVariants({ variant: "outline", size: "sm" })));
    expect(buttons.BUTTON_QUIET_SM).toBe(cn(buttonVariants({ variant: "ghost", size: "sm" })));
    expect(buttons.BUTTON_COMPACT_QUIET_SM).toBe(buttons.BUTTON_QUIET_SM);
    expect(buttons.BUTTON_DANGER_QUIET_SM).toBe(
      cn(buttonVariants({ variant: "destructive", size: "sm" })),
    );
    expect(buttons.BUTTON_DANGER_SOLID_SM).toBe(
      cn(buttonVariants({ variant: "destructive-solid", size: "sm" })),
    );
    expect(buttons.BUTTON_PRIMARY).toBe(cn(buttonVariants({ variant: "default", size: "lg" })));
  });

  it("uses the Primer control sizes and radii for every button size", () => {
    expect(classes(buttonVariants({ size: "sm" }))).toEqual(
      expect.arrayContaining(["h-ctl-sm", "rounded-ctl", "text-sm"]),
    );
    expect(classes(buttonVariants())).toEqual(
      expect.arrayContaining(["h-ctl", "rounded-ctl", "text-sm"]),
    );
    expect(classes(buttonVariants({ size: "lg" }))).toEqual(
      expect.arrayContaining(["h-ctl-lg", "rounded-ctl", "text-sm"]),
    );
  });

  it("keeps disabled and aria-disabled controls inert at one opacity", () => {
    for (const variant of ["default", "outline", "ghost", "destructive"] as const) {
      expect(classes(buttonVariants({ variant }))).toEqual(
        expect.arrayContaining([
          "disabled:pointer-events-none",
          "disabled:opacity-64",
          "aria-disabled:pointer-events-none",
          "aria-disabled:cursor-default",
          "aria-disabled:opacity-64",
        ]),
      );
    }
  });

  it("keeps quiet and solid danger actions visually distinct", () => {
    const quiet = classes(buttons.BUTTON_DANGER_QUIET_SM);
    const solid = classes(buttons.BUTTON_DANGER_SOLID_SM);
    expect(quiet).toEqual(expect.arrayContaining(["bg-destructive/10", "text-destructive"]));
    expect(solid).toEqual(
      expect.arrayContaining(["border-destructive", "bg-destructive", "text-background"]),
    );
    expect(solid).not.toEqual(quiet);
  });

  it("keeps the solid danger fill readable in both themes", async () => {
    const tokens = await readFile(resolve(themeRoot, "tokens.css"), "utf8");
    const dangers = hexValues(tokens, "danger");
    const backgrounds = hexValues(tokens, "bg");
    const pairs = [
      [dangers[0] ?? "", backgrounds[0] ?? ""],
      [dangers.at(-1) ?? "", backgrounds.at(-1) ?? ""],
    ];
    expect(pairs[0]).not.toEqual(pairs[1]);
    for (const [fill, text] of pairs) expect(contrast(fill, text)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps resting button shadows and Tailwind preflight out", async () => {
    for (const value of Object.values(buttons)) {
      expect(classes(value).filter((entry) => entry.startsWith("shadow-"))).toEqual([]);
    }
    const entry = await readFile(resolve(themeRoot, "tailwind.css"), "utf8");
    expect(entry).not.toContain("preflight");
  });
});
