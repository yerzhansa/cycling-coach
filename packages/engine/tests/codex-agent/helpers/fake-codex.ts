import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FAKE_CODEX_SCRIPTS_DIR = join(HERE, "frame-scripts");
const VENDORED_SCHEMA_DIR = join(HERE, "..", "..", "..", "src", "agent", "codex-agent", "schema");

export interface FakeCodexEnumRule {
  readonly path: string;
  readonly allowed: readonly string[];
}

const ENUM_RULE_SOURCES: ReadonlyArray<{
  readonly method: string;
  readonly schema: string;
  readonly paths: readonly string[];
}> = [
  {
    method: "thread/start",
    schema: "v2/ThreadStartParams.json",
    paths: ["sandbox", "approvalPolicy", "approvalsReviewer"],
  },
  {
    method: "turn/start",
    schema: "v2/TurnStartParams.json",
    paths: ["sandboxPolicy.type", "approvalPolicy", "approvalsReviewer", "input.type"],
  },
];

type SchemaNode = Record<string, unknown>;

function isSchemaNode(value: unknown): value is SchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deref(root: SchemaNode, node: unknown, depth = 0): SchemaNode | null {
  if (!isSchemaNode(node)) return null;
  const ref = node.$ref;
  if (typeof ref !== "string" || depth > 16 || !ref.startsWith("#/")) return node;
  let cursor: unknown = root;
  for (const segment of ref.slice(2).split("/")) {
    if (!isSchemaNode(cursor)) return null;
    cursor = cursor[segment];
  }
  return deref(root, cursor, depth + 1);
}

function branchesOf(node: SchemaNode): unknown[] {
  const out: unknown[] = [];
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branch = node[key];
    if (Array.isArray(branch)) out.push(...branch);
  }
  return out;
}

function candidatesFor(root: SchemaNode, node: unknown, name: string, out: unknown[], depth = 0) {
  const resolved = deref(root, node);
  if (resolved === null || depth > 16) return;
  const properties = resolved.properties;
  if (isSchemaNode(properties) && name in properties) out.push(properties[name]);
  for (const branch of branchesOf(resolved)) candidatesFor(root, branch, name, out, depth + 1);
  if (resolved.items !== undefined) candidatesFor(root, resolved.items, name, out, depth + 1);
}

function gatherEnums(root: SchemaNode, node: unknown, out: string[], depth = 0): void {
  const resolved = deref(root, node);
  if (resolved === null || depth > 16) return;
  const values = resolved.enum;
  if (Array.isArray(values)) {
    for (const value of values) if (typeof value === "string" && !out.includes(value)) out.push(value);
  }
  for (const branch of branchesOf(resolved)) gatherEnums(root, branch, out, depth + 1);
}

export async function readVendoredEnumRules(): Promise<Record<string, FakeCodexEnumRule[]>> {
  const table: Record<string, FakeCodexEnumRule[]> = {};
  for (const source of ENUM_RULE_SOURCES) {
    const root = JSON.parse(
      await readFile(join(VENDORED_SCHEMA_DIR, source.schema), "utf8"),
    ) as SchemaNode;
    const rules: FakeCodexEnumRule[] = [];
    for (const path of source.paths) {
      let cursors: unknown[] = [root];
      for (const segment of path.split(".")) {
        const next: unknown[] = [];
        for (const cursor of cursors) candidatesFor(root, cursor, segment, next);
        cursors = next;
      }
      const allowed: string[] = [];
      for (const cursor of cursors) gatherEnums(root, cursor, allowed);
      if (allowed.length > 0) rules.push({ path, allowed });
    }
    table[source.method] = rules;
  }
  return table;
}

export const HANG_VERSION = "__hang__";
export const FAIL_VERSION = "__fail__";

export const DEFAULT_FAKE_CODEX_VERSION = "0.146.0";
export const DEFAULT_FAKE_CODEX_SCRIPT = "handshake-only";

