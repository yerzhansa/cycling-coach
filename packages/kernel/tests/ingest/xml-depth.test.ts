import { describe, expect, it } from "vitest";
import { parseGpx } from "../../src/ingest/gpx.js";
import { parseTcx } from "../../src/ingest/tcx.js";
import { childElements, documentOrder, elementPath, parseXmlDocument, textValue, validateDocumentShell } from "../../src/ingest/xml-common.js";

const depth = 10_000;
const nested = (body: string): string => `${"<x>".repeat(depth)}${body}${"</x>".repeat(depth)}`;

describe("deep XML input", () => {
  it("walks and numbers every node without a call-stack limit", () => {
    const root = validateDocumentShell(parseXmlDocument(nested("text")));
    const order = documentOrder(root);
    expect(order.size).toBe(depth + 1);
    expect([...order.values()]).toEqual(Array.from({ length: depth + 1 }, (_, index) => index));
    expect(textValue(root)).toBe("text");
    let leaf = root;
    for (let child = childElements(leaf)[0]; child; child = childElements(leaf)[0]) leaf = child;
    expect(elementPath(leaf)).toBe(`$${"/x[0]".repeat(depth - 1)}`);
  });

  it("keeps preorder and sibling path indices", () => {
    const root = validateDocumentShell(parseXmlDocument("<root><x>A<y>B</y>C</x><x>D</x></root>"));
    expect([...documentOrder(root).keys()].map((node) => node.nodeName)).toEqual([
      "root", "x", "#text", "y", "#text", "#text", "x", "#text",
    ]);
    expect(elementPath(childElements(root)[1]!)).toBe("$/x[1]");
    expect(textValue(root)).toBe("ABCD");
    expect(documentOrder(childElements(root)[0]!).size).toBe(5);
  });

  it("returns typed quarantine results from both public activity parsers", () => {
    const body = nested("");
    expect(parseGpx(body).quarantine?.code).toBe("xml.namespace");
    expect(parseTcx(body).quarantine?.code).toBe("xml.namespace");
    expect(parseGpx(`<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1">${body}</gpx>`).quarantine?.code).toBe("xml.missing_required");
    expect(parseTcx(`<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">${body}</TrainingCenterDatabase>`).quarantine?.code).toBe("xml.missing_required");
  });

  it("reports a deeply nested foreign element without recursive error paths", () => {
    const report = parseGpx(`<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1">${nested('<bad xmlns="urn:foreign"/>')}</gpx>`);
    expect(report.quarantine).toMatchObject({ code: "xml.namespace", path: `$${"/x[0]".repeat(depth)}/bad[0]` });
  });
});
