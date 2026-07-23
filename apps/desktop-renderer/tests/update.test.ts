import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  createDesktopUpdateController,
  type DesktopUpdateBridge,
  type DesktopUpdateState,
  type DesktopUpdateView,
} from "../src/update/controller.js";
import { createDesktopUpdateView } from "../src/update/view.js";

function setupController(initial: DesktopUpdateState = { status: "idle" }) {
  let listener: ((state: DesktopUpdateState) => void) | undefined;
  let action: (() => void) | undefined;
  const bridge: DesktopUpdateBridge = {
    getUpdateState: vi.fn<DesktopUpdateBridge["getUpdateState"]>(async () => initial),
    checkForUpdates: vi.fn<DesktopUpdateBridge["checkForUpdates"]>(async () => ({
      status: "current",
    })),
    restartToUpdate: vi.fn<DesktopUpdateBridge["restartToUpdate"]>(async () => ({
      status: "installing",
      version: "2026.7.23",
    })),
    onUpdateState: vi.fn((next) => {
      listener = next;
      return vi.fn();
    }),
  };
  const view: DesktopUpdateView = {
    bind: vi.fn((next) => {
      action = next;
    }),
    render: vi.fn(),
    dispose: vi.fn(),
  };
  const controller = createDesktopUpdateController({ bridge, view });
  return {
    action: () => action?.(),
    bridge,
    controller,
    publish: (state: DesktopUpdateState) => listener?.(state),
    view,
  };
}

