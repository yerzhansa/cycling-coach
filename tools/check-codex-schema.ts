import * as ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TS_EXTS, ext, collectFiles, nonFlagArgs, runGateCli } from "./lint-fs.js";

export const CODEX_AGENT_DIR = "packages/engine/src/agent/codex-agent";
export const CODEX_SCHEMA_DIR = `${CODEX_AGENT_DIR}/schema`;

export interface CodexWireContract {
  readonly method: string;
  readonly direction: "client-request" | "client-notification" | "client-response";
  readonly schema: string | null;
  readonly fields: readonly string[];
  readonly values?: Readonly<Record<string, string>>;
  readonly emptyObjects?: readonly string[];
}

export const CODEX_WIRE_CONTRACT: readonly CodexWireContract[] = [
  {
    method: "initialize",
    direction: "client-request",
    schema: "v1/InitializeParams.json",
    fields: [
      "clientInfo",
      "clientInfo.name",
      "clientInfo.title",
      "clientInfo.version",
      "capabilities",
      "capabilities.experimentalApi",
      "capabilities.requestAttestation",
      "capabilities.optOutNotificationMethods",
    ],
  },
  { method: "initialized", direction: "client-notification", schema: null, fields: [] },
  {
    method: "thread/start",
    direction: "client-request",
    schema: "v2/ThreadStartParams.json",
    fields: [
      "ephemeral",
      "model",
      "developerInstructions",
      "approvalPolicy",
      "approvalsReviewer",
      "sandbox",
    ],
    values: { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "read-only" },
  },
  {
    method: "turn/start",
    direction: "client-request",
    schema: "v2/TurnStartParams.json",
    fields: [
      "threadId",
      "input",
      "input.type",
      "input.text",
      "effort",
      "approvalPolicy",
      "approvalsReviewer",
      "sandboxPolicy",
      "sandboxPolicy.type",
    ],
    values: {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      "sandboxPolicy.type": "readOnly",
      "input.type": "text",
    },
  },
  {
    method: "turn/interrupt",
    direction: "client-request",
    schema: "v2/TurnInterruptParams.json",
    fields: ["threadId", "turnId"],
  },
  {
    method: "account/read",
    direction: "client-request",
    schema: "v2/GetAccountParams.json",
    fields: [],
  },
  {
    method: "model/list",
    direction: "client-request",
    schema: "v2/ModelListParams.json",
    fields: [],
  },
  {
    method: "config/read",
    direction: "client-request",
    schema: "v2/ConfigReadParams.json",
    fields: ["includeLayers"],
  },
  {
    method: "config/mcpServer/reload",
    direction: "client-request",
    schema: null,
    fields: [],
  },
  {
    method: "item/commandExecution/requestApproval",
    direction: "client-response",
    schema: "CommandExecutionRequestApprovalResponse.json",
    fields: ["decision"],
    values: { decision: "decline" },
  },
  {
    method: "item/fileChange/requestApproval",
    direction: "client-response",
    schema: "FileChangeRequestApprovalResponse.json",
    fields: ["decision"],
    values: { decision: "decline" },
  },
  {
    method: "mcpServer/elicitation/request",
    direction: "client-response",
    schema: "McpServerElicitationRequestResponse.json",
    fields: ["action", "content", "_meta"],
    values: { action: "decline" },
  },
  {
    method: "item/tool/requestUserInput",
    direction: "client-response",
    schema: "ToolRequestUserInputResponse.json",
    fields: ["answers"],
    emptyObjects: ["answers"],
  },
  {
    method: "item/permissions/requestApproval",
    direction: "client-response",
    schema: "PermissionsRequestApprovalResponse.json",
    fields: ["permissions", "scope"],
    values: { scope: "turn" },
    emptyObjects: ["permissions"],
  },
];

export interface CodexConsumedShape {
  readonly method: string;
  readonly schema: string;
  readonly fields: readonly string[];
}

