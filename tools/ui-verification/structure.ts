export type Side = "top" | "right" | "bottom" | "left";

export type Anchor = {
  readonly name: string;
  readonly selector: string;
  readonly count: { readonly exact: number } | { readonly atLeast: number };
};

export type StructuralRule =
  | {
      readonly kind: "inset";
      readonly container: string;
      readonly children: string;
      readonly sides: readonly Side[];
      readonly value: number;
      readonly tolerance?: number;
    }
  | {
      readonly kind: "alignment";
      readonly anchors: readonly string[];
      readonly edge: Side;
      readonly tolerance?: number;
    }
  | {
      readonly kind: "action-order";
      readonly actions: readonly string[];
      readonly tolerance?: number;
    }
  | { readonly kind: "separators"; readonly rows: string };

export type StructuralContract = {
  readonly anchors: readonly Anchor[];
  readonly rules: readonly StructuralRule[];
};

export type Measurement = {
  readonly text: string;
  readonly order: number;
  readonly visible: boolean;
  readonly rect: Readonly<Record<Side | "width" | "height", number>>;
  readonly style: Readonly<Record<string, string>>;
};

export type StructuralSnapshot = Readonly<Record<string, readonly Measurement[]>>;

export type StructuralFailure = {
  readonly anchor: string;
  readonly property: string;
  readonly expected: string;
  readonly actual: string;
};

export function probeStructure(anchors: readonly Anchor[]): StructuralSnapshot {
  const documentOrder = new Map(
    Array.from(document.querySelectorAll("*")).map((element, index) => [element, index]),
  );
  const properties = [
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "letter-spacing",
    "color",
    "background-color",
    "border-color",
    "border-radius",
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "margin-top",
    "margin-bottom",
    "row-gap",
    "column-gap",
    "opacity",
  ];
  return Object.fromEntries(
    anchors.map((anchor) => [
      anchor.name,
      Array.from(document.querySelectorAll(anchor.selector)).map((element): Measurement => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          text: (element.textContent ?? "").replace(/\s+/gu, " ").trim(),
          order: documentOrder.get(element) ?? -1,
          visible:
            element.getClientRects().length > 0 &&
            style.visibility !== "hidden" &&
            style.visibility !== "collapse" &&
            Number(style.opacity) !== 0,
          rect: {
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          },
          style: Object.fromEntries(
            properties.map((property) => [property, style.getPropertyValue(property)]),
          ),
        };
      }),
    ]),
  );
}

export function probeExpression(anchors: readonly Anchor[]): string {
  validateAnchors(anchors);
  return `(${probeStructure.toString()})(${JSON.stringify(anchors)})`;
}

export function validateSelection(known: readonly string[], selected: readonly string[]): void {
  for (const [name, values] of [
    ["known", known],
    ["selected", selected],
  ] satisfies readonly [string, readonly string[]][]) {
    if (values.length === 0) throw new TypeError(`${name} scenarios must not be empty`);
    if (values.some((value) => value.trim().length === 0))
      throw new TypeError(`${name} scenario names must not be blank`);
    if (new Set(values).size !== values.length)
      throw new TypeError(`${name} scenarios contain duplicates`);
  }
  for (const id of selected) {
    if (!known.includes(id)) throw new TypeError(`unknown scenario: ${id}`);
  }
}

export function validateContract(contract: StructuralContract): void {
  validateAnchors(contract.anchors);
  const references = (names: readonly string[], minimum: number): void => {
    if (names.length < minimum) throw new TypeError(`rule requires at least ${minimum} anchors`);
    if (new Set(names).size !== names.length)
      throw new TypeError("rule contains duplicate anchors");
    for (const name of names) {
      if (!contract.anchors.some((anchor) => anchor.name === name))
        throw new TypeError(`unknown anchor: ${name}`);
    }
  };
  const single = (name: string): void => {
    const anchor = contract.anchors.find((entry) => entry.name === name);
    if (!anchor || !("exact" in anchor.count) || anchor.count.exact !== 1) {
      throw new TypeError(`rule requires exactly one ${name}`);
    }
  };
  for (const rule of contract.rules) {
    if ("tolerance" in rule && rule.tolerance !== undefined) {
      nonnegative(rule.tolerance, "tolerance");
    }
    switch (rule.kind) {
      case "inset":
        references([rule.container, rule.children], 2);
        single(rule.container);
        nonnegative(rule.value, "inset");
        if (rule.sides.length === 0 || new Set(rule.sides).size !== rule.sides.length) {
          throw new TypeError("inset sides must be nonempty and unique");
        }
        break;
      case "alignment":
        references(rule.anchors, 1);
        break;
      case "action-order":
        references(rule.actions, 2);
        rule.actions.forEach(single);
        break;
      case "separators":
        references([rule.rows], 1);
        break;
      default: {
        const exhaustive: never = rule;
        throw new TypeError(`unknown rule: ${String(exhaustive)}`);
      }
    }
  }
}

