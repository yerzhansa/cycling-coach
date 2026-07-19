import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelfTestRpcResult } from "@enduragent/coach-contract";
import { createPackagedSelfTestOperation } from "../src/packaged-self-test.js";

const roots: string[] = [];

function validResult(): SelfTestRpcResult {
  const digest = "a".repeat(64);
  return {
    schemaVersion: 1,
    type: "self-test-terminal",
    ok: true,
    runtime: { node: "24.18.0", electron: "43.1.1", v8: "15.0" },
    resources: {
      algorithm: "sha256",
      matrixSha256: digest,
      insideAsarSha256: digest,
      extraResourcesSha256: digest,
      byteIdentical: true,
    },
    suites: {
      parity: { cases: 1, passed: 1 },
      differential: { cases: 2, passed: 2 },
    },
  };
}

async function resourceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "packaged-operation-"));
  roots.push(root);
  await mkdir(join(root, "self-test"), { recursive: true });
  await writeFile(join(root, "self-test/self-test-runner.cjs"), "module.exports = {};");
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("packaged self-test operation", () => {
  it("validates the module and emits progress around a schema-valid result", async () => {
    const root = await resourceRoot();
    const runSelfTest = vi.fn(() => validResult());
    const operation = createPackagedSelfTestOperation({
      resourcesPath: () => root,
      loadCommonJsModule: () => ({ runSelfTest }),
    });
    const events: unknown[] = [];
    await expect(operation((event) => events.push(event))).resolves.toEqual(validResult());
    expect(runSelfTest).toHaveBeenCalledWith({ resourcesPath: root });
    expect(events).toEqual([
      { phase: "started", completed: 0, total: 1 },
      { phase: "completed", completed: 1, total: 1 },
    ]);
  });

  it("shares one execution between concurrent callers and clears after settlement", async () => {
    const root = await resourceRoot();
    const runSelfTest = vi.fn(() => validResult());
    const operation = createPackagedSelfTestOperation({
      resourcesPath: () => root,
      loadCommonJsModule: () => ({ runSelfTest }),
    });
    const firstEvents: unknown[] = [];
    const secondEvents: unknown[] = [];
    await Promise.all([
      operation((event) => firstEvents.push(event)),
      operation((event) => secondEvents.push(event)),
    ]);
    expect(runSelfTest).toHaveBeenCalledTimes(1);
    expect(firstEvents).toHaveLength(2);
    expect(secondEvents).toHaveLength(2);
    await operation();
    expect(runSelfTest).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["relative resources", () => "relative", () => ({ runSelfTest: () => validResult() })],
    ["missing export", (root: string) => root, () => ({})],
    [
      "extra export",
      (root: string) => root,
      () => ({ runSelfTest: () => validResult(), extra: true }),
    ],
    ["malformed result", (root: string) => root, () => ({ runSelfTest: () => ({ ok: true }) })],
    [
      "raw failure",
      (root: string) => root,
      () => ({
        runSelfTest: () => {
          throw new Error("synthetic-private-value");
        },
      }),
    ],
  ])("returns a fixed failure for %s", async (_name, resourcesPath, loadCommonJsModule) => {
    const root = await resourceRoot();
    const operation = createPackagedSelfTestOperation({
      resourcesPath: () => resourcesPath(root),
      loadCommonJsModule,
    });
    const result = await operation();
    expect(result).toEqual({
      schemaVersion: 1,
      type: "self-test-terminal",
      ok: false,
      error: { code: "RUNNER_ERROR", message: "packaged self-test failed" },
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-private-value");
  });

  it("rejects a symbolic runner before module loading", async () => {
    const root = await resourceRoot();
    const runner = join(root, "self-test/self-test-runner.cjs");
    await rm(runner);
    await symlink(join(root, "outside.cjs"), runner);
    const loadCommonJsModule = vi.fn();
    const operation = createPackagedSelfTestOperation({
      resourcesPath: () => root,
      loadCommonJsModule,
    });
    await expect(operation()).resolves.toMatchObject({
      ok: false,
      error: { code: "RUNNER_ERROR" },
    });
    expect(loadCommonJsModule).not.toHaveBeenCalled();
  });
});