export interface FakeCodexOptions {
  version?: string;
  script?: string;
  scriptSequence?: readonly string[];
}

export interface FakeCodex {
  dir: string;
  binaryPath: string;
  scriptsDir: string;
  setVersion(version: string): Promise<void>;
  setScript(script: string): Promise<void>;
  setScriptSequence(scripts: readonly string[]): Promise<void>;
  spawnCount(): Promise<number>;
  readArgv(index?: number): Promise<string[]>;
  readEnv(index?: number): Promise<Record<string, string>>;
  readFramesIn(index?: number): Promise<Array<Record<string, unknown>>>;
  readReplies(index?: number): Promise<Array<Record<string, unknown>>>;
  cleanup(): Promise<void>;
}

function stubSource(
  dir: string,
  scriptsDir: string,
  enumRules: Record<string, FakeCodexEnumRule[]>,
): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const STUB_DIR = ${JSON.stringify(dir)};
const SCRIPTS_DIR = ${JSON.stringify(scriptsDir)};
const WIRE_ENUMS = ${JSON.stringify(enumRules)};
const argv = process.argv.slice(2);

function readPointer(name, fallback) {
  try {
    return fs.readFileSync(path.join(STUB_DIR, name), "utf8").trim();
  } catch {
    return fallback;
  }
}

function hangForever() {
  setInterval(() => {}, 60000);
}

function claimSpawnIndex() {
  const current = Number.parseInt(readPointer("spawns", "0"), 10);
  const index = Number.isFinite(current) ? current : 0;
  fs.writeFileSync(path.join(STUB_DIR, "spawns"), String(index + 1));
  return index;
}

