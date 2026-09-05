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
  requiredUnqualifiedAttribute,
  runXmlValidationStages,
  textValue,
  throwFirstIssue,
  validateDocumentShell,
  type XmlValidationIssue,
} from "./xml-common.js";
import type { XmlChannel, XmlLap, XmlParseReport, XmlSession } from "./xml-types.js";

const TCX = "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2";
const ACTIVITY_EXTENSION = "http://www.garmin.com/xmlschemas/ActivityExtension/v2";
const XMLNS = "http://www.w3.org/2000/xmlns/";

export type TcxParseReport = XmlParseReport<"tcx">;

function many(parent: Element, namespace: string, localName: string): Element[] {
  return directChildren(parent, namespace, localName);
}

function requiredMany(parent: Element, namespace: string, localName: string): Element[] {
  const values = many(parent, namespace, localName);
  if (values.length === 0) throw quarantine("xml.missing_required", `${elementPath(parent)}/${localName}[0]`);
  return values;
}

function activityElements(root: Element): Element[] {
  const container = many(root, TCX, "Activities")[0];
  return container ? many(container, TCX, "Activity") : [];
}

function lapElements(root: Element): Element[] {
  return activityElements(root).flatMap((activity) => many(activity, TCX, "Lap"));
}

function pointElements(root: Element): Element[] {
  return lapElements(root).flatMap((lap) =>
    many(lap, TCX, "Track").flatMap((track) => many(track, TCX, "Trackpoint")),
  );
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

function validateTcxNamespaces(root: Element, order: ReturnType<typeof documentOrder>): void {
  if (root.namespaceURI !== TCX || root.localName !== "TrainingCenterDatabase") {
    throw quarantine("xml.namespace", "$");
  }
  const issues: XmlValidationIssue[] = [];
  const visitExtension = (element: Element): void => {
    attrIssues(element, [], order, issues);
    for (const child of childElements(element)) {
      if (
        child.namespaceURI === ACTIVITY_EXTENSION &&
        ["Speed", "RunCadence", "Watts"].includes(child.localName ?? "")
      ) {
        attrIssues(child, [], order, issues);
        for (const descendant of childElements(child)) {
          issues.push({ order: elementOrder(order, descendant), path: elementPath(descendant) });
        }
      }
    }
  };
  const pending: Element[] = [root];
  for (let element = pending.pop(); element; element = pending.pop()) {
    const allowed = element.localName === "Activity" ? ["Sport"] : element.localName === "Lap" ? ["StartTime"] : [];
    attrIssues(element, allowed, order, issues);
    for (const child of childElements(element)) {
      if (element.localName === "Extensions") {
        if (child.namespaceURI === ACTIVITY_EXTENSION && child.localName === "TPX") visitExtension(child);
        continue;
      }
      if (child.namespaceURI !== TCX) {
        issues.push({ order: elementOrder(order, child), path: elementPath(child) });
      } else {
        pending.push(child);
      }
    }
  }
  throwFirstIssue("xml.namespace", issues);
}

function validateTcxMissing(root: Element, order: ReturnType<typeof documentOrder>): void {
  const issues: XmlValidationIssue[] = [];
  const missing = (parent: Element, localName: string, offset: number): void => {
    issues.push({ order: elementOrder(order, parent, offset), path: `${elementPath(parent)}/${localName}[0]` });
  };
  const activities = many(root, TCX, "Activities");
  if (activities.length === 0) missing(root, "Activities", 10);
  for (const container of activities) {
    const activityElements = many(container, TCX, "Activity");
    if (activityElements.length === 0) missing(container, "Activity", 10);
    for (const activity of activityElements) {
      const sport = activity.getAttributeNode("Sport");
      if (!sport || sport.value.trim() === "") {
        issues.push({ order: elementOrder(order, activity, 1), path: attributePath(activity, "Sport") });
      }
      const laps = many(activity, TCX, "Lap");
      if (laps.length === 0) missing(activity, "Lap", 10);
      for (const lap of laps) {
        if (!lap.getAttributeNode("StartTime")) {
          issues.push({ order: elementOrder(order, lap, 1), path: attributePath(lap, "StartTime") });
        }
        const tracks = many(lap, TCX, "Track");
        if (tracks.length === 0) missing(lap, "Track", 10);
        for (const track of tracks) {
          const points = many(track, TCX, "Trackpoint");
          if (points.length === 0) missing(track, "Trackpoint", 10);
          for (const point of points) {
            if (many(point, TCX, "Time").length === 0) missing(point, "Time", 10);
            for (const position of many(point, TCX, "Position")) {
              if (many(position, TCX, "LatitudeDegrees").length === 0) missing(position, "LatitudeDegrees", 10);
              if (many(position, TCX, "LongitudeDegrees").length === 0) missing(position, "LongitudeDegrees", 20);
            }
            for (const heartRate of many(point, TCX, "HeartRateBpm")) {
              if (many(heartRate, TCX, "Value").length === 0) missing(heartRate, "Value", 10);
            }
          }
        }
      }
    }
  }
  throwFirstIssue("xml.missing_required", issues);
}

function validateTcxDuplicates(root: Element, order: ReturnType<typeof documentOrder>): void {
  const issues: XmlValidationIssue[] = [];
  const duplicate = (values: Element[]): void => {
    if (values.length > 1) issues.push({ order: elementOrder(order, values[1]!), path: elementPath(values[1]!) });
  };
  duplicate(many(root, TCX, "Activities"));
  for (const lap of lapElements(root)) {
    duplicate(many(lap, TCX, "TotalTimeSeconds"));
    duplicate(many(lap, TCX, "DistanceMeters"));
  }
  for (const point of pointElements(root)) {
    for (const name of ["Time", "Position", "AltitudeMeters", "DistanceMeters", "HeartRateBpm", "Cadence", "Extensions"] as const) {
      duplicate(many(point, TCX, name));
    }
    for (const position of many(point, TCX, "Position")) {
      duplicate(many(position, TCX, "LatitudeDegrees"));
      duplicate(many(position, TCX, "LongitudeDegrees"));
    }
    for (const heartRate of many(point, TCX, "HeartRateBpm")) duplicate(many(heartRate, TCX, "Value"));
    const cadence = many(point, TCX, "Cadence")[0];
    const extensions = many(point, TCX, "Extensions")[0];
    const tpx = extensions ? many(extensions, ACTIVITY_EXTENSION, "TPX") : [];
    duplicate(tpx);
    if (tpx[0]) {
      for (const name of ["Speed", "RunCadence", "Watts"] as const) duplicate(many(tpx[0], ACTIVITY_EXTENSION, name));
      const runCadence = many(tpx[0], ACTIVITY_EXTENSION, "RunCadence")[0];
      if (cadence && runCadence) issues.push({ order: elementOrder(order, runCadence), path: elementPath(runCadence) });
    }
  }
  throwFirstIssue("xml.duplicate", issues);
}

function numericElements(root: Element): { element: Element; kind: "decimal" | "nonnegative" | "hr" | "cadence" }[] {
  const result: { element: Element; kind: "decimal" | "nonnegative" | "hr" | "cadence" }[] = [];
  for (const lap of lapElements(root)) {
    for (const name of ["TotalTimeSeconds", "DistanceMeters"] as const) {
      const element = many(lap, TCX, name)[0];
      if (element) result.push({ element, kind: "nonnegative" });
    }
  }
  for (const point of pointElements(root)) {
    for (const position of many(point, TCX, "Position")) {
      const latitude = many(position, TCX, "LatitudeDegrees")[0];
      const longitude = many(position, TCX, "LongitudeDegrees")[0];
      if (latitude) result.push({ element: latitude, kind: "decimal" });
      if (longitude) result.push({ element: longitude, kind: "decimal" });
    }
    const altitude = many(point, TCX, "AltitudeMeters")[0];
    const distance = many(point, TCX, "DistanceMeters")[0];
    const heartRate = many(point, TCX, "HeartRateBpm")[0];
    const value = heartRate ? many(heartRate, TCX, "Value")[0] : null;
    const cadence = many(point, TCX, "Cadence")[0];
    if (altitude) result.push({ element: altitude, kind: "decimal" });
    if (distance) result.push({ element: distance, kind: "nonnegative" });
    if (value) result.push({ element: value, kind: "hr" });
    if (cadence) result.push({ element: cadence, kind: "cadence" });
    const extensions = many(point, TCX, "Extensions")[0];
    const tpx = extensions ? many(extensions, ACTIVITY_EXTENSION, "TPX")[0] : null;
    if (tpx) {
      for (const name of ["Speed", "Watts"] as const) {
        const element = many(tpx, ACTIVITY_EXTENSION, name)[0];
        if (element) result.push({ element, kind: "nonnegative" });
      }
      const runCadence = many(tpx, ACTIVITY_EXTENSION, "RunCadence")[0];
      if (runCadence) result.push({ element: runCadence, kind: "cadence" });
    }
  }
  return result;
}

function decimalOrNull(element: Element, nonnegative: boolean): number | null {
  try {
    const value = parseDecimal(textValue(element), elementPath(element));
    return nonnegative && value < 0 ? null : value;
  } catch (error) {
    if (error instanceof XmlViolation && error.quarantine.code === "xml.invalid_number") return null;
    throw error;
  }
}

function validateTcxNumbers(root: Element, order: ReturnType<typeof documentOrder>): void {
  const issues: XmlValidationIssue[] = [];
  for (const { element, kind } of numericElements(root)) {
    let valid = true;
    try {
      if (kind === "hr") parseInteger(textValue(element), elementPath(element), 1, 255);
      else if (kind === "cadence") parseInteger(textValue(element), elementPath(element), 0, 255);
      else {
        const value = parseDecimal(textValue(element), elementPath(element));
        if (kind === "nonnegative" && value < 0) valid = false;
      }
    } catch (error) {
      if (!(error instanceof XmlViolation) || error.quarantine.code !== "xml.invalid_number") throw error;
      valid = false;
    }
    if (!valid) issues.push({ order: elementOrder(order, element), path: elementPath(element) });
  }
  for (const activity of activityElements(root)) {
    const laps = many(activity, TCX, "Lap");
    for (const name of ["TotalTimeSeconds", "DistanceMeters"] as const) {
      const values = laps.map((lap) => many(lap, TCX, name)[0] ?? null);
      if (values.some((element) => element === null)) continue;
      let sum = 0;
      for (const element of values as Element[]) {
        const value = decimalOrNull(element, true);
        if (value === null) break;
        sum += value;
        if (Object.is(sum, -0)) sum = 0;
        if (!Number.isFinite(sum)) {
          issues.push({ order: elementOrder(order, element), path: elementPath(element) });
          break;
        }
      }
    }
  }
  throwFirstIssue("xml.invalid_number", issues);
}

function validateTcxTimes(root: Element, order: ReturnType<typeof documentOrder>): void {
  const issues: XmlValidationIssue[] = [];
  const elements = [
    ...lapElements(root).map((element) => ({ element, attribute: true })),
    ...pointElements(root).map((point) => ({ element: many(point, TCX, "Time")[0]!, attribute: false })),
  ];
  for (const { element, attribute } of elements) {
    const path = attribute ? attributePath(element, "StartTime") : elementPath(element);
    const text = attribute ? element.getAttribute("StartTime")! : textValue(element);
    try {
      parseZonedTime(text, path);
    } catch (error) {
      if (!(error instanceof XmlViolation) || error.quarantine.code !== "xml.invalid_time") throw error;
      issues.push({ order: elementOrder(order, element, attribute ? 1 : 500), path });
    }
  }
  throwFirstIssue("xml.invalid_time", issues);
}

function pointTimes(lap: Element): { element: Element; value: number }[] {
  const result: { element: Element; value: number }[] = [];
  for (const track of many(lap, TCX, "Track")) {
    for (const point of many(track, TCX, "Trackpoint")) {
      const time = many(point, TCX, "Time")[0]!;
      result.push({ element: time, value: parseZonedTime(textValue(time), elementPath(time)) });
    }
  }
  return result;
}

function validateTcxChronology(root: Element, order: ReturnType<typeof documentOrder>): void {
  const issues: XmlValidationIssue[] = [];
  for (const activity of activityElements(root)) {
    let priorPoint: number | null = null;
    for (const lap of many(activity, TCX, "Lap")) {
      const points = pointTimes(lap);
      const start = parseZonedTime(lap.getAttribute("StartTime")!, attributePath(lap, "StartTime"));
      if (start > points[0]!.value) {
        issues.push({ order: elementOrder(order, lap, 1), path: attributePath(lap, "StartTime") });
      }
      for (const point of points) {
        if (priorPoint !== null && point.value <= priorPoint) {
          issues.push({ order: elementOrder(order, point.element), path: elementPath(point.element) });
        }
        priorPoint = point.value;
      }
    }
  }
  throwFirstIssue("xml.non_chronological", issues);
}

function validateTcxCoordinates(root: Element, order: ReturnType<typeof documentOrder>): void {
  const issues: XmlValidationIssue[] = [];
  for (const point of pointElements(root)) {
    for (const position of many(point, TCX, "Position")) {
      const lat = many(position, TCX, "LatitudeDegrees")[0]!;
      const lng = many(position, TCX, "LongitudeDegrees")[0]!;
      const latitude = parseDecimal(textValue(lat), elementPath(lat));
      const longitude = parseDecimal(textValue(lng), elementPath(lng));
      if (latitude < -90 || latitude > 90) issues.push({ order: elementOrder(order, lat), path: elementPath(lat) });
      if (longitude < -180 || longitude > 180) issues.push({ order: elementOrder(order, lng), path: elementPath(lng) });
    }
  }
  throwFirstIssue("xml.invalid_coordinate", issues);
}

function validateTcxOverlap(root: Element, order: ReturnType<typeof documentOrder>): void {
  const issues: XmlValidationIssue[] = [];
  for (const activity of activityElements(root)) {
    let priorLast: number | null = null;
    for (const lap of many(activity, TCX, "Lap")) {
      const start = parseZonedTime(lap.getAttribute("StartTime")!, attributePath(lap, "StartTime"));
      if (priorLast !== null && start < priorLast) {
        issues.push({ order: elementOrder(order, lap, 1), path: attributePath(lap, "StartTime") });
      }
      priorLast = pointTimes(lap).at(-1)!.value;
    }
  }
  throwFirstIssue("xml.overlap", issues);
}

function validateTcx(root: Element): void {
  const order = documentOrder(root);
  runXmlValidationStages({
    namespace: () => validateTcxNamespaces(root, order),
    missingRequired: () => validateTcxMissing(root, order),
    duplicate: () => validateTcxDuplicates(root, order),
    invalidNumber: () => validateTcxNumbers(root, order),
    invalidTime: () => validateTcxTimes(root, order),
    nonChronological: () => validateTcxChronology(root, order),
    invalidCoordinate: () => validateTcxCoordinates(root, order),
    overlap: () => validateTcxOverlap(root, order),
  });
}

function optionalDecimal(parent: Element, localName: string): { value: number | null; element: Element | null } {
  const element = optionalChild(parent, TCX, localName);
  return { value: element ? parseDecimal(textValue(element), elementPath(element)) : null, element };
}

function sportValue(activity: Element): string {
  const value = requiredUnqualifiedAttribute(activity, "Sport");
  if (value === "Biking") return "cycling";
  if (value === "Running") return "running";
  if (value === "Other") return "other";
  return `unknown:${value}`;
}

function emitChannels(timestamps: number[], values: Record<string, (number | null)[]>): Record<string, XmlChannel> {
  const channels: Record<string, XmlChannel> = { time: { timestamps: [...timestamps], values: [...timestamps] } };
  for (const [name, channelValues] of Object.entries(values)) {
    if (channelValues.some((value) => value !== null)) channels[name] = { timestamps: [...timestamps], values: [...channelValues] };
  }
  return channels;
}

function checkedLapSum(values: readonly { value: number | null; element: Element | null }[]): number | null {
  if (values.some((item) => item.value === null)) return null;
  let sum = 0;
  for (const item of values) {
    sum += item.value!;
    if (Object.is(sum, -0)) sum = 0;
    if (!Number.isFinite(sum)) throw quarantine("xml.invalid_number", elementPath(item.element!));
  }
  return sum;
}

function parseActivity(activity: Element, sessionOrdinal: number): XmlSession {
  const lapElements = requiredMany(activity, TCX, "Lap");
  const timestamps: number[] = [];
  const values: Record<string, (number | null)[]> = {
    lat: [], lng: [], distance: [], altitude: [], speed: [], heart_rate: [], cadence: [], power: [],
  };
  const laps: XmlLap[] = [];
  const elapsedParts: { value: number | null; element: Element | null }[] = [];
  const distanceParts: { value: number | null; element: Element | null }[] = [];
  for (const [lapSeq, lap] of lapElements.entries()) {
    const startUtc = parseZonedTime(requiredUnqualifiedAttribute(lap, "StartTime"), attributePath(lap, "StartTime"));
    const elapsed = optionalDecimal(lap, "TotalTimeSeconds");
    const distance = optionalDecimal(lap, "DistanceMeters");
    elapsedParts.push(elapsed);
    distanceParts.push(distance);
    const firstSampleIndex = timestamps.length;
    for (const track of requiredMany(lap, TCX, "Track")) {
      for (const point of requiredMany(track, TCX, "Trackpoint")) {
        const timeElement = requiredChild(point, TCX, "Time");
        const time = parseZonedTime(textValue(timeElement), elementPath(timeElement));
        timestamps.push(time);
        const position = optionalChild(point, TCX, "Position");
        values.lat!.push(position ? parseDecimal(textValue(requiredChild(position, TCX, "LatitudeDegrees")), elementPath(requiredChild(position, TCX, "LatitudeDegrees"))) : null);
        values.lng!.push(position ? parseDecimal(textValue(requiredChild(position, TCX, "LongitudeDegrees")), elementPath(requiredChild(position, TCX, "LongitudeDegrees"))) : null);
        values.altitude!.push(optionalDecimal(point, "AltitudeMeters").value);
        values.distance!.push(optionalDecimal(point, "DistanceMeters").value);
        const heartRate = optionalChild(point, TCX, "HeartRateBpm");
        const heartRateValue = heartRate ? requiredChild(heartRate, TCX, "Value") : null;
        values.heart_rate!.push(heartRateValue ? parseInteger(textValue(heartRateValue), elementPath(heartRateValue), 1, 255) : null);
        const coreCadence = optionalChild(point, TCX, "Cadence");
        const extensions = optionalChild(point, TCX, "Extensions");
        const tpx = extensions ? optionalChild(extensions, ACTIVITY_EXTENSION, "TPX") : null;
        const runCadence = tpx ? optionalChild(tpx, ACTIVITY_EXTENSION, "RunCadence") : null;
        const cadence = coreCadence ?? runCadence;
        values.cadence!.push(cadence ? parseInteger(textValue(cadence), elementPath(cadence), 0, 255) : null);
        const speed = tpx ? optionalChild(tpx, ACTIVITY_EXTENSION, "Speed") : null;
        const watts = tpx ? optionalChild(tpx, ACTIVITY_EXTENSION, "Watts") : null;
        values.speed!.push(speed ? parseDecimal(textValue(speed), elementPath(speed)) : null);
        values.power!.push(watts ? parseDecimal(textValue(watts), elementPath(watts)) : null);
      }
    }
    laps.push({ lapSeq, startUtc, elapsedS: elapsed.value, distanceM: distance.value, firstSampleIndex, endSampleIndexExclusive: timestamps.length });
  }
  const startUtc = laps[0]!.startUtc;
  return {
    workoutOrdinal: 0,
    sessionOrdinal,
    sport: sportValue(activity),
    startUtc,
    localDateKey: localDateKey(startUtc, attributePath(lapElements[0]!, "StartTime")),
    elapsedS: checkedLapSum(elapsedParts),
    distanceM: checkedLapSum(distanceParts),
    laps,
    segmentStartIndices: null,
    channels: emitChannels(timestamps, values),
  };
}

export function parseTcx(xml: string): TcxParseReport {
  try {
    const root = validateDocumentShell(parseXmlDocument(preprocessXml(xml)));
    validateTcx(root);
    const activities = requiredMany(requiredChild(root, TCX, "Activities"), TCX, "Activity");
    return { format: "tcx", sessions: activities.map(parseActivity), quarantine: null };
  } catch (error) {
    if (!(error instanceof XmlViolation)) throw error;
    return { format: "tcx", sessions: [], quarantine: error.quarantine };
  }
}