export const CODEX_CONSUMED_SHAPES: readonly CodexConsumedShape[] = [
  { method: "<initialize response>", schema: "v1/InitializeResponse.json", fields: ["userAgent"] },
  {
    method: "<thread/start response>",
    schema: "v2/ThreadStartResponse.json",
    fields: ["thread", "thread.id"],
  },
  {
    method: "<turn/start response>",
    schema: "v2/TurnStartResponse.json",
    fields: ["turn", "turn.id"],
  },
  { method: "<turn/interrupt response>", schema: "v2/TurnInterruptResponse.json", fields: [] },
  {
    method: "<account/read response>",
    schema: "v2/GetAccountResponse.json",
    fields: ["account", "requiresOpenaiAuth"],
  },
  { method: "<model/list response>", schema: "v2/ModelListResponse.json", fields: ["data"] },
  { method: "<config/read response>", schema: "v2/ConfigReadResponse.json", fields: ["config"] },
  { method: "thread/started", schema: "v2/ThreadStartedNotification.json", fields: ["thread"] },
  { method: "turn/started", schema: "v2/TurnStartedNotification.json", fields: ["turn"] },
  {
    method: "turn/completed",
    schema: "v2/TurnCompletedNotification.json",
    fields: ["turn", "turn.status", "turn.error"],
  },
  { method: "item/started", schema: "v2/ItemStartedNotification.json", fields: ["item"] },
  { method: "item/completed", schema: "v2/ItemCompletedNotification.json", fields: ["item"] },
  {
    method: "item/agentMessage/delta",
    schema: "v2/AgentMessageDeltaNotification.json",
    fields: ["delta", "itemId"],
  },
  {
    method: "item/reasoning/textDelta",
    schema: "v2/ReasoningTextDeltaNotification.json",
    fields: ["delta"],
  },
  {
    method: "item/reasoning/summaryTextDelta",
    schema: "v2/ReasoningSummaryTextDeltaNotification.json",
    fields: ["delta"],
  },
  {
    method: "item/reasoning/summaryPartAdded",
    schema: "v2/ReasoningSummaryPartAddedNotification.json",
    fields: ["itemId"],
  },
  {
    method: "item/mcpToolCall/progress",
    schema: "v2/McpToolCallProgressNotification.json",
    fields: ["itemId"],
  },
  {
    method: "thread/tokenUsage/updated",
    schema: "v2/ThreadTokenUsageUpdatedNotification.json",
    fields: ["tokenUsage"],
  },
  { method: "error", schema: "v2/ErrorNotification.json", fields: ["error", "willRetry"] },
  {
    method: "<item/commandExecution/requestApproval params>",
    schema: "CommandExecutionRequestApprovalParams.json",
    fields: [],
  },
  {
    method: "<item/fileChange/requestApproval params>",
    schema: "FileChangeRequestApprovalParams.json",
    fields: [],
  },
  {
    method: "<mcpServer/elicitation/request params>",
    schema: "McpServerElicitationRequestParams.json",
    fields: [],
  },
  {
    method: "<item/tool/requestUserInput params>",
    schema: "ToolRequestUserInputParams.json",
    fields: [],
  },
  {
    method: "<item/permissions/requestApproval params>",
    schema: "PermissionsRequestApprovalParams.json",
    fields: [],
  },
];

export interface CodexSchemaHit {
  readonly where: string;
  readonly detail: string;
}

type JsonNode = Record<string, unknown>;

function isNode(value: unknown): value is JsonNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deref(root: JsonNode, node: unknown, depth = 0): JsonNode | null {
  if (!isNode(node)) return null;
  const ref = node.$ref;
  if (typeof ref !== "string" || depth > 16) return node;
  if (!ref.startsWith("#/")) return node;
  let cursor: unknown = root;
  for (const segment of ref.slice(2).split("/")) {
    if (!isNode(cursor)) return null;
    cursor = cursor[segment];
  }
  return deref(root, cursor, depth + 1);
}

function branchesOf(node: JsonNode): unknown[] {
  const out: unknown[] = [];
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branch = node[key];
    if (Array.isArray(branch)) out.push(...branch);
  }
  return out;
}

