import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logDesktopStartupFailure } from "../src/main/startup-failure.js";

const scratchDirectories: string[] = [];

async function scratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "enduragent-desktop-startup-failure-"));
  scratchDirectories.push(path);
  return path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    scratchDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("desktop startup failure", () => {
  it("writes the classified error to the durable app log", async () => {
    const root = await scratch();
    const error = new TypeError("synthetic startup failure");
    error.stack = "TypeError: synthetic startup failure\n    at synthetic-startup.ts:1:1";
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    logDesktopStartupFailure(error, root);

    const lines = (await readFile(join(root, "logs", "log.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "error",
      component: "desktop",
      event: "startup_failed",
      err: {
        name: "TypeError",
        message: "synthetic startup failure",
        stack: error.stack,
      },
    });
  });

  it("logs before the startup dialog gate without changing its flags", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");
    const catchStart = source.indexOf("void runPrimaryDesktop().catch");
    const classifiedLog = source.indexOf("logDesktopStartupFailure(error);", catchStart);
    const dialogGate = source.indexOf(
      "if (!desktopIsClosing && !desktopStartedInBackground && !desktopAcceptanceHidden)",
      catchStart,
    );
    const dialog = source.indexOf("dialog.showErrorBox(unexpectedStartupCopy.title", dialogGate);

    expect(catchStart).toBeGreaterThanOrEqual(0);
    expect(classifiedLog).toBeGreaterThan(catchStart);
    expect(dialogGate).toBeGreaterThan(classifiedLog);
    expect(dialog).toBeGreaterThan(dialogGate);
  });
});
