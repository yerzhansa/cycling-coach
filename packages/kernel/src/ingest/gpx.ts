import type { Element } from "@xmldom/xmldom";
import {
  XmlViolation,
  attributePath,
  childElements,
  directChildren,
  documentOrder,
  elementOrder,
  elementPath,
  localDateKey,
  optionalChild,
  parseDecimal,
  parseInteger,
  parseXmlDocument,
  parseZonedTime,
  preprocessXml,
  quarantine,
  requiredChild,
  runXmlValidationStages,
  textValue,
  throwFirstIssue,
  validateDocumentShell,
  type XmlValidationIssue,
} from "./xml-common.js";
import type { XmlChannel, XmlParseReport, XmlSession } from "./xml-types.js";
import type {
  CourseRoute,
  CourseRouteParseResult,
  CourseRoutePoint,
  CourseRouteSegment,
} from "./course-route.js";

const GPX_10 = "http://www.topografix.com/GPX/1/0";
const GPX_11 = "http://www.topografix.com/GPX/1/1";
const TRACK_POINT_EXTENSION = "http://www.garmin.com/xmlschemas/TrackPointExtension/v1";
const XMLNS = "http://www.w3.org/2000/xmlns/";

export type GpxParseReport = XmlParseReport<"gpx">;

function many(parent: Element, namespace: string, localName: string): Element[] {
  return directChildren(parent, namespace, localName);
}

function requiredMany(parent: Element, namespace: string, localName: string): Element[] {
  const values = many(parent, namespace, localName);
  if (values.length === 0) throw quarantine("xml.missing_required", `${elementPath(parent)}/${localName}[0]`);
  return values;
}

function attrIssues(
  element: Element,
  allowed: readonly string[],
  order: ReturnType<typeof documentOrder>,
  issues: XmlValidationIssue[],
): void {
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (!attribute || attribute.namespaceURI === XMLNS) continue;
    const localName = attribute.localName ?? attribute.name;
    if (attribute.namespaceURI || !allowed.includes(localName)) {
      issues.push({ order: elementOrder(order, element, index), path: attributePath(element, localName) });
    }
  }
}

function validateGpxNamespaces(root: Element, core: string, order: ReturnType<typeof documentOrder>): void {
  if (root.localName !== "gpx" || (core !== GPX_10 && core !== GPX_11)) throw quarantine("xml.namespace", "$");
  const version = root.getAttributeNode("version");
  const expected = core === GPX_11 ? "1.1" : "1.0";
  if (!version || version.namespaceURI || version.value.trim() !== expected) throw quarantine("xml.namespace", "$/@version");
  const issues: XmlValidationIssue[] = [];
  const visitExtension = (element: Element): void => {
    attrIssues(element, [], order, issues);
    for (const child of childElements(element)) {
      if (child.namespaceURI === TRACK_POINT_EXTENSION && ["hr", "cad"].includes(child.localName ?? "")) {
        attrIssues(child, [], order, issues);
        for (const descendant of childElements(child)) {
          issues.push({ order: elementOrder(order, descendant), path: elementPath(descendant) });
        }
      }
    }
  };
  const pending: Element[] = [root];
  for (let element = pending.pop(); element; element = pending.pop()) {
    const allowed = element === root ? ["version", "creator"] : ["trkpt", "wpt", "rtept"].includes(element.localName ?? "") ? ["lat", "lon"] : [];
    attrIssues(element, allowed, order, issues);
    for (const child of childElements(element)) {
      if (element.localName === "extensions") {
        if (child.namespaceURI === TRACK_POINT_EXTENSION && child.localName === "TrackPointExtension") visitExtension(child);
        continue;
      }
      if (child.namespaceURI !== core) issues.push({ order: elementOrder(order, child), path: elementPath(child) });
      else pending.push(child);
    }
  }
  throwFirstIssue("xml.namespace", issues);
}

function tracks(root: Element, core: string): Element[] {
  return many(root, core, "trk");
}

function segments(track: Element, core: string): Element[] {
  return many(track, core, "trkseg");
}

function points(segment: Element, core: string): Element[] {
  return many(segment, core, "trkpt");
}

