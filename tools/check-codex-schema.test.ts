import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CODEX_AUTO_DENIED_METHODS } from "../packages/engine/src/agent/codex-agent/session.js";
import {
  CODEX_AGENT_DIR,
  CODEX_CONSUMED_SHAPES,
  CODEX_RESPONSE_CONTRACT,
  CODEX_WIRE_CONTRACT,
  collectFieldEnums,
  collectStringConstants,
  failClosedFieldNames,
  findCallSiteHits,
  findResponsePayloadHits,
  main,
  resolveFieldPath,
} from "./check-codex-schema.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "codex-schema-gate-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeLaneFile(rel: string, contents: string): string {
  const path = join(tempDir, CODEX_AGENT_DIR, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents, "utf-8");
  return path;
}

function seedSchema(rel: string, schema: unknown): void {
  const path = join(tempDir, CODEX_AGENT_DIR, "schema", rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(schema, null, 2), "utf-8");
}

describe("codex wire contract manifest", () => {
  it("passes against the vendored schema in the repo", () => {
    expect(main([])).toBe(0);
  });

  it("declares every method the plan pins as the stable surface", () => {
    const methods = CODEX_WIRE_CONTRACT.map((entry) => entry.method);
    for (const method of [
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
      "turn/interrupt",
      "account/read",
      "model/list",
      "config/read",
      "config/mcpServer/reload",
    ]) {
      expect(methods).toContain(method);
    }
  });

  it("declares no experimental-only method", () => {
    const methods = [
      ...CODEX_WIRE_CONTRACT.map((entry) => entry.method),
      ...CODEX_CONSUMED_SHAPES.map((entry) => entry.method),
    ];
    for (const forbidden of ["thread/resume", "thread/rollback", "thread/shellCommand"]) {
      expect(methods).not.toContain(forbidden);
    }
  });
});

describe("field path resolution", () => {
  const root = {
    properties: { turn: { $ref: "#/definitions/Turn" } },
    definitions: {
      Turn: {
        properties: { status: { type: "string" }, error: { $ref: "#/definitions/Err" } },
      },
      Err: { anyOf: [{ properties: { message: { type: "string" } } }, { type: "null" }] },
    },
  };

  it("follows $ref chains", () => {
    expect(resolveFieldPath(root, "turn.status")).toBe(true);
  });

  it("follows nullable anyOf branches", () => {
    expect(resolveFieldPath(root, "turn.error.message")).toBe(true);
  });

  it("rejects an absent leaf", () => {
    expect(resolveFieldPath(root, "turn.error.reason")).toBe(false);
  });

  it("returns null for a field with no enum constraint", () => {
    expect(collectFieldEnums(root, "turn.status")).toBeNull();
  });
});

describe("vendored enum values", () => {
  it("pins thread/start sandbox to the kebab SandboxMode spelling", () => {
    const entry = CODEX_WIRE_CONTRACT.find((item) => item.method === "thread/start");
    expect(entry?.values?.sandbox).toBe("read-only");
  });

  it("pins turn/start sandboxPolicy.type to the camel SandboxPolicy tag", () => {
    const entry = CODEX_WIRE_CONTRACT.find((item) => item.method === "turn/start");
    expect(entry?.values?.["sandboxPolicy.type"]).toBe("readOnly");
  });
});

const FULL_TURN_START_PINS = [
  `input: [{ type: "text", text: "hi" }]`,
  `approvalPolicy: "never"`,
  `approvalsReviewer: "user"`,
  `sandboxPolicy: { type: "readOnly" }`,
].join(", ");

function seedTurnStartSchema(): void {
  seedSchema("v2/TurnStartParams.json", {
    properties: {
      threadId: { type: "string" },
      effort: { type: "string" },
      approvalPolicy: { type: "string" },
      approvalsReviewer: { type: "string" },
      sandboxPolicy: { properties: { type: { type: "string" } } },
      input: {
        items: { properties: { type: { type: "string" }, text: { type: "string" } } },
        type: "array",
      },
    },
  });
}

