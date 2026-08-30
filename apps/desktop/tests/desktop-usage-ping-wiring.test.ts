import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("desktop usage ping wiring", () => {
  it("starts only after desktop residency and the initial window barrier", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");
    const preferences = source.indexOf("const desktopPreferencesRoot = join(");
    const construction = source.indexOf("const desktopUsagePingController =");
    const residency = source.indexOf("await residency.start();");
    const initialWindow = source.indexOf("const initialWindow =");
    const start = source.indexOf("void desktopUsagePingController?.start();");
    const securitySmoke = source.indexOf("if (securitySmokeMode) {", start);

    expect(preferences).toBeGreaterThan(-1);
    expect(construction).toBeGreaterThan(preferences);
    expect(start).toBeGreaterThan(residency);
    expect(start).toBeGreaterThan(initialWindow);
    expect(securitySmoke).toBeGreaterThan(start);
  });

  it("gates the heartbeat and closes it through centralized shutdown", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");
    const channel = source.indexOf("const desktopUsagePingChannel =");
    const construction = source.indexOf("const desktopUsagePingController =");
    const shutdown = source.indexOf("const shutdown =", construction);
    const block = source.slice(channel, shutdown);
    const close = source.indexOf("desktopUsagePingController?.close();", shutdown);
    const updateClose = source.indexOf("updateController.close();", shutdown);

    expect(block).toContain("desktopUsagePingChannelForPlatform(process.platform)");
    expect(block).toContain("!desktopAcceptanceHidden");
    expect(block).toContain('environment.ENDURAGENT_NO_USAGE_PING !== "1"');
    expect(block).toContain("isOfficialDesktopRelease({");
    expect(block).toContain("securitySmokeMode,");
    expect(block).toContain("request: (url, init) => net.fetch(url, init)");
    expect(close).toBeGreaterThan(shutdown);
    expect(updateClose).toBeGreaterThan(close);
  });
});
