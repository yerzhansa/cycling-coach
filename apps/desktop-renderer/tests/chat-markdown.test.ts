import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_COACH_MARKDOWN_LIMITS,
  renderCoachMarkdown,
  type CoachMarkdownLimits,
} from "../src/chat/markdown";

class FakeNode {
  readonly children: FakeNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  className = "";
  private ownText = "";

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children.splice(0);
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) {
      if (node.tagName === "#fragment") this.children.push(...node.children.splice(0));
      else this.children.push(node);
    }
  }

  replaceChildren(...nodes: FakeNode[]): void {
    this.ownText = "";
    this.children.splice(0);
    this.append(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

class FakeDocument {
  createElement(name: string): FakeNode {
    return new FakeNode(name);
  }

  createTextNode(value: string): FakeNode {
    const node = new FakeNode("#text");
    node.textContent = value;
    return node;
  }

  createDocumentFragment(): FakeNode {
    return new FakeNode("#fragment");
  }
}

function findAll(root: FakeNode, tagName: string): FakeNode[] {
  return [
    ...(root.tagName === tagName ? [root] : []),
    ...root.children.flatMap((child) => findAll(child, tagName)),
  ];
}

function render(source: string, limits?: CoachMarkdownLimits): FakeNode {
  const container = new FakeNode("div");
  renderCoachMarkdown(container as never, source, limits);
  return container;
}

beforeEach(() => {
  Object.assign(globalThis, { document: new FakeDocument() });
});

describe("coach markdown", () => {
  it("renders the finite athlete-facing block and inline subset", () => {
    const root = render(`# Today

Build **steadily**, recover *fully*, and ~~skip~~ adjust \`carefully\`.
Keep the cadence
comfortable.

- Easy start
- Smooth finish

1. Warm up
2. Ride

\`\`\`text
const effort = "easy";
\`\`\`

| Session | Goal |
| --- | --- |
| Endurance | **Steady** |

[Training guide](https://example.test/guide)`);

    expect(findAll(root, "h1")).toHaveLength(1);
    expect(findAll(root, "strong").map((node) => node.textContent)).toEqual(["steadily", "Steady"]);
    expect(findAll(root, "em")[0]?.textContent).toBe("fully");
    expect(findAll(root, "del")[0]?.textContent).toBe("skip");
    expect(findAll(root, "br")).toHaveLength(2);
    expect(findAll(root, "ul")[0]?.children).toHaveLength(2);
    expect(findAll(root, "ol")[0]?.children).toHaveLength(2);
    expect(findAll(root, "pre")[0]?.textContent).toBe('const effort = "easy";');
    expect(findAll(root, "table")).toHaveLength(1);
    expect(findAll(root, "div")[1]?.className).toBe(
      "chat-markdown__table-scroll my-[0.65em] max-w-full overflow-x-auto",
    );
    expect(findAll(root, "th").map((node) => node.textContent)).toEqual(["Session", "Goal"]);
    const anchor = findAll(root, "a")[0]!;
    expect(anchor.textContent).toBe("Training guide");
    expect(Object.fromEntries(anchor.attributes)).toEqual({
      href: "https://example.test/guide",
      target: "_blank",
      rel: "noopener noreferrer",
      referrerpolicy: "no-referrer",
    });
  });

  it("keeps raw HTML and image syntax literal without creating network-capable elements", () => {
    const source =
      '<script>globalThis.executed = true</script> <img src="https://attacker.invalid/pixel"> ![route](https://attacker.invalid/route.png)';
    const root = render(source);

    expect(root.textContent).toBe(source);
    expect(findAll(root, "script")).toHaveLength(0);
    expect(findAll(root, "img")).toHaveLength(0);
    expect(findAll(root, "a")).toHaveLength(0);
    expect((globalThis as Record<string, unknown>).executed).toBeUndefined();
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "mailto:coach@example.test",
    "/relative",
    "//example.test/path",
    "https://user@example.test/path",
    "https://user:secret@example.test/path",
    " https://example.test/path",
    "https://example.test/path\u007f",
    "http://",
  ])("leaves an unsafe link destination visible: %s", (destination) => {
    const source = `[unsafe](${destination})`;
    const root = render(source);

    expect(root.textContent).toBe(source);
    expect(findAll(root, "a")).toHaveLength(0);
  });

  it("canonicalizes safe absolute HTTP links before placing them in the DOM", () => {
    const root = render("[safe](HTTPS://EXAMPLE.TEST:443/a/../guide)");

    expect(findAll(root, "a")[0]?.attributes.get("href")).toBe("https://example.test/guide");
  });

  it("matches the coaching channel's emphasis flanking without changing interval math or identifiers", () => {
    const source =
      "Do 3 * 8 reps, then 2 * 20min with threshold_power_zone; this is *important* and _useful_.";
    const root = render(source);

    expect(root.textContent).toBe(
      "Do 3 * 8 reps, then 2 * 20min with threshold_power_zone; this is important and useful.",
    );
    expect(findAll(root, "em").map((node) => node.textContent)).toEqual(["important", "useful"]);
  });

  it.each(["foo*bar*baz", "interval * spaced*", "interval *spaced *", "embedded_under_score"])(
    "leaves non-flanking emphasis literal: %s",
    (source) => {
      const root = render(source);
      expect(root.textContent).toBe(source);
      expect(findAll(root, "em")).toHaveLength(0);
    },
  );

  it("uses the coaching channel's exact underscore boundaries", () => {
    const root = render("_ spaced_ _trailing _ __paired__ foo_bar_baz _line\nbreak_");

    expect(findAll(root, "em").map((node) => node.textContent)).toEqual([
      " spaced",
      "trailing ",
      "linebreak",
    ]);
    expect(root.textContent).toBe(" spaced trailing  __paired__ foo_bar_baz linebreak");
  });

  it("supports balanced and escaped parentheses in safe link destinations", () => {
    const root = render(
      "[Foo](https://en.wikipedia.org/wiki/Foo_(bar)) [plan\\]](https://example.test/a\\(b\\))",
    );

    expect(findAll(root, "a").map((anchor) => anchor.textContent)).toEqual(["Foo", "plan]"]);
    expect(findAll(root, "a").map((anchor) => anchor.attributes.get("href"))).toEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)",
      "https://example.test/a(b)",
    ]);
  });

  it.each([
    "A cumulative **strong response",
    "A cumulative *emphasis response",
    "A cumulative ~~strike response",
    "A cumulative `code response",
    "A cumulative [link](https://example.test",
  ])("keeps incomplete streaming syntax visible and never throws: %s", (source) => {
    expect(() => render(source)).not.toThrow();
    const root = render(source);
    expect(root.textContent).toBe(source.replaceAll("\n", ""));
    expect(findAll(root, "br")).toHaveLength(source.split("\n").length - 1);
  });

  it("consumes an unfinished fence remainder literally without interpreting later blocks", () => {
    const source = "```ts\n# not a heading\n[not a link](https://example.test/)";
    const root = render(source);

    expect(root.textContent).toBe(source);
    expect(findAll(root, "pre")).toHaveLength(1);
    expect(findAll(root, "h1")).toHaveLength(0);
    expect(findAll(root, "a")).toHaveLength(0);
  });

  it("consumes a long unfinished fence within the bounded work budget", () => {
    const source = `\`\`\`text\n${"# still inert fence content\n".repeat(3_000)}`;
    const root = render(source);

    expect(root.textContent).toBe(source);
    expect(findAll(root, "pre")).toHaveLength(1);
    expect(findAll(root, "h1")).toHaveLength(0);
  });

  it("handles a long unmatched-bracket stream in one literal pass", () => {
    const source = `${"[".repeat(8_000)}still streaming`;
    const root = render(source);

    expect(root.textContent).toBe(source);
    expect(findAll(root, "p")).toHaveLength(1);
    expect(findAll(root, "a")).toHaveLength(0);
  });

  it.each([
    {
      name: "source",
      limits: { ...DEFAULT_COACH_MARKDOWN_LIMITS, sourceCharacters: 3 },
    },
    {
      name: "work",
      limits: { ...DEFAULT_COACH_MARKDOWN_LIMITS, workUnits: 1 },
    },
    {
      name: "nodes",
      limits: { ...DEFAULT_COACH_MARKDOWN_LIMITS, nodes: 1 },
    },
  ])("falls back to the complete plain source when the $name budget is exhausted", ({ limits }) => {
    const source = "## **complete source**";
    const root = render(source, limits);

    expect(root.textContent).toBe(source);
    expect(root.children).toHaveLength(0);
  });

  it("does not treat pipes in fences or inline code as table separators", () => {
    const root = render(`\`\`\`
| fenced | content |
\`\`\`

| Expression | Result |
| --- | --- |
| \`left|right\` | safe |`);

    expect(findAll(root, "pre")[0]?.textContent).toBe("| fenced | content |");
    expect(findAll(root, "table")).toHaveLength(1);
    expect(findAll(root, "td")).toHaveLength(2);
    expect(findAll(root, "td")[0]?.textContent).toBe("left|right");
  });
});