export function checkStructure(
  snapshot: StructuralSnapshot,
  contract: StructuralContract,
): readonly StructuralFailure[] {
  validateContract(contract);
  const failures = requiredFailures(snapshot, contract.anchors);
  const values = (name: string): readonly Measurement[] => snapshot[name] ?? [];
  for (const rule of contract.rules) {
    switch (rule.kind) {
      case "inset": {
        const container = values(rule.container)[0];
        if (!container) break;
        values(rule.children).forEach((child, index) => {
          for (const side of rule.sides) {
            const sign = side === "left" || side === "top" ? 1 : -1;
            const inset = (child.rect[side] - container.rect[side]) * sign;
            difference(
              failures,
              `${rule.children}[${index}]`,
              `${side}-inset`,
              rule.value,
              inset,
              rule.tolerance ?? 0.5,
            );
          }
        });
        break;
      }
      case "alignment": {
        const measurements = rule.anchors.flatMap((anchor) =>
          values(anchor).map((value, index) => ({ name: `${anchor}[${index}]`, value })),
        );
        const first = measurements[0];
        if (!first || measurements.length < 2) {
          failures.push({
            anchor: rule.anchors.join(","),
            property: "alignment-coverage",
            expected: "at least 2 measurements",
            actual: String(measurements.length),
          });
          break;
        }
        for (const measurement of measurements.slice(1)) {
          difference(
            failures,
            measurement.name,
            `${rule.edge}-alignment`,
            first.value.rect[rule.edge],
            measurement.value.rect[rule.edge],
            rule.tolerance ?? 0.5,
          );
        }
        break;
      }
      case "action-order": {
        for (let index = 1; index < rule.actions.length; index++) {
          const beforeName = rule.actions[index - 1];
          const afterName = rule.actions[index];
          if (beforeName === undefined || afterName === undefined) continue;
          const before = values(beforeName)[0];
          const after = values(afterName)[0];
          if (!before || !after) continue;
          if (before.order >= after.order) {
            failures.push({
              anchor: afterName,
              property: "dom-order",
              expected: `after ${beforeName}`,
              actual: "before or same element",
            });
          }
          const tolerance = rule.tolerance ?? 0.5;
          const sameRow =
            Math.min(before.rect.bottom, after.rect.bottom) -
              Math.max(before.rect.top, after.rect.top) >
            tolerance;
          const ordered = sameRow
            ? before.rect.right <= after.rect.left + tolerance
            : before.rect.bottom <= after.rect.top + tolerance;
          if (!ordered) {
            failures.push({
              anchor: afterName,
              property: "visual-order",
              expected: `after ${beforeName}`,
              actual: "before or overlapping",
            });
          }
        }
        break;
      }
      case "separators": {
        const rows = values(rule.rows);
        rows.forEach((row, index) => {
          const width = Number.parseFloat(row.style["border-bottom-width"] ?? "");
          const expected = index === rows.length - 1 ? "none" : "visible";
          const valid = Number.isFinite(width) && (expected === "none" ? width === 0 : width > 0);
          if (!valid)
            failures.push({
              anchor: `${rule.rows}[${index}]`,
              property: "separator",
              expected,
              actual: `${width}px`,
            });
        });
        break;
      }
      default: {
        const exhaustive: never = rule;
        throw new TypeError(`unknown rule: ${String(exhaustive)}`);
      }
    }
  }
  return failures;
}

