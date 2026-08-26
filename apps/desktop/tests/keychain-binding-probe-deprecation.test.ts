import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopViteConfig } from "../electron.vite.config.js";

const desktopRoot = resolve(import.meta.dirname, "..");
const probeFlag = "--desktop-keychain-binding-probe";
const originalArgv = process.argv;
const originalNoDeprecation = process.noDeprecation;
const builtMainEntry = resolve(desktopRoot, "out/main/index.js");

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

  it("configures the policy as a dedicated main-process chunk", () => {
    const config = createDesktopViteConfig();
    const output = config.main?.build?.rollupOptions?.output;

    expect(config.main?.build?.rollupOptions?.input).toMatchObject({
      index: resolve(desktopRoot, "src/main/index.ts"),
    });
    expect(output).not.toBeInstanceOf(Array);
    expect(output).toMatchObject({
      manualChunks: {
        "keychain-binding-probe-deprecation": [
          resolve(desktopRoot, "src/main/keychain-binding-probe-deprecation.ts"),
        ],
      },
    });
  });

  it.skipIf(!existsSync(builtMainEntry))(
    "evaluates the policy chunk before the built main-process imports",
    () => {
      const firstLine = readFileSync(builtMainEntry, "utf8").split("\n", 1)[0];
      const guardImport = firstLine.match(
        /^import "(\.\/chunks\/keychain-binding-probe-deprecation-[^"]+\.js)";$/u,
      );

      expect(guardImport).not.toBeNull();
      if (guardImport === null) return;

      const guardChunk = readFileSync(resolve(desktopRoot, "out/main", guardImport[1]), "utf8");
      expect(guardChunk).toContain(`process.argv.includes("${probeFlag}")`);
      expect(guardChunk).toContain("process.noDeprecation = true;");
      expect(guardChunk).not.toMatch(/^\s*import\b/mu);
    },
  );
});
