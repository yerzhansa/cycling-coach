import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { verifyWindowsAuthenticode } from "../scripts/verify-windows-authenticode.mjs";

const execFileAsync = promisify(execFile);
const scriptDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts");
let temporaryDirectory: string | undefined;
let fixture: {
  readonly fixturePath: string;
  readonly subject: string;
  readonly thumbprint: string;
  readonly timestamped: boolean;
} | undefined;

if (process.platform === "win32") {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "windows-authenticode-fixture-"));
  const result = await execFileAsync("pwsh", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(scriptDirectory, "make-test-signing-cert.ps1"),
    "-OutputDirectory",
    temporaryDirectory,
  ]);
  fixture = JSON.parse(result.stdout);
}

const fixtureTest = fixture !== undefined && !fixture.timestamped ? it.skip : it;

afterAll(async () => {
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== "win32")(
  "Windows-only: needs pwsh, New-SelfSignedCertificate, and a reachable RFC 3161 TSA",
  () => {
    fixtureTest("verifies the generated self-signed and timestamped PE", async () => {
      if (fixture === undefined) throw new TypeError("Windows fixture is unavailable");
      const options = {
        installerPath: fixture.fixturePath,
        expectedPublisherDn: fixture.subject,
        expectedThumbprint: fixture.thumbprint,
        allowSelfSignedTest: true,
        allowMissingSigntool: true,
      };
      await expect(verifyWindowsAuthenticode(options)).resolves.toMatchObject({ ok: true });
      await expect(
        verifyWindowsAuthenticode({ ...options, expectedPublisherDn: "CN=Different Test Publisher" }),
      ).rejects.toThrow("Authenticode publisher mismatch");
      await expect(
        verifyWindowsAuthenticode({ ...options, allowSelfSignedTest: false }),
      ).rejects.toThrow("Authenticode chain is untrusted");
    });
  },
);
