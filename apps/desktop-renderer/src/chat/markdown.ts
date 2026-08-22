import { COACH_RESPONSE_CODE_UNIT_LIMIT } from "./limits.js";

export interface CoachMarkdownLimits {
  readonly sourceCharacters: number;
  readonly workUnits: number;
  readonly nodes: number;
}

export const DEFAULT_COACH_MARKDOWN_LIMITS: CoachMarkdownLimits = Object.freeze({
  sourceCharacters: COACH_RESPONSE_CODE_UNIT_LIMIT,
  workUnits: 500_000,
  nodes: 4_096,
});

const MAX_INLINE_DEPTH = 16;
const FENCE_OPENING = /^ {0,3}(`{3,}|~{3,})(?:[ \t]*([\w-]+))?[ \t]*$/u;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+)$/u;
const UNORDERED_ITEM = /^ {0,3}[-+*][ \t]+(.+)$/u;
const ORDERED_ITEM = /^ {0,3}(\d+)[.)][ \t]+(.+)$/u;

class MarkdownBudget {
  private workRemaining: number;
  private nodesRemaining: number;

  constructor(source: string, limits: CoachMarkdownLimits) {
    if (
      !Number.isSafeInteger(limits.sourceCharacters) ||
      limits.sourceCharacters < 0 ||
      !Number.isSafeInteger(limits.workUnits) ||
      limits.workUnits < 0 ||
      !Number.isSafeInteger(limits.nodes) ||
      limits.nodes < 0 ||
      source.length > limits.sourceCharacters
    ) {
      throw new RangeError();
    }
    this.workRemaining = limits.workUnits;
    this.nodesRemaining = limits.nodes;
    this.work(source.length);
  }

  work(units: number): void {
    this.workRemaining -= units;
    if (this.workRemaining < 0) throw new RangeError();
  }

  node(): void {
    this.nodesRemaining -= 1;
    if (this.nodesRemaining < 0) throw new RangeError();
  }
}

function element(budget: MarkdownBudget, tagName: string): HTMLElement {
  budget.node();
  return document.createElement(tagName);
}

function textNode(budget: MarkdownBudget, value: string): Text {
  budget.node();
  return document.createTextNode(value);
}

function setLiteral(element: HTMLElement, value: string, budget: MarkdownBudget): void {
  if (value.length > 0) budget.node();
  element.textContent = value;
}

function appendText(parent: HTMLElement, value: string, budget: MarkdownBudget): void {
  if (value.length > 0) parent.append(textNode(budget, value));
}

function hasUnsafeUrlCodePoint(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function canonicalExternalUrl(value: string): string | undefined {
  if (hasUnsafeUrlCodePoint(value)) return undefined;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.hostname.length === 0 ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function isWhitespace(value: string | undefined): boolean {
  return value === undefined || /\s/u.test(value);
}

function isWord(value: string | undefined): boolean {
  return value !== undefined && /\w/u.test(value);
}

function canOpenAsterisk(text: string, index: number): boolean {
  const before = text[index - 1];
  const after = text[index + 1];
  return !isWord(before) && before !== "*" && !isWhitespace(after) && after !== "*";
}

function canCloseAsterisk(text: string, index: number): boolean {
  const before = text[index - 1];
  const after = text[index + 1];
  return !isWhitespace(before) && before !== "*" && !isWord(after) && after !== "*";
}

function canOpenUnderscore(text: string, index: number): boolean {
  return !isWord(text[index - 1]);
}

function canCloseUnderscore(text: string, index: number, length = 1): boolean {
  return !isWord(text[index + length]);
}

function escapedAt(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function findSimpleClosing(
  text: string,
  from: number,
  marker: string,
  budget: MarkdownBudget,
): number {
  for (let index = from; index <= text.length - marker.length; index += 1) {
    budget.work(1);
    if (text[index] === "\n") return -1;
    if (text[index] !== marker[0] || escapedAt(text, index)) continue;
    budget.work(marker.length);
    if (text.startsWith(marker, index)) return index;
  }
  return -1;
}

function findSingleEmphasisClosing(
  text: string,
  from: number,
  marker: "*" | "_",
  budget: MarkdownBudget,
): number {
  for (let index = from; index < text.length; index += 1) {
    budget.work(1);
    if (marker === "*" && text[index] === "\n") return -1;
    if (text[index] !== marker || escapedAt(text, index)) continue;
    return index;
  }
  return -1;
}

type ParsedLink =
  | { readonly kind: "none"; readonly consumed: number }
  | { readonly kind: "unterminated" }
  | {
      readonly kind: "complete";
      readonly end: number;
      readonly label: string;
      readonly destination: string;
    };

function parseLink(text: string, start: number, budget: MarkdownBudget): ParsedLink {
  let labelEnd = -1;
  for (let index = start + 1; index < text.length; index += 1) {
    budget.work(1);
    if (text[index] === "]" && !escapedAt(text, index)) {
      labelEnd = index;
      break;
    }
  }
  if (labelEnd === -1) return { kind: "unterminated" };
  if (text[labelEnd + 1] !== "(") {
    return { kind: "none", consumed: labelEnd - start + 1 };
  }

  let depth = 1;
  let destination = "";
  for (let index = labelEnd + 2; index < text.length; index += 1) {
    budget.work(1);
    const current = text[index]!;
    if (current === "\\" && index + 1 < text.length) {
      budget.work(1);
      destination += text[index + 1]!;
      index += 1;
      continue;
    }
    if (current === "(") {
      depth += 1;
      destination += current;
      continue;
    }
    if (current === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          kind: "complete",
          end: index + 1,
          label: text.slice(start + 1, labelEnd),
          destination,
        };
      }
      destination += current;
      continue;
    }
    destination += current;
  }
  return { kind: "unterminated" };
}

function appendInline(
  parent: HTMLElement,
  source: string,
  budget: MarkdownBudget,
  depth = 0,
): void {
  if (depth >= MAX_INLINE_DEPTH) {
    appendText(parent, source, budget);
    return;
  }

  let index = 0;
  let plain = "";
  const flush = (): void => {
    appendText(parent, plain, budget);
    plain = "";
  };
  const appendRemainder = (): void => {
    plain += source.slice(index);
    index = source.length;
  };

  while (index < source.length) {
    budget.work(1);
    const current = source[index]!;
    if (current === "\\" && index + 1 < source.length) {
      budget.work(1);
      plain += source[index + 1]!;
      index += 2;
      continue;
    }
    if (current === "\n") {
      flush();
      parent.append(element(budget, "br"));
      index += 1;
      continue;
    }

    if (current === "`") {
      let markerLength = 1;
      while (source[index + markerLength] === "`") markerLength += 1;
      budget.work(markerLength - 1);
      const marker = "`".repeat(markerLength);
      const closing = findSimpleClosing(source, index + markerLength, marker, budget);
      if (closing === -1) {
        appendRemainder();
        break;
      }
      flush();
      const code = element(budget, "code");
      setLiteral(code, source.slice(index + markerLength, closing), budget);
      parent.append(code);
      index = closing + markerLength;
      continue;
    }

    const pairedMarker = source.startsWith("**", index)
      ? { marker: "**", tag: "strong" }
      : source.startsWith("~~", index)
        ? { marker: "~~", tag: "del" }
        : undefined;
    if (pairedMarker !== undefined) {
      const contentStart = index + pairedMarker.marker.length;
      const closing = findSimpleClosing(source, contentStart, pairedMarker.marker, budget);
      if (closing === -1) {
        appendRemainder();
        break;
      }
      if (closing === contentStart) {
        plain += pairedMarker.marker;
        index = contentStart;
        continue;
      }
      flush();
      const formatted = element(budget, pairedMarker.tag);
      appendInline(formatted, source.slice(contentStart, closing), budget, depth + 1);
      parent.append(formatted);
      index = closing + pairedMarker.marker.length;
      continue;
    }

    if (current === "[" && (index === 0 || source[index - 1] !== "!")) {
      const link = parseLink(source, index, budget);
      if (link.kind === "unterminated") {
        appendRemainder();
        break;
      }
      if (link.kind === "none") {
        plain += source.slice(index, index + link.consumed);
        index += link.consumed;
        continue;
      }
      const href = canonicalExternalUrl(link.destination);
      if (href === undefined) {
        plain += source.slice(index, link.end);
      } else {
        flush();
        const anchor = element(budget, "a");
        anchor.setAttribute("href", href);
        anchor.setAttribute("target", "_blank");
        anchor.setAttribute("rel", "noopener noreferrer");
        anchor.setAttribute("referrerpolicy", "no-referrer");
        appendInline(anchor, link.label, budget, depth + 1);
        parent.append(anchor);
      }
      index = link.end;
      continue;
    }

    const canOpenEmphasis =
      (current === "*" && canOpenAsterisk(source, index)) ||
      (current === "_" && canOpenUnderscore(source, index));
    if ((current === "*" || current === "_") && canOpenEmphasis) {
      const closing = findSingleEmphasisClosing(source, index + 1, current, budget);
      if (closing === -1) {
        appendRemainder();
        break;
      }
      const canClose =
        closing > index + 1 &&
        (current === "*" ? canCloseAsterisk(source, closing) : canCloseUnderscore(source, closing));
      if (!canClose) {
        plain += current;
        index += 1;
        continue;
      }
      flush();
      const emphasis = element(budget, "em");
      appendInline(emphasis, source.slice(index + 1, closing), budget, depth + 1);
      parent.append(emphasis);
      index = closing + 1;
      continue;
    }

    plain += current;
    index += 1;
  }
  flush();
}

