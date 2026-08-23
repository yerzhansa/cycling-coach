import { DOMParser, type Document, type Element, type Node } from "@xmldom/xmldom";
import {
  XML_QUARANTINE_MESSAGE,
  type XmlQuarantine,
  type XmlQuarantineCode,
} from "./xml-types.js";

const XML_SPACE = "[\\x20\\x09\\x0d\\x0a]";
const XML_SPACE_CHARACTERS = new Set([" ", "\t", "\r", "\n"]);
const DECLARATION = new RegExp(
  `^<\\?xml${XML_SPACE}+version${XML_SPACE}*=${XML_SPACE}*(?:"1\\.0"|'1\\.0')` +
    `(?:${XML_SPACE}+encoding${XML_SPACE}*=${XML_SPACE}*(?:"[Uu][Tt][Ff]-8"|'[Uu][Tt][Ff]-8'))?` +
    `(?:${XML_SPACE}+standalone${XML_SPACE}*=${XML_SPACE}*(?:"(?:yes|no)"|'(?:yes|no)'))?` +
    `${XML_SPACE}*\\?>`,
);
const DECIMAL = /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const INTEGER = /^-?[0-9]+$/;
const ZONED_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
export class XmlViolation extends Error {
  readonly quarantine: XmlQuarantine;

  constructor(quarantineValue: XmlQuarantine) {
    super(quarantineValue.message);
    this.name = "XmlViolation";
    this.quarantine = quarantineValue;
  }
}

export interface XmlValidationIssue {
  readonly order: number;
  readonly path: string;
}

export interface XmlValidationStages {
  readonly namespace: () => void;
  readonly missingRequired: () => void;
  readonly duplicate: () => void;
  readonly invalidNumber: () => void;
  readonly invalidTime: () => void;
  readonly nonChronological: () => void;
  readonly invalidCoordinate: () => void;
  readonly overlap: () => void;
}

export function quarantine(code: XmlQuarantineCode, path: string): XmlViolation {
  return new XmlViolation({ code, path, message: XML_QUARANTINE_MESSAGE[code] });
}

export function preprocessXml(xml: string): string {
  if (xml.charCodeAt(0) === 0xfeff) throw quarantine("xml.parse", "$");
  let remainder = xml;
  const following = xml[5];
  const candidate = xml.startsWith("<?xml") &&
    (following === undefined || following === "?" || XML_SPACE_CHARACTERS.has(following));
  if (candidate) {
    const end = xml.indexOf("?>");
    const declarationText = end < 0 ? xml : xml.slice(0, end + 2);
    const encoding = new RegExp(
      `${XML_SPACE}+encoding${XML_SPACE}*=${XML_SPACE}*(["'])([^"']*)\\1`,
    ).exec(declarationText);
    if (encoding && encoding[2]?.toUpperCase() !== "UTF-8") {
      throw quarantine("xml.invalid_utf8", "$");
    }
    const match = DECLARATION.exec(xml);
    if (!match || match[0].length !== declarationText.length) {
      throw quarantine("xml.parse", "$");
    }
    remainder = xml.slice(match[0].length);
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(remainder)) {
    throw quarantine("xml.doctype_forbidden", "$");
  }
  if (remainder.includes("<?")) {
    throw quarantine("xml.processing_instruction_forbidden", "$");
  }
  return remainder;
}

export function runXmlValidationStages(stages: XmlValidationStages): void {
  stages.namespace();
  stages.missingRequired();
  stages.duplicate();
  stages.invalidNumber();
  stages.invalidTime();
  stages.nonChronological();
  stages.invalidCoordinate();
  stages.overlap();
}

export function documentOrder(root: Element): ReadonlyMap<Node, number> {
  const result = new Map<Node, number>();
  let next = 0;
  const visit = (node: Node): void => {
    result.set(node, next);
    next += 1;
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
  };
  visit(root);
  return result;
}

export function elementOrder(order: ReadonlyMap<Node, number>, element: Element, offset = 500): number {
  const value = order.get(element);
  if (value === undefined) throw new Error("XML element is outside the document");
  return value * 1_000 + offset;
}

export function throwFirstIssue(
  code: XmlQuarantineCode,
  issues: readonly XmlValidationIssue[],
): void {
  if (issues.length === 0) return;
  let first = issues[0]!;
  for (const issue of issues.slice(1)) {
    if (issue.order < first.order) first = issue;
  }
  throw quarantine(code, first.path);
}

export function parseXmlDocument(xmlWithoutDeclaration: string): Document {
  try {
    return new DOMParser({
      onError(level, _message, _context): never {
        throw new Error(`xml parser ${level}`);
      },
    }).parseFromString(xmlWithoutDeclaration, "application/xml");
  } catch {
    throw quarantine("xml.parse", "$");
  }
}

function walk(node: Node): void {
  if (node.nodeType === 5 || node.nodeType === 6 || node.nodeType === 7 || node.nodeType === 10) {
    throw quarantine("xml.parse", "$");
  }
  for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
}

