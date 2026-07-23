import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { OnboardingBridge } from "../src/onboarding/bridge.js";
import { mountOnboarding } from "../src/onboarding/mount.js";

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Set<() => void>>();
  parent: FakeElement | undefined;
  className = "";
  disabled = false;
  hidden = false;
  id = "";
  type = "";
  value = "";
  htmlFor = "";
  tabIndex = 0;
  private ownText = "";

  constructor(
    readonly tagName: string,
    private readonly document: FakeDocument,
  ) {}

  get classList(): { contains(value: string): boolean } {
    return { contains: (value) => this.className.split(/\s+/u).includes(value) };
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children.splice(0);
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const value of nodes) {
      const node = typeof value === "string" ? this.document.createTextNode(value) : value;
      node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: FakeElement[]): void {
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

  addEventListener(name: string, listener: () => void): void {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  dispatch(name: string): void {
    if (name === "click" && this.disabled) return;
    for (const listener of this.listeners.get(name) ?? []) listener();
  }

  click(): void {
    this.dispatch("click");
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

  closest(): null {
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return descendants(this).filter((node) => matches(node, selector));
  }
}

class FakeDocument {
  readonly body = new FakeElement("body", this);
  activeElement: FakeElement | null = null;

  createElement(name: string): FakeElement {
    return new FakeElement(name, this);
  }

  createTextNode(value: string): FakeElement {
    const node = new FakeElement("#text", this);
    node.textContent = value;
    return node;
  }
}

function descendants(root: FakeElement): FakeElement[] {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

function matches(node: FakeElement, selector: string): boolean {
  if (selector.startsWith("#")) return node.id === selector.slice(1);
  if (selector === 'input[type="password"]')
    return node.tagName === "input" && node.type === "password";
  if (selector === 'input[type="password"][data-slot]') {
    return node.tagName === "input" && node.type === "password" && node.dataset.slot !== undefined;
  }
  return node.tagName === selector;
}

function findByText(root: FakeElement, tagName: string, text: string): FakeElement {
  const node = descendants(root).find(
    (entry) => entry.tagName === tagName && entry.textContent === text,
  );
  if (node === undefined) throw new Error("Element not found");
  return node;
}

function selectProvider(root: FakeElement, provider: string): void {
  const select = root.querySelector("#onboarding-llm-provider");
  if (select === null) throw new Error("Provider select not found");
  select.value = provider;
  select.dispatch("change");
}

function providerLaneBadges(root: FakeElement): FakeElement[] {
  return descendants(root).filter(
    (node) =>
      node.className.startsWith("credential-state") &&
      (node.parent?.className === "chatgpt-lane-heading" || node.parent?.tagName === "label"),
  );
}

function activeProviderLanes(root: FakeElement): FakeElement[] {
  return providerLaneBadges(root).filter(
    (node) => node.className === "credential-state configured",
  );
}

function expectOneActiveProvider(root: FakeElement): void {
  expect(providerLaneBadges(root)).toHaveLength(10);
  expect(activeProviderLanes(root)).toHaveLength(1);
}

function createBridge(overrides: Partial<OnboardingBridge>): OnboardingBridge {
  return {
    credentialStatuses: vi.fn(async () => []),
    retryFailedCredentials: vi.fn(async () => []),
    writeCredential: vi.fn(),
    llmConfiguration: vi.fn(async () => ({
      schemaVersion: 1,
      providers: [
        {
          provider: "anthropic",
          defaultModel: "claude-sonnet-4-6",
          models: [{ value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }],
        },
        {
          provider: "openai-codex",
          defaultModel: "gpt-5.5",
          models: [{ value: "gpt-5.5", label: "GPT-5.5" }],
        },
      ],
      active: null,
    })),
    applyLlmSelection: vi.fn(async () => ({ status: "configured", runtimeReady: true })),
    chatGptStatus: vi.fn(async () => ({ state: "absent", runtimeReady: false })),
    chatGptLogin: vi.fn(async () => ({ status: "refused", reason: "cancelled" })),
    chooseImportFiles: vi.fn(async () => []),
    importFiles: vi.fn(),
    saveIntake: vi.fn(),
    onDroppedImportFiles: vi.fn(() => vi.fn()),
    ...overrides,
  } as OnboardingBridge;
}

describe("onboarding provider status", () => {
  it("shows only ChatGPT as active after sign-in supersedes an API-key provider", async () => {
    const document = new FakeDocument();
    let selectedProvider: "anthropic" | "chatgpt" = "anthropic";
    const credentialStatuses = vi.fn(async () => [
      {
        slot: "anthropic" as const,
        state: "configured" as const,
        runtimeState:
          selectedProvider === "anthropic" ? ("active" as const) : ("stored-inactive" as const),
      },
    ]);
    const chatGptStatus = vi.fn(async () => ({
      state: selectedProvider === "chatgpt" ? ("configured" as const) : ("absent" as const),
      runtimeReady: selectedProvider === "chatgpt",
    }));
    const chatGptLogin = vi.fn(async () => {
      selectedProvider = "chatgpt";
      return { status: "configured" as const, runtimeReady: true as const };
    });
    const controller = mountOnboarding({
      document: document as never,
      bridge: createBridge({ credentialStatuses, chatGptStatus, chatGptLogin }),
      opener: new FakeElement("button", document) as never,
      onComplete: vi.fn(),
    });
    await controller.open();

    findByText(document.body, "button", "Sign in with ChatGPT").click();

    await vi.waitFor(() => {
      expect(credentialStatuses).toHaveBeenCalledTimes(2);
      expectOneActiveProvider(document.body);
    });
    expect(activeProviderLanes(document.body)[0]?.textContent).toBe("Configured");
    expect(findByText(document.body, "span", "Saved · Not in use").className).toBe(
      "credential-state stored-inactive",
    );
    expect(document.body.textContent).not.toContain("Retry saved keys");
    expect(chatGptStatus).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("shows only the API-key provider as active after a key save", async () => {
    const document = new FakeDocument();
    let selectedProvider: "anthropic" | "chatgpt" = "chatgpt";
    const credentialStatuses = vi.fn(async () =>
      selectedProvider === "anthropic"
        ? [
            {
              slot: "anthropic" as const,
              state: "configured" as const,
              runtimeState: "active" as const,
            },
          ]
        : [],
    );
    const chatGptStatus = vi.fn(async () => ({
      state: "configured" as const,
      runtimeReady: selectedProvider === "chatgpt",
    }));
    const writeCredential = vi.fn(async () => {
      selectedProvider = "anthropic";
      return {
        slot: "anthropic" as const,
        status: "configured" as const,
        runtimeReady: true as const,
      };
    });
    const controller = mountOnboarding({
      document: document as never,
      bridge: createBridge({ credentialStatuses, chatGptStatus, writeCredential }),
      opener: new FakeElement("button", document) as never,
      onComplete: vi.fn(),
    });
    await controller.open();
    selectProvider(document.body, "anthropic");
    const input = descendants(document.body).find((node) => node.dataset.slot === "anthropic");
    if (input === undefined) throw new Error("Element not found");
    input.value = randomUUID();

    findByText(document.body, "button", "Continue").click();

    await vi.waitFor(() => expect(credentialStatuses).toHaveBeenCalledTimes(2));
    findByText(document.body, "button", "Back").click();
    expectOneActiveProvider(document.body);
    expect(activeProviderLanes(document.body)[0]?.textContent).toBe("Configured");
    expect(findByText(document.body, "span", "Saved · Not in use").className).toBe(
      "credential-state stored-inactive",
    );
    controller.dispose();
  });

  it("shows only the selected API-key provider as active after Continue succeeds", async () => {
    const document = new FakeDocument();
    let selectedProvider: "anthropic" | "chatgpt" = "chatgpt";
    const credentialStatuses = vi.fn(async () => [
      {
        slot: "anthropic" as const,
        state: "configured" as const,
        runtimeState: selectedProvider === "anthropic" ? ("active" as const) : ("failed" as const),
      },
    ]);
    const chatGptStatus = vi.fn(async () => ({
      state: "configured" as const,
      runtimeReady: selectedProvider === "chatgpt",
    }));
    const applyLlmSelection = vi.fn(async () => {
      selectedProvider = "anthropic";
      return { status: "configured" as const, runtimeReady: true as const };
    });
    const controller = mountOnboarding({
      document: document as never,
      bridge: createBridge({ credentialStatuses, chatGptStatus, applyLlmSelection }),
      opener: new FakeElement("button", document) as never,
      onComplete: vi.fn(),
    });
    await controller.open();
    selectProvider(document.body, "anthropic");

    findByText(document.body, "button", "Continue").click();

    await vi.waitFor(() => {
      expect(applyLlmSelection).toHaveBeenCalledOnce();
      expect(chatGptStatus).toHaveBeenCalledTimes(2);
    });
    findByText(document.body, "button", "Back").click();
    await vi.waitFor(() => {
      expectOneActiveProvider(document.body);
    });
    expect(activeProviderLanes(document.body)[0]?.textContent).toBe("Configured");
    expect(document.body.textContent).toContain(
      "Your ChatGPT sign-in is saved. Sign in again to activate it.",
    );
    expect(document.body.textContent).not.toContain("ChatGPT is ready.");
    controller.dispose();
  });

  it("fails ChatGPT activity closed when its post-selection status is unavailable", async () => {
    const document = new FakeDocument();
    let selectedProvider: "anthropic" | "chatgpt" = "chatgpt";
    const chatGptStatus = vi
      .fn<OnboardingBridge["chatGptStatus"]>()
      .mockResolvedValueOnce({ state: "configured", runtimeReady: true })
      .mockRejectedValueOnce(new Error("private status failure"));
    const credentialStatuses = vi.fn(async () => [
      {
        slot: "anthropic" as const,
        state: "configured" as const,
        runtimeState: selectedProvider === "anthropic" ? ("active" as const) : ("failed" as const),
      },
    ]);
    const applyLlmSelection = vi.fn(async () => {
      selectedProvider = "anthropic";
      return { status: "configured" as const, runtimeReady: true as const };
    });
    const controller = mountOnboarding({
      document: document as never,
      bridge: createBridge({
        credentialStatuses,
        chatGptStatus,
        applyLlmSelection,
      }),
      opener: new FakeElement("button", document) as never,
      onComplete: vi.fn(),
    });
    await controller.open();
    selectProvider(document.body, "anthropic");

    findByText(document.body, "button", "Continue").click();

    await vi.waitFor(() => {
      expect(applyLlmSelection).toHaveBeenCalledOnce();
      expect(chatGptStatus).toHaveBeenCalledTimes(2);
    });
    findByText(document.body, "button", "Back").click();
    await vi.waitFor(() => {
      expectOneActiveProvider(document.body);
    });
    expect(activeProviderLanes(document.body)[0]?.textContent).toBe("Configured");
    expect(document.body.textContent).toContain(
      "Your ChatGPT sign-in is saved. Sign in again to activate it.",
    );
    expect(document.body.textContent).not.toContain("private status failure");
    controller.dispose();
  });

  it("does not report a completed sign-in as refused when status refresh fails", async () => {
    const document = new FakeDocument();
    const credentialStatuses = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new TypeError());
    const chatGptLogin = vi.fn(async () => ({
      status: "configured" as const,
      runtimeReady: true as const,
    }));
    const chatGptStatus = vi
      .fn<OnboardingBridge["chatGptStatus"]>()
      .mockResolvedValueOnce({ state: "absent", runtimeReady: false })
      .mockResolvedValueOnce({ state: "configured", runtimeReady: true });
    const controller = mountOnboarding({
      document: document as never,
      bridge: createBridge({ credentialStatuses, chatGptLogin, chatGptStatus }),
      opener: new FakeElement("button", document) as never,
      onComplete: vi.fn(),
    });
    await controller.open();

    findByText(document.body, "button", "Sign in with ChatGPT").click();

    await vi.waitFor(() => expect(credentialStatuses).toHaveBeenCalledTimes(2));
    expect(document.body.textContent).toContain("ChatGPT is ready.");
    expect(document.body.textContent).not.toContain(
      "ChatGPT sign-in could not be completed. Please retry.",
    );
    controller.dispose();
  });
});
