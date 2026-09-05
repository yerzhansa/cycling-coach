import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  checkStructure,
  compareStructure,
  probeExpression,
  validateContract,
  validateSelection,
  type Anchor,
  type Measurement,
  type StructuralContract,
} from "./structure.js";

const rowAnchor: Anchor = { name: "rows", selector: ".row", count: { exact: 3 } };
const item = (
  input: {
    readonly left?: number;
    readonly top?: number;
    readonly width?: number;
    readonly height?: number;
    readonly order?: number;
    readonly border?: number;
    readonly padding?: number;
    readonly text?: string;
    readonly visible?: boolean;
  } = {},
): Measurement => ({
  text: input.text ?? "Fictional row",
  order: input.order ?? 1,
  visible: input.visible ?? true,
  rect: {
    left: input.left ?? 8,
    top: input.top ?? 8,
    right: (input.left ?? 8) + (input.width ?? 100),
    bottom: (input.top ?? 8) + (input.height ?? 20),
    width: input.width ?? 100,
    height: input.height ?? 20,
  },
  style: {
    "border-bottom-width": `${input.border ?? 0}px`,
    "padding-left": `${input.padding ?? 8}px`,
  },
});
const anchors: readonly Anchor[] = [rowAnchor];
const rows = [item({ order: 1 }), item({ order: 2 }), item({ order: 3 })];

function singleton(name: string): Anchor {
  return { name, selector: `.${name}`, count: { exact: 1 } };
}

describe("required measurements", () => {
  it("fails required anchors absent from both compared snapshots", () => {
    expect(compareStructure({}, {}, anchors)).toEqual([
      { anchor: "expected.rows", property: "count", expected: "exactly 3", actual: "0" },
      { anchor: "actual.rows", property: "count", expected: "exactly 3", actual: "0" },
    ]);
  });

  it("checks a defect on the second and final rows", () => {
    const actual = [
      rows[0],
      item({ order: 2, padding: 32 }),
      item({ order: 3, width: 140 }),
    ].filter((value) => value !== undefined);
    const failures = compareStructure({ rows }, { rows: actual }, anchors);
    expect(failures).toContainEqual({
      anchor: "rows[1]",
      property: "padding-left",
      expected: "8px",
      actual: "32px",
    });
    expect(failures).toContainEqual({
      anchor: "rows[2]",
      property: "width",
      expected: "100px",
      actual: "140px",
    });
    expect(compareStructure({ rows }, { rows }, anchors)).toEqual([]);
  });

  it("compares text and positions in addition to styles and dimensions", () => {
    const before = { control: [item()] };
    const after = { control: [item({ left: 24, text: "Changed consequence" })] };
    expect(compareStructure(before, after, [singleton("control")])).toEqual([
      {
        anchor: "control[0]",
        property: "text",
        expected: "Fictional row",
        actual: "Changed consequence",
      },
      { anchor: "control[0]", property: "left", expected: "8px", actual: "24px" },
    ]);
  });

  it("rejects hidden and nonfinite measurements", () => {
    const failures = checkStructure(
      { control: [item({ visible: false, left: Number.NaN })] },
      { anchors: [singleton("control")], rules: [] },
    );
    expect(failures.map((failure) => failure.property)).toEqual(["visibility", "measurement"]);
  });

  it("enforces exact and minimum cardinality independently", () => {
    expect(checkStructure({ rows: rows.slice(0, 2) }, { anchors, rules: [] })).toHaveLength(1);
    const minimum = [{ ...rowAnchor, count: { atLeast: 2 } }];
    expect(checkStructure({ rows }, { anchors: minimum, rules: [] })).toEqual([]);
    expect(checkStructure({ rows: [] }, { anchors: minimum, rules: [] })).toHaveLength(1);
  });
});