if (argv.includes("--version")) {
  const version = readPointer("version", ${JSON.stringify(DEFAULT_FAKE_CODEX_VERSION)});
  if (version === ${JSON.stringify(HANG_VERSION)}) {
    hangForever();
  } else if (version === ${JSON.stringify(FAIL_VERSION)}) {
    process.stderr.write(
      "codex: fatal: startup failed (env keys: " + Object.keys(process.env).sort().join(",") + ")\\n",
    );
    process.exit(3);
  } else {
    const index = claimSpawnIndex();
    fs.writeFileSync(path.join(STUB_DIR, "argv." + index), argv.map((a) => a + "\\n").join(""));
    fs.writeFileSync(path.join(STUB_DIR, "env." + index + ".json"), JSON.stringify(process.env, null, 2));
    process.stdout.write("codex-cli " + version + "\\n");
    process.exit(0);
  }
} else {
  const index = claimSpawnIndex();
  const framesInPath = path.join(STUB_DIR, "frames-in." + index + ".ndjson");
  const repliesPath = path.join(STUB_DIR, "replies." + index + ".ndjson");
  fs.writeFileSync(path.join(STUB_DIR, "argv." + index), argv.map((a) => a + "\\n").join(""));
  fs.writeFileSync(path.join(STUB_DIR, "env." + index + ".json"), JSON.stringify(process.env, null, 2));
  fs.writeFileSync(framesInPath, "");
  fs.writeFileSync(repliesPath, "");

  const sequenceRaw = process.env.FAKE_CODEX_SCRIPT_SEQUENCE || readPointer("script-sequence", "");
  const sequence = sequenceRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const scriptName =
    sequence.length > 0
      ? sequence[Math.min(index, sequence.length - 1)]
      : process.env.FAKE_CODEX_SCRIPT || readPointer("script", ${JSON.stringify(DEFAULT_FAKE_CODEX_SCRIPT)});

  let raw;
  try {
    raw = fs.readFileSync(path.join(SCRIPTS_DIR, scriptName + ".ndjson"), "utf8");
  } catch {
    process.stderr.write("fake-codex: unknown script " + scriptName + "\\n");
    process.exit(66);
  }

  const startup = [];
  const handlers = new Map();
  for (const line of raw.split("\\n")) {
    if (line.trim().length === 0) continue;
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object" && typeof parsed.__on === "string") {
      const existing = handlers.get(parsed.__on) || [];
      handlers.set(parsed.__on, existing.concat(parsed.emit || []));
      continue;
    }
    startup.push(parsed);
  }

  let serverRequestId = 1000;
  let ignoreStdinEnd = false;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const overrides = new Map();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "-c") continue;
    const raw = argv[i + 1] || "";
    const eq = raw.indexOf("=");
    if (eq > 0) overrides.set(raw.slice(0, eq), raw.slice(eq + 1));
  }
  const unquote = (value) =>
    typeof value === "string" && value.length > 1 && value.startsWith('"') && value.endsWith('"')
      ? value.slice(1, -1)
      : value;
  const substitute = (text) => {
    let out = text;
    const tools = overrides.get("mcp_servers.enduragent.enabled_tools");
    if (out.includes('"__MCP_TOOLS__"')) {
      out = out.split('"__MCP_TOOLS__"').join(tools === undefined ? "[]" : tools);
    }
    if (out.includes('"__MCP_APPROVAL__"')) {
      const approval = overrides.get("mcp_servers.enduragent.default_tools_approval_mode");
      out = out.split('"__MCP_APPROVAL__"').join(approval === undefined ? "null" : approval);
    }
    if (out.includes("__MCP_URL__")) {
      out = out.split("__MCP_URL__").join(overrides.get("mcp_servers.enduragent.url") || "");
    }
    if (out.includes("__MCP_BEARER_ENV__")) {
      out = out
        .split("__MCP_BEARER_ENV__")
        .join(unquote(overrides.get("mcp_servers.enduragent.bearer_token_env_var")) || "");
    }
    return out;
  };

  const emitLine = (text) => {
    process.stdout.write(substitute(text) + "\\n");
  };

  const valuesAtPath = (params, segments) => {
    let cursors = [params];
    for (const segment of segments) {
      const next = [];
      for (const cursor of cursors) {
        if (Array.isArray(cursor)) {
          for (const item of cursor) {
            if (item && typeof item === "object" && item[segment] !== undefined) {
              next.push(item[segment]);
            }
          }
          continue;
        }
        if (cursor && typeof cursor === "object" && cursor[segment] !== undefined) {
          next.push(cursor[segment]);
        }
      }
      cursors = next;
    }
    const out = [];
    for (const cursor of cursors) {
      if (Array.isArray(cursor)) out.push(...cursor.filter((v) => typeof v === "string"));
      else if (typeof cursor === "string") out.push(cursor);
    }
    return out;
  };

  const unknownVariant = (params, method) => {
    const rules = WIRE_ENUMS[method] || [];
    for (const rule of rules) {
      for (const value of valuesAtPath(params, rule.path.split("."))) {
        if (rule.allowed.includes(value)) continue;
        const expected = rule.allowed.map((a) => "\`" + a + "\`").join(", ");
        return "Invalid request: unknown variant \`" + value + "\`, expected one of " + expected;
      }
    }
    return null;
  };

  async function emitOne(spec, inboundId) {
    if (spec === null || typeof spec !== "object") {
      emitLine(JSON.stringify(spec));
      return;
    }
    if (typeof spec.__raw === "string") {
      emitLine(spec.__raw);
      return;
    }
    if (typeof spec.__stderr === "string") {
      process.stderr.write(spec.__stderr + "\\n");
      return;
    }
    if (typeof spec.__control === "string") {
      if (spec.__control === "sleep") await sleep(spec.ms || 0);
      else if (spec.__control === "exit") process.exit(spec.code || 0);
      else if (spec.__control === "hang") hangForever();
      else if (spec.__control === "ignoreStdinEnd") {
        ignoreStdinEnd = true;
        hangForever();
      }
      return;
    }
    if (spec.__request && typeof spec.__request === "object") {
      serverRequestId += 1;
      const message = { id: serverRequestId, method: spec.__request.method };
      if (spec.__request.params !== undefined) message.params = spec.__request.params;
      emitLine(JSON.stringify(message));
      return;
    }
    if (spec.__result === true) {
      const id = spec.__idAs === "string" ? String(inboundId) : inboundId;
      const message = { id };
      if (spec.error !== undefined) message.error = spec.error;
      else message.result = spec.result === undefined ? {} : spec.result;
      emitLine(JSON.stringify(message));
      return;
    }
    emitLine(JSON.stringify(spec));
  }

  async function emitAll(specs, inboundId) {
    for (const spec of specs) await emitOne(spec, inboundId);
  }

  let chain = emitAll(startup, null);

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\\n");
      if (line.trim().length === 0) continue;
      fs.appendFileSync(framesInPath, line + "\\n");
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = null;
      }
      if (parsed === null || typeof parsed !== "object") continue;
      if (parsed.id !== undefined && parsed.method === undefined) {
        fs.appendFileSync(repliesPath, line + "\\n");
        continue;
      }
      if (typeof parsed.method !== "string") continue;
      const inboundId = parsed.id === undefined ? null : parsed.id;
      const violation = unknownVariant(parsed.params, parsed.method);
      if (violation !== null && inboundId !== null) {
        const frame = { id: inboundId, error: { code: -32600, message: violation } };
        chain = chain.then(() => emitLine(JSON.stringify(frame)));
        continue;
      }
      const specs = handlers.get(parsed.method);
      if (specs === undefined) continue;
      chain = chain.then(() => emitAll(specs, inboundId));
    }
  });
  process.stdin.on("end", () => {
    if (ignoreStdinEnd) return;
    chain.then(() => process.exit(0)).catch(() => process.exit(0));
  });
}
`;
}

export async function createFakeCodex(options: FakeCodexOptions = {}): Promise<FakeCodex> {
  const dir = await mkdtemp(join(tmpdir(), "fake-codex-"));
  const binaryPath = join(dir, "fake-codex");
  const enumRules = await readVendoredEnumRules();
  await writeFile(binaryPath, stubSource(dir, FAKE_CODEX_SCRIPTS_DIR, enumRules), { mode: 0o755 });
  await writeFile(join(dir, "version"), options.version ?? DEFAULT_FAKE_CODEX_VERSION);
  await writeFile(join(dir, "script"), options.script ?? DEFAULT_FAKE_CODEX_SCRIPT);
  await writeFile(join(dir, "script-sequence"), (options.scriptSequence ?? []).join(","));
  await writeFile(join(dir, "spawns"), "0");

  const readLines = async (name: string): Promise<Array<Record<string, unknown>>> => {
    let raw: string;
    try {
      raw = await readFile(join(dir, name), "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  return {
    dir,
    binaryPath,
    scriptsDir: FAKE_CODEX_SCRIPTS_DIR,
    setVersion: async (version: string) => {
      await writeFile(join(dir, "version"), version);
    },
    setScript: async (script: string) => {
      await writeFile(join(dir, "script"), script);
    },
    setScriptSequence: async (scripts: readonly string[]) => {
      await writeFile(join(dir, "script-sequence"), scripts.join(","));
    },
    spawnCount: async () => {
      const raw = await readFile(join(dir, "spawns"), "utf8");
      return Number.parseInt(raw.trim(), 10);
    },
    readArgv: async (index = 0) => {
      const raw = await readFile(join(dir, `argv.${index}`), "utf8");
      return raw.split("\n").slice(0, -1);
    },
    readEnv: async (index = 0) => {
      const raw = await readFile(join(dir, `env.${index}.json`), "utf8");
      return JSON.parse(raw) as Record<string, string>;
    },
    readFramesIn: async (index = 0) => await readLines(`frames-in.${index}.ndjson`),
    readReplies: async (index = 0) => await readLines(`replies.${index}.ndjson`),
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