function turnStartCall(members: string): string {
  return `export const go = (c: any) => c.request("turn/start", { threadId: "t", ${members} });\n`;
}

describe("lane constant resolution", () => {
  it("drops a name the scanned set declares more than once", () => {
    const one = writeLaneFile("bridge.ts", `const ONLY = "x";\nconst DUP = "y";\n`);
    expect([...collectStringConstants([one])]).toEqual([
      ["ONLY", "x"],
      ["DUP", "y"],
    ]);

    const two = writeLaneFile("version.ts", `const DUP = "z";\n`);
    const across = collectStringConstants([one, two]);
    expect(across.get("ONLY")).toBe("x");
    expect(across.has("DUP")).toBe(false);
  });

  it("drops a name a non-literal declaration redeclares", () => {
    const file = writeLaneFile(
      "bridge.ts",
      `const DUP = "y";\nexport function build(): string {\n  const DUP = String(process.env.DUP);\n  return DUP;\n}\n`,
    );
    expect(collectStringConstants([file]).has("DUP")).toBe(false);
  });
});

describe("call-site scan", () => {
  it("flags a params field absent from the vendored schema", () => {
    seedSchema("v2/ThreadStartParams.json", { properties: { model: { type: "string" } } });
    const file = writeLaneFile(
      "bridge.ts",
      `export const go = (c: any) => c.request("thread/start", { model: "m", collaborationMode: {} });\n`,
    );
    const hits = findCallSiteHits(tempDir, [file]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.detail).toContain("collaborationMode");
  });

  it("accepts a params field present in the vendored schema", () => {
    seedSchema("v2/ThreadStartParams.json", {
      properties: { model: { type: "string" }, ephemeral: { type: "boolean" } },
    });
    const file = writeLaneFile(
      "bridge.ts",
      `export const go = (c: any) => c.request("thread/start", { model: "m", ephemeral: true });\n`,
    );
    expect(findCallSiteHits(tempDir, [file])).toHaveLength(0);
  });

  it("flags a method outside the wire contract", () => {
    const file = writeLaneFile(
      "bridge.ts",
      `export const go = (c: any) => c.request("thread/resume", { threadId: "t" });\n`,
    );
    const hits = findCallSiteHits(tempDir, [file]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.detail).toContain("thread/resume");
  });

  it("flags a params key on a method whose params must be omitted", () => {
    const file = writeLaneFile(
      "session.ts",
      `export const go = (c: any) => c.notify("initialized", {});\n`,
    );
    const hits = findCallSiteHits(tempDir, [file]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.detail).toContain("no params key");
  });

  it("accepts the paramless initialized notification", () => {
    const file = writeLaneFile(
      "session.ts",
      `export const go = (c: any) => c.notify("initialized");\n`,
    );
    expect(findCallSiteHits(tempDir, [file])).toHaveLength(0);
  });

  it("flags an enum value that is absent from the vendored schema", () => {
    seedSchema("v2/ThreadStartParams.json", {
      properties: { sandbox: { $ref: "#/definitions/SandboxMode" } },
      definitions: { SandboxMode: { enum: ["read-only", "workspace-write"], type: "string" } },
    });
    const file = writeLaneFile(
      "bridge.ts",
      `export const go = (c: any) => c.request("thread/start", { sandbox: "readOnly" });\n`,
    );
    const hits = findCallSiteHits(tempDir, [file]);
    expect(hits.map((hit) => hit.detail).join("\n")).toContain("'sandbox' = 'readOnly'");
  });

  it("resolves a lane constant before checking its enum value", () => {
    seedSchema("v2/ThreadStartParams.json", {
      properties: { sandbox: { $ref: "#/definitions/SandboxMode" } },
      definitions: { SandboxMode: { enum: ["read-only"], type: "string" } },
    });
    const bad = writeLaneFile(
      "bridge.ts",
      `const S = "readOnly";\nexport const go = (c: any) => c.request("thread/start", { sandbox: S });\n`,
    );
    expect(findCallSiteHits(tempDir, [bad]).length).toBeGreaterThan(0);

    const good = writeLaneFile(
      "bridge.ts",
      `const S = "read-only";\nexport const go = (c: any) => c.request("thread/start", { sandbox: S });\n`,
    );
    expect(findCallSiteHits(tempDir, [good])).toHaveLength(0);
  });

  it("checks tagged-union tags across every branch and array elements", () => {
    seedSchema("v2/TurnStartParams.json", {
      properties: {
        sandboxPolicy: { $ref: "#/definitions/SandboxPolicy" },
        input: { items: { $ref: "#/definitions/UserInput" }, type: "array" },
      },
      definitions: {
        SandboxPolicy: {
          oneOf: [
            { properties: { type: { enum: ["dangerFullAccess"] } } },
            { properties: { type: { enum: ["readOnly"] } } },
          ],
        },
        UserInput: {
          oneOf: [
            { properties: { type: { enum: ["text"] }, text: { type: "string" } } },
            { properties: { type: { enum: ["image"] }, url: { type: "string" } } },
          ],
        },
      },
    });
    const good = writeLaneFile(
      "bridge.ts",
      `export const go = (c: any) => c.request("turn/start", { sandboxPolicy: { type: "readOnly" }, input: [{ type: "text", text: "hi" }] });\n`,
    );
    expect(findCallSiteHits(tempDir, [good])).toHaveLength(0);

    const bad = writeLaneFile(
      "bridge.ts",
      `export const go = (c: any) => c.request("turn/start", { sandboxPolicy: { type: "read-only" }, input: [{ type: "audio" }] });\n`,
    );
    const details = findCallSiteHits(tempDir, [bad])
      .map((hit) => hit.detail)
      .join("\n");
    expect(details).toContain("'sandboxPolicy.type' = 'read-only'");
    expect(details).toContain("'input.type' = 'audio'");
  });

  it("reads a conditional spread of object literals but refuses an opaque one", () => {
    seedSchema("v2/TurnStartParams.json", {
      properties: { threadId: { type: "string" }, effort: { type: "string" } },
    });
    const good = writeLaneFile(
      "bridge.ts",
      `const effort: string | undefined = undefined;\nexport const go = (c: any) => c.request("turn/start", { threadId: "t", ...(effort === undefined ? {} : { effort }) });\n`,
    );
    expect(findCallSiteHits(tempDir, [good])).toHaveLength(0);

    const bad = writeLaneFile(
      "bridge.ts",
      `declare const OVERRIDE: Record<string, unknown>;\nexport const go = (c: any) => c.request("turn/start", { threadId: "t", ...OVERRIDE });\n`,
    );
    const details = findCallSiteHits(tempDir, [bad])
      .map((hit) => hit.detail)
      .join("\n");
    expect(details).toContain("params has a member the schema gate cannot read");
    expect(details).toContain("SpreadAssignment '...OVERRIDE'");
  });

  it("flags a params field smuggled in through a conditional spread", () => {
    seedSchema("v2/TurnStartParams.json", { properties: { threadId: { type: "string" } } });
    const file = writeLaneFile(
      "bridge.ts",
      `const on = true;\nexport const go = (c: any) => c.request("turn/start", { threadId: "t", ...(on ? { dangerFullAccess: true } : {}) });\n`,
    );
    const hits = findCallSiteHits(tempDir, [file]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.detail).toContain("dangerFullAccess");
  });

  it("resolves a computed params key but refuses one it cannot resolve", () => {
    seedSchema("v2/ThreadStartParams.json", { properties: { model: { type: "string" } } });
    const good = writeLaneFile(
      "bridge.ts",
      `const KEY = "model";\nexport const go = (c: any) => c.request("thread/start", { [KEY]: "m" });\n`,
    );
    expect(findCallSiteHits(tempDir, [good])).toHaveLength(0);

    const resolved = writeLaneFile(
      "bridge.ts",
      `const KEY = "collaborationMode";\nexport const go = (c: any) => c.request("thread/start", { [KEY]: {} });\n`,
    );
    expect(
      findCallSiteHits(tempDir, [resolved])
        .map((hit) => hit.detail)
        .join("\n"),
    ).toContain("params field 'collaborationMode' is absent from v2/ThreadStartParams.json");

    const opaque = writeLaneFile(
      "bridge.ts",
      `export const go = (c: any, k: string) => c.request("thread/start", { [k]: "m" });\n`,
    );
    const details = findCallSiteHits(tempDir, [opaque])
      .map((hit) => hit.detail)
      .join("\n");
    expect(details).toContain("params has a member the schema gate cannot read");
    expect(details).toContain(`PropertyAssignment '[k]: "m"'`);
  });

  it("requires every pinned value the wire contract declares at the call site", () => {
    seedTurnStartSchema();
    const good = writeLaneFile("bridge.ts", turnStartCall(FULL_TURN_START_PINS));
    expect(findCallSiteHits(tempDir, [good])).toHaveLength(0);

    const dropped = writeLaneFile(
      "bridge.ts",
      turnStartCall(`input: [{ type: "text", text: "hi" }], approvalsReviewer: "user"`),
    );
    const details = findCallSiteHits(tempDir, [dropped])
      .map((hit) => hit.detail)
      .join("\n");
    expect(details).toContain(
      "'turn/start' params omit 'approvalPolicy' = 'never' required by the wire contract",
    );
    expect(details).toContain(
      "'turn/start' params omit 'sandboxPolicy.type' = 'readOnly' required by the wire contract",
    );
  });

  it("leaves a contract field the wire contract pins no value for optional", () => {
    seedTurnStartSchema();
    const withEffort = writeLaneFile(
      "bridge.ts",
      turnStartCall(`effort: "high", ${FULL_TURN_START_PINS}`),
    );
    expect(findCallSiteHits(tempDir, [withEffort])).toHaveLength(0);

    const conditional = writeLaneFile(
      "bridge.ts",
      `const effort: string | undefined = undefined;\n${turnStartCall(
        `...(effort === undefined ? {} : { effort }), ${FULL_TURN_START_PINS}`,
      )}`,
    );
    expect(findCallSiteHits(tempDir, [conditional])).toHaveLength(0);
  });

  it("refuses a pinned value whose constant a later declaration shadows", () => {
    seedSchema("v2/ThreadStartParams.json", { properties: { sandbox: { type: "string" } } });
    const good = writeLaneFile(
      "bridge.ts",
      `const S = "read-only";\nexport const go = (c: any) => c.request("thread/start", { sandbox: S });\n`,
    );
    expect(findCallSiteHits(tempDir, [good])).toHaveLength(0);

    const shadowed = writeLaneFile(
      "bridge.ts",
      `const S = "read-only";\nexport const go = (c: any) => c.request("thread/start", { sandbox: S });\nexport function label(): string {\n  const S = "workspace-write";\n  return S;\n}\n`,
    );
    const details = findCallSiteHits(tempDir, [shadowed])
      .map((hit) => hit.detail)
      .join("\n");
    expect(details).toContain("'thread/start' params set 'sandbox' to a value the gate cannot read");
    expect(details).toContain("the wire contract declares 'read-only'");
  });

  it("refuses a pinned value whose constant a second lane file redeclares", () => {
    seedSchema("v2/ThreadStartParams.json", { properties: { sandbox: { type: "string" } } });
    const caller = writeLaneFile(
      "bridge.ts",
      `const S = "read-only";\nexport const go = (c: any) => c.request("thread/start", { sandbox: S });\n`,
    );
    expect(findCallSiteHits(tempDir, [caller])).toHaveLength(0);

    const other = writeLaneFile("version.ts", `const S = "workspace-write";\nexport const l = S;\n`);
    const details = findCallSiteHits(tempDir, [caller, other])
      .map((hit) => hit.detail)
      .join("\n");
    expect(details).toContain("'thread/start' params set 'sandbox' to a value the gate cannot read");
    expect(details).toContain("the wire contract declares 'read-only'");
  });

  it("descends into nested params objects", () => {
    seedSchema("v1/InitializeParams.json", {
      properties: { capabilities: { properties: { experimentalApi: { type: "boolean" } } } },
    });
    const file = writeLaneFile(
      "session.ts",
      `export const go = (c: any) => c.request("initialize", { capabilities: { experimentalApi: false, wideOpen: true } });\n`,
    );
    const hits = findCallSiteHits(tempDir, [file]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.detail).toContain("capabilities.wideOpen");
  });
});

