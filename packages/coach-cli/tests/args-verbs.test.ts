import { describe, expect, it } from "vitest";
import { parseCoachCliInvocation } from "../src/args.js";

const verbUsage = {
  kind: "verb-usage",
  message:
    "Usage: enduragent <ask|state|analyze|import|plan week|sync|wellness set> [--json|--stream-json] [--session <key>|--fresh] [--local]",
} as const;

describe("scriptable CLI arguments", () => {
  it("preserves predecessor invocation forms", () => {
    expect(parseCoachCliInvocation([])).toEqual({ kind: "repl" });
    expect(parseCoachCliInvocation(["version"])).toEqual({ kind: "version" });
    expect(parseCoachCliInvocation(["--version"])).toEqual({ kind: "version" });
    expect(parseCoachCliInvocation(["serve"])).toEqual({ kind: "serve" });
    for (const argv of [["unknown"], ["serve", "--json"]]) {
      expect(parseCoachCliInvocation(argv)).toEqual({
        kind: "usage",
        message: "Usage: enduragent [version|serve|self-test]",
      });
    }
    expect(parseCoachCliInvocation(["import"])).toEqual(verbUsage);
    expect(parseCoachCliInvocation(["sync", "anything"])).toEqual(verbUsage);
  });

  it("parses only the exact self-test invocation", () => {
    expect(parseCoachCliInvocation(["self-test"])).toEqual({ kind: "self-test" });
    for (const argv of [
      ["self-test", "--json"],
      ["self-test", "extra"],
    ]) {
      expect(parseCoachCliInvocation(argv)).toEqual({
        kind: "usage",
        message: "Usage: enduragent [version|serve|self-test]",
      });
    }
  });

  it("parses every verb and permits flags around operands", () => {
    expect(
      parseCoachCliInvocation([
        "ask",
        "--session",
        "RaceA",
        "hello",
        "--stream-json",
        "world",
        "--local",
      ]),
    ).toEqual({
      kind: "verb",
      verb: { name: "ask", input: { kind: "argv", text: "hello world" } },
      outputMode: "stream-json",
      session: { kind: "named", key: "RaceA" },
      local: true,
    });
    expect(parseCoachCliInvocation(["state", "--local", "--json"])).toEqual({
      kind: "verb",
      verb: { name: "state" },
      outputMode: "json",
      session: { kind: "default" },
      local: true,
    });
    expect(parseCoachCliInvocation(["analyze", "--fresh", "last-ride"])).toEqual({
      kind: "verb",
      verb: { name: "analyze", target: "last-ride" },
      outputMode: "text",
      session: { kind: "fresh" },
      local: false,
    });
    expect(parseCoachCliInvocation(["plan", "--json", "week"])).toEqual({
      kind: "verb",
      verb: { name: "plan-week" },
      outputMode: "json",
      session: { kind: "default" },
      local: false,
    });
    expect(parseCoachCliInvocation(["import", "a.fit", "b.tcx", "c.gpx", "--json"])).toEqual({
      kind: "verb",
      verb: { name: "import", paths: ["a.fit", "b.tcx", "c.gpx"] },
      outputMode: "json",
      session: { kind: "default" },
      local: false,
    });
    expect(parseCoachCliInvocation(["sync", "--stream-json"])).toEqual({
      kind: "verb",
      verb: { name: "sync" },
      outputMode: "stream-json",
      session: { kind: "default" },
      local: false,
    });
    expect(
      parseCoachCliInvocation([
        "wellness",
        "--session",
        "recovery",
        "set",
        "sleep=good",
        "note=a=b",
      ]),
    ).toEqual({
      kind: "verb",
      verb: {
        name: "wellness-set",
        entries: [
          { key: "sleep", value: "good" },
          { key: "note", value: "a=b" },
        ],
      },
      outputMode: "text",
      session: { kind: "named", key: "recovery" },
      local: false,
    });
  });

  it("selects stdin for empty ask and a lone dash", () => {
    for (const argv of [["ask"], ["ask", "-"]]) {
      expect(parseCoachCliInvocation(argv)).toEqual({
        kind: "verb",
        verb: { name: "ask", input: { kind: "stdin" } },
        outputMode: "text",
        session: { kind: "default" },
        local: false,
      });
    }
  });

  it("honors the end-of-flags marker", () => {
    expect(parseCoachCliInvocation(["ask", "--", "--json", "tail"])).toEqual({
      kind: "verb",
      verb: { name: "ask", input: { kind: "argv", text: "--json tail" } },
      outputMode: "text",
      session: { kind: "default" },
      local: false,
    });
    expect(parseCoachCliInvocation(["analyze", "--", "--fresh"])).toEqual({
      kind: "verb",
      verb: { name: "analyze", target: "--fresh" },
      outputMode: "text",
      session: { kind: "default" },
      local: false,
    });
    expect(parseCoachCliInvocation(["import", "--", "--dash.fit"])).toEqual({
      kind: "verb",
      verb: { name: "import", paths: ["--dash.fit"] },
      outputMode: "text",
      session: { kind: "default" },
      local: false,
    });
  });

  it("rejects duplicate, exclusive, missing, and unknown flags", () => {
    const rows = [
      ["ask", "x", "--json", "--json"],
      ["ask", "x", "--stream-json", "--stream-json"],
      ["ask", "x", "--local", "--local"],
      ["ask", "x", "--fresh", "--fresh"],
      ["ask", "x", "--session", "a", "--session", "b"],
      ["ask", "x", "--json", "--stream-json"],
      ["ask", "x", "--fresh", "--session", "a"],
      ["ask", "x", "--session", "a", "--fresh"],
      ["ask", "x", "--session"],
      ["ask", "x", "--unknown"],
    ];
    for (const argv of rows) expect(parseCoachCliInvocation(argv)).toEqual(verbUsage);
  });

  it("rejects state-only forbidden flags and invalid operand shapes", () => {
    const rows = [
      ["state", "--stream-json"],
      ["state", "--fresh"],
      ["state", "--session", "a"],
      ["state", "extra"],
      ["analyze"],
      ["analyze", "-"],
      ["analyze", "a", "b"],
      ["plan"],
      ["plan", "month"],
      ["wellness", "set"],
      ["wellness", "set", "1sleep=good"],
      ["wellness", "set", "sleep="],
      ["wellness", "set", "sleep=good", "sleep=bad"],
      ["import", "a.fit", "a.fit"],
      ["import", "-"],
      ["import", "a.fit", "--local"],
      ["import", "a.fit", "--fresh"],
      ["import", "a.fit", "--session", "a"],
      ["sync", "--local"],
      ["sync", "--fresh"],
      ["sync", "--session", "a"],
    ];
    for (const argv of rows) expect(parseCoachCliInvocation(argv)).toEqual(verbUsage);
  });
});