export function validateDocumentShell(document: Document): Element {
  walk(document);
  let element: Element | null = null;
  for (let child = document.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) {
      if (element) throw quarantine("xml.parse", "$");
      element = child as Element;
      continue;
    }
    if (child.nodeType === 8) continue;
    if (child.nodeType === 3 && [...(child.nodeValue ?? "")].every((value) => XML_SPACE_CHARACTERS.has(value))) continue;
    throw quarantine("xml.parse", "$");
  }
  if (!element) throw quarantine("xml.parse", "$");
  return element;
}

export function directChildren(parent: Element, namespace: string, localName: string): Element[] {
  const result: Element[] = [];
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && child.namespaceURI === namespace && child.localName === localName) {
      result.push(child as Element);
    }
  }
  return result;
}

export function childElements(parent: Element): Element[] {
  const result: Element[] = [];
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) result.push(child as Element);
  }
  return result;
}

export function elementPath(element: Element): string {
  const parent = element.parentNode;
  if (!parent || parent.nodeType === 9) return "$";
  let index = 0;
  for (let sibling = parent.firstChild; sibling && sibling !== element; sibling = sibling.nextSibling) {
    if (sibling.nodeType === 1 && sibling.localName === element.localName) index += 1;
  }
  return `${elementPath(parent as Element)}/${element.localName}[${index}]`;
}

export function attributePath(element: Element, localName: string): string {
  return `${elementPath(element)}/@${localName}`;
}

export function requiredChild(parent: Element, namespace: string, localName: string): Element {
  const matches = directChildren(parent, namespace, localName);
  if (matches.length === 0) {
    throw quarantine("xml.missing_required", `${elementPath(parent)}/${localName}[0]`);
  }
  if (matches.length > 1) throw quarantine("xml.duplicate", elementPath(matches[1]!));
  return matches[0]!;
}

export function optionalChild(parent: Element, namespace: string, localName: string): Element | null {
  const matches = directChildren(parent, namespace, localName);
  if (matches.length > 1) throw quarantine("xml.duplicate", elementPath(matches[1]!));
  return matches[0] ?? null;
}

export function requiredUnqualifiedAttribute(element: Element, localName: string): string {
  const attribute = element.getAttributeNode(localName);
  if (!attribute || attribute.namespaceURI) {
    throw quarantine("xml.missing_required", attributePath(element, localName));
  }
  return attribute.value.trim();
}

export function textValue(element: Element): string {
  return (element.textContent ?? "").trim();
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

export function parseDecimal(text: string, path: string): number {
  const trimmed = text.trim();
  if (!DECIMAL.test(trimmed)) throw quarantine("xml.invalid_number", path);
  const value = Number(trimmed);
  if (!Number.isFinite(value)) throw quarantine("xml.invalid_number", path);
  return normalizeZero(value);
}

export function parseInteger(text: string, path: string, min: number, max: number): number {
  const trimmed = text.trim();
  if (!INTEGER.test(trimmed)) throw quarantine("xml.invalid_number", path);
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw quarantine("xml.invalid_number", path);
  }
  return normalizeZero(value);
}

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return leapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const monthPrime = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * monthPrime + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

export function parseZonedTime(text: string, path: string): number {
  const match = ZONED_TIME.exec(text.trim());
  if (!match) throw quarantine("xml.invalid_time", path);
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (
    year! < 1 || year! > 9999 || month! < 1 || month! > 12 || day! < 1 ||
    day! > daysInMonth(year!, month!) || hour! > 23 || minute! > 59 || second! > 59
  ) {
    throw quarantine("xml.invalid_time", path);
  }
  const fractionDigits = match[7];
  const zone = match[8]!;
  let offsetMagnitude = 0;
  let signedOffset = 0;
  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) throw quarantine("xml.invalid_time", path);
    offsetMagnitude = offsetHour * 3600 + offsetMinute * 60;
    signedOffset = zone[0] === "+" ? offsetMagnitude : -offsetMagnitude;
  }
  const fraction = fractionDigits === undefined ? 0 : Number(fractionDigits) / 10 ** fractionDigits.length;
  const localWholeSeconds =
    daysFromCivil(year!, month!, day!) * 86400 + hour! * 3600 + minute! * 60 + second!;
  const epochWholeSeconds = localWholeSeconds - signedOffset;
  const minimumEpoch = daysFromCivil(1, 1, 1) * 86400;
  const maximumEpochExclusive = daysFromCivil(10000, 1, 1) * 86400;
  if (
    !Number.isFinite(epochWholeSeconds) ||
    epochWholeSeconds < minimumEpoch ||
    epochWholeSeconds >= maximumEpochExclusive
  ) {
    throw quarantine("xml.invalid_time", path);
  }
  let epochSeconds = epochWholeSeconds + fraction;
  if (epochSeconds === maximumEpochExclusive && fraction > 0) {
    epochSeconds = maximumEpochExclusive - Math.abs(maximumEpochExclusive) * Number.EPSILON;
  }
  return normalizeZero(epochSeconds);
}

export function localDateKey(epochSeconds: number, path: string): number {
  const date = new Date(epochSeconds * 1000);
  const year = date.getUTCFullYear();
  if (year < 1 || year > 9999 || !Number.isFinite(date.getTime())) throw quarantine("xml.invalid_time", path);
  return year * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}