function validateGpxMissing(root: Element, core: string, order: ReturnType<typeof documentOrder>): void {
  const issues: XmlValidationIssue[] = [];
  const missing = (parent: Element, localName: string, offset: number): void => {
    issues.push({ order: elementOrder(order, parent, offset), path: `${elementPath(parent)}/${localName}[0]` });
  };
  const trackElements = tracks(root, core);
  if (trackElements.length === 0) missing(root, "trk", 10);
  for (const track of trackElements) {
    const segmentElements = segments(track, core);
    if (segmentElements.length === 0) missing(track, "trkseg", 10);
    for (const segment of segmentElements) {
      const pointElements = points(segment, core);
      if (pointElements.length === 0) missing(segment, "trkpt", 10);
      for (const point of pointElements) {
        if (!point.getAttributeNode("lat")) issues.push({ order: elementOrder(order, point, 1), path: attributePath(point, "lat") });
        if (!point.getAttributeNode("lon")) issues.push({ order: elementOrder(order, point, 2), path: attributePath(point, "lon") });
        if (many(point, core, "time").length === 0) missing(point, "time", 10);
      }
    }
  }
  throwFirstIssue("xml.missing_required", issues);
}

function validateGpxDuplicates(root: Element, core: string, order: ReturnType<typeof documentOrder>): void {
  const issues: XmlValidationIssue[] = [];
  const duplicate = (values: Element[]): void => {
    if (values.length > 1) issues.push({ order: elementOrder(order, values[1]!), path: elementPath(values[1]!) });
  };
  for (const track of tracks(root, core)) {
    for (const segment of segments(track, core)) {
      for (const point of points(segment, core)) {
        for (const name of ["time", "ele", "extensions"] as const) duplicate(many(point, core, name));
        const extensions = many(point, core, "extensions")[0];
        const mapped = extensions ? many(extensions, TRACK_POINT_EXTENSION, "TrackPointExtension") : [];
        duplicate(mapped);
        if (mapped[0]) {
          duplicate(many(mapped[0], TRACK_POINT_EXTENSION, "hr"));
          duplicate(many(mapped[0], TRACK_POINT_EXTENSION, "cad"));
        }
      }
    }
  }
  throwFirstIssue("xml.duplicate", issues);
}

function catchInvalidNumber(
  element: Element,
  order: ReturnType<typeof documentOrder>,
  issues: XmlValidationIssue[],
  parse: () => number,
): void {
  try {
    parse();
  } catch (error) {
    if (!(error instanceof XmlViolation) || error.quarantine.code !== "xml.invalid_number") throw error;
    issues.push({ order: elementOrder(order, element), path: error.quarantine.path });
  }
}

function validateGpxNumbers(root: Element, core: string, order: ReturnType<typeof documentOrder>): void {
  const issues: XmlValidationIssue[] = [];
  for (const track of tracks(root, core)) {
    for (const segment of segments(track, core)) {
      for (const point of points(segment, core)) {
        catchInvalidNumber(point, order, issues, () => parseDecimal(point.getAttribute("lat")!, attributePath(point, "lat")));
        catchInvalidNumber(point, order, issues, () => parseDecimal(point.getAttribute("lon")!, attributePath(point, "lon")));
        const elevation = many(point, core, "ele")[0];
        if (elevation) catchInvalidNumber(elevation, order, issues, () => parseDecimal(textValue(elevation), elementPath(elevation)));
        const extensions = many(point, core, "extensions")[0];
        const mapped = extensions ? many(extensions, TRACK_POINT_EXTENSION, "TrackPointExtension")[0] : null;
        const heartRate = mapped ? many(mapped, TRACK_POINT_EXTENSION, "hr")[0] : null;
        const cadence = mapped ? many(mapped, TRACK_POINT_EXTENSION, "cad")[0] : null;
        if (heartRate) catchInvalidNumber(heartRate, order, issues, () => parseInteger(textValue(heartRate), elementPath(heartRate), 1, 255));
        if (cadence) catchInvalidNumber(cadence, order, issues, () => parseInteger(textValue(cadence), elementPath(cadence), 0, 255));
      }
    }
  }
  throwFirstIssue("xml.invalid_number", issues);
}

function validateGpxTimes(root: Element, core: string, order: ReturnType<typeof documentOrder>): void {
  const issues: XmlValidationIssue[] = [];
  for (const track of tracks(root, core)) {
    for (const segment of segments(track, core)) {
      for (const point of points(segment, core)) {
        const time = many(point, core, "time")[0]!;
        try {
          parseZonedTime(textValue(time), elementPath(time));
        } catch (error) {
          if (!(error instanceof XmlViolation) || error.quarantine.code !== "xml.invalid_time") throw error;
          issues.push({ order: elementOrder(order, time), path: elementPath(time) });
        }
      }
    }
  }
  throwFirstIssue("xml.invalid_time", issues);
}

