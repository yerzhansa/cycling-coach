import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as buttons from "../src/ui/shared/buttons.js";

const srcRoot = resolve(import.meta.dirname, "..", "src");
const themeRoot = resolve(srcRoot, "theme");

const DANGER_TOKEN = "danger";

const WEIGHT_TOKENS = /danger|ink/u;

function constants(): ReadonlyArray<readonly [string, string]> {
  return Object.entries<string>({ ...buttons }).filter(([, value]) => typeof value === "string");
}

function classes(value: string): ReadonlyArray<string> {
  return value.split(" ").filter((entry) => entry.length > 0);
}

function weightOf(value: string): ReadonlyArray<string> {
  return classes(value)
    .filter((entry) => !WEIGHT_TOKENS.test(entry))
    .sort();
}

function compact(value: string): string {
  return value.replaceAll("_", " ").replaceAll(/\s+/gu, "");
}

function arbitrary(constant: string, prefix: string): string {
  const start = constant.indexOf(`${prefix}-[`);
  expect(`${prefix} present=${String(start >= 0)}`).toContain("present=true");
  const open = start + prefix.length + 1;
  let depth = 0;
  for (let index = open; index < constant.length; index += 1) {
    if (constant[index] === "[") depth += 1;
    else if (constant[index] === "]") {
      depth -= 1;
      if (depth === 0) return constant.slice(open + 1, index);
    }
  }
  throw new Error(`Unterminated arbitrary value for ${prefix}`);
}

function declarations(source: string, selector: string): string {
  const start = source.indexOf(selector);
  expect(`${selector} found=${String(start >= 0)}`).toContain("found=true");
  const open = source.indexOf("{", start);
  return source.slice(open + 1, source.indexOf("}", open));
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

async function sourceFiles(directory: string): Promise<ReadonlyArray<string>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: Array<string> = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) found.push(path);
  }
  return found;
}

describe("button primitives", () => {
  it("gives every exported button constant a pointer cursor", () => {
    const exported = constants();
    expect(exported.length).toBeGreaterThanOrEqual(6);
    for (const [name, value] of exported) {
      expect(`${name} ${value}`).toContain("cursor-pointer");
      expect(`${name} ${value}`).toContain("disabled:cursor-default");
    }
  });

  it("exports exactly two danger button constants", () => {
    const danger = constants().filter(([, value]) => value.includes(DANGER_TOKEN));
    expect(danger.map(([name]) => name).sort()).toEqual([
      "BUTTON_DANGER_QUIET_SM",
      "BUTTON_DANGER_SOLID_SM",
    ]);
  });

  it("keeps the in-row danger button at the quiet weight with no border", () => {
    expect(weightOf(buttons.BUTTON_DANGER_QUIET_SM)).toEqual(weightOf(buttons.BUTTON_QUIET_SM));
    expect(classes(buttons.BUTTON_DANGER_QUIET_SM)).toContain("border-transparent");
    expect(classes(buttons.BUTTON_DANGER_QUIET_SM)).toContain("bg-transparent");
    const bordered = classes(buttons.BUTTON_DANGER_QUIET_SM).filter(
      (entry) => entry.startsWith("border-") && entry !== "border-transparent",
    );
    expect(bordered).toEqual([]);
    expect(
      classes(buttons.BUTTON_DANGER_QUIET_SM).filter((entry) => entry.startsWith("shadow-")),
    ).toEqual([]);
  });

  it("keeps the confirm danger button at the solid weight with a filled background", () => {
    expect(weightOf(buttons.BUTTON_DANGER_SOLID_SM)).toEqual(weightOf(buttons.BUTTON_SOLID_SM));
    expect(classes(buttons.BUTTON_DANGER_SOLID_SM)).toContain("bg-danger");
    expect(classes(buttons.BUTTON_DANGER_SOLID_SM)).toContain("border-danger");
    expect(classes(buttons.BUTTON_DANGER_SOLID_SM)).toContain("text-bg");
    expect(buttons.BUTTON_DANGER_SOLID_SM).not.toBe(buttons.BUTTON_DANGER_QUIET_SM);
  });

  it("keeps the solid danger fill readable in both themes", async () => {
    const tokens = await readFile(resolve(themeRoot, "tokens.css"), "utf8");
    const dangers = hexValues(tokens, "danger");
    const backgrounds = hexValues(tokens, "bg");
    expect(dangers.length).toBeGreaterThanOrEqual(2);
    expect(backgrounds.length).toBeGreaterThanOrEqual(2);
    const pairs = [
      [dangers[0] ?? "", backgrounds[0] ?? ""],
      [dangers.at(-1) ?? "", backgrounds.at(-1) ?? ""],
    ];
    expect(pairs[0]).not.toEqual(pairs[1]);
    for (const [fill, text] of pairs) expect(contrast(fill, text)).toBeGreaterThanOrEqual(4.5);
  });

  it("matches the module danger control to the quiet danger constant", async () => {
    const surface = await readFile(resolve(themeRoot, "surface.module.css"), "utf8");
    const hover = arbitrary(buttons.BUTTON_DANGER_QUIET_SM, "hover:bg");

    const base = compact(declarations(surface, ".dangerous"));
    expect(base).toContain("border-color:transparent");
    expect(base).toContain("background-color:transparent");
    expect(base).toContain("color:var(--danger)");

    const hovered = compact(declarations(surface, ".dangerous:hover:not(:disabled)"));
    expect(hovered).toContain(`background-color:${compact(hover)}`);
    expect(hovered).not.toContain("border-color:");
  });

  it("keeps every danger button on the shared constants", async () => {
    const offenders: Array<string> = [];
    for (const file of await sourceFiles(srcRoot)) {
      if (file.endsWith("shared/buttons.ts")) continue;
      const source = await readFile(file, "utf8");
      for (const literal of source.match(/"[^"\n]*"|`[^`]*`/gu) ?? []) {
        if (!literal.includes("text-danger")) continue;
        if (/h-ctl|rounded-ctl|cursor-pointer/u.test(literal)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("disables controls at one opacity across both styling systems", async () => {
    const surface = await readFile(resolve(themeRoot, "surface.module.css"), "utf8");
    const match = /disabled:opacity-(\d+)/u.exec(buttons.BUTTON_SOLID_SM);
    expect(match).not.toBeNull();
    const opacity = Number(match?.[1] ?? 0) / 100;
    expect(compact(declarations(surface, ".control:disabled"))).toContain(
      `opacity:${String(opacity)}`,
    );
  });

  it("keeps Tailwind preflight out of the stylesheet entry", async () => {
    const entry = await readFile(resolve(themeRoot, "tailwind.css"), "utf8");
    expect(entry).not.toContain("preflight");
  });

  it("gives the setup select the shared chevron affordances", async () => {
    const card = await readFile(resolve(srcRoot, "ui", "onboarding", "SetupCard.tsx"), "utf8");
    const surface = await readFile(resolve(themeRoot, "surface.module.css"), "utf8");
    const select = /export const SETUP_SELECT_CLASS =([\s\S]*?);\n/u.exec(card)?.[1] ?? "";
    for (const utility of [
      "cursor-pointer",
      "appearance-none",
      "bg-[image:var(--chevron)]",
      "bg-no-repeat",
    ])
      expect(select).toContain(utility);
    expect(compact(declarations(surface, "select.field"))).toContain(
      "background-image:var(--chevron)",
    );
  });
});
