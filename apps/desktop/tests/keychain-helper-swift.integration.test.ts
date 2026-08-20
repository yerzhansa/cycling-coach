import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  KEYCHAIN_CREDENTIAL_SERVICE_DEV,
  createKeychainHelperTransport,
} from "../src/main/keychain-helper.js";

const SWIFT_COMPILE_TIMEOUT_MS = 180_000;

function swiftcAvailable(): boolean {
  if (process.platform !== "darwin") return false;
  const probe = spawnSync("swiftc", ["-version"], { stdio: "ignore" });
  return probe.error === undefined && probe.status === 0;
}

const source = fileURLToPath(new URL("../native/keychain-helper/main.swift", import.meta.url));
let root = "";
let helperPath = "";

describe.skipIf(!swiftcAvailable())("keychain helper binary", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "enduragent-keychain-helper-"));
    helperPath = join(root, "keychain-helper");
    const build = spawnSync("swiftc", [source, "-o", helperPath], { encoding: "utf8" });
    expect(build.status, build.stderr ?? "").toBe(0);
  }, SWIFT_COMPILE_TIMEOUT_MS);

  afterAll(async () => {
    if (root !== "") await rm(root, { recursive: true, force: true });
  });

  it("refuses every operation from a build without the team identity", async () => {
    const transport = createKeychainHelperTransport({ helperPath });
    await expect(
      transport.send({ op: "probe", service: KEYCHAIN_CREDENTIAL_SERVICE_DEV }),
    ).resolves.toEqual({ ok: false, code: "not-team-signed" });
    await expect(
      transport.send({ op: "read-key", service: KEYCHAIN_CREDENTIAL_SERVICE_DEV }),
    ).resolves.toEqual({ ok: false, code: "not-team-signed" });
    await expect(
      transport.send({ op: "create-key", service: KEYCHAIN_CREDENTIAL_SERVICE_DEV }),
    ).resolves.toEqual({ ok: false, code: "not-team-signed" });
    await expect(
      transport.send({ op: "delete-key", service: KEYCHAIN_CREDENTIAL_SERVICE_DEV }),
    ).resolves.toEqual({ ok: false, code: "not-team-signed" });
  });

  it("answers a malformed request line with unknown", async () => {
    const helper = spawnSync(helperPath, { input: "not a request\n", encoding: "utf8" });
    expect(helper.status).toBe(0);
    expect(JSON.parse(helper.stdout.trim())).toEqual({ ok: false, code: "unknown" });
  });
});