export function compareStructure(
  expected: StructuralSnapshot,
  actual: StructuralSnapshot,
  anchors: readonly Anchor[],
): readonly StructuralFailure[] {
  validateAnchors(anchors);
  const failures = [
    ...requiredFailures(expected, anchors).map((failure) => ({
      ...failure,
      anchor: `expected.${failure.anchor}`,
    })),
    ...requiredFailures(actual, anchors).map((failure) => ({
      ...failure,
      anchor: `actual.${failure.anchor}`,
    })),
  ];
  for (const anchor of anchors) {
    const left = expected[anchor.name] ?? [];
    const right = actual[anchor.name] ?? [];
    if (left.length !== right.length) {
      failures.push({
        anchor: anchor.name,
        property: "count",
        expected: String(left.length),
        actual: String(right.length),
      });
    }
    left.forEach((sample, index) => {
      const other = right[index];
      if (!other) return;
      const name = `${anchor.name}[${index}]`;
      if (sample.text !== other.text)
        failures.push({
          anchor: name,
          property: "text",
          expected: sample.text,
          actual: other.text,
        });
      for (const side of ["left", "top", "width", "height"] satisfies readonly (
        | Side
        | "width"
        | "height"
      )[]) {
        difference(failures, name, side, sample.rect[side], other.rect[side], 0.5);
      }
      for (const property of new Set([...Object.keys(sample.style), ...Object.keys(other.style)])) {
        const a = sample.style[property] ?? "";
        const b = other.style[property] ?? "";
        if (!styleEqual(a, b)) failures.push({ anchor: name, property, expected: a, actual: b });
      }
    });
  }
  return failures;
}

function validateAnchors(anchors: readonly Anchor[]): void {
  if (anchors.length === 0) throw new TypeError("required anchors must not be empty");
  if (new Set(anchors.map((anchor) => anchor.name)).size !== anchors.length)
    throw new TypeError("anchor names must be unique");
  for (const anchor of anchors) {
    if (anchor.name.trim().length === 0 || anchor.selector.trim().length === 0)
      throw new TypeError("anchor name and selector must not be blank");
    const count = "exact" in anchor.count ? anchor.count.exact : anchor.count.atLeast;
    if (!Number.isInteger(count) || count < 1)
      throw new TypeError(`required anchor ${anchor.name} needs a positive count`);
  }
}

function requiredFailures(
  snapshot: StructuralSnapshot,
  anchors: readonly Anchor[],
): StructuralFailure[] {
  const failures: StructuralFailure[] = [];
  for (const anchor of anchors) {
    const samples = snapshot[anchor.name] ?? [];
    const expected =
      "exact" in anchor.count
        ? `exactly ${anchor.count.exact}`
        : `at least ${anchor.count.atLeast}`;
    const matches =
      "exact" in anchor.count
        ? samples.length === anchor.count.exact
        : samples.length >= anchor.count.atLeast;
    if (!matches)
      failures.push({
        anchor: anchor.name,
        property: "count",
        expected,
        actual: String(samples.length),
      });
    samples.forEach((sample, index) => {
      if (!sample.visible)
        failures.push({
          anchor: `${anchor.name}[${index}]`,
          property: "visibility",
          expected: "visible",
          actual: "hidden",
        });
      if (
        sample.order < 0 ||
        !Number.isInteger(sample.order) ||
        Object.values(sample.rect).some((value) => !Number.isFinite(value))
      ) {
        failures.push({
          anchor: `${anchor.name}[${index}]`,
          property: "measurement",
          expected: "finite geometry and document order",
          actual: "invalid",
        });
      }
    });
  }
  return failures;
}

function difference(
  failures: StructuralFailure[],
  anchor: string,
  property: string,
  expected: number,
  actual: number,
  tolerance: number,
): void {
  if (!Number.isFinite(actual) || Math.abs(expected - actual) > tolerance) {
    failures.push({ anchor, property, expected: `${expected}px`, actual: `${actual}px` });
  }
}

function nonnegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0)
    throw new TypeError(`${name} must be finite and nonnegative`);
}

function styleEqual(a: string, b: string): boolean {
  if (a === b) return true;
  const px = /^(-?\d+(?:\.\d+)?)px$/u;
  const left = px.exec(a);
  const right = px.exec(b);
  if (left && right) return Math.abs(Number(left[1]) - Number(right[1])) <= 0.5;
  return false;
}
