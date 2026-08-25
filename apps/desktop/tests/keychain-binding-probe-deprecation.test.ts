import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const probeFlag = "--desktop-keychain-binding-probe";
const originalArgv = process.argv;
const originalNoDeprecation = process.noDeprecation;

async function loadProbeDeprecationPolicy(commandLine: readonly string[]): Promise<boolean> {
  process.argv = [...commandLine];
  process.noDeprecation = false;
  vi.resetModules();
  await import("../src/main/keychain-binding-probe-deprecation.js");
  return process.noDeprecation;
}

afterEach(() => {
  process.argv = originalArgv;
  if (originalNoDeprecation === undefined) delete process.noDeprecation;
  else process.noDeprecation = originalNoDeprecation;
  vi.resetModules();
});

describe("keychain binding probe deprecation policy", () => {
  it("disables deprecation output for the backend-selection probe", async () => {
    await expect(loadProbeDeprecationPolicy(["electron", "index.js", probeFlag])).resolves.toBe(
      true,
    );
  });

  it.each([{ arguments_: [] }, { arguments_: [`${probeFlag}-other`] }])(
    "leaves deprecation output enabled without the exact probe flag",
    async ({ arguments_ }) => {
      await expect(
        loadProbeDeprecationPolicy(["electron", "index.js", ...arguments_]),
      ).resolves.toBe(false);
    },
  );

  it("loads the policy before every other main-process import", async () => {
    const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");

    expect(source.split("\n", 1)).toEqual([
      'import "./keychain-binding-probe-deprecation.js";',
    ]);
  });
});
