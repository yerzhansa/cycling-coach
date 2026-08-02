import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CODEX_AGENT_DIR,
  CODEX_CONSUMED_SHAPES,
  CODEX_WIRE_CONTRACT,
  collectFieldEnums,
  findCallSiteHits,
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