function validateGpxChronology(root: Element, core: string, order: ReturnType<typeof documentOrder>): void {
  const issues: XmlValidationIssue[] = [];
  for (const track of tracks(root, core)) {
    let prior: number | null = null;
    for (const segment of segments(track, core)) {
      for (const point of points(segment, core)) {
        const time = many(point, core, "time")[0]!;
        const value = parseZonedTime(textValue(time), elementPath(time));
        if (prior !== null && value <= prior) issues.push({ order: elementOrder(order, time), path: elementPath(time) });
        prior = value;
      }
    }
  }
  throwFirstIssue("xml.non_chronological", issues);
}

function validateGpxCoordinates(root: Element, core: string, order: ReturnType<typeof documentOrder>): void {
  const issues: XmlValidationIssue[] = [];
  for (const track of tracks(root, core)) {
    for (const segment of segments(track, core)) {
      for (const point of points(segment, core)) {
        const latitude = parseDecimal(point.getAttribute("lat")!, attributePath(point, "lat"));
        const longitude = parseDecimal(point.getAttribute("lon")!, attributePath(point, "lon"));
        if (latitude < -90 || latitude > 90) issues.push({ order: elementOrder(order, point, 1), path: attributePath(point, "lat") });
        if (longitude < -180 || longitude > 180) issues.push({ order: elementOrder(order, point, 2), path: attributePath(point, "lon") });
      }
    }
  }
  throwFirstIssue("xml.invalid_coordinate", issues);
}

function validateGpx(root: Element): string {
  const core = root.namespaceURI ?? "";
  const order = documentOrder(root);
  runXmlValidationStages({
    namespace: () => validateGpxNamespaces(root, core, order),
    missingRequired: () => validateGpxMissing(root, core, order),
    duplicate: () => validateGpxDuplicates(root, core, order),
    invalidNumber: () => validateGpxNumbers(root, core, order),
    invalidTime: () => validateGpxTimes(root, core, order),
    nonChronological: () => validateGpxChronology(root, core, order),
    invalidCoordinate: () => validateGpxCoordinates(root, core, order),
    overlap: () => {},
  });
  return core;
}

function emitChannels(timestamps: number[], values: Record<string, (number | null)[]>): Record<string, XmlChannel> {
  const result: Record<string, XmlChannel> = {
    time: { timestamps: [...timestamps], values: [...timestamps] },
    lat: { timestamps: [...timestamps], values: [...values.lat!] },
    lng: { timestamps: [...timestamps], values: [...values.lng!] },
  };
  for (const name of ["altitude", "heart_rate", "cadence"] as const) {
    const channel = values[name]!;
    if (channel.some((value) => value !== null)) result[name] = { timestamps: [...timestamps], values: [...channel] };
  }
  return result;
}

function parseTrack(track: Element, core: string, sessionOrdinal: number): XmlSession {
  const segmentElements = requiredMany(track, core, "trkseg");
  const timestamps: number[] = [];
  const segmentStartIndices: number[] = [];
  const values: Record<string, (number | null)[]> = { lat: [], lng: [], altitude: [], heart_rate: [], cadence: [] };
  for (const segment of segmentElements) {
    segmentStartIndices.push(timestamps.length);
    for (const point of requiredMany(segment, core, "trkpt")) {
      const latitude = parseDecimal(point.getAttribute("lat")!, attributePath(point, "lat"));
      const longitude = parseDecimal(point.getAttribute("lon")!, attributePath(point, "lon"));
      const timeElement = requiredChild(point, core, "time");
      const time = parseZonedTime(textValue(timeElement), elementPath(timeElement));
      timestamps.push(time);
      values.lat!.push(latitude);
      values.lng!.push(longitude);
      const elevation = optionalChild(point, core, "ele");
      values.altitude!.push(elevation ? parseDecimal(textValue(elevation), elementPath(elevation)) : null);
      const extensions = optionalChild(point, core, "extensions");
      const mapped = extensions ? optionalChild(extensions, TRACK_POINT_EXTENSION, "TrackPointExtension") : null;
      const heartRate = mapped ? optionalChild(mapped, TRACK_POINT_EXTENSION, "hr") : null;
      const cadence = mapped ? optionalChild(mapped, TRACK_POINT_EXTENSION, "cad") : null;
      values.heart_rate!.push(heartRate ? parseInteger(textValue(heartRate), elementPath(heartRate), 1, 255) : null);
      values.cadence!.push(cadence ? parseInteger(textValue(cadence), elementPath(cadence), 0, 255) : null);
    }
  }
  const startUtc = timestamps[0]!;
  const firstPoint = many(segmentElements[0]!, core, "trkpt")[0]!;
  const firstTime = many(firstPoint, core, "time")[0]!;
  return {
    workoutOrdinal: 0,
    sessionOrdinal,
    sport: null,
    startUtc,
    localDateKey: localDateKey(startUtc, elementPath(firstTime)),
    elapsedS: null,
    distanceM: null,
    laps: null,
    segmentStartIndices,
    channels: emitChannels(timestamps, values),
  };
}

