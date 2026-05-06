import { describe, it, expect } from "vitest";
import { markdownToTelegramHtml, chunkHtml } from "../src/channels/telegram.js";

describe("markdownToTelegramHtml", () => {
  it("passes plain markdown through with existing transforms", () => {
    const out = markdownToTelegramHtml("# Hello\n\nSome **bold** and *italic*.\n- one\n- two");
    expect(out).toContain("<b>Hello</b>");
    expect(out).toContain("<b>bold</b>");
    expect(out).toContain("<i>italic</i>");
    expect(out).toContain("• one");
  });

  it("renders a basic markdown table as a padded <pre> block", () => {
    const md = `| Phase | Duration |\n|-------|----------|\n| Warmup | 10min |\n| Main | 30min |`;
    const out = markdownToTelegramHtml(md);
    expect(out.startsWith("<pre>")).toBe(true);
    expect(out.endsWith("</pre>")).toBe(true);
    // Header padded to widest cell ("Warmup" = 6); columns separated by two spaces.
    expect(out).toContain("Phase   Duration");
    expect(out).toContain("Warmup  10min");
    expect(out).toContain("Main    30min");
  });

  it("escapes HTML special chars inside table cells", () => {
    const md = `| Day | Plan |\n|-----|------|\n| Mon | <easy> & rest |`;
    const out = markdownToTelegramHtml(md);
    expect(out).toContain("&lt;easy&gt;");
    expect(out).toContain("&amp;");
    expect(out).not.toContain("<easy>");
  });

  it("renders multiple tables as separate <pre> blocks", () => {
    const md = `| A | B |\n|---|---|\n| 1 | 2 |\n\n| C | D |\n|---|---|\n| 3 | 4 |`;
    const out = markdownToTelegramHtml(md);
    const matches = out.match(/<pre>[\s\S]*?<\/pre>/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("leaves a malformed table (no separator) as plain pipes", () => {
    const md = `| not | a | table |\n| really | not | one |`;
    const out = markdownToTelegramHtml(md);
    expect(out).not.toContain("<pre>");
    expect(out).toContain("|");
  });

  it("does not let italic regex match the placeholder content", () => {
    const md = `| _hidden_ | x |\n|----------|---|\n| a | b |`;
    const out = markdownToTelegramHtml(md);
    expect(out).toContain("<pre>");
    // The leading underscore in "_hidden_" stays literal inside the <pre>;
    // it should NOT have been turned into <i>hidden</i> by the italic pass.
    expect(out).not.toContain("<i>hidden</i>");
  });

  it("renders a header-only table (no body rows) without crashing", () => {
    const md = `| Col1 | Col2 |\n|------|------|`;
    const out = markdownToTelegramHtml(md);
    expect(out).toContain("<pre>");
    expect(out).toContain("Col1");
    expect(out).toContain("Col2");
  });

  it("renders a table at the very start of a message cleanly", () => {
    const md = `| A | B |\n|---|---|\n| 1 | 2 |\n\nFollow-up text.`;
    const out = markdownToTelegramHtml(md);
    expect(out.startsWith("<pre>")).toBe(true);
    expect(out).toContain("Follow-up text.");
  });

  it("renders a table at the very end of a message cleanly", () => {
    const md = `Intro text.\n\n| A | B |\n|---|---|\n| 1 | 2 |`;
    const out = markdownToTelegramHtml(md);
    expect(out).toContain("Intro text.");
    expect(out.trimEnd().endsWith("</pre>")).toBe(true);
  });

  it("coexists with markdown code blocks (both become separate <pre> blocks)", () => {
    const md = "```\nsome code\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |";
    const out = markdownToTelegramHtml(md);
    const preBlocks = out.match(/<pre>[\s\S]*?<\/pre>/g) ?? [];
    expect(preBlocks.length).toBe(2);
    expect(out).toContain("some code");
    expect(out).toContain("1");
  });
});

describe("chunkHtml", () => {
  const MAX = 4096;

  it("returns a single chunk when the message fits", () => {
    expect(chunkHtml("short message")).toEqual(["short message"]);
  });

  it("splits on line boundaries when there is no <pre> block", () => {
    const line = "x".repeat(2000);
    const html = `${line}\n${line}\n${line}`;
    const chunks = chunkHtml(html);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX);
  });

  it("keeps a multi-line <pre> block whole when the surrounding text pushes total over the limit", () => {
    const para = "x".repeat(2500);
    const pre = "<pre>row1\nrow2\nrow3\nrow4</pre>";
    const html = `${para}\n\n${para}\n\n${pre}`;
    expect(html.length).toBeGreaterThan(MAX);
    const chunks = chunkHtml(html);
    expect(chunks.length).toBeGreaterThan(1);
    // Whichever chunk contains <pre> must also contain </pre> on the same chunk.
    const preChunk = chunks.find((c) => c.includes("<pre>"));
    expect(preChunk).toBeDefined();
    expect(preChunk).toContain("</pre>");
    expect(preChunk).toContain("row4");
  });

  it("splits a <pre> block whose own size exceeds the limit into multiple wrapped <pre> chunks", () => {
    const row = "row content padding ".repeat(20); // ~400 chars
    const rows = Array.from({ length: 30 }, (_, i) => `${i}: ${row}`).join("\n");
    const pre = `<pre>${rows}</pre>`;
    expect(pre.length).toBeGreaterThan(MAX);
    const chunks = chunkHtml(pre);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX);
      // Every chunk that contains <pre> content must have a matching close, and vice versa.
      const opens = (c.match(/<pre>/g) ?? []).length;
      const closes = (c.match(/<\/pre>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });

  it("hard-splits a single non-<pre> line longer than the limit", () => {
    const line = "y".repeat(MAX + 500);
    const chunks = chunkHtml(line);
    expect(chunks.length).toBe(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX);
    expect(chunks.join("")).toBe(line);
  });

  it("invariant: every chunk has matching <pre>/</pre> tag counts", () => {
    const filler = "lorem ipsum dolor sit amet ".repeat(200); // ~5400 chars
    const pre = `<pre>${"x".repeat(50)}\n${"y".repeat(50)}\n${"z".repeat(50)}</pre>`;
    const html = `${filler}\n${pre}\n${filler}`;
    const chunks = chunkHtml(html);
    for (const c of chunks) {
      const opens = (c.match(/<pre>/g) ?? []).length;
      const closes = (c.match(/<\/pre>/g) ?? []).length;
      expect(opens).toBe(closes);
      expect(c.length).toBeLessThanOrEqual(MAX);
    }
  });

  it("preserves consecutive multi-line <pre> blocks across chunking", () => {
    const pre1 = "<pre>a\nb\nc</pre>";
    const pre2 = "<pre>d\ne\nf</pre>";
    // Two paragraphs of filler force chunking; both <pre> blocks must end up intact.
    const filler = "x".repeat(2500);
    const html = `${pre1}\n\n${filler}\n\n${pre2}\n\n${filler}`;
    expect(html.length).toBeGreaterThan(MAX);
    const chunks = chunkHtml(html);
    expect(chunks.join("\n")).toContain(pre1);
    expect(chunks.join("\n")).toContain(pre2);
    for (const c of chunks) {
      expect((c.match(/<pre>/g) ?? []).length).toBe((c.match(/<\/pre>/g) ?? []).length);
    }
  });
});
