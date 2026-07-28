import { readdir, readFile } from "node:fs/promises";
import { posix, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "..", "src");

const DARK_MEDIA = /prefers-color-scheme:\s*dark/u;
const SYSTEM_DARK_GUARD = ':not([data-theme="light"])';
const EXPLICIT_DARK_GUARD = '[data-theme="dark"]';
const RUNTIME_PROPERTIES = new Set(["--chat-composer-clearance"]);

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
    expect(files).toContain("theme/tokens.css");

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
    expect(guarded).toBeGreaterThanOrEqual(1);
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

  it("stamps the colour scheme for both explicit themes", async () => {
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
  });

  it("resolves every referenced custom property from the theme vocabulary", async () => {
    const tokens = parse(await readFile(resolve(sourceRoot, "theme/tokens.css"), "utf8"));
    const declared = new Set(
      tokens.flatMap((rule) =>
        rule.selector.startsWith(":root") ? [...rule.declarations.keys()] : [],
      ),
    );
    expect(declared.size).toBeGreaterThanOrEqual(20);

    const undeclared: string[] = [];
    for (const file of await stylesheets()) {
      const source = await readFile(resolve(sourceRoot, file), "utf8");
      for (const match of source.matchAll(/var\(\s*(--[\w-]+)/gu)) {
        const property = match[1];
        if (RUNTIME_PROPERTIES.has(property) || declared.has(property)) continue;
        undeclared.push(`${file} ${property}`);
      }
    }
    expect(undeclared).toEqual([]);
  });
});
