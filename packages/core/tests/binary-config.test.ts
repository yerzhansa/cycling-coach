import { describe, it, expect } from "vitest";
import type { BinaryConfig } from "../src/binary.js";

const testCoachBinary: BinaryConfig = {
  binaryName: "test-coach",
  displayName: "Test Coach",
  dataSubdir: "test",
  keychainPrefix: "test-coach",
  homeEnvVar: "TEST_COACH_HOME",
};

describe("setup helpers under a non-cycling BinaryConfig", () => {
  it("_formatOrphanCleanup uses the binary's keychainPrefix in the security delete-generic-password command", async () => {
    const { _formatOrphanCleanup } = await import("../src/setup.js");
    const out = _formatOrphanCleanup(
      {
        createdThisRun: [
          {
            backend: "keychain",
            field: "llm.api_key",
            title: "llm_api_key",
            keychainPath: "/tmp/test.keychain-db",
            preExistedBeforeWizard: false,
          },
        ],
      },
      testCoachBinary,
    );
    expect(out).toContain('security delete-generic-password -s test-coach -a "llm_api_key"');
    expect(out).not.toContain("cycling-coach");
  });

  it("_formatOrphanCleanup ignores op-backend orphans (vault names are sport-agnostic)", async () => {
    const { _formatOrphanCleanup } = await import("../src/setup.js");
    const out = _formatOrphanCleanup(
      {
        createdThisRun: [
          {
            backend: "op",
            field: "llm.api_key",
            title: "test-coach · llm_api_key",
            vaultName: "Personal",
            opAbsPath: "/usr/local/bin/op",
            preExistedBeforeWizard: false,
          },
        ],
      },
      testCoachBinary,
    );
    // op uses the title verbatim; the binary doesn't influence the command shape, only the
    // title that the wizard uses when creating items (covered by binary.keychainPrefix
    // application elsewhere). This test confirms _formatOrphanCleanup doesn't accidentally
    // inject "cycling-coach" anywhere when the binary is non-cycling.
    expect(out).toContain('op item delete "test-coach · llm_api_key"');
    expect(out).not.toContain("cycling-coach");
  });
});