function splitTableRow(line: string, budget: MarkdownBudget): string[] {
  budget.work(line.length);
  const trimmed = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  const cells: string[] = [];
  let cell = "";
  let codeMarkerLength = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    budget.work(1);
    const current = trimmed[index]!;
    if (current === "\\" && trimmed[index + 1] === "|") {
      cell += "|";
      index += 1;
      continue;
    }
    if (current === "`") {
      let length = 1;
      while (trimmed[index + length] === "`") length += 1;
      if (codeMarkerLength === 0) codeMarkerLength = length;
      else if (codeMarkerLength === length) codeMarkerLength = 0;
      cell += "`".repeat(length);
      index += length - 1;
      continue;
    }
    if (current === "|" && codeMarkerLength === 0) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += current;
  }
  cells.push(cell.trim());
  return cells;
}

function tableColumns(
  lines: readonly string[],
  index: number,
  budget: MarkdownBudget,
): readonly string[][] | undefined {
  if (index + 1 >= lines.length || !lines[index]!.includes("|")) return undefined;
  const header = splitTableRow(lines[index]!, budget);
  const separator = splitTableRow(lines[index + 1]!, budget);
  if (
    header.length !== separator.length ||
    header.length === 0 ||
    !separator.every((cell) => /^:?-{3,}:?$/u.test(cell))
  ) {
    return undefined;
  }
  return [header, separator];
}