describe("desktop update renderer controller", () => {
  it("loads the initial state, checks on demand, and accepts pushed state", async () => {
    const subject = setupController();
    await subject.controller.start();
    expect(subject.view.render).toHaveBeenLastCalledWith({ status: "idle" });
    subject.action();
    await vi.waitFor(() => expect(subject.bridge.checkForUpdates).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(subject.view.render).toHaveBeenLastCalledWith({ status: "current" }),
    );
    subject.publish({ status: "downloading", version: "2026.7.23" });
    expect(subject.view.render).toHaveBeenLastCalledWith({
      status: "downloading",
      version: "2026.7.23",
    });
  });

  it("restarts only from downloaded and ignores actions while busy", async () => {
    const subject = setupController({ status: "checking" });
    await subject.controller.start();
    subject.action();
    expect(subject.bridge.checkForUpdates).not.toHaveBeenCalled();
    expect(subject.bridge.restartToUpdate).not.toHaveBeenCalled();

    subject.publish({ status: "downloaded", version: "2026.7.23" });
    subject.action();
    await vi.waitFor(() => expect(subject.bridge.restartToUpdate).toHaveBeenCalledOnce());
    expect(subject.bridge.checkForUpdates).not.toHaveBeenCalled();
  });

  it("contains rejected diagnostics and disposes its subscription and view", async () => {
    const raw = "Authorization: secret https://private.invalid/feed";
    const subject = setupController();
    vi.mocked(subject.bridge.getUpdateState).mockRejectedValue(new Error(raw));
    await subject.controller.start();
    expect(subject.view.render).toHaveBeenLastCalledWith({ status: "failed", stage: "check" });
    expect(JSON.stringify(vi.mocked(subject.view.render).mock.calls)).not.toContain(raw);
    subject.controller.dispose();
    subject.controller.dispose();
    expect(subject.view.dispose).toHaveBeenCalledOnce();
    subject.publish({ status: "current" });
    expect(subject.view.render).toHaveBeenCalledOnce();
  });
});

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Set<() => void>>();
  parent: FakeElement | undefined;
  className = "";
  disabled = false;
  hidden = false;
  type = "";
  title = "";
  textContent = "";

  constructor(private readonly document: FakeDocument) {}

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.remove();
      node.parent = this;
      this.children.push(node);
    }
  }

  insertBefore(node: FakeElement, before: FakeElement | null): void {
    node.remove();
    node.parent = this;
    const index = before === null ? -1 : this.children.indexOf(before);
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(name: string, listener: () => void): void {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name: string, listener: () => void): void {
    this.listeners.get(name)?.delete(listener);
  }

  click(): void {
    if (this.disabled) return;
    for (const listener of this.listeners.get("click") ?? []) listener();
  }

  focus(): void {
    this.document.activeElement = this;
  }

  remove(): void {
    if (this.parent === undefined) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = undefined;
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null;
  createElement(): FakeElement {
    return new FakeElement(this);
  }
}

describe("desktop update renderer view", () => {
  it("renders a compact accessible action with restart copy only when downloaded", () => {
    const document = new FakeDocument();
    const actionHost = document.createElement();
    const before = document.createElement();
    actionHost.append(before);
    const view = createDesktopUpdateView({
      document: document as never,
      actionHost: actionHost as never,
      before: before as never,
    });
    const root = actionHost.children[0]!;
    const button = root.children[0]!;
    const status = root.children[1]!;
    button.focus();

    const cases: readonly [DesktopUpdateState, string, boolean][] = [
      [{ status: "idle" }, "Check for updates", false],
      [{ status: "checking" }, "Checking…", true],
      [{ status: "current" }, "Check for updates", false],
      [{ status: "downloading", version: "2026.7.23" }, "Downloading…", true],
      [{ status: "downloaded", version: "2026.7.23" }, "Restart to update", false],
      [{ status: "installing", version: "2026.7.23" }, "Restarting…", true],
      [{ status: "failed", stage: "download" }, "Try update again", false],
    ];
    for (const [state, copy, disabled] of cases) {
      view.render(state);
      expect(button.textContent).toBe(copy);
      expect(button.disabled).toBe(disabled);
      expect(document.activeElement).toBe(button);
      expect(status.attributes.get("role")).toBe("status");
      if (state.status === "current") expect(status.textContent).toBe("Enduragent is up to date");
      if (state.status !== "downloaded") expect(button.textContent).not.toBe("Restart to update");
    }
    expect(button.attributes.get("aria-label")).toContain("Try update again");
  });

  it("hides disabled updates, preserves focus, and removes the bound action", () => {
    const document = new FakeDocument();
    const actionHost = document.createElement();
    const view = createDesktopUpdateView({
      document: document as never,
      actionHost: actionHost as never,
    });
    const root = actionHost.children[0]!;
    const button = root.children[0]!;
    const action = vi.fn();
    view.bind(action);
    view.render({ status: "disabled" });
    expect(root.hidden).toBe(true);
    button.click();
    expect(action).not.toHaveBeenCalled();

    view.render({ status: "current" });
    button.focus();
    button.click();
    expect(action).toHaveBeenCalledOnce();
    view.dispose();
    view.dispose();
    expect(actionHost.children).toHaveLength(0);
    button.click();
    expect(action).toHaveBeenCalledOnce();
  });

  it("only applies the inline layout while the update root is visible", async () => {
    const stylesheet = await readFile(new URL("../src/update/styles.css", import.meta.url), "utf8");
    expect(stylesheet).toMatch(/\.desktop-update:not\(\[hidden\]\)\s*\{\s*display:\s*inline-flex;/);
    expect(stylesheet).not.toMatch(/\.desktop-update\s*\{[^}]*\bdisplay\s*:/);
  });
});

describe("desktop update renderer interaction", () => {
  it("keeps a pushed restart action disabled until the active check settles", async () => {
    let publish: (state: DesktopUpdateState) => void = () => undefined;
    let settleCheck!: (state: DesktopUpdateState) => void;
    const pendingCheck = new Promise<DesktopUpdateState>((resolve) => {
      settleCheck = resolve;
    });
    const restartToUpdate = vi.fn<DesktopUpdateBridge["restartToUpdate"]>(async () => ({
      status: "installing",
      version: "2026.7.23",
    }));
    const bridge: DesktopUpdateBridge = {
      getUpdateState: vi.fn<DesktopUpdateBridge["getUpdateState"]>(async () => ({
        status: "idle",
      })),
      checkForUpdates: vi.fn(() => pendingCheck),
      restartToUpdate,
      onUpdateState: vi.fn((listener) => {
        publish = listener;
        return vi.fn();
      }),
    };
    const document = new FakeDocument();
    const actionHost = document.createElement();
    const view = createDesktopUpdateView({
      document: document as never,
      actionHost: actionHost as never,
    });
    const controller = createDesktopUpdateController({ bridge, view });
    const button = actionHost.children[0]!.children[0]!;

    await controller.start();
    button.click();
    await vi.waitFor(() => expect(bridge.checkForUpdates).toHaveBeenCalledOnce());

    publish({ status: "downloaded", version: "2026.7.23" });
    expect(button.textContent).toBe("Restart to update");
    expect(button.disabled).toBe(true);
    button.click();
    expect(restartToUpdate).not.toHaveBeenCalled();

    settleCheck({ status: "current" });
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(button.textContent).toBe("Restart to update");
    button.click();
    button.click();
    await vi.waitFor(() => expect(restartToUpdate).toHaveBeenCalledOnce());

    controller.dispose();
  });
});