function propertyOf(root: JsonNode, node: unknown, name: string, depth = 0): unknown {
  const resolved = deref(root, node);
  if (resolved === null || depth > 16) return undefined;
  const properties = resolved.properties;
  if (isNode(properties) && name in properties) return properties[name];
  for (const branch of branchesOf(resolved)) {
    const found = propertyOf(root, branch, name, depth + 1);
    if (found !== undefined) return found;
  }
  const items = resolved.items;
  if (items !== undefined) return propertyOf(root, items, name, depth + 1);
  return undefined;
}

export function resolveFieldPath(root: JsonNode, path: string): boolean {
  let cursor: unknown = root;
  for (const segment of path.split(".")) {
    cursor = propertyOf(root, cursor, segment);
    if (cursor === undefined) return false;
  }
  return true;
}

function propertyCandidates(
  root: JsonNode,
  node: unknown,
  name: string,
  out: unknown[],
  depth = 0,
): void {
  const resolved = deref(root, node);
  if (resolved === null || depth > 16) return;
  const properties = resolved.properties;
  if (isNode(properties) && name in properties) out.push(properties[name]);
  for (const branch of branchesOf(resolved)) propertyCandidates(root, branch, name, out, depth + 1);
  const items = resolved.items;
  if (items !== undefined) propertyCandidates(root, items, name, out, depth + 1);
}

function gatherEnums(root: JsonNode, node: unknown, out: Set<string>, depth = 0): void {
  const resolved = deref(root, node);
  if (resolved === null || depth > 16) return;
  const values = resolved.enum;
  if (Array.isArray(values)) {
    for (const value of values) if (typeof value === "string") out.add(value);
  }
  for (const branch of branchesOf(resolved)) gatherEnums(root, branch, out, depth + 1);
}

export function collectFieldEnums(root: JsonNode, path: string): Set<string> | null {
  let cursors: unknown[] = [root];
  for (const segment of path.split(".")) {
    const next: unknown[] = [];
    for (const cursor of cursors) propertyCandidates(root, cursor, segment, next);
    if (next.length === 0) return null;
    cursors = next;
  }
  const values = new Set<string>();
  for (const cursor of cursors) gatherEnums(root, cursor, values);
  return values.size === 0 ? null : values;
}

function enumViolation(
  schema: JsonNode,
  schemaName: string,
  method: string,
  path: string,
  value: string,
): string | null {
  const allowed = collectFieldEnums(schema, path);
  if (allowed === null || allowed.has(value)) return null;
  const expected = [...allowed].map((entry) => `'${entry}'`).join(", ");
  return (
    `'${method}' sends '${path}' = '${value}', which is not one of ` +
    `${expected} in ${schemaName}`
  );
}

function loadSchema(rootDir: string, relative: string): JsonNode | string {
  const file = join(rootDir, CODEX_SCHEMA_DIR, relative);
  if (!existsSync(file)) return `missing vendored schema ${relative}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return `vendored schema ${relative} is not parseable JSON`;
  }
  if (!isNode(parsed)) return `vendored schema ${relative} is not a JSON object`;
  return parsed;
}

function checkManifest(rootDir: string): CodexSchemaHit[] {
  const hits: CodexSchemaHit[] = [];
  const entries: Array<{
    label: string;
    method: string;
    schema: string | null;
    fields: readonly string[];
    values: Readonly<Record<string, string>>;
  }> = [
    ...CODEX_WIRE_CONTRACT.map((entry) => ({
      label: `${entry.direction} ${entry.method}`,
      method: entry.method,
      schema: entry.schema,
      fields: entry.fields,
      values: entry.values ?? {},
    })),
    ...CODEX_CONSUMED_SHAPES.map((entry) => ({
      label: `consumed ${entry.method}`,
      method: entry.method,
      schema: entry.schema,
      fields: entry.fields,
      values: {},
    })),
  ];
  for (const entry of entries) {
    if (entry.schema === null) {
      if (entry.fields.length > 0) {
        hits.push({ where: entry.label, detail: "declares fields but no schema file" });
      }
      continue;
    }
    const schema = loadSchema(rootDir, entry.schema);
    if (typeof schema === "string") {
      hits.push({ where: entry.label, detail: schema });
      continue;
    }
    for (const field of entry.fields) {
      if (!resolveFieldPath(schema, field)) {
        hits.push({
          where: entry.label,
          detail: `field '${field}' is absent from ${entry.schema}`,
        });
      }
    }
    for (const [path, value] of Object.entries(entry.values)) {
      if (!resolveFieldPath(schema, path)) {
        hits.push({
          where: entry.label,
          detail: `field '${path}' is absent from ${entry.schema}`,
        });
        continue;
      }
      const violation = enumViolation(schema, entry.schema, entry.method, path, value);
      if (violation !== null) hits.push({ where: entry.label, detail: violation });
    }
  }
  for (const entry of CODEX_WIRE_CONTRACT) {
    for (const path of entry.emptyObjects ?? []) {
      if (entry.fields.includes(path)) continue;
      hits.push({
        where: `${entry.direction} ${entry.method}`,
        detail: `requires '${path}' to be an empty object but does not declare it as a field`,
      });
    }
  }
  return hits;
}

function literalText(node: ts.Node): string | null {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

interface CollectedPath {
  readonly path: string;
  readonly value: string | null;
  readonly text: string;
  readonly emptyObject: boolean;
}

interface CollectedMembers {
  readonly paths: CollectedPath[];
  readonly unreadable: string[];
}

function sourceSnippet(node: ts.Node): string {
  const text = node.getText().replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 60)}...` : text;
}

