import type { SecretRef } from "../types.js";
import { spawnCapture, spawnStdin } from "./_spawn.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_VALUE_BYTES = 64 * 1024;

const MULTI_VAULT_RE = /more than one vault|no default vault|--vault required|multiple vaults/i;
const NOT_AN_ITEM_RE = /isn't an item|item.*not found|could not find item/i;

export class OpVaultAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpVaultAmbiguousError";
  }
}

export class SecretTooLargeError extends Error {
  readonly byteLength: number;
  constructor(byteLength: number) {
    super(
      `Secret value is ${byteLength} bytes; max allowed is ${MAX_VALUE_BYTES} bytes.`,
    );
    this.name = "SecretTooLargeError";
    this.byteLength = byteLength;
  }
}

export async function opItemGet(
  opPath: string,
  title: string,
  vaultName?: string,
): Promise<{ exists: false } | { exists: true; vaultName: string }> {
  const args = vaultName
    ? ["item", "get", title, "--vault", vaultName, "--format=json"]
    : ["item", "get", title, "--format=json"];
  const res = await spawnCapture(opPath, args, { timeoutMs: DEFAULT_TIMEOUT_MS });
  if (res.timedOut) {
    throw new Error(`op item get timed out after ${DEFAULT_TIMEOUT_MS}ms.`);
  }
  if (res.exitCode === 0) {
    const parsed = safeParseOpItem(res.stdout);
    if (!parsed) throw new Error("op item get returned non-JSON.");
    return { exists: true, vaultName: parsed.vault.name };
  }
  if (NOT_AN_ITEM_RE.test(res.stderr)) {
    return { exists: false };
  }
  throw new Error(`op item get failed: ${res.stderr.slice(-200).trim()}`);
}

export async function opItemCreate(
  opPath: string,
  title: string,
  value: string,
  vaultName?: string,
): Promise<{ vaultName: string }> {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > MAX_VALUE_BYTES) {
    throw new SecretTooLargeError(byteLength);
  }

  const template = JSON.stringify({
    title,
    category: "API_CREDENTIAL",
    fields: [
      { id: "credential", type: "CONCEALED", label: "credential", value },
    ],
  });

  const args = vaultName
    ? ["item", "create", "-", "--format=json", "--vault", vaultName]
    : ["item", "create", "-", "--format=json"];
  const res = await spawnStdin(opPath, args, template, { timeoutMs: DEFAULT_TIMEOUT_MS });

  if (res.timedOut) {
    throw new Error(`op item create timed out after ${DEFAULT_TIMEOUT_MS}ms.`);
  }
  if (res.exitCode !== 0) {
    if (MULTI_VAULT_RE.test(res.stderr)) {
      throw new OpVaultAmbiguousError(
        `1Password could not pick a default vault. stderr: ${res.stderr.slice(-200).trim()}`,
      );
    }
    throw new Error(
      `op item create failed: ${res.stderr.slice(-200).trim()} (template: ${redactTemplateForLog(template)})`,
    );
  }

  const parsed = safeParseOpItem(res.stdout);
  if (!parsed) {
    throw new Error("op item create returned non-JSON.");
  }
  return { vaultName: parsed.vault.name };
}

export async function opItemUpdate(
  opPath: string,
  title: string,
  value: string,
  vaultName: string,
): Promise<void> {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > MAX_VALUE_BYTES) {
    throw new SecretTooLargeError(byteLength);
  }

  const getRes = await spawnCapture(
    opPath,
    ["item", "get", title, "--vault", vaultName, "--format=json"],
    { timeoutMs: DEFAULT_TIMEOUT_MS },
  );
  if (getRes.timedOut) {
    throw new Error(`op item get timed out after ${DEFAULT_TIMEOUT_MS}ms.`);
  }
  if (getRes.exitCode !== 0) {
    throw new Error(`op item get failed: ${getRes.stderr.slice(-200).trim()}`);
  }
  const item = safeParseOpItemForEdit(getRes.stdout);
  if (!item) {
    throw new Error("op item get returned non-JSON.");
  }
  const credField = item.fields.find((f) => f.id === "credential");
  if (!credField) {
    throw new Error(`1Password item "${title}" has no 'credential' field.`);
  }
  credField.value = value;

  const editJson = JSON.stringify(item);
  const editRes = await spawnStdin(
    opPath,
    ["item", "edit", title, "--vault", vaultName, "-"],
    editJson,
    { timeoutMs: DEFAULT_TIMEOUT_MS },
  );
  if (editRes.timedOut) {
    throw new Error(`op item edit timed out after ${DEFAULT_TIMEOUT_MS}ms.`);
  }
  if (editRes.exitCode !== 0) {
    throw new Error(
      `op item edit failed: ${editRes.stderr.slice(-200).trim()} (payload: ${redactTemplateForLog(editJson)})`,
    );
  }
}