export function parseGpx(xml: string): GpxParseReport {
  try {
    const root = validateDocumentShell(parseXmlDocument(preprocessXml(xml)));
    const core = validateGpx(root);
    return { format: "gpx", sessions: requiredMany(root, core, "trk").map((track, index) => parseTrack(track, core, index)), quarantine: null };
  } catch (error) {
    if (!(error instanceof XmlViolation)) throw error;
    return { format: "gpx", sessions: [], quarantine: error.quarantine };
  }
}

function parseCoursePoint(point: Element, core: string): CourseRoutePoint {
  const latitudeNode = point.getAttributeNode("lat");
  const longitudeNode = point.getAttributeNode("lon");
  if (!latitudeNode) throw quarantine("xml.missing_required", attributePath(point, "lat"));
  if (!longitudeNode) throw quarantine("xml.missing_required", attributePath(point, "lon"));
  const latitude = parseDecimal(latitudeNode.value, attributePath(point, "lat"));
  const longitude = parseDecimal(longitudeNode.value, attributePath(point, "lon"));
  if (latitude < -90 || latitude > 90) {
    throw quarantine("xml.invalid_coordinate", attributePath(point, "lat"));
  }
  if (longitude < -180 || longitude > 180) {
    throw quarantine("xml.invalid_coordinate", attributePath(point, "lon"));
  }
  const elevations = many(point, core, "ele");
  if (elevations.length > 1) throw quarantine("xml.duplicate", elementPath(elevations[1]!));
  const elevation = elevations[0];
  return Object.freeze({
    latitude,
    longitude,
    elevationM: elevation ? parseDecimal(textValue(elevation), elementPath(elevation)) : null,
  });
}

function parseCourseSegments(root: Element, core: string): readonly CourseRouteSegment[] {
  const result: CourseRouteSegment[] = [];
  for (const track of many(root, core, "trk")) {
    for (const segment of many(track, core, "trkseg")) {
      const routePoints = many(segment, core, "trkpt").map((point) => parseCoursePoint(point, core));
      if (routePoints.length > 0) result.push(Object.freeze({ points: Object.freeze(routePoints) }));
    }
  }
  for (const route of many(root, core, "rte")) {
    const routePoints = many(route, core, "rtept").map((point) => parseCoursePoint(point, core));
    if (routePoints.length > 0) result.push(Object.freeze({ points: Object.freeze(routePoints) }));
  }
  return Object.freeze(result);
}

export function parseGpxCourse(xml: string): CourseRouteParseResult {
  try {
    const root = validateDocumentShell(parseXmlDocument(preprocessXml(xml)));
    const core = root.namespaceURI ?? "";
    if (root.localName !== "gpx" || (core !== GPX_10 && core !== GPX_11)) {
      throw quarantine("xml.namespace", "$");
    }
    const version = root.getAttributeNode("version");
    const expected = core === GPX_11 ? "1.1" : "1.0";
    if (!version || version.namespaceURI || version.value.trim() !== expected) {
      throw quarantine("xml.namespace", "$/@version");
    }
    const segments = parseCourseSegments(root, core);
    if (!segments.some((segment) => segment.points.length >= 2)) {
      return { ok: false, reason: "route-missing", detail: "The GPX file does not contain a usable route." };
    }
    const route: CourseRoute = Object.freeze({ format: "gpx", segments });
    return { ok: true, route };
  } catch (error) {
    if (!(error instanceof XmlViolation)) throw error;
    return { ok: false, reason: "unreadable", detail: error.quarantine.message };
  }
}
