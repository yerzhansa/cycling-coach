import { describe, expect, it, vi } from "vitest";
import type { OnboardingBridge } from "../src/onboarding/bridge.js";
import { mountOnboarding } from "../src/onboarding/mount.js";
import type { ChatGptLoginResult } from "../src/onboarding/machine.js";
import { createRideImportController } from "../src/ride-import.js";

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  readonly dataset: Record<string, string> = {};
  className = "";
  id = "";
  type = "";
  value = "";
  autocomplete = "";
  htmlFor = "";
  name = "";
  disabled = false;
  checked = false;
  tabIndex = 0;
  parent: FakeElement | null = null;
  private ownText = "";

  constructor(
    readonly tagName: string,
    private readonly owner: FakeDocument,
  ) {}

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children.splice(0);
  }

  get classList(): { contains: (name: string) => boolean } {
    return {
      contains: (name) => this.className.split(/\s+/u).includes(name),
    };
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of this.children) child.parent = null;
    this.ownText = "";
    this.children.splice(0);
    this.append(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  addEventListener(name: string, listener: (event: Record<string, unknown>) => void): void {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name: string, listener: (event: Record<string, unknown>) => void): void {
    this.listeners.get(name)?.delete(listener);
  }

  dispatch(name: string): void {
    if (name === "click" && this.disabled) return;
    const event = { target: this, preventDefault() {} };
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }

  closest(): FakeElement | null {
    return null;
  }

  focus(): void {
    this.owner.activeElement = this;
  }

  remove(): void {
    if (this.parent === null) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }

  private matches(selector: string): boolean {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith(".")) {
      return this.className.split(/\s+/u).includes(selector.slice(1));
    }
    const tag = selector.match(/^[a-z]+/iu)?.[0];
    if (tag !== undefined && this.tagName !== tag.toUpperCase()) return false;
    const type = selector.match(/\[type="([^"]+)"\]/u)?.[1];
    if (type !== undefined && this.type !== type) return false;
    if (selector.includes("[data-slot]") && this.dataset.slot === undefined) return false;
    return tag !== undefined;
  }
}

class FakeDocument {
  readonly body = new FakeElement("BODY", this);
  activeElement: FakeElement | null = null;

  createElement(name: string): FakeElement {
    return new FakeElement(name.toUpperCase(), this);
  }

  createTextNode(value: string): FakeElement {
    const node = new FakeElement("#TEXT", this);
    node.textContent = value;
    return node;
  }
}

function bridge(login: () => Promise<ChatGptLoginResult>): OnboardingBridge & {
  readonly credentialStatuses: ReturnType<typeof vi.fn<OnboardingBridge["credentialStatuses"]>>;
  readonly chatGptStatus: ReturnType<typeof vi.fn<OnboardingBridge["chatGptStatus"]>>;
  readonly chatGptLogin: ReturnType<typeof vi.fn<OnboardingBridge["chatGptLogin"]>>;
  readonly importFiles: ReturnType<typeof vi.fn<OnboardingBridge["importFiles"]>>;
  readonly onDroppedImportFiles: ReturnType<typeof vi.fn<OnboardingBridge["onDroppedImportFiles"]>>;
} {
  const credentialStatuses = vi.fn<OnboardingBridge["credentialStatuses"]>(async () => []);
  const chatGptStatus = vi.fn<OnboardingBridge["chatGptStatus"]>(async () => ({
    state: "configured",
    runtimeReady: true,
  }));
  const chatGptLogin = vi.fn<OnboardingBridge["chatGptLogin"]>(login);
  const importFiles = vi.fn<OnboardingBridge["importFiles"]>(async () => ({
    schemaVersion: 1,
    files: { total: 0, imported: 0, quarantined: 0 },
    changes: {
      rawFilesInserted: 0,
      sourceRecordsInserted: 0,
      sourceRecordsUpdated: 0,
      relinkedSourceRecords: 0,
    },
  }));
  const onDroppedImportFiles = vi.fn<OnboardingBridge["onDroppedImportFiles"]>(() => () => {});
  return {
    credentialStatuses,
    retryFailedCredentials: vi.fn<OnboardingBridge["retryFailedCredentials"]>(async () => []),
    writeCredential: vi.fn<OnboardingBridge["writeCredential"]>(async ({ slot }) => ({
      slot,
      status: "configured",
      runtimeReady: true,
    })),
    chatGptStatus,
    chatGptLogin,
    chooseImportFiles: vi.fn<OnboardingBridge["chooseImportFiles"]>(async () => []),
    onDroppedImportFiles,
    importFiles,
    saveIntake: vi.fn<OnboardingBridge["saveIntake"]>(async () => {}),
  } satisfies OnboardingBridge;
}