const DECISION_VARIANTS = ["accept", "acceptForSession", "decline", "cancel"];

const SHIPPED_REPLIES: Readonly<Record<string, string>> = {
  "item/commandExecution/requestApproval": `() => ({ decision: "decline" })`,
  "item/fileChange/requestApproval": `() => ({ decision: "decline" })`,
  "mcpServer/elicitation/request": `() => ({ action: "decline", content: null, _meta: null })`,
  "item/tool/requestUserInput": `() => ({ answers: {} })`,
  "item/permissions/requestApproval": `() => ({ permissions: {}, scope: "turn" })`,
};

function seedResponseSchemas(): void {
  seedSchema("CommandExecutionRequestApprovalResponse.json", {
    properties: { decision: { enum: DECISION_VARIANTS, type: "string" } },
  });
  seedSchema("FileChangeRequestApprovalResponse.json", {
    properties: { decision: { enum: DECISION_VARIANTS, type: "string" } },
  });
  seedSchema("McpServerElicitationRequestResponse.json", {
    properties: {
      action: { enum: ["accept", "decline", "cancel"], type: "string" },
      content: { description: "nullable" },
      _meta: { description: "nullable" },
    },
  });
  seedSchema("ToolRequestUserInputResponse.json", {
    properties: {
      answers: {
        additionalProperties: { properties: { answers: { items: { type: "string" } } } },
        type: "object",
      },
    },
  });
  seedSchema("PermissionsRequestApprovalResponse.json", {
    properties: {
      permissions: {
        properties: {
          network: { properties: { enabled: { type: "boolean" } } },
          fileSystem: { properties: { write: { items: { type: "string" }, type: "array" } } },
        },
        type: "object",
      },
      scope: { allOf: [{ enum: ["turn", "session"], type: "string" }], default: "turn" },
      strictAutoReview: { type: ["boolean", "null"] },
    },
  });
}