function closesFence(line: string, marker: string, budget: MarkdownBudget): boolean {
  budget.work(line.length);
  let index = 0;
  while (index < 3 && line[index] === " ") index += 1;
  let markerLength = 0;
  while (line[index + markerLength] === marker[0]) markerLength += 1;
  if (markerLength < marker.length) return false;
  for (let cursor = index + markerLength; cursor < line.length; cursor += 1) {
    if (line[cursor] !== " " && line[cursor] !== "\t") return false;
  }
  return true;
}

function isBlockStart(lines: readonly string[], index: number, budget: MarkdownBudget): boolean {
  const line = lines[index]!;
  budget.work(line.length);
  return (
    HEADING.test(line) ||
    UNORDERED_ITEM.test(line) ||
    ORDERED_ITEM.test(line) ||
    FENCE_OPENING.test(line) ||
    tableColumns(lines, index, budget) !== undefined
  );
}

function appendTable(
  parent: DocumentFragment,
  rows: readonly string[][],
  budget: MarkdownBudget,
): void {
  const scroll = element(budget, "div");
  scroll.className = "chat-markdown__table-scroll my-[0.65em] max-w-full overflow-x-auto";
  const table = element(budget, "table");
  const head = element(budget, "thead");
  const headRow = element(budget, "tr");
  for (const value of rows[0]!) {
    const heading = element(budget, "th");
    heading.setAttribute("scope", "col");
    appendInline(heading, value, budget);
    headRow.append(heading);
  }
  head.append(headRow);
  table.append(head);
  if (rows.length > 1) {
    const body = element(budget, "tbody");
    for (const row of rows.slice(1)) {
      const tableRow = element(budget, "tr");
      for (let index = 0; index < rows[0]!.length; index += 1) {
        const cell = element(budget, "td");
        appendInline(cell, row[index] ?? "", budget);
        tableRow.append(cell);
      }
      body.append(tableRow);
    }
    table.append(body);
  }
  scroll.append(table);
  parent.append(scroll);
}