function documentBoundary(document: FakeDocument): Document {
  return document as unknown as Document;
}

function elementBoundary(element: FakeElement): HTMLElement {
  return element as unknown as HTMLElement;
}

function buttonWithText(document: FakeDocument, text: string): FakeElement {
  const button = document.body
    .querySelectorAll("button")
    .find((candidate) => candidate.textContent === text);
  if (button === undefined) throw new Error(`Button not found: ${text}`);
  return button;
}

describe("mounted onboarding", () => {
  it("runs configured ChatGPT sign-in again through pending to configured", async () => {
    const document = new FakeDocument();
    let resolveLogin!: (result: ChatGptLoginResult) => void;
    const chatGptLogin = bridge(
      () =>
        new Promise((resolve) => {
          resolveLogin = resolve;
        }),
    );
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: chatGptLogin,
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });
    await controller.open();

    const signInAgain = buttonWithText(document, "Sign in again");
    expect(signInAgain.type).toBe("button");
    expect(signInAgain.disabled).toBe(false);
    signInAgain.dispatch("click");
    signInAgain.dispatch("click");

    expect(chatGptLogin.chatGptLogin).toHaveBeenCalledTimes(1);
    const pending = buttonWithText(document, "Finish signing in in your browser…");
    expect(pending.disabled).toBe(true);
    resolveLogin({ status: "configured", runtimeReady: true });

    await vi.waitFor(() => {
      expect(chatGptLogin.credentialStatuses).toHaveBeenCalledTimes(2);
      expect(chatGptLogin.chatGptStatus).toHaveBeenCalledTimes(2);
      expect(document.body.textContent).toContain("ChatGPT is ready.");
    });
    expect(buttonWithText(document, "Sign in again").disabled).toBe(false);
  });

  it("renders the existing refusal state after configured sign-in is refused", async () => {
    const document = new FakeDocument();
    const chatGptLogin = bridge(async () => ({ status: "refused", reason: "timed-out" }));
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: chatGptLogin,
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });
    await controller.open();

    buttonWithText(document, "Sign in again").dispatch("click");
    await Promise.resolve();
    await Promise.resolve();

    expect(document.body.textContent).toContain(
      "ChatGPT sign-in timed out. Retry when you are ready.",
    );
    expect(buttonWithText(document, "Retry ChatGPT sign-in").disabled).toBe(false);
  });

  it("owns drops only on the training-data step and gates on returned imported counts", async () => {
    const document = new FakeDocument();
    const onboardingBridge = bridge(async () => ({
      status: "configured",
      runtimeReady: true,
    }));
    onboardingBridge.importFiles
      .mockResolvedValueOnce({
        schemaVersion: 1,
        files: { total: 2, imported: 1, quarantined: 1 },
        changes: {
          rawFilesInserted: 1,
          sourceRecordsInserted: 1,
          sourceRecordsUpdated: 0,
          relinkedSourceRecords: 0,
        },
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        files: { total: 2, imported: 0, quarantined: 2 },
        changes: {
          rawFilesInserted: 0,
          sourceRecordsInserted: 0,
          sourceRecordsUpdated: 0,
          relinkedSourceRecords: 0,
        },
      });
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: onboardingBridge,
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });
    await controller.open();
    expect(controller.ownsDroppedImportFiles()).toBe(false);
    expect(onboardingBridge.onDroppedImportFiles).not.toHaveBeenCalled();

    buttonWithText(document, "Continue").dispatch("click");
    await vi.waitFor(() => expect(controller.ownsDroppedImportFiles()).toBe(true));
    controller.importDroppedFiles(["/synthetic/batch.fit"]);
    await vi.waitFor(() => expect(onboardingBridge.importFiles).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(controller.state().importedRideFileCount).toBe(1));
    expect(document.body.textContent).toContain(
      "Local library import: 1 ride file imported. 1 ride file quarantined.",
    );

    controller.importDroppedFiles(["/synthetic/quarantined.fit"]);
    await vi.waitFor(() => expect(onboardingBridge.importFiles).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "Local library import failed. 0 ride files imported. 2 ride files quarantined.",
      ),
    );
    expect(controller.state().importedRideFileCount).toBe(1);
    expect(document.body.textContent).not.toContain("Import completed");

    buttonWithText(document, "Continue").dispatch("click");
    await vi.waitFor(() => expect(controller.state().step).toBe("safety-intake"));
    expect(controller.ownsDroppedImportFiles()).toBe(false);
    controller.importDroppedFiles(["/synthetic/not-owned.fit"]);
    expect(onboardingBridge.importFiles).toHaveBeenCalledTimes(2);
    controller.close();
    expect(controller.ownsDroppedImportFiles()).toBe(false);
    controller.dispose();
  });

  it("does not start a dropped import while the training-data step is submitting", async () => {
    const document = new FakeDocument();
    const onboardingBridge = bridge(async () => ({
      status: "configured",
      runtimeReady: true,
    }));
    let resolveCredential!: (value: { status: "configured"; runtimeReady: true }) => void;
    vi.mocked(onboardingBridge.writeCredential).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCredential = resolve;
        }),
    );
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: onboardingBridge,
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });
    await controller.open();
    buttonWithText(document, "Continue").dispatch("click");
    await vi.waitFor(() => expect(controller.ownsDroppedImportFiles()).toBe(true));
    const intervalsInput = document.body
      .querySelectorAll('input[type="password"][data-slot]')
      .find((input) => input.dataset.slot === "intervals-icu");
    expect(intervalsInput).toBeDefined();
    intervalsInput!.value = "synthetic-key";

    buttonWithText(document, "Continue").dispatch("click");
    await vi.waitFor(() => expect(onboardingBridge.writeCredential).toHaveBeenCalledOnce());
    controller.importDroppedFiles(["/synthetic/during-submit.fit"]);
    expect(onboardingBridge.importFiles).not.toHaveBeenCalled();

    resolveCredential({ status: "configured", runtimeReady: true });
    await vi.waitFor(() => expect(controller.state().busy).toBe(false));
    controller.dispose();
  });

  it("presents resident-routed import outcomes while another onboarding step is open", async () => {
    const document = new FakeDocument();
    const onboardingBridge = bridge(async () => ({
      status: "configured",
      runtimeReady: true,
    }));
    onboardingBridge.importFiles.mockResolvedValue({
      schemaVersion: 1,
      files: { total: 2, imported: 1, quarantined: 1 },
      changes: {
        rawFilesInserted: 1,
        sourceRecordsInserted: 1,
        sourceRecordsUpdated: 0,
        relinkedSourceRecords: 0,
      },
    });
    const presentationChanges = vi.fn();
    const imports = createRideImportController(onboardingBridge);
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: onboardingBridge,
      rideImports: imports,
      onRideImportPresentationChange: presentationChanges,
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });

    await controller.open();
    expect(controller.state().step).toBe("coach-keys");
    expect(presentationChanges).toHaveBeenLastCalledWith(true);
    await imports.importPaths("resident", ["/synthetic/outside-training.fit"]);
    expect(document.body.textContent).toContain(
      "Local library import: 1 ride file imported. 1 ride file quarantined.",
    );

    controller.close();
    expect(presentationChanges).toHaveBeenLastCalledWith(false);
    controller.dispose();
  });
});