function memberLabel(property: ts.ObjectLiteralElementLike, prefix: string): string {
  const label = `${ts.SyntaxKind[property.kind]} '${sourceSnippet(property)}'`;
  return prefix === "" ? label : `${label} under '${prefix}'`;
}

function spreadObjects(node: ts.Expression): ts.ObjectLiteralExpression[] | null {
  if (ts.isParenthesizedExpression(node)) return spreadObjects(node.expression);
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return spreadObjects(node.expression);
  }
  if (ts.isObjectLiteralExpression(node)) return [node];
  if (ts.isConditionalExpression(node)) {
    const whenTrue = spreadObjects(node.whenTrue);
    const whenFalse = spreadObjects(node.whenFalse);
    if (whenTrue === null || whenFalse === null) return null;
    return [...whenTrue, ...whenFalse];
  }
  return null;
}

function collectObjectPaths(
  node: ts.ObjectLiteralExpression,
  prefix: string,
  out: CollectedMembers,
  constants: ReadonlyMap<string, string>,
): void {
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      const merged = spreadObjects(property.expression);
      if (merged === null) {
        out.unreadable.push(memberLabel(property, prefix));
        continue;
      }
      for (const object of merged) collectObjectPaths(object, prefix, out, constants);
      continue;
    }
    let name: string | null = null;
    if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
      const propertyName = property.name;
      if (ts.isIdentifier(propertyName)) name = propertyName.text;
      else if (ts.isStringLiteralLike(propertyName)) name = propertyName.text;
    }
    if (name === null) {
      out.unreadable.push(memberLabel(property, prefix));
      continue;
    }
    const path = prefix === "" ? name : `${prefix}.${name}`;
    if (!ts.isPropertyAssignment(property)) {
      out.paths.push({ path, value: null, text: sourceSnippet(property), emptyObject: false });
      continue;
    }
    const initializer = property.initializer;
    out.paths.push({
      path,
      value: literalValue(initializer, constants),
      text: sourceSnippet(initializer),
      emptyObject: ts.isObjectLiteralExpression(initializer) && initializer.properties.length === 0,
    });
    if (ts.isObjectLiteralExpression(initializer)) {
      collectObjectPaths(initializer, path, out, constants);
      continue;
    }
    if (ts.isArrayLiteralExpression(initializer)) {
      for (const element of initializer.elements) {
        if (ts.isObjectLiteralExpression(element)) {
          collectObjectPaths(element, path, out, constants);
        }
      }
    }
  }
}

function literalValue(node: ts.Node, constants: ReadonlyMap<string, string>): string | null {
  const direct = literalText(node);
  if (direct !== null) return direct;
  if (ts.isIdentifier(node)) return constants.get(node.text) ?? null;
  return null;
}

