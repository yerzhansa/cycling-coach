export type CoachCliOutputMode = "text" | "json" | "stream-json";

export type CoachCliSessionSelection =
  | { readonly kind: "default" }
  | { readonly kind: "named"; readonly key: string }
  | { readonly kind: "fresh" };

export type CoachCliVerb =
  | {
      readonly name: "ask";
      readonly input: { readonly kind: "argv"; readonly text: string } | { readonly kind: "stdin" };
    }
  | { readonly name: "state" }
  | { readonly name: "analyze"; readonly target: string }
  | { readonly name: "plan-week" }
  | {
      readonly name: "wellness-set";
      readonly entries: readonly { readonly key: string; readonly value: string }[];
    };

export type CoachCliVerbInvocation = {
  readonly kind: "verb";
  readonly verb: CoachCliVerb;
  readonly outputMode: CoachCliOutputMode;
  readonly session: CoachCliSessionSelection;
  readonly local: boolean;
};

export type CoachCliInvocation =
  | { readonly kind: "repl" }
  | { readonly kind: "version" }
  | { readonly kind: "serve" }
  | {
      readonly kind: "usage";
      readonly message: "Usage: enduragent [version|serve]";
    }
  | CoachCliVerbInvocation
  | {
      readonly kind: "verb-usage";
      readonly message: "Usage: enduragent <ask|state|analyze|plan week|wellness set> [--json|--stream-json] [--session <key>|--fresh] [--local]";
    };

const VERB_USAGE =
  "Usage: enduragent <ask|state|analyze|plan week|wellness set> [--json|--stream-json] [--session <key>|--fresh] [--local]" as const;

interface ScannedVerbArguments {
  readonly operands: readonly string[];
  readonly outputMode: CoachCliOutputMode;
  readonly session: CoachCliSessionSelection;
  readonly local: boolean;
}

function scanVerbArguments(tokens: readonly string[]): ScannedVerbArguments | undefined {
  const operands: string[] = [];
  const seen = new Set<string>();
  let outputMode: CoachCliOutputMode = "text";
  let session: CoachCliSessionSelection = { kind: "default" };
  let local = false;
  let flagsEnded = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!flagsEnded && token === "--") {
      flagsEnded = true;
      continue;
    }
    if (flagsEnded || token === "-" || !token.startsWith("-")) {
      operands.push(token);
      continue;
    }
    if (token === "--session") {
      if (seen.has(token) || session.kind === "fresh" || index + 1 >= tokens.length) {
        return undefined;
      }
      seen.add(token);
      session = { kind: "named", key: tokens[index + 1]! };
      index += 1;
      continue;
    }
    if (token === "--fresh") {
      if (seen.has(token) || session.kind === "named") return undefined;
      seen.add(token);
      session = { kind: "fresh" };
      continue;
    }
    if (token === "--json" || token === "--stream-json") {
      if (
        seen.has(token) ||
        (token === "--json" && seen.has("--stream-json")) ||
        (token === "--stream-json" && seen.has("--json"))
      ) {
        return undefined;
      }
      seen.add(token);
      outputMode = token === "--json" ? "json" : "stream-json";
      continue;
    }
    if (token === "--local") {
      if (seen.has(token)) return undefined;
      seen.add(token);
      local = true;
      continue;
    }
    return undefined;
  }

  return { operands, outputMode, session, local };
}

function parseVerb(root: string, scanned: ScannedVerbArguments): CoachCliVerb | undefined {
  const operands = scanned.operands;
  if (root === "ask") {
    if (operands.length === 0 || (operands.length === 1 && operands[0] === "-")) {
      return { name: "ask", input: { kind: "stdin" } };
    }
    const text = operands.join(" ");
    return /\S/u.test(text) ? { name: "ask", input: { kind: "argv", text } } : undefined;
  }
  if (root === "state") {
    if (
      operands.length !== 0 ||
      scanned.outputMode === "stream-json" ||
      scanned.session.kind !== "default"
    ) {
      return undefined;
    }
    return { name: "state" };
  }
  if (root === "analyze") {
    return operands.length === 1 && operands[0] !== "" && operands[0] !== "-"
      ? { name: "analyze", target: operands[0]! }
      : undefined;
  }
  if (root === "plan") {
    return operands.length === 1 && operands[0] === "week" ? { name: "plan-week" } : undefined;
  }
  if (root !== "wellness" || operands[0] !== "set" || operands.length < 2) {
    return undefined;
  }
  const entries: { readonly key: string; readonly value: string }[] = [];
  const keys = new Set<string>();
  for (const operand of operands.slice(1)) {
    const separator = operand.indexOf("=");
    const key = separator < 0 ? "" : operand.slice(0, separator);
    const value = separator < 0 ? "" : operand.slice(separator + 1);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) || value.length === 0 || keys.has(key)) {
      return undefined;
    }
    keys.add(key);
    entries.push({ key, value });
  }
  return { name: "wellness-set", entries };
}

export function parseCoachCliInvocation(argv: readonly string[]): CoachCliInvocation {
  if (argv.length === 0) return { kind: "repl" };
  if (argv.length === 1 && (argv[0] === "version" || argv[0] === "--version")) {
    return { kind: "version" };
  }
  if (argv.length === 1 && argv[0] === "serve") return { kind: "serve" };
  const root = argv[0]!;
  if (!new Set(["ask", "state", "analyze", "plan", "wellness"]).has(root)) {
    return { kind: "usage", message: "Usage: enduragent [version|serve]" };
  }
  const scanned = scanVerbArguments(argv.slice(1));
  if (scanned === undefined) return { kind: "verb-usage", message: VERB_USAGE };
  const verb = parseVerb(root, scanned);
  if (verb === undefined) return { kind: "verb-usage", message: VERB_USAGE };
  return {
    kind: "verb",
    verb,
    outputMode: scanned.outputMode,
    session: scanned.session,
    local: scanned.local,
  };
}
