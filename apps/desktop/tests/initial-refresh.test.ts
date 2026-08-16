import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createDesktopInitialRefreshCoordinator,
  shouldReleaseInitialRefreshAfterLoadFailure,
} from "../src/main/initial-refresh.js";

function connection(generation: number, port = 45_000 + generation) {
  return {
    generation,
    url: `ws://127.0.0.1:${port}/rpc` as const,
    token: String(generation).repeat(43),
    owner: "app-supervised" as const,
  };
}

function harness() {
  let current = connection(1);
  const retries: Array<() => void> = [];
  const startInitialRefresh = vi.fn(async () => ({ status: "accepted" as const }));
  const reportFailure = vi.fn();
  const coordinator = createDesktopInitialRefreshCoordinator({
    currentConnection: () => current,
    startInitialRefresh,
    reportFailure,
    scheduleRetry: (operation) => retries.push(operation),
  });
  return {
    coordinator,
    startInitialRefresh,
    reportFailure,
    setCurrent(next: ReturnType<typeof connection>) {
      current = next;
    },
    runRetry() {
      const retry = retries.shift();
      if (retry === undefined) throw new Error("Expected a scheduled initial-refresh retry.");
      retry();
    },
  };
}

describe("desktop initial refresh coordinator", () => {
  it("releases only for genuine main-frame load failures", () => {
    expect(shouldReleaseInitialRefreshAfterLoadFailure(-105, true)).toBe(true);
    expect(shouldReleaseInitialRefreshAfterLoadFailure(-3, true)).toBe(false);
    expect(shouldReleaseInitialRefreshAfterLoadFailure(-105, false)).toBe(false);
  });

  it("wires the visible, background, recovery, close, and render-gone barriers in main", () => {
    const source = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
    const initialArm = source.indexOf("initialRefreshCoordinator.arm(initialRefreshConnection)");
    const residencyReady = source.indexOf("await residency.start()", initialArm);
    const backgroundRelease = source.indexOf(
      "void initialRefreshCoordinator.releaseCurrent()",
      residencyReady,
    );
    const initialShow = source.indexOf("await mainWindow.show()", backgroundRelease);
    const serviceManagedRecovery = source.indexOf('if (current.owner !== "app-supervised") {');
    const serviceManagedPrepare = source.indexOf(
      "connectionIpc!.prepareDocumentNavigation",
      serviceManagedRecovery,
    );
    const serviceManagedLoad = source.indexOf(
      "visibleWindow.loadURL(navigationUrl)",
      serviceManagedPrepare,
    );
    const serviceManagedReturn = source.indexOf("return;", serviceManagedLoad);
    const recoveryPrepare = source.indexOf(
      "connectionIpc!.prepareDocumentNavigation(visibleWindow, current.generation)",
      serviceManagedReturn,
    );
    const recoveryArm = source.indexOf("initialRefreshCoordinator.prepareRecovery({");
    const recoveryLoad = source.indexOf("visibleWindow!.loadURL(navigationUrl!)", recoveryArm);
    const windowClose = source.indexOf('created.once("closed"');
    const closeRelease = source.indexOf(
      "void initialRefreshCoordinator.releaseCurrent()",
      windowClose,
    );
    const renderGone = source.indexOf('created.webContents.on("render-process-gone"');
    const goneRelease = source.indexOf(
      "void initialRefreshCoordinator.releaseCurrent()",
      renderGone,
    );
    const failedLoad = source.indexOf('created.webContents.on("did-fail-load"');
    const failedLoadQualification = source.indexOf(
      "connectionIpc?.isCurrentDocumentNavigation(created, failedUrl)",
      failedLoad,
    );
    const failedLoadRelease = source.indexOf(
      "void initialRefreshCoordinator.releaseCurrent()",
      failedLoadQualification,
    );

    expect(initialArm).toBeGreaterThan(-1);
    expect(residencyReady).toBeGreaterThan(initialArm);
    expect(backgroundRelease).toBeGreaterThan(residencyReady);
    expect(initialShow).toBeGreaterThan(backgroundRelease);
    expect(source).not.toContain(".reload()");
    expect(serviceManagedPrepare).toBeGreaterThan(serviceManagedRecovery);
    expect(serviceManagedLoad).toBeGreaterThan(serviceManagedPrepare);
    expect(serviceManagedReturn).toBeGreaterThan(serviceManagedLoad);
    expect(recoveryPrepare).toBeGreaterThan(serviceManagedReturn);
    expect(recoveryArm).toBeGreaterThan(recoveryPrepare);
    expect(recoveryLoad).toBeGreaterThan(recoveryArm);
    expect(closeRelease).toBeGreaterThan(windowClose);
    expect(goneRelease).toBeGreaterThan(renderGone);
    expect(failedLoadQualification).toBeGreaterThan(failedLoad);
    expect(failedLoadRelease).toBeGreaterThan(failedLoadQualification);
  });

  it("keeps an initial visible generation armed until its renderer settles", async () => {
    const test = harness();
    test.coordinator.arm(connection(1));
    expect(test.startInitialRefresh).not.toHaveBeenCalled();

    await test.coordinator.initialSetupStatusSettled(1);
    expect(test.startInitialRefresh).toHaveBeenCalledOnce();
    expect(test.startInitialRefresh).toHaveBeenCalledWith(connection(1));
  });

  it("releases a background generation without a renderer signal", async () => {
    const test = harness();
    test.coordinator.arm(connection(1));
    await test.coordinator.releaseCurrent();
    expect(test.startInitialRefresh).toHaveBeenCalledWith(connection(1));
  });

  it("ignores stale renderer signals and makes duplicate signals idempotent", async () => {
    const test = harness();
    test.coordinator.arm(connection(1));
    await test.coordinator.initialSetupStatusSettled(2);
    expect(test.startInitialRefresh).not.toHaveBeenCalled();

    await Promise.all([
      test.coordinator.initialSetupStatusSettled(1),
      test.coordinator.initialSetupStatusSettled(1),
    ]);
    expect(test.startInitialRefresh).toHaveBeenCalledOnce();
  });

  it("arms a recovered generation before waiting for the reloaded renderer", async () => {
    const test = harness();
    test.coordinator.arm(connection(1));
    await test.coordinator.initialSetupStatusSettled(1);
    const successor = connection(2, 45_010);
    test.setCurrent(successor);
    expect(
      test.coordinator.prepareRecovery({
        current: successor,
        rendererPresent: true,
      }),
    ).toBe("reload-required");

    expect(test.startInitialRefresh).toHaveBeenCalledOnce();
    await test.coordinator.initialSetupStatusSettled(1);
    expect(test.startInitialRefresh).toHaveBeenCalledOnce();
    await test.coordinator.initialSetupStatusSettled(2);
    expect(test.startInitialRefresh).toHaveBeenCalledTimes(2);
    expect(test.startInitialRefresh).toHaveBeenLastCalledWith(successor);
  });

  it("waits for the recovered renderer generation even when the port is unchanged", async () => {
    const samePort = harness();
    samePort.coordinator.arm(connection(1, 45_001));
    const samePortSuccessor = connection(2, 45_001);
    samePort.setCurrent(samePortSuccessor);
    expect(
      samePort.coordinator.prepareRecovery({
        current: samePortSuccessor,
        rendererPresent: true,
      }),
    ).toBe("reload-required");
    expect(samePort.startInitialRefresh).not.toHaveBeenCalled();

    await samePort.coordinator.initialSetupStatusSettled(1);
    expect(samePort.startInitialRefresh).not.toHaveBeenCalled();
    await Promise.all([
      samePort.coordinator.initialSetupStatusSettled(2),
      samePort.coordinator.initialSetupStatusSettled(2),
    ]);
    expect(samePort.startInitialRefresh).toHaveBeenCalledOnce();
    expect(samePort.startInitialRefresh).toHaveBeenCalledWith(samePortSuccessor);
  });

  it("releases recovery immediately when no renderer exists", async () => {
    for (const successor of [connection(2, 45_001), connection(2, 45_010)]) {
      const noRenderer = harness();
      noRenderer.setCurrent(successor);
      expect(
        noRenderer.coordinator.prepareRecovery({
          current: successor,
          rendererPresent: false,
        }),
      ).toBe("released");
      await Promise.resolve();
      expect(noRenderer.startInitialRefresh).toHaveBeenCalledWith(successor);
    }
  });

  it("releases when the current window closes or its render process exits", async () => {
    const close = harness();
    close.coordinator.arm(connection(1));
    await close.coordinator.releaseCurrent();
    expect(close.startInitialRefresh).toHaveBeenCalledOnce();

    const gone = harness();
    gone.coordinator.arm(connection(1));
    await gone.coordinator.releaseCurrent();
    expect(gone.startInitialRefresh).toHaveBeenCalledOnce();
  });

  it("retries a failed release without poisoning the current or a future generation", async () => {
    const test = harness();
    test.startInitialRefresh.mockRejectedValueOnce(new Error("synthetic control failure"));
    test.coordinator.arm(connection(1));
    await test.coordinator.releaseCurrent();
    expect(test.startInitialRefresh).toHaveBeenCalledOnce();
    test.runRetry();
    await vi.waitFor(() => expect(test.startInitialRefresh).toHaveBeenCalledTimes(2));
    expect(test.reportFailure).toHaveBeenCalledOnce();

    const successor = connection(2);
    test.setCurrent(successor);
    test.coordinator.arm(successor);
    await test.coordinator.releaseCurrent();
    expect(test.startInitialRefresh).toHaveBeenCalledTimes(3);
  });
});