export function collectStringConstants(
  files: readonly string[],
  read: (file: string) => string = (file) => readFileSync(file, "utf-8"),
): Map<string, string> {
  const constants = new Map<string, string>();
  for (const file of files) {
    const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.ESNext, true);
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const initializer = node.initializer;
        const text = initializer === undefined ? null : literalText(initializer);
        if (text !== null) constants.set(node.name.text, text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return constants;
}

export function findCallSiteHits(rootDir: string, files: readonly string[]): CodexSchemaHit[] {
  const hits: CodexSchemaHit[] = [];
  const byMethod = new Map(CODEX_WIRE_CONTRACT.map((entry) => [entry.method, entry]));
  const schemaCache = new Map<string, JsonNode | string>();
  const constants = collectStringConstants(files);

  for (const file of files) {
    const source = readFileSync(file, "utf-8");
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const callee = node.expression.name.text;
        if (callee === "request" || callee === "notify") {
          const first = node.arguments[0];
          const method = first === undefined ? null : literalText(first);
          if (method !== null) {
            const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            const where = `${file}:${lc.line + 1}:${lc.character + 1}`;
            const entry = byMethod.get(method);
            if (entry === undefined) {
              hits.push({ where, detail: `method '${method}' is not in the codex wire contract` });
            } else {
              const params = node.arguments[1];
              if (params !== undefined && entry.schema === null) {
                hits.push({
                  where,
                  detail: `method '${method}' must be sent with no params key`,
                });
              } else if (params !== undefined && ts.isObjectLiteralExpression(params)) {
                let schema = schemaCache.get(entry.schema as string);
                if (schema === undefined) {
                  schema = loadSchema(rootDir, entry.schema as string);
                  schemaCache.set(entry.schema as string, schema);
                }
                if (typeof schema === "string") {
                  hits.push({ where, detail: schema });
                } else {
                  const collected: CollectedMembers = { paths: [], unreadable: [] };
                  collectObjectPaths(params, "", collected, constants);
                  for (const label of collected.unreadable) {
                    hits.push({
                      where,
                      detail: `'${method}' params has a member the schema gate cannot read: ${label}`,
                    });
                  }
                  const declared = entry.values ?? {};
                  for (const { path, value } of collected.paths) {
                    if (!resolveFieldPath(schema, path)) {
                      hits.push({
                        where,
                        detail: `'${method}' params field '${path}' is absent from ${entry.schema}`,
                      });
                      continue;
                    }
                    if (value === null) continue;
                    const violation = enumViolation(
                      schema,
                      entry.schema as string,
                      method,
                      path,
                      value,
                    );
                    if (violation !== null) hits.push({ where, detail: violation });
                    const expected = declared[path];
                    if (expected !== undefined && expected !== value) {
                      hits.push({
                        where,
                        detail:
                          `'${method}' sends '${path}' = '${value}' but the wire contract ` +
                          `declares '${expected}'`,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sf);
  }
  return hits;
}

export const CODEX_RESPONSE_CONTRACT: readonly CodexWireContract[] = CODEX_WIRE_CONTRACT.filter(
  (entry) => entry.direction === "client-response",
);

function payloadObjectOf(node: ts.Node): ts.ObjectLiteralExpression | null {
  if (ts.isParenthesizedExpression(node)) return payloadObjectOf(node.expression);
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return payloadObjectOf(node.expression);
  }
  if (ts.isObjectLiteralExpression(node)) return node;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const body = node.body;
    if (!ts.isBlock(body)) return payloadObjectOf(body);
    for (const statement of body.statements) {
      if (ts.isReturnStatement(statement) && statement.expression !== undefined) {
        return payloadObjectOf(statement.expression);
      }
    }
    return null;
  }
  return null;
}

function checkResponsePayload(
  rootDir: string,
  schemaCache: Map<string, JsonNode | string>,
  constants: ReadonlyMap<string, string>,
  entry: CodexWireContract,
  payload: ts.ObjectLiteralExpression | null,
  where: string,
): CodexSchemaHit[] {
  const method = entry.method;
  if (payload === null) {
    return [
      {
        where,
        detail: `'${method}' reply payload is not a literal object the schema gate can read`,
      },
    ];
  }
  const schemaName = entry.schema;
  if (schemaName === null) {
    return [{ where, detail: `'${method}' sends a reply payload but declares no schema file` }];
  }
  let schema = schemaCache.get(schemaName);
  if (schema === undefined) {
    schema = loadSchema(rootDir, schemaName);
    schemaCache.set(schemaName, schema);
  }
  if (typeof schema === "string") return [{ where, detail: schema }];

  const hits: CodexSchemaHit[] = [];
  const collected: CollectedMembers = { paths: [], unreadable: [] };
  collectObjectPaths(payload, "", collected, constants);
  for (const label of collected.unreadable) {
    hits.push({
      where,
      detail: `'${method}' reply payload has a member the schema gate cannot read: ${label}`,
    });
  }
  const declared = entry.values ?? {};
  const sent = new Map<string, CollectedPath>();
  for (const record of collected.paths) sent.set(record.path, record);

  for (const { path, value } of collected.paths) {
    if (!entry.fields.includes(path)) {
      hits.push({
        where,
        detail: `'${method}' replies with '${path}', which the wire contract does not declare`,
      });
    }
    if (!resolveFieldPath(schema, path)) {
      hits.push({
        where,
        detail: `'${method}' reply field '${path}' is absent from ${schemaName}`,
      });
      continue;
    }
    if (value === null) continue;
    const violation = enumViolation(schema, schemaName, method, path, value);
    if (violation !== null) hits.push({ where, detail: violation });
    const expected = declared[path];
    if (expected !== undefined && expected !== value) {
      hits.push({
        where,
        detail:
          `'${method}' replies '${path}' = '${value}' but the wire contract ` +
          `declares '${expected}'`,
      });
    }
  }

  for (const path of entry.emptyObjects ?? []) {
    const record = sent.get(path);
    if (record === undefined || record.emptyObject) continue;
    hits.push({
      where,
      detail:
        `'${method}' replies '${path}' = '${record.text}' but the wire contract ` +
        `requires the empty object '{}'`,
    });
  }

  for (const path of new Set([...entry.fields, ...Object.keys(declared)])) {
    const expected = declared[path];
    const record = sent.get(path);
    if (record === undefined) {
      hits.push({
        where,
        detail:
          expected === undefined
            ? `'${method}' reply omits contract field '${path}'`
            : `'${method}' reply omits '${path}' = '${expected}' required by the wire contract`,
      });
      continue;
    }
    if (expected !== undefined && record.value === null) {
      hits.push({
        where,
        detail:
          `'${method}' reply sets '${path}' to a value the gate cannot read; ` +
          `the wire contract declares '${expected}'`,
      });
    }
  }
  return hits;
}

function replyMapKeyOf(property: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(property)) return null;
  return ts.isStringLiteralLike(property.name) ? property.name.text : null;
}

function isReplyMap(
  node: ts.ObjectLiteralExpression,
  byMethod: ReadonlyMap<string, CodexWireContract>,
): boolean {
  for (const property of node.properties) {
    const key = replyMapKeyOf(property);
    if (key !== null && byMethod.has(key)) return true;
  }
  return false;
}

export function failClosedFieldNames(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const entry of CODEX_RESPONSE_CONTRACT) {
    for (const path of Object.keys(entry.values ?? {})) {
      if (!path.includes(".")) names.add(path);
    }
    for (const path of entry.emptyObjects ?? []) {
      if (!path.includes(".")) names.add(path);
    }
  }
  return names;
}

function failClosedKeysOf(
  node: ts.ObjectLiteralExpression,
  guarded: ReadonlySet<string>,
): string[] {
  const found: string[] = [];
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
    const name = property.name;
    const text = ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
    if (text !== null && guarded.has(text)) found.push(text);
  }
  return found;
}

function withinAny(node: ts.Node, roots: ReadonlySet<ts.Node>): boolean {
  let cursor: ts.Node | undefined = node;
  while (cursor !== undefined) {
    if (roots.has(cursor)) return true;
    cursor = cursor.parent;
  }
  return false;
}

export function findResponsePayloadHits(
  rootDir: string,
  files: readonly string[],
): CodexSchemaHit[] {
  const hits: CodexSchemaHit[] = [];
  const byMethod = new Map(CODEX_RESPONSE_CONTRACT.map((entry) => [entry.method, entry]));
  const schemaCache = new Map<string, JsonNode | string>();
  const constants = collectStringConstants(files);
  const guarded = failClosedFieldNames();
  const seen = new Set<string>();

  for (const file of files) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.ESNext, true);
    const at = (node: ts.Node): string => {
      const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      return `${file}:${lc.line + 1}:${lc.character + 1}`;
    };
    const payloads = new Set<ts.Node>();

    const visitMaps = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node) && isReplyMap(node, byMethod)) {
        for (const property of node.properties) {
          const where = at(property);
          const key = replyMapKeyOf(property);
          if (key === null) {
            hits.push({
              where,
              detail:
                `the auto-reply payload map has a member the schema gate cannot read: ` +
                `${memberLabel(property, "")}`,
            });
            continue;
          }
          const entry = byMethod.get(key);
          if (entry === undefined) {
            hits.push({
              where,
              detail:
                `the auto-reply payload map answers '${key}', which the wire contract does ` +
                `not declare as a client-response method`,
            });
            continue;
          }
          seen.add(entry.method);
          const payload = payloadObjectOf((property as ts.PropertyAssignment).initializer);
          if (payload !== null) payloads.add(payload);
          hits.push(...checkResponsePayload(rootDir, schemaCache, constants, entry, payload, where));
        }
      }
      ts.forEachChild(node, visitMaps);
    };
    visitMaps(sf);

    const visitShapes = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node) && !withinAny(node, payloads)) {
        const keys = failClosedKeysOf(node, guarded);
        if (keys.length > 0) {
          hits.push({
            where: at(node),
            detail:
              `object literal '${sourceSnippet(node)}' sets the fail-closed reply field(s) ` +
              `'${keys.join("', '")}' outside the auto-reply payload map`,
          });
        }
      }
      ts.forEachChild(node, visitShapes);
    };
    visitShapes(sf);
  }

  for (const entry of CODEX_RESPONSE_CONTRACT) {
    if (seen.has(entry.method)) continue;
    hits.push({
      where: `client-response ${entry.method}`,
      detail: `no reply payload literal for '${entry.method}' was found under ${CODEX_AGENT_DIR}`,
    });
  }
  return hits;
}