export async function opItemDelete(
  opPath: string,
  title: string,
  vaultName: string,
): Promise<{ deleted: boolean }> {
  const res = await spawnCapture(
    opPath,
    ["item", "delete", title, "--vault", vaultName],
    { timeoutMs: DEFAULT_TIMEOUT_MS },
  );
  if (res.timedOut) {
    throw new Error(`op item delete timed out after ${DEFAULT_TIMEOUT_MS}ms.`);
  }
  if (res.exitCode === 0) {
    return { deleted: true };
  }
  if (NOT_AN_ITEM_RE.test(res.stderr)) {
    return { deleted: false };
  }
  throw new Error(`op item delete failed: ${res.stderr.slice(-200).trim()}`);
}

export async function opVaultList(
  opPath: string,
): Promise<Array<{ id: string; name: string }>> {
  const res = await spawnCapture(opPath, ["vault", "list", "--format=json"], {
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  if (res.timedOut) {
    throw new Error(`op vault list timed out after ${DEFAULT_TIMEOUT_MS}ms.`);
  }
  if (res.exitCode !== 0) {
    throw new Error(`op vault list failed: ${res.stderr.slice(-200).trim()}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error("op vault list returned non-JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("op vault list did not return an array.");
  }
  const out: Array<{ id: string; name: string }> = [];
  for (const entry of parsed) {
    if (entry && typeof entry === "object") {
      const e = entry as { id?: unknown; name?: unknown };
      if (typeof e.id === "string" && typeof e.name === "string") {
        out.push({ id: e.id, name: e.name });
      }
    }
  }
  return out;
}

export function opSecretRef(
  title: string,
  opAbsPath: string,
  vaultName: string,
): SecretRef {
  return {
    source: "exec",
    command: opAbsPath,
    args: ["read", `op://${vaultName}/${title}/credential`],
  };
}

export function redactTemplateForLog(templateJson: string): string {
  try {
    const obj = JSON.parse(templateJson) as {
      fields?: Array<{ value?: unknown }>;
    };
    if (obj && Array.isArray(obj.fields)) {
      for (const f of obj.fields) {
        if (f && typeof f === "object") {
          f.value = "<redacted>";
        }
      }
    }
    return JSON.stringify(obj);
  } catch {
    return "<redacted>";
  }
}

type OpItemJson = {
  vault: { name: string };
};

type OpItemForEdit = {
  fields: Array<{ id: string; value: string }>;
} & Record<string, unknown>;

function safeParseOpItem(json: string): OpItemJson | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as { vault?: unknown };
  if (!p.vault || typeof p.vault !== "object") return null;
  const v = p.vault as { name?: unknown };
  if (typeof v.name !== "string") return null;
  return { vault: { name: v.name } };
}

function safeParseOpItemForEdit(json: string): OpItemForEdit | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as { fields?: unknown };
  if (!Array.isArray(p.fields)) return null;
  for (const f of p.fields) {
    if (!f || typeof f !== "object") return null;
    const fo = f as { id?: unknown; value?: unknown };
    if (typeof fo.id !== "string") return null;
    if (fo.value !== undefined && typeof fo.value !== "string") return null;
  }
  return parsed as OpItemForEdit;
}
