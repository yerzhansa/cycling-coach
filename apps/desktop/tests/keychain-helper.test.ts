import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KEYCHAIN_CREDENTIAL_SERVICE,
  KEYCHAIN_HELPER_DEADLINE_MS,
  KEYCHAIN_HELPER_MAX_RESPONSE_BYTES,
  KEYCHAIN_KEY_BYTES,
  createKeychainHelperTransport,
  parseKeychainHelperResponse,
  type KeychainHelperSpawn,
} from "../src/main/keychain-helper.js";

const ENCODED_KEY = randomBytes(KEYCHAIN_KEY_BYTES).toString("base64");

const RESPONDER = `
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  let request = null;
  try { request = JSON.parse(data.trim()); } catch {}
  const matched =
    request !== null &&
    request.op === "delete-key" &&
    request.service === ${JSON.stringify(KEYCHAIN_CREDENTIAL_SERVICE)};
  const response = matched
    ? { ok: true, op: "delete-key", deleted: true }
    : { ok: false, code: "unknown" };
  process.stdout.write(JSON.stringify(response) + "\\n");
});
`;

const TRAILING_NOISE = `
process.stdout.write(JSON.stringify({ ok: true, op: "create-key", key: ${JSON.stringify(ENCODED_KEY)} }) + "\\n");
process.stdout.write("diagnostic noise the transport must ignore\\n");
`;

const SILENT = `process.exit(0);`;
const SLEEPER = `setTimeout(() => {}, 30000);`;
const FLOOD = `process.stdout.write("x".repeat(64 * 1024));`;

function nodeSpawn(script: string): KeychainHelperSpawn {
  return () => spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "ignore"] });
}

describe("parseKeychainHelperResponse", () => {
  it("accepts each success shape", () => {
    expect(
      parseKeychainHelperResponse('{"ok":true,"op":"probe","teamIdentifier":"FA494ACVTF"}'),
    ).toEqual({ ok: true, op: "probe", teamIdentifier: "FA494ACVTF" });
    expect(
      parseKeychainHelperResponse(`{"ok":true,"op":"read-key","key":"${ENCODED_KEY}"}`),
    ).toEqual({
      ok: true,
      op: "read-key",
      key: ENCODED_KEY,
    });
    expect(parseKeychainHelperResponse('{"ok":true,"op":"delete-key","deleted":false}')).toEqual({
      ok: true,
      op: "delete-key",
      deleted: false,
    });
  });

  it("accepts every documented error code", () => {
    expect(parseKeychainHelperResponse('{"ok":false,"code":"not-team-signed"}')).toEqual({
      ok: false,
      code: "not-team-signed",
    });
    expect(parseKeychainHelperResponse('{"code":"keychain-locked","ok":false}')).toEqual({
      ok: false,
      code: "keychain-locked",
    });
  });

  it("rejects malformed, unknown-coded, and wrong-sized payloads", () => {
    const unknown = { ok: false, code: "unknown" };
    expect(parseKeychainHelperResponse("")).toEqual(unknown);
    expect(parseKeychainHelperResponse("not json")).toEqual(unknown);
    expect(parseKeychainHelperResponse("[]")).toEqual(unknown);
    expect(parseKeychainHelperResponse('{"ok":false,"code":"teapot"}')).toEqual(unknown);
    expect(parseKeychainHelperResponse('{"ok":true,"op":"probe"}')).toEqual(unknown);
    expect(parseKeychainHelperResponse('{"ok":true,"op":"read-key","key":"short"}')).toEqual(
      unknown,
    );
    expect(parseKeychainHelperResponse('{"ok":true,"op":"unheard-of"}')).toEqual(unknown);
  });
});

describe("createKeychainHelperTransport", () => {
  it("delivers the request line and returns the parsed response", async () => {
    const transport = createKeychainHelperTransport({
      helperPath: join("unused", "keychain-helper"),
      spawnHelper: nodeSpawn(RESPONDER),
    });
    await expect(
      transport.send({ op: "delete-key", service: KEYCHAIN_CREDENTIAL_SERVICE }),
    ).resolves.toEqual({ ok: true, op: "delete-key", deleted: true });
  });

  it("takes the first line and ignores trailing output", async () => {
    const transport = createKeychainHelperTransport({
      helperPath: join("unused", "keychain-helper"),
      spawnHelper: nodeSpawn(TRAILING_NOISE),
    });
    await expect(
      transport.send({ op: "create-key", service: KEYCHAIN_CREDENTIAL_SERVICE }),
    ).resolves.toEqual({ ok: true, op: "create-key", key: ENCODED_KEY });
  });

  it("reports unknown when the helper exits silently", async () => {
    const transport = createKeychainHelperTransport({
      helperPath: join("unused", "keychain-helper"),
      spawnHelper: nodeSpawn(SILENT),
    });
    await expect(
      transport.send({ op: "probe", service: KEYCHAIN_CREDENTIAL_SERVICE }),
    ).resolves.toEqual({
      ok: false,
      code: "unknown",
    });
  });

  it("reports unknown when the helper misses the deadline", async () => {
    const transport = createKeychainHelperTransport({
      helperPath: join("unused", "keychain-helper"),
      deadlineMs: 50,
      spawnHelper: nodeSpawn(SLEEPER),
    });
    await expect(
      transport.send({ op: "probe", service: KEYCHAIN_CREDENTIAL_SERVICE }),
    ).resolves.toEqual({
      ok: false,
      code: "unknown",
    });
  });

  it("reports unknown when the helper floods stdout", async () => {
    const transport = createKeychainHelperTransport({
      helperPath: join("unused", "keychain-helper"),
      maxResponseBytes: 128,
      spawnHelper: nodeSpawn(FLOOD),
    });
    await expect(
      transport.send({ op: "probe", service: KEYCHAIN_CREDENTIAL_SERVICE }),
    ).resolves.toEqual({
      ok: false,
      code: "unknown",
    });
  });

  it("reports unknown when the helper binary is absent", async () => {
    const transport = createKeychainHelperTransport({
      helperPath: join("no", "such", "keychain-helper"),
      deadlineMs: 2_000,
    });
    await expect(
      transport.send({ op: "probe", service: KEYCHAIN_CREDENTIAL_SERVICE }),
    ).resolves.toEqual({
      ok: false,
      code: "unknown",
    });
  });

  it("keeps its default bounds", () => {
    expect(KEYCHAIN_HELPER_DEADLINE_MS).toBe(5_000);
    expect(KEYCHAIN_HELPER_MAX_RESPONSE_BYTES).toBe(8_192);
  });
});