export function main(argv: readonly string[]): number {
  const args = nonFlagArgs(argv);
  const rootDir = args[0] ?? ".";

  const laneDir = join(rootDir, CODEX_AGENT_DIR);
  if (!existsSync(laneDir)) {
    console.log(`check-codex-schema: ${CODEX_AGENT_DIR} (not present yet)`);
    return 0;
  }

  const files: string[] = [];
  collectFiles(laneDir, files);
  const sources = files.filter((file) => TS_EXTS.has(ext(file)));

  const hits = [
    ...checkManifest(rootDir),
    ...findCallSiteHits(rootDir, sources),
    ...findResponsePayloadHits(rootDir, sources),
  ];
  if (hits.length === 0) {
    console.log(
      `check-codex-schema: ${CODEX_WIRE_CONTRACT.length} wire method(s), ` +
        `${CODEX_CONSUMED_SHAPES.length} consumed shape(s) and ` +
        `${CODEX_RESPONSE_CONTRACT.length} reply payload(s) match the vendored schema ` +
        `across ${sources.length} lane file(s).`,
    );
    return 0;
  }
  console.error(`check-codex-schema: ${hits.length} schema contract violation(s) found:`);
  for (const hit of hits) console.error(`  ${hit.where}  ${hit.detail}`);
  console.error(
    `\nRegenerate the vendored schema per ${CODEX_SCHEMA_DIR}/README.md, stop sending the field, ` +
      `or bring the lane source and CODEX_WIRE_CONTRACT back into agreement.`,
  );
  return 1;
}

runGateCli(import.meta.url, main);