describe("composition rules", () => {
  it("checks each child inset relative to its container", () => {
    const contract: StructuralContract = {
      anchors: [singleton("card"), rowAnchor],
      rules: [
        { kind: "inset", container: "card", children: "rows", sides: ["left", "right"], value: 8 },
      ],
    };
    const card = [item({ left: 0, width: 116 })];
    expect(checkStructure({ card, rows }, contract)).toEqual([]);
    const failures = checkStructure(
      { card, rows: [item(), item({ left: 20, width: 88 }), item()] },
      contract,
    );
    expect(failures).toEqual([
      { anchor: "rows[1]", property: "left-inset", expected: "8px", actual: "20px" },
    ]);
  });

  it("checks alignment of every repeated row", () => {
    const contract: StructuralContract = {
      anchors,
      rules: [{ kind: "alignment", anchors: ["rows"], edge: "left" }],
    };
    expect(checkStructure({ rows }, contract)).toEqual([]);
    expect(checkStructure({ rows: [item(), item(), item({ left: 10 })] }, contract)).toEqual([
      { anchor: "rows[2]", property: "left-alignment", expected: "8px", actual: "10px" },
    ]);
  });

  it("checks both DOM and visual action order, permitting a wrapped next row", () => {
    const contract: StructuralContract = {
      anchors: [singleton("back"), singleton("continue")],
      rules: [{ kind: "action-order", actions: ["back", "continue"] }],
    };
    const back = [item({ left: 8, order: 10 })];
    expect(checkStructure({ back, continue: [item({ left: 116, order: 20 })] }, contract)).toEqual(
      [],
    );
    expect(
      checkStructure({ back, continue: [item({ left: 8, top: 36, order: 20 })] }, contract),
    ).toEqual([]);
    expect(
      checkStructure({ back, continue: [item({ left: 0, order: 5 })] }, contract).map(
        (failure) => failure.property,
      ),
    ).toEqual(["dom-order", "visual-order"]);
    expect(
      checkStructure({ back, continue: [item({ left: 116, order: 5 })] }, contract).map(
        (failure) => failure.property,
      ),
    ).toEqual(["dom-order"]);
  });

  it("rejects an alignment rule that performs no comparison", () => {
    expect(
      checkStructure(
        { control: [item()] },
        {
          anchors: [singleton("control")],
          rules: [{ kind: "alignment", anchors: ["control"], edge: "left" }],
        },
      ),
    ).toEqual([
      {
        anchor: "control",
        property: "alignment-coverage",
        expected: "at least 2 measurements",
        actual: "1",
      },
    ]);
  });

  it("requires separators between all rows and rejects a trailing divider", () => {
    const contract: StructuralContract = { anchors, rules: [{ kind: "separators", rows: "rows" }] };
    expect(
      checkStructure({ rows: [item({ border: 1 }), item({ border: 1 }), item()] }, contract),
    ).toEqual([]);
    expect(
      checkStructure({ rows: [item({ border: 1 }), item(), item({ border: 1 })] }, contract),
    ).toEqual([
      { anchor: "rows[1]", property: "separator", expected: "visible", actual: "0px" },
      { anchor: "rows[2]", property: "separator", expected: "none", actual: "1px" },
    ]);
  });
});

describe("selection and contract boundaries", () => {
  it("rejects selections that could pass without doing the requested work", () => {
    expect(() => validateSelection(["ready"], [])).toThrow("must not be empty");
    expect(() => validateSelection(["ready"], ["typo"])).toThrow("unknown scenario");
    expect(() => validateSelection(["ready"], ["ready", "ready"])).toThrow("duplicates");
    expect(() => validateSelection([], ["ready"])).toThrow("must not be empty");
    expect(() => validateSelection(["ready"], ["ready"])).not.toThrow();
  });

  it("rejects empty or ambiguous required contracts", () => {
    expect(() => validateContract({ anchors: [], rules: [] })).toThrow("must not be empty");
    expect(() => validateContract({ anchors: [rowAnchor, rowAnchor], rules: [] })).toThrow(
      "unique",
    );
    expect(() =>
      validateContract({ anchors: [{ ...rowAnchor, count: { exact: 0 } }], rules: [] }),
    ).toThrow("positive count");
    expect(() =>
      validateContract({ anchors: [{ ...rowAnchor, count: { atLeast: 1.5 } }], rules: [] }),
    ).toThrow("positive count");
    expect(() =>
      validateContract({ anchors, rules: [{ kind: "separators", rows: "missing" }] }),
    ).toThrow("unknown anchor");
    expect(() =>
      validateContract({
        anchors,
        rules: [
          {
            kind: "alignment",
            anchors: ["rows"],
            edge: "left",
            tolerance: Number.POSITIVE_INFINITY,
          },
        ],
      }),
    ).toThrow("finite");
  });
});

it("serializes a self-contained probe that samples every matching element", () => {
  const elements = [1, 2, 3].map((index) => ({
    textContent: `  Row  ${index}  `,
    getClientRects: () => [true],
    getBoundingClientRect: () => ({
      left: 8,
      right: 108,
      top: index * 20,
      bottom: index * 20 + 20,
      width: 100,
      height: 20,
    }),
  }));
  const measured: unknown = runInNewContext(probeExpression(anchors), {
    document: { querySelectorAll: () => elements },
    getComputedStyle: () => ({
      visibility: "visible",
      opacity: "1",
      getPropertyValue: () => "8px",
    }),
  });
  expect(measured).toMatchObject({
    rows: [
      { text: "Row 1", order: 0, visible: true },
      { text: "Row 2", order: 1, visible: true },
      { text: "Row 3", order: 2, visible: true },
    ],
  });
});
