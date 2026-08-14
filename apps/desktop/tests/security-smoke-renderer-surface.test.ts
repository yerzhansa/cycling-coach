import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const mainEntry = new URL("../src/main/index.ts", import.meta.url);
const smokeScript = new URL("../scripts/electron-smoke.mjs", import.meta.url);

describe("desktop security smoke renderer surface", () => {
  it("recognizes only nested app and setup-gate surfaces and rejects both or neither", async () => {
    const source = await readFile(mainEntry, "utf8");
    const start = source.indexOf("const detectRendererSurface = () => {");
    const end = source.indexOf("\n      };", start);
    const detector = source.slice(start, end).replace(/\s+/gu, " ");

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(detector).toContain(
      `document.querySelector('[data-shell="app"] button.sync-chip') !== null`,
    );
    expect(detector).toContain(
      `document.querySelector('[data-shell="gate"] [data-setup-host="gate"]') !== null`,
    );
    expect(detector).toContain("if (appSurface === setupGateSurface) return null;");
    expect(detector).toContain('return appSurface ? "app" : "setup-gate";');
  });

  it("polls for a valid renderer surface after RPC with the existing deadline", async () => {
    const source = await readFile(mainEntry, "utf8");
    const deadline = source.indexOf("const deadline = Date.now() + 5000;");
    const rpcPoll = source.indexOf(
      "while (document.documentElement.dataset.rpc === undefined && Date.now() < deadline)",
      deadline,
    );
    const surfacePoll = source.indexOf(
      "while (rendererSurface === null && Date.now() < deadline)",
      rpcPoll,
    );
    const result = source.indexOf("rendererSurface: rendererResult.rendererSurface", surfacePoll);

    expect(deadline).toBeGreaterThanOrEqual(0);
    expect(rpcPoll).toBeGreaterThan(deadline);
    expect(surfacePoll).toBeGreaterThan(rpcPoll);
    expect(result).toBeGreaterThan(surfacePoll);
    expect(source.slice(deadline, result).match(/Date\.now\(\) \+ 5000/gu)).toHaveLength(1);
  });

  it("waits for the detected surface to paint before capturing its screenshot", async () => {
    const source = await readFile(mainEntry, "utf8");
    const surfacePoll = source.indexOf("while (rendererSurface === null && Date.now() < deadline)");
    const paintBarrier = source.indexOf(
      "requestAnimationFrame(() => requestAnimationFrame(resolve))",
      surfacePoll,
    );
    const rendererReturn = source.indexOf("rendererSurface,", paintBarrier);
    const capture = source.indexOf("webContents.capturePage()", rendererReturn);

    expect(surfacePoll).toBeGreaterThanOrEqual(0);
    expect(paintBarrier).toBeGreaterThan(surfacePoll);
    expect(rendererReturn).toBeGreaterThan(paintBarrier);
    expect(capture).toBeGreaterThan(rendererReturn);
  });

  it("requires the fresh profile to show the setup gate and includes the non-secret summary in failures", async () => {
    const source = await readFile(smokeScript, "utf8");

    expect(source).toContain("rendererSurface: ready.rendererSurface");
    expect(source).toContain('summary.rendererSurface !== "setup-gate"');
    expect(source).toContain("desktop security assertions failed: ${JSON.stringify(summary)}");
  });
});
