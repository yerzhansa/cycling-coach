import { describe, expect, it, vi } from "vitest";
import {
  runMacosGenesisVerifierCli,
  verifyMacosGenesisRelease,
} from "../scripts/verify-macos-genesis-release.mjs";

const artifactDirectory = "/synthetic/release-envelope";
const candidateApplication = "/synthetic/candidate/Enduragent.app";

function output() {
  let value = "";
  return {
    writer: { write: (chunk: string) => (value += chunk) },
    value: () => value,
  };
}

describe("macOS genesis verifier boundary", () => {
  it("delegates exact absolute paths to the canonical verifier", async () => {
    const verified = Object.freeze({ version: "2026.8.1" });
    const verifyEnvelope = vi.fn(async () => verified);

    await expect(
      verifyMacosGenesisRelease(
        { artifactDirectory, candidateApplication },
        { verifyEnvelope: verifyEnvelope as never },
      ),
    ).resolves.toBe(verified);
    expect(verifyEnvelope).toHaveBeenCalledWith(artifactDirectory, candidateApplication);
  });

  it.each([
    [[] as string[]],
    [[artifactDirectory]],
    [[artifactDirectory, candidateApplication, "/synthetic/extra"]],
    [["relative-envelope", candidateApplication]],
    [[artifactDirectory, "relative-candidate.app"]],
  ])("rejects invalid CLI arguments before canonical verification: %j", async (arguments_) => {
    const verifyEnvelope = vi.fn();
    const stdout = output();
    const stderr = output();

    await expect(
      runMacosGenesisVerifierCli(arguments_, {
        verifyEnvelope: verifyEnvelope as never,
        stdout: stdout.writer,
        stderr: stderr.writer,
      }),
    ).resolves.toBe(1);
    expect(verifyEnvelope).not.toHaveBeenCalled();
    expect(stdout.value()).toBe("");
    expect(stderr.value()).toBe("expected absolute genesis artifact and loose candidate paths\n");
  });

  it("reports success without exposing verifier internals", async () => {
    const stdout = output();
    const stderr = output();

    await expect(
      runMacosGenesisVerifierCli([artifactDirectory, candidateApplication], {
        verifyEnvelope: vi.fn(async () => Object.freeze({ version: "2026.8.1" })) as never,
        stdout: stdout.writer,
        stderr: stderr.writer,
      }),
    ).resolves.toBe(0);
    expect(stdout.value()).toBe("macOS genesis release envelope verified\n");
    expect(stderr.value()).toBe("");
  });

  it("sanitizes canonical verifier failures", async () => {
    const stdout = output();
    const stderr = output();
    const privateDiagnostic = `${candidateApplication}: private signing output`;

    await expect(
      runMacosGenesisVerifierCli([artifactDirectory, candidateApplication], {
        verifyEnvelope: vi.fn(async () => {
          throw new Error(privateDiagnostic);
        }) as never,
        stdout: stdout.writer,
        stderr: stderr.writer,
      }),
    ).resolves.toBe(1);
    expect(stdout.value()).toBe("");
    expect(stderr.value()).toBe("macOS genesis release verification failed\n");
    expect(stderr.value()).not.toContain(privateDiagnostic);
  });
});
