import { readdir, readFile } from "node:fs/promises";
import { posix, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "..", "src");

const DARK_MEDIA = /prefers-color-scheme:\s*dark/u;
const SYSTEM_DARK_GUARD = ':not([data-theme="light"])';
const EXPLICIT_DARK_GUARD = '[data-theme="dark"]';

interface ParsedRule {
  readonly selector: string;
  readonly media: string | undefined;
  readonly raw: string;
  readonly declarations: ReadonlyMap<string, string>;
}

function readBlock(source: string, openIndex: number): { body: string; end: number } {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return { body: source.slice(openIndex + 1, index), end: index + 1 };
    }
  }
  throw new Error("Unbalanced CSS block");
}

function customProperties(body: string): ReadonlyMap<string, string> {
  const declarations = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/gu))
    declarations.set(match[1], match[2].trim());
  return declarations;
}

function collect(source: string, media: string | undefined, into: ParsedRule[]): void {
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("{", index);
    if (open === -1) return;
    const prelude = source.slice(index, open).trim();
    const { body, end } = readBlock(source, open);
    if (prelude.startsWith("@")) collect(body, prelude, into);
    else into.push({ selector: prelude, media, raw: body, declarations: customProperties(body) });
    index = end;
  }
}

function parse(source: string): readonly ParsedRule[] {
  const rules: ParsedRule[] = [];
  collect(source.replace(/\/\*[\s\S]*?\*\//gu, ""), undefined, rules);
  return rules;
}

async function stylesheets(): Promise<readonly string[]> {
  const entries = await readdir(sourceRoot, { recursive: true });
  return entries
    .filter((entry) => entry.endsWith(".css"))
    .map((entry) => entry.split(sep).join(posix.sep))
    .sort();
}

describe("theme guards", () => {
  it("gates every system-dark custom property behind the explicit light override", async () => {
    const files = await stylesheets();
    expect(files).toContain("styles.css");
    expect(files).toContain("training-context/styles.css");

    let guarded = 0;
    for (const file of files) {
      const rules = parse(await readFile(resolve(sourceRoot, file), "utf8"));
      for (const rule of rules) {
        if (rule.media === undefined || !DARK_MEDIA.test(rule.media)) continue;
        if (rule.declarations.size === 0) continue;
        guarded += 1;
        expect(`${file} ${rule.selector}`).toContain(SYSTEM_DARK_GUARD);
      }
    }
    expect(guarded).toBeGreaterThanOrEqual(3);
  });

  it("mirrors every system-dark custom property onto the stamped dark theme", async () => {
    for (const file of await stylesheets()) {
      const rules = parse(await readFile(resolve(sourceRoot, file), "utf8"));
      const stamped = rules.filter(
        (rule) => rule.media === undefined && rule.selector.includes(EXPLICIT_DARK_GUARD),
      );
      for (const rule of rules) {
        if (rule.media === undefined || !DARK_MEDIA.test(rule.media)) continue;
        for (const [property, value] of rule.declarations) {
          const mirrored = stamped.some(
            (candidate) => candidate.declarations.get(property) === value,
          );
          expect(`${file} ${property}: ${value} mirrored=${String(mirrored)}`).toContain(
            "mirrored=true",
          );
        }
      }
    }
  });

  it("keeps the legacy surface ramp readable against the stamped palette ink", async () => {
    const rules = parse(await readFile(resolve(sourceRoot, "styles.css"), "utf8"));
    const stamped = rules.find(
      (rule) => rule.media === undefined && rule.selector === ':root[data-theme="dark"]',
    );
    expect(stamped).toBeDefined();
    for (const property of [
      "--canvas",
      "--surface",
      "--surface-solid",
      "--surface-soft",
      "--muted",
      "--faint",
      "--line-strong",
      "--focus",
      "--moss",
      "--moss-strong",
      "--moss-soft",
      "--coral",
    ])
      expect(stamped?.declarations.has(property)).toBe(true);

    const tokens = parse(await readFile(resolve(sourceRoot, "theme/tokens.css"), "utf8"));
    for (const [selector, scheme] of [
      [':root[data-theme="light"]', "light"],
      [':root[data-theme="dark"]', "dark"],
    ] as const)
      expect(
        tokens.some(
          (rule) =>
            rule.media === undefined &&
            rule.selector === selector &&
            new RegExp(`color-scheme:\\s*${scheme}\\s*;`, "u").test(rule.raw),
        ),
      ).toBe(true);

    const drawer = parse(await readFile(resolve(sourceRoot, "training-context/styles.css"), "utf8"));
    expect(
      drawer.some(
        (rule) =>
          rule.media === undefined &&
          rule.selector.includes(EXPLICIT_DARK_GUARD) &&
          rule.declarations.has("--sync-status-caution"),
      ),
    ).toBe(true);
  });
});