function parseBlocks(source: string, budget: MarkdownBudget): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    budget.work(line.length + 1);
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const opening = FENCE_OPENING.exec(line);
    if (opening !== null) {
      const marker = opening[1]!;
      let closingIndex = -1;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        if (closesFence(lines[cursor]!, marker, budget)) {
          closingIndex = cursor;
          break;
        }
      }
      const pre = element(budget, "pre");
      const code = element(budget, "code");
      if (closingIndex === -1) {
        setLiteral(code, lines.slice(index).join("\n"), budget);
        pre.append(code);
        fragment.append(pre);
        break;
      }
      if (opening[2] !== undefined) code.dataset.language = opening[2];
      setLiteral(code, lines.slice(index + 1, closingIndex).join("\n"), budget);
      pre.append(code);
      fragment.append(pre);
      index = closingIndex + 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const headingElement = element(budget, `h${heading[1]!.length}`);
      appendInline(headingElement, heading[2]!, budget);
      fragment.append(headingElement);
      index += 1;
      continue;
    }

    const columns = tableColumns(lines, index, budget);
    if (columns !== undefined) {
      const rows = [columns[0]!];
      index += 2;
      while (
        index < lines.length &&
        lines[index]!.trim().length > 0 &&
        lines[index]!.includes("|")
      ) {
        rows.push(splitTableRow(lines[index]!, budget));
        index += 1;
      }
      appendTable(fragment, rows, budget);
      continue;
    }

    const unordered = UNORDERED_ITEM.exec(line);
    const ordered = ORDERED_ITEM.exec(line);
    if (unordered !== null || ordered !== null) {
      const orderedList = ordered !== null;
      const list = element(budget, orderedList ? "ol" : "ul");
      if (ordered !== null && ordered[1] !== "1") list.setAttribute("start", ordered[1]!);
      while (index < lines.length) {
        budget.work(lines[index]!.length);
        const match = orderedList
          ? ORDERED_ITEM.exec(lines[index]!)
          : UNORDERED_ITEM.exec(lines[index]!);
        if (match === null) break;
        const item = element(budget, "li");
        appendInline(item, match[orderedList ? 2 : 1]!, budget);
        list.append(item);
        index += 1;
      }
      fragment.append(list);
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index]!.trim().length > 0 &&
      !isBlockStart(lines, index, budget)
    ) {
      paragraphLines.push(lines[index]!);
      index += 1;
    }
    const paragraph = element(budget, "p");
    appendInline(paragraph, paragraphLines.join("\n"), budget);
    fragment.append(paragraph);
  }
  return fragment;
}

export function renderCoachMarkdown(
  container: HTMLElement,
  source: string,
  limits: CoachMarkdownLimits = DEFAULT_COACH_MARKDOWN_LIMITS,
): void {
  try {
    const budget = new MarkdownBudget(source, limits);
    container.replaceChildren(parseBlocks(source, budget));
  } catch {
    container.textContent = source;
  }
}