function writeReplyMap(overrides: Readonly<Record<string, string | null>> = {}): string {
  const entries = Object.entries({ ...SHIPPED_REPLIES, ...overrides })
    .filter(([, body]) => body !== null)
    .map(([method, body]) => `  ${JSON.stringify(method)}: ${String(body)},`)
    .join("\n");
  return writeLaneFile(
    "session.ts",
    `const AUTO_DENY_PAYLOADS: Readonly<Record<string, () => Record<string, unknown>>> = {\n${entries}\n};\nexport const methods = Object.keys(AUTO_DENY_PAYLOADS);\n`,
  );
}

function replyDetails(overrides: Readonly<Record<string, string | null>> = {}): string {
  return findResponsePayloadHits(tempDir, [writeReplyMap(overrides)])
    .map((hit) => `${hit.where}  ${hit.detail}`)
    .join("\n");
}

describe("auto-reply payload scan", () => {
  beforeEach(() => {
    seedResponseSchemas();
  });

  it("accepts the shipped fail-closed reply map", () => {
    expect(findResponsePayloadHits(tempDir, [writeReplyMap()])).toHaveLength(0);
  });

  it("covers every client-response method the wire contract declares", () => {
    expect(CODEX_RESPONSE_CONTRACT.map((entry) => entry.method).sort()).toEqual(
      Object.keys(SHIPPED_REPLIES).sort(),
    );
  });

  it("answers exactly the client-response methods the shipped lane auto-denies", () => {
    expect([...CODEX_AUTO_DENIED_METHODS].sort()).toEqual(
      CODEX_RESPONSE_CONTRACT.map((entry) => entry.method).sort(),
    );
    expect(Object.keys(SHIPPED_REPLIES).sort()).toEqual([...CODEX_AUTO_DENIED_METHODS].sort());
  });

  it("guards every fail-closed field the client-response contract pins", () => {
    expect([...failClosedFieldNames()].sort()).toEqual([
      "action",
      "answers",
      "decision",
      "permissions",
      "scope",
    ]);
  });

  it("flags a schema-valid decision that contradicts the wire contract", () => {
    const details = replyDetails({
      "item/commandExecution/requestApproval": `() => ({ decision: "accept" })`,
    });
    expect(details).toContain("session.ts");
    expect(details).toContain("'decision' = 'accept'");
    expect(details).toContain("declares 'decline'");
  });

  it("flags a schema-valid elicitation action that contradicts the wire contract", () => {
    const details = replyDetails({
      "mcpServer/elicitation/request": `() => ({ action: "accept", content: null, _meta: null })`,
    });
    expect(details).toContain("'action' = 'accept'");
    expect(details).toContain("declares 'decline'");
  });

  it("flags a schema-valid permission scope that contradicts the wire contract", () => {
    const details = replyDetails({
      "item/permissions/requestApproval": `() => ({ permissions: {}, scope: "session" })`,
    });
    expect(details).toContain("'scope' = 'session'");
    expect(details).toContain("declares 'turn'");
  });

  it("flags a decision value that is absent from the vendored schema", () => {
    const details = replyDetails({
      "item/fileChange/requestApproval": `() => ({ decision: "approve" })`,
    });
    expect(details).toContain("'decision' = 'approve'");
    expect(details).toContain("FileChangeRequestApprovalResponse.json");
  });

  it("resolves a lane constant before comparing the reply to the contract", () => {
    const file = writeLaneFile(
      "session.ts",
      `const DECISION = "accept";\nconst AUTO_DENY_PAYLOADS = {\n  "item/commandExecution/requestApproval": () => ({ decision: DECISION }),\n};\nexport const methods = Object.keys(AUTO_DENY_PAYLOADS);\n`,
    );
    const details = findResponsePayloadHits(tempDir, [file])
      .map((hit) => hit.detail)
      .join("\n");
    expect(details).toContain("'decision' = 'accept'");
    expect(details).toContain("declares 'decline'");
  });

  it("reads a reply payload returned from a block body", () => {
    const details = replyDetails({
      "item/tool/requestUserInput": `() => {\n    return { answers: {} };\n  }`,
    });
    expect(details).toBe("");
  });

  it("refuses a reply payload it cannot read as a literal", () => {
    const details = replyDetails({ "item/fileChange/requestApproval": `buildFileChangeReply` });
    expect(details).toContain("is not a literal object the schema gate can read");
  });

  it("flags a dropped contract field", () => {
    const details = replyDetails({
      "item/permissions/requestApproval": `() => ({ permissions: {} })`,
    });
    expect(details).toContain("omits 'scope' = 'turn' required by the wire contract");
  });

  it("flags a reply field the wire contract does not declare", () => {
    const details = replyDetails({
      "item/permissions/requestApproval": `() => ({ permissions: {}, scope: "turn", strictAutoReview: true })`,
    });
    expect(details).toContain("'strictAutoReview', which the wire contract does not declare");
  });

  it("flags a granted permission nested under the reply", () => {
    expect(replyDetails()).toBe("");
    const details = replyDetails({
      "item/permissions/requestApproval": `() => ({ permissions: { network: { enabled: true }, fileSystem: { write: ["/"] } }, scope: "turn" })`,
    });
    expect(details).toContain(
      "'permissions.network.enabled', which the wire contract does not declare",
    );
    expect(details).toContain(
      "'permissions.fileSystem.write', which the wire contract does not declare",
    );
    expect(details).toContain("requires the empty object '{}'");
  });

  it("requires the granted-permission object to be an empty literal", () => {
    expect(replyDetails()).toBe("");
    const details = replyDetails({
      "item/permissions/requestApproval": `() => ({ permissions: buildGrants(), scope: "turn" })`,
    });
    expect(details).toContain(
      "replies 'permissions' = 'buildGrants()' but the wire contract requires the empty object '{}'",
    );
    expect(details).not.toContain("which the wire contract does not declare");
  });

  it("requires the tool-input answers object to be an empty literal", () => {
    expect(replyDetails()).toBe("");
    const details = replyDetails({
      "item/tool/requestUserInput": `() => ({ answers: { q1: { answers: ["yes"] } } })`,
    });
    expect(details).toContain("requires the empty object '{}'");
    expect(details).toContain("'answers.q1', which the wire contract does not declare");
  });

  it("flags a reply payload member it cannot read as a key/value pair", () => {
    expect(replyDetails()).toBe("");
    const details = replyDetails({
      "item/commandExecution/requestApproval": `() => ({ decision: "decline", ...OVERRIDE })`,
    });
    expect(details).toContain("session.ts");
    expect(details).toContain("reply payload has a member the schema gate cannot read");
    expect(details).toContain("SpreadAssignment '...OVERRIDE'");
  });

  it("flags a reply payload accessor that hides its value from the gate", () => {
    expect(replyDetails()).toBe("");
    const details = replyDetails({
      "item/fileChange/requestApproval": `() => ({ get decision() { return "accept"; } })`,
    });
    expect(details).toContain("reply payload has a member the schema gate cannot read");
    expect(details).toContain("GetAccessor");
    expect(details).toContain("omits 'decision' = 'decline' required by the wire contract");
  });

  it("flags an auto-reply entry for a method the wire contract does not declare", () => {
    expect(replyDetails()).toBe("");
    const details = replyDetails({
      "item/someNewSurface/requestApproval": `() => ({ decision: "accept" })`,
    });
    expect(details).toContain("session.ts");
    expect(details).toContain(
      "the auto-reply payload map answers 'item/someNewSurface/requestApproval', " +
        "which the wire contract does not declare as a client-response method",
    );
  });

  it("flags an auto-reply map member it cannot read as a method key", () => {
    expect(replyDetails()).toBe("");
    const file = writeLaneFile(
      "session.ts",
      `const EXTRA: Record<string, () => Record<string, unknown>> = {};\nconst AUTO_DENY_PAYLOADS = {\n  ...EXTRA,\n  "item/commandExecution/requestApproval": () => ({ decision: "decline" }),\n};\nexport const methods = Object.keys(AUTO_DENY_PAYLOADS);\n`,
    );
    const details = findResponsePayloadHits(tempDir, [file])
      .map((hit) => hit.detail)
      .join("\n");
    expect(details).toContain("the auto-reply payload map has a member the schema gate cannot read");
    expect(details).toContain("SpreadAssignment '...EXTRA'");
  });

  it("flags a fail-closed reply shape built outside the auto-reply map", () => {
    const clean = writeLaneFile(
      "protocol.ts",
      `export const outcome = (m: string) => ({ error: { code: -32601, message: m } });\n`,
    );
    expect(findResponsePayloadHits(tempDir, [clean, writeReplyMap()])).toHaveLength(0);

    const bypass = writeLaneFile(
      "protocol.ts",
      `export const outcome = (m: string) => {\n  if (process.env.CODEX_YOLO === "1") return { result: { decision: "accept" } };\n  return { error: { code: -32601, message: m } };\n};\n`,
    );
    const details = findResponsePayloadHits(tempDir, [bypass, writeReplyMap()])
      .map((hit) => `${hit.where}  ${hit.detail}`)
      .join("\n");
    expect(details).toContain("protocol.ts");
    expect(details).toContain(
      `object literal '{ decision: "accept" }' sets the fail-closed reply field(s) ` +
        `'decision' outside the auto-reply payload map`,
    );
  });

  it("flags a fail-closed reply field hidden behind a computed key", () => {
    const clean = writeLaneFile(
      "protocol.ts",
      `const FIELD = "message";\nexport const outcome = (m: string) => ({ error: { [FIELD]: m } });\n`,
    );
    expect(findResponsePayloadHits(tempDir, [clean, writeReplyMap()])).toHaveLength(0);

    const bypass = writeLaneFile(
      "protocol.ts",
      `const FIELD = "decision";\nexport const outcome = () => ({ result: { [FIELD]: "accept" } });\n`,
    );
    const details = findResponsePayloadHits(tempDir, [bypass, writeReplyMap()])
      .map((hit) => `${hit.where}  ${hit.detail}`)
      .join("\n");
    expect(details).toContain("protocol.ts");
    expect(details).toContain(
      `object literal '{ [FIELD]: "accept" }' sets the fail-closed reply field(s) ` +
        `'decision' outside the auto-reply payload map`,
    );
  });

  it("flags a reply-shaped computed key it cannot resolve", () => {
    const clean = writeLaneFile(
      "protocol.ts",
      `export const outcome = (m: string) => ({ error: { code: -32601, message: m } });\n`,
    );
    expect(findResponsePayloadHits(tempDir, [clean, writeReplyMap()])).toHaveLength(0);

    const bypass = writeLaneFile(
      "protocol.ts",
      `export const outcome = (field: string) => ({ result: { [field]: "accept" } });\n`,
    );
    const details = findResponsePayloadHits(tempDir, [bypass, writeReplyMap()])
      .map((hit) => `${hit.where}  ${hit.detail}`)
      .join("\n");
    expect(details).toContain("protocol.ts");
    expect(details).toContain(
      `object literal '{ [field]: "accept" }' has a computed key the schema gate cannot read: ` +
        `PropertyAssignment '[field]: "accept"'; it may set a fail-closed reply field outside ` +
        `the auto-reply payload map`,
    );
  });

  it("reads a second reply table whose method key is a computed constant", () => {
    const clean = writeLaneFile(
      "protocol.ts",
      `const M = "item/fileChange/requestApproval";\nexport const table = { [M]: () => ({ decision: "decline" }) };\n`,
    );
    expect(findResponsePayloadHits(tempDir, [clean, writeReplyMap()])).toHaveLength(0);

    const bypass = writeLaneFile(
      "protocol.ts",
      `const M = "item/fileChange/requestApproval";\nexport const table = { [M]: () => ({ decision: "accept" }) };\n`,
    );
    const details = findResponsePayloadHits(tempDir, [bypass, writeReplyMap()])
      .map((hit) => `${hit.where}  ${hit.detail}`)
      .join("\n");
    expect(details).toContain("protocol.ts");
    expect(details).toContain(
      `'item/fileChange/requestApproval' replies 'decision' = 'accept' but the wire contract ` +
        `declares 'decline'`,
    );
  });

  it("refuses a reply constant that a second lane file redeclares", () => {
    const map = writeLaneFile(
      "session.ts",
      `const DECISION = "decline";\nconst AUTO_DENY_PAYLOADS = {\n  "item/commandExecution/requestApproval": () => ({ decision: DECISION }),\n};\nexport const methods = Object.keys(AUTO_DENY_PAYLOADS);\n`,
    );
    expect(
      findResponsePayloadHits(tempDir, [map])
        .map((hit) => hit.detail)
        .join("\n"),
    ).not.toContain("'item/commandExecution/requestApproval' reply");

    const other = writeLaneFile("version.ts", `const DECISION = "accept";\nexport const l = DECISION;\n`);
    const details = findResponsePayloadHits(tempDir, [map, other])
      .map((hit) => hit.detail)
      .join("\n");
    expect(details).toContain(
      `'item/commandExecution/requestApproval' reply sets 'decision' to a value the gate ` +
        `cannot read; the wire contract declares 'decline'`,
    );
  });

  it("flags a client-response method with no reply payload in the lane", () => {
    const details = replyDetails({ "item/commandExecution/requestApproval": null });
    expect(details).toContain(
      "no reply payload literal for 'item/commandExecution/requestApproval' was found",
    );
  });

  it("ignores an unrelated object literal", () => {
    const file = writeLaneFile(
      "bridge.ts",
      `export const labels = { "turn/started": "started", "item/completed": "done" };\n`,
    );
    const details = findResponsePayloadHits(tempDir, [file, writeReplyMap()])
      .map((hit) => hit.detail)
      .join("\n");
    expect(details).toBe("");
  });
});
