import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  CredentialWriteResult,
  OnboardingBridge,
  OnboardingLlmConfiguration,
} from "../src/onboarding/bridge.js";
import { mountOnboarding } from "../src/onboarding/mount.js";
import type { ChatGptLoginResult } from "../src/onboarding/machine.js";
import { createRideImportController } from "../src/ride-import.js";

const TEST_LLM_CONFIGURATION: OnboardingLlmConfiguration = {
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
    {
      provider: "openrouter",
      defaultModel: "deepseek/deepseek-v4-flash",
      models: [
        {
          value: "deepseek/deepseek-v4-flash",
          label: "DeepSeek V4 Flash",
        },
      ],
      defaultBaseUrl: "https://openrouter.ai/api/v1",
    },
    {
      provider: "openai",
      defaultModel: "gpt-5.5",
      models: [{ value: "gpt-5.5", label: "GPT-5.5" }],
    },
    {
      provider: "google",
      defaultModel: "gemini-3.5-flash",
      models: [{ value: "gemini-3.5-flash", label: "Gemini 3.5 Flash" }],
    },
    {
      provider: "deepseek",
      defaultModel: "deepseek-v4-flash",
      models: [{ value: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
      defaultBaseUrl: "https://api.deepseek.com/v1",
    },
    {
      provider: "qwen",
      defaultModel: "qwen3.5-plus",
      models: [{ value: "qwen3.5-plus", label: "Qwen3.5 Plus" }],
      defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    },
    {
      provider: "minimax",
      defaultModel: "MiniMax-M2.7",
      models: [{ value: "MiniMax-M2.7", label: "MiniMax M2.7" }],
      defaultBaseUrl: "https://api.minimax.io/v1",
    },
    {
      provider: "kimi",
      defaultModel: "kimi-k2.6",
      models: [{ value: "kimi-k2.6", label: "Kimi K2.6" }],
      defaultBaseUrl: "https://api.moonshot.ai/v1",
    },
    {
      provider: "zai",
      defaultModel: "glm-4.7",
      models: [{ value: "glm-4.7", label: "GLM-4.7" }],
      defaultBaseUrl: "https://api.z.ai/api/openai/v1",
    },
  ],
  active: null,
};

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

  dispatch(name: string, overrides: Record<string, unknown> = {}): void {
    if (this.disabled && ["click", "change", "input"].includes(name)) return;
    const event = { target: this, preventDefault() {}, ...overrides };
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
  readonly llmConfiguration: ReturnType<typeof vi.fn<OnboardingBridge["llmConfiguration"]>>;
  readonly applyLlmSelection: ReturnType<typeof vi.fn<OnboardingBridge["applyLlmSelection"]>>;
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
  const llmConfiguration = vi.fn<OnboardingBridge["llmConfiguration"]>(
    async () => TEST_LLM_CONFIGURATION,
  );
  const applyLlmSelection = vi.fn<OnboardingBridge["applyLlmSelection"]>(async () => ({
    status: "configured",
    runtimeReady: true,
  }));
  const importFiles = vi.fn<OnboardingBridge["importFiles"]>(async () => ({
    schemaVersion: 2,
    files: { total: 0, imported: 0, quarantined: 0 },
    changes: {
      rawFilesInserted: 0,
      sourceRecordsInserted: 0,
      sourceRecordsUpdated: 0,
      relinkedSourceRecords: 0,
    },
    publication: { scope: "activities-and-streams", status: "available" },
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
    llmConfiguration,
    applyLlmSelection,
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

function passwordInputFor(document: FakeDocument, slot: string): FakeElement {
  const input = document.body
    .querySelectorAll('input[type="password"][data-slot]')
    .find((candidate) => candidate.dataset.slot === slot);
  if (input === undefined) throw new Error(`Password input not found: ${slot}`);
  return input;
}

function controlById(document: FakeDocument, id: string): FakeElement {
  const control = document.body.querySelector(`#${id}`);
  if (control === null) throw new Error(`Control not found: ${id}`);
  return control;
}

function changeControl(document: FakeDocument, id: string, value: string): void {
  const control = controlById(document, id);
  control.value = value;
  control.dispatch("change");
}

function radioInputFor(document: FakeDocument, name: string, copy: string): FakeElement {
  const input = document.body
    .querySelectorAll("input")
    .find((candidate) => candidate.name === name && candidate.parent?.textContent === copy);
  if (input === undefined) throw new Error(`Radio input not found: ${name} / ${copy}`);
  return input;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

type CredentialWriteRefusalReason = Extract<
  CredentialWriteResult,
  { readonly status: "refused" }
>["reason"];

const CREDENTIAL_REFUSAL_CASES = [
  {
    reason: "invalid-input",
    fixedError: "invalid-input",
    copy: "That key was not accepted. Check it and enter it again.",
  },
  {
    reason: "encryption-unavailable",
    fixedError: "encryption-unavailable",
    copy: "macOS encryption is unavailable. Make sure Keychain is available, then try again.",
  },
  {
    reason: "unsafe-backend",
    fixedError: "unsafe-backend",
    copy: "The app cannot safely store that key with the current storage backend.",
  },
  {
    reason: "storage-failed",
    fixedError: "storage-failed",
    copy: "The app could not confirm that key was saved securely. Check that secure storage is available and try again.",
  },
  {
    reason: "runtime-unavailable",
    fixedError: "model-runtime-unavailable",
    copy: "Your provider choice is saved, but it is not active yet. Choose Continue to retry it.",
  },
] as const satisfies ReadonlyArray<{
  readonly reason: CredentialWriteRefusalReason;
  readonly fixedError: CredentialWriteRefusalReason | "model-runtime-unavailable";
  readonly copy: string;
}>;

describe("mounted onboarding", () => {
  it.each(CREDENTIAL_REFUSAL_CASES)(
    "keeps the athlete on coach keys and explains $reason refusals",
    async ({ reason, fixedError, copy }) => {
      const document = new FakeDocument();
      const baseBridge = bridge(async () => ({
        status: "configured",
        runtimeReady: true,
      }));
      if (reason === "runtime-unavailable") {
        baseBridge.credentialStatuses
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            { slot: "anthropic", state: "configured", runtimeState: "failed" },
          ]);
      }
      let credentialWriteCount = 0;
      const onboardingBridge: OnboardingBridge = {
        ...baseBridge,
        async writeCredential({ slot }) {
          credentialWriteCount += 1;
          return { slot, status: "refused", reason };
        },
      };
      const onComplete = vi.fn();
      const controller = mountOnboarding({
        document: documentBoundary(document),
        bridge: onboardingBridge,
        opener: elementBoundary(document.createElement("button")),
        onComplete,
      });
      await controller.open();
      const passwordInput = passwordInputFor(document, "anthropic");
      passwordInput.value = randomUUID();

      buttonWithText(document, "Continue").dispatch("click");

      await vi.waitFor(() => expect(controller.state().fixedError).toBe(fixedError));
      expect(document.body.querySelector("#onboarding-error")?.textContent).toBe(copy);
      expect(controller.state().step).toBe("coach-keys");
      expect(passwordInput.value).toBe("");
      expect(credentialWriteCount).toBe(1);
      expect(baseBridge.credentialStatuses).toHaveBeenCalledTimes(2);
      expect(onComplete).not.toHaveBeenCalled();
      controller.dispose();
    },
  );

  it("explains a training-account mismatch on the reachable intervals.icu path", async () => {
    const document = new FakeDocument();
    const baseBridge = bridge(async () => ({
      status: "configured",
      runtimeReady: true,
    }));
    baseBridge.credentialStatuses.mockResolvedValue([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
    ]);
    const onboardingBridge: OnboardingBridge = {
      ...baseBridge,
      async writeCredential({ slot }) {
        return {
          slot,
          status: "refused",
          reason: "training-account-mismatch",
        };
      },
    };
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: onboardingBridge,
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });
    await controller.open();
    buttonWithText(document, "Continue").dispatch("click");
    await vi.waitFor(() => expect(controller.state().step).toBe("training-data"));
    passwordInputFor(document, "intervals-icu").value = randomUUID();

    buttonWithText(document, "Continue").dispatch("click");

    await vi.waitFor(() => expect(controller.state().fixedError).toBe("training-account-mismatch"));
    expect(document.body.querySelector("#onboarding-error")?.textContent).toBe(
      "That intervals.icu key belongs to a different athlete than the training history already stored. Switching accounts is not supported yet.",
    );
    expect(controller.state().step).toBe("training-data");
    expect(passwordInputFor(document, "intervals-icu").value).toBe("");
    controller.dispose();
  });

  it("retries a saved provider choice with Continue without rewriting the key", async () => {
    const document = new FakeDocument();
    const failedStatuses = [
      { slot: "anthropic", state: "configured", runtimeState: "failed" },
    ] as const;
    const activeStatuses = [
      { slot: "anthropic", state: "configured", runtimeState: "active" },
    ] as const;
    const baseBridge = bridge(async () => ({
      status: "configured",
      runtimeReady: true,
    }));
    baseBridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    baseBridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(failedStatuses)
      .mockResolvedValueOnce(activeStatuses);
    let credentialWriteCount = 0;
    const onboardingBridge: OnboardingBridge = {
      ...baseBridge,
      async writeCredential({ slot }) {
        credentialWriteCount += 1;
        return { slot, status: "refused", reason: "runtime-unavailable" };
      },
    };
    const onComplete = vi.fn();
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: onboardingBridge,
      opener: elementBoundary(document.createElement("button")),
      onComplete,
    });
    await controller.open();
    const passwordInput = passwordInputFor(document, "anthropic");
    passwordInput.value = randomUUID();

    buttonWithText(document, "Continue").dispatch("click");

    await vi.waitFor(() => expect(controller.state().fixedError).toBe("model-runtime-unavailable"));
    expect(document.body.textContent).toContain(
      "Your provider choice is saved, but it is not active yet. Choose Continue to retry it.",
    );
    expect(
      document.body
        .querySelectorAll("button")
        .some((button) => button.textContent === "Retry saved keys"),
    ).toBe(false);
    expect(passwordInput.value).toBe("");
    expect(baseBridge.credentialStatuses).toHaveBeenCalledTimes(2);

    buttonWithText(document, "Continue").dispatch("click");

    await vi.waitFor(() => expect(controller.state().step).toBe("training-data"));
    expect(baseBridge.applyLlmSelection).toHaveBeenCalledWith({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      endpoint: { mode: "automatic" },
    });
    expect(baseBridge.credentialStatuses).toHaveBeenCalledTimes(3);
    expect(credentialWriteCount).toBe(1);
    expect(baseBridge.retryFailedCredentials).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("keeps Continue activation recovery available when applying the provider fails", async () => {
    const document = new FakeDocument();
    const failedStatuses = [
      { slot: "anthropic", state: "configured", runtimeState: "failed" },
    ] as const;
    const baseBridge = bridge(async () => ({
      status: "configured",
      runtimeReady: true,
    }));
    baseBridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    baseBridge.credentialStatuses.mockResolvedValueOnce([]).mockResolvedValueOnce(failedStatuses);
    const onboardingBridge: OnboardingBridge = {
      ...baseBridge,
      async applyLlmSelection() {
        throw new Error("private daemon failure");
      },
      async writeCredential({ slot }) {
        return { slot, status: "refused", reason: "runtime-unavailable" };
      },
    };
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: onboardingBridge,
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });
    await controller.open();
    passwordInputFor(document, "anthropic").value = randomUUID();
    buttonWithText(document, "Continue").dispatch("click");
    await vi.waitFor(() => expect(controller.state().fixedError).toBe("model-runtime-unavailable"));

    buttonWithText(document, "Continue").dispatch("click");

    await vi.waitFor(() => expect(controller.state().busy).toBe(false));
    expect(controller.state().fixedError).toBe("model-runtime-unavailable");
    expect(document.body.querySelector("#onboarding-error")?.textContent).toBe(
      "Your provider choice is saved, but it is not active yet. Choose Continue to retry it.",
    );
    expect(
      document.body
        .querySelectorAll("button")
        .some((button) => button.textContent === "Retry saved keys"),
    ).toBe(false);
    expect(baseBridge.retryFailedCredentials).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("private daemon failure");
    controller.dispose();
  });

  it("offers intervals.icu recovery on training data without leaving or rewriting", async () => {
    const document = new FakeDocument();
    const failedStatuses = [
      { slot: "intervals-icu", state: "configured", runtimeState: "failed" },
    ] as const;
    const baseBridge = bridge(async () => ({
      status: "configured",
      runtimeReady: true,
    }));
    baseBridge.credentialStatuses.mockResolvedValueOnce([]).mockResolvedValue(failedStatuses);
    const retryFailedCredentials = vi.fn<OnboardingBridge["retryFailedCredentials"]>(
      async () => failedStatuses,
    );
    let credentialWriteCount = 0;
    const onboardingBridge: OnboardingBridge = {
      ...baseBridge,
      retryFailedCredentials,
      async writeCredential({ slot }) {
        credentialWriteCount += 1;
        return { slot, status: "refused", reason: "runtime-unavailable" };
      },
    };
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: onboardingBridge,
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });
    await controller.open();
    buttonWithText(document, "Continue").dispatch("click");
    await vi.waitFor(() => expect(controller.state().step).toBe("training-data"));
    const intervalsInput = passwordInputFor(document, "intervals-icu");
    intervalsInput.value = randomUUID();

    buttonWithText(document, "Continue").dispatch("click");

    await vi.waitFor(() => expect(controller.state().fixedError).toBe("runtime-unavailable"));
    expect(controller.state().step).toBe("training-data");
    expect(document.body.querySelector("#onboarding-error")?.textContent).toBe(
      "That key was saved, but it is not active yet. Choose Retry saved keys to activate it.",
    );
    expect(
      document.body
        .querySelectorAll("button")
        .filter((button) => button.textContent === "Retry saved keys"),
    ).toHaveLength(1);
    expect(intervalsInput.value).toBe("");

    buttonWithText(document, "Back").dispatch("click");
    expect(controller.state().step).toBe("coach-keys");
    expect(
      document.body
        .querySelectorAll("button")
        .filter((button) => button.textContent === "Retry saved keys"),
    ).toHaveLength(0);
    buttonWithText(document, "Continue").dispatch("click");
    await vi.waitFor(() => expect(controller.state().step).toBe("training-data"));
    expect(
      document.body
        .querySelectorAll("button")
        .filter((button) => button.textContent === "Retry saved keys"),
    ).toHaveLength(1);

    buttonWithText(document, "Retry saved keys").dispatch("click");

    await vi.waitFor(() => expect(retryFailedCredentials).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(controller.state().busy).toBe(false));
    expect(controller.state().step).toBe("training-data");
    expect(
      document.body
        .querySelectorAll("button")
        .filter((button) => button.textContent === "Retry saved keys"),
    ).toHaveLength(1);
    expect(credentialWriteCount).toBe(1);
    expect(retryFailedCredentials).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("does not leak a late runtime-unavailable write into a reopened visit", async () => {
    const document = new FakeDocument();
    const baseBridge = bridge(async () => ({
      status: "configured",
      runtimeReady: true,
    }));
    const pendingWrite = deferred<CredentialWriteResult>();
    let credentialWriteCount = 0;
    const onboardingBridge: OnboardingBridge = {
      ...baseBridge,
      writeCredential() {
        credentialWriteCount += 1;
        return pendingWrite.promise;
      },
    };
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: onboardingBridge,
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });
    await controller.open();
    passwordInputFor(document, "anthropic").value = randomUUID();
    buttonWithText(document, "Continue").dispatch("click");
    await vi.waitFor(() => expect(credentialWriteCount).toBe(1));

    controller.close();
    pendingWrite.resolve({
      slot: "anthropic",
      status: "refused",
      reason: "runtime-unavailable",
    });
    await pendingWrite.promise;
    await controller.open();

    expect(controller.state()).toMatchObject({
      step: "coach-keys",
      busy: false,
      fixedError: null,
    });
    expect(
      document.body
        .querySelectorAll("button")
        .some((button) => button.textContent === "Retry saved keys"),
    ).toBe(false);
    expect(credentialWriteCount).toBe(1);
    controller.dispose();
  });

  it("snapshots and clears every password before the first write settles", async () => {
    const document = new FakeDocument();
    const firstValue = randomUUID();
    const secondValue = randomUUID();
    const firstWrite = deferred<void>();
    let firstValueMatched = false;
    let secondValueMatched = false;
    const baseBridge = bridge(async () => ({ status: "refused", reason: "cancelled" }));
    baseBridge.writeCredential = async ({ slot, value }) => {
      if (slot === "anthropic") {
        firstValueMatched = value === firstValue;
        await firstWrite.promise;
      }
      if (slot === "openrouter") secondValueMatched = value === secondValue;
      return { slot, status: "configured", runtimeReady: true };
    };
    baseBridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ slot: "openrouter", state: "configured", runtimeState: "active" }]);
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: baseBridge,
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });
    await controller.open();
    const firstInput = passwordInputFor(document, "anthropic");
    const secondInput = passwordInputFor(document, "openrouter");
    firstInput.value = firstValue;
    secondInput.value = secondValue;

    buttonWithText(document, "Continue").dispatch("click");

    await vi.waitFor(() => expect(firstValueMatched).toBe(true));
    expect(firstInput.disabled).toBe(true);
    expect(secondInput.disabled).toBe(true);
    expect(firstInput.value).toBe("");
    expect(secondInput.value).toBe("");
    expect(document.body.querySelector(".onboarding-action-status")?.textContent).toBe("Working…");
    secondInput.value = randomUUID();
    firstWrite.resolve();

    await vi.waitFor(() => expect(controller.state().step).toBe("training-data"));
    expect(secondValueMatched).toBe(true);
    expect(secondInput.value).toBe("");
    controller.dispose();
  });

  it("writes the explicitly selected provider last and attaches its model choice", async () => {
    const document = new FakeDocument();
    const anthropicKey = randomUUID();
    const openRouterKey = randomUUID();
    const baseBridge = bridge(async () => ({ status: "refused", reason: "cancelled" }));
    baseBridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    baseBridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ slot: "openrouter", state: "configured", runtimeState: "active" }]);
    const writeCredential = vi.fn<OnboardingBridge["writeCredential"]>(
      async ({ slot, selection }) => ({
        slot,
        status: "configured",
        runtimeReady: selection !== undefined,
      }),
    );
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: { ...baseBridge, writeCredential },
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });
    await controller.open();
    changeControl(document, "onboarding-llm-provider", "openrouter");
    passwordInputFor(document, "anthropic").value = anthropicKey;
    passwordInputFor(document, "openrouter").value = openRouterKey;

    buttonWithText(document, "Continue").dispatch("click");

    await vi.waitFor(() => expect(controller.state().step).toBe("training-data"));
    expect(writeCredential).toHaveBeenNthCalledWith(1, {
      slot: "anthropic",
      value: anthropicKey,
    });
    expect(writeCredential).toHaveBeenNthCalledWith(2, {
      slot: "openrouter",
      value: openRouterKey,
      selection: {
        provider: "openrouter",
        model: "deepseek/deepseek-v4-flash",
        endpoint: { mode: "automatic" },
      },
    });
    expect(baseBridge.applyLlmSelection).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("applies a changed model for an active provider without a Desktop-owned key", async () => {
    const document = new FakeDocument();
    const baseBridge = bridge(async () => ({ status: "refused", reason: "cancelled" }));
    baseBridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    baseBridge.llmConfiguration.mockResolvedValue({
      ...TEST_LLM_CONFIGURATION,
      active: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    baseBridge.credentialStatuses.mockResolvedValue([]);
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: baseBridge,
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });
    await controller.open();
    changeControl(document, "onboarding-llm-model", "__custom__");
    const customModel = controlById(document, "onboarding-custom-model");
    customModel.value = "athlete-selected-model";
    customModel.dispatch("input");

    buttonWithText(document, "Continue").dispatch("click");

    await vi.waitFor(() => expect(controller.state().step).toBe("training-data"));
    expect(baseBridge.writeCredential).not.toHaveBeenCalled();
    expect(baseBridge.applyLlmSelection).toHaveBeenCalledWith({
      provider: "anthropic",
      model: "athlete-selected-model",
      endpoint: { mode: "automatic" },
    });
    controller.dispose();
  });

  it("continues with an active ChatGPT profile without signing in again", async () => {
    const document = new FakeDocument();
    const baseBridge = bridge(async () => ({ status: "refused", reason: "cancelled" }));
    baseBridge.llmConfiguration.mockResolvedValue({
      ...TEST_LLM_CONFIGURATION,
      active: { provider: "openai-codex", model: "custom-chat-model" },
    });
    baseBridge.chatGptStatus.mockResolvedValue({ state: "configured", runtimeReady: true });
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: baseBridge,
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });
    await controller.open();

    buttonWithText(document, "Continue").dispatch("click");

    await vi.waitFor(() => expect(controller.state().step).toBe("training-data"));
    expect(baseBridge.chatGptLogin).not.toHaveBeenCalled();
    expect(baseBridge.applyLlmSelection).toHaveBeenCalledWith({
      provider: "openai-codex",
      model: "custom-chat-model",
      endpoint: { mode: "automatic" },
    });
    controller.dispose();
  });

  it("applies an endpoint change for an already-active provider without requiring the key again", async () => {
    const document = new FakeDocument();
    const baseBridge = bridge(async () => ({ status: "refused", reason: "cancelled" }));
    baseBridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    baseBridge.llmConfiguration.mockResolvedValue({
      ...TEST_LLM_CONFIGURATION,
      active: { provider: "openrouter", model: "deepseek/deepseek-v4-flash" },
    });
    baseBridge.credentialStatuses.mockResolvedValue([
      { slot: "openrouter", state: "configured", runtimeState: "active" },
    ]);
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: baseBridge,
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });
    await controller.open();
    changeControl(document, "onboarding-endpoint-mode", "custom");
    const endpoint = controlById(document, "onboarding-custom-endpoint");
    endpoint.value = "https://models.example.test/v1";
    endpoint.dispatch("input");

    buttonWithText(document, "Continue").dispatch("click");

    await vi.waitFor(() => expect(controller.state().step).toBe("training-data"));
    expect(baseBridge.writeCredential).not.toHaveBeenCalled();
    expect(baseBridge.applyLlmSelection).toHaveBeenCalledWith({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      endpoint: { mode: "custom", value: "https://models.example.test/v1" },
    });
    controller.dispose();
  });

  it("freezes provider, model, and endpoint controls while applying a selection", async () => {
    const document = new FakeDocument();
    const pending = deferred<{
      readonly status: "configured";
      readonly runtimeReady: true;
    }>();
    let active = false;
    const baseBridge = bridge(async () => ({ status: "refused", reason: "cancelled" }));
    baseBridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    baseBridge.credentialStatuses.mockImplementation(async () => [
      {
        slot: "openrouter",
        state: "configured",
        runtimeState: active ? "active" : "stored-inactive",
      },
    ]);
    baseBridge.applyLlmSelection.mockImplementation(() => pending.promise);
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: baseBridge,
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });
    await controller.open();
    changeControl(document, "onboarding-llm-provider", "openrouter");

    buttonWithText(document, "Continue").dispatch("click");

    await vi.waitFor(() => expect(baseBridge.applyLlmSelection).toHaveBeenCalledOnce());
    const provider = controlById(document, "onboarding-llm-provider");
    const model = controlById(document, "onboarding-llm-model");
    const endpoint = controlById(document, "onboarding-endpoint-mode");
    expect(provider.disabled).toBe(true);
    expect(model.disabled).toBe(true);
    expect(endpoint.disabled).toBe(true);

    active = true;
    pending.resolve({ status: "configured", runtimeReady: true });
    await vi.waitFor(() => expect(controller.state().step).toBe("training-data"));
    expect(baseBridge.applyLlmSelection).toHaveBeenCalledWith({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      endpoint: { mode: "automatic" },
    });
    controller.dispose();
  });

  it("does not submit the wizard when Enter is handled by a selection control", async () => {
    const document = new FakeDocument();
    const baseBridge = bridge(async () => ({ status: "refused", reason: "cancelled" }));
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: baseBridge,
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });
    await controller.open();
    const provider = controlById(document, "onboarding-llm-provider");
    const dialog = document.body.querySelector(".onboarding");
    if (dialog === null) throw new Error("Dialog not found");
    const preventDefault = vi.fn();

    dialog.dispatch("keydown", { key: "Enter", target: provider, preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(baseBridge.applyLlmSelection).not.toHaveBeenCalled();
    expect(controller.state().busy).toBe(false);
    controller.dispose();
  });

  it("retains a custom model and endpoint through provider switches and activation retry", async () => {
    const document = new FakeDocument();
    const secret = randomUUID();
    const selection = {
      provider: "openrouter" as const,
      model: "vendor/private-model",
      endpoint: { mode: "custom" as const, value: "https://models.example.test/v1" },
    };
    const baseBridge = bridge(async () => ({ status: "refused", reason: "cancelled" }));
    baseBridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    baseBridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ slot: "openrouter", state: "configured", runtimeState: "failed" }])
      .mockResolvedValueOnce([{ slot: "openrouter", state: "configured", runtimeState: "active" }]);
    const writeCredential = vi.fn<OnboardingBridge["writeCredential"]>(async ({ slot }) => ({
      slot,
      status: "refused",
      reason: "runtime-unavailable",
    }));
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: { ...baseBridge, writeCredential },
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });
    await controller.open();
    changeControl(document, "onboarding-llm-provider", "openrouter");
    changeControl(document, "onboarding-llm-model", "__custom__");
    const customModel = controlById(document, "onboarding-custom-model");
    customModel.value = selection.model;
    customModel.dispatch("input");
    changeControl(document, "onboarding-endpoint-mode", "custom");
    const customEndpoint = controlById(document, "onboarding-custom-endpoint");
    customEndpoint.value = selection.endpoint.value;
    customEndpoint.dispatch("input");

    changeControl(document, "onboarding-llm-provider", "anthropic");
    changeControl(document, "onboarding-llm-provider", "openrouter");

    expect(controlById(document, "onboarding-llm-model").value).toBe("__custom__");
    expect(controlById(document, "onboarding-custom-model").value).toBe(selection.model);
    expect(controlById(document, "onboarding-endpoint-mode").value).toBe("custom");
    expect(controlById(document, "onboarding-custom-endpoint").value).toBe(
      selection.endpoint.value,
    );
    passwordInputFor(document, "openrouter").value = secret;

    buttonWithText(document, "Continue").dispatch("click");

    await vi.waitFor(() => expect(controller.state().fixedError).toBe("model-runtime-unavailable"));
    expect(writeCredential).toHaveBeenCalledWith({
      slot: "openrouter",
      value: secret,
      selection,
    });
    expect(passwordInputFor(document, "openrouter").value).toBe("");
    expect(controlById(document, "onboarding-custom-model").value).toBe(selection.model);
    expect(controlById(document, "onboarding-custom-endpoint").value).toBe(
      selection.endpoint.value,
    );

    buttonWithText(document, "Continue").dispatch("click");

    await vi.waitFor(() => expect(controller.state().step).toBe("training-data"));
    expect(baseBridge.applyLlmSelection).toHaveBeenCalledWith(selection);
    expect(writeCredential).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("blocks a non-loopback HTTP endpoint before invoking credential or runtime IPC", async () => {
    const document = new FakeDocument();
    const baseBridge = bridge(async () => ({ status: "refused", reason: "cancelled" }));
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: baseBridge,
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });
    await controller.open();
    changeControl(document, "onboarding-llm-provider", "openrouter");
    changeControl(document, "onboarding-endpoint-mode", "custom");
    const endpoint = controlById(document, "onboarding-custom-endpoint");
    endpoint.value = "http://models.example.test/v1";
    endpoint.dispatch("input");
    passwordInputFor(document, "openrouter").value = randomUUID();

    buttonWithText(document, "Continue").dispatch("click");

    await vi.waitFor(() => expect(controller.state().fixedError).toBe("endpoint-invalid"));
    expect(baseBridge.writeCredential).not.toHaveBeenCalled();
    expect(baseBridge.applyLlmSelection).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("passes the selected model to ChatGPT sign-in", async () => {
    const document = new FakeDocument();
    const chatGptLogin = bridge(async () => ({ status: "refused", reason: "cancelled" }));
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: chatGptLogin,
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });
    await controller.open();
    changeControl(document, "onboarding-llm-provider", "openai-codex");
    changeControl(document, "onboarding-llm-model", "__custom__");
    const customModel = controlById(document, "onboarding-custom-model");
    customModel.value = "gpt-5.5-codex-max";
    customModel.dispatch("input");

    buttonWithText(document, "Sign in again").dispatch("click");

    await vi.waitFor(() => expect(chatGptLogin.chatGptLogin).toHaveBeenCalledOnce());
    expect(chatGptLogin.chatGptLogin).toHaveBeenCalledWith({
      provider: "openai-codex",
      model: "gpt-5.5-codex-max",
      endpoint: { mode: "automatic" },
    });
    controller.dispose();
  });

  it.each([{ runtimeState: "active" }, { runtimeState: "stored-inactive" }] as const)(
    "recovers a selected provider from $runtimeState only after it is active",
    async (status) => {
      const document = new FakeDocument();
      const baseBridge = bridge(async () => ({
        status: "configured",
        runtimeReady: true,
      }));
      baseBridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
      baseBridge.credentialStatuses
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { slot: "anthropic", state: "configured", runtimeState: status.runtimeState },
        ])
        .mockResolvedValueOnce([
          { slot: "anthropic", state: "configured", runtimeState: "active" },
        ]);
      let credentialWriteCount = 0;
      const onboardingBridge: OnboardingBridge = {
        ...baseBridge,
        async writeCredential({ slot }) {
          credentialWriteCount += 1;
          return { slot, status: "refused", reason: "runtime-unavailable" };
        },
      };
      const controller = mountOnboarding({
        document: documentBoundary(document),
        bridge: onboardingBridge,
        opener: elementBoundary(document.createElement("button")),
        onComplete: vi.fn(),
      });
      await controller.open();
      passwordInputFor(document, "anthropic").value = randomUUID();

      buttonWithText(document, "Continue").dispatch("click");

      await vi.waitFor(() => expect(controller.state().step).toBe("training-data"));
      expect(controller.state().fixedError).toBeNull();
      expect(document.body.textContent).not.toContain(
        "That key was saved, but it is not active yet.",
      );
      expect(
        document.body
          .querySelectorAll("button")
          .some((button) => button.textContent === "Retry saved keys"),
      ).toBe(false);
      buttonWithText(document, "Back").dispatch("click");
      expect(
        passwordInputFor(document, "anthropic").parent?.querySelector(".credential-state")
          ?.textContent,
      ).toBe("Configured");
      expect(
        document.body
          .querySelectorAll("button")
          .some((button) => button.textContent === "Retry saved keys"),
      ).toBe(false);
      expect(baseBridge.applyLlmSelection).toHaveBeenCalledOnce();
      expect(credentialWriteCount).toBe(1);
      controller.dispose();
    },
  );

  it("uses Continue instead of credential retry when an unrelated saved key failed", async () => {
    const document = new FakeDocument();
    const baseBridge = bridge(async () => ({
      status: "configured",
      runtimeReady: true,
    }));
    baseBridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    baseBridge.credentialStatuses.mockResolvedValueOnce([]).mockResolvedValue([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
      { slot: "openrouter", state: "configured", runtimeState: "failed" },
    ]);
    let credentialWriteCount = 0;
    const onboardingBridge: OnboardingBridge = {
      ...baseBridge,
      async writeCredential({ slot }) {
        credentialWriteCount += 1;
        return { slot, status: "refused", reason: "runtime-unavailable" };
      },
    };
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: onboardingBridge,
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });
    await controller.open();
    passwordInputFor(document, "anthropic").value = randomUUID();
    passwordInputFor(document, "openrouter").value = randomUUID();

    buttonWithText(document, "Continue").dispatch("click");

    await vi.waitFor(() => expect(controller.state().fixedError).toBe("model-runtime-unavailable"));
    expect(controller.state().step).toBe("coach-keys");
    expect(
      document.body
        .querySelectorAll("button")
        .filter((button) => button.textContent === "Retry saved keys"),
    ).toHaveLength(0);

    buttonWithText(document, "Continue").dispatch("click");

    await vi.waitFor(() => expect(controller.state().step).toBe("training-data"));
    expect(credentialWriteCount).toBe(2);
    controller.dispose();
  });

  it.each([
    { refreshedState: "re-prompt", description: "must be re-entered" },
    { refreshedState: "missing", description: "is reported missing" },
    { refreshedState: null, description: "is absent" },
  ] as const)("asks for the key again when the refreshed key $description", async (status) => {
    const document = new FakeDocument();
    const baseBridge = bridge(async () => ({
      status: "configured",
      runtimeReady: true,
    }));
    baseBridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    baseBridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(
        status.refreshedState === null
          ? []
          : [{ slot: "anthropic", state: status.refreshedState, runtimeState: null }],
      );
    const onboardingBridge: OnboardingBridge = {
      ...baseBridge,
      async writeCredential({ slot }) {
        return { slot, status: "refused", reason: "runtime-unavailable" };
      },
    };
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: onboardingBridge,
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });
    await controller.open();
    passwordInputFor(document, "anthropic").value = randomUUID();

    buttonWithText(document, "Continue").dispatch("click");

    await vi.waitFor(() => {
      expect(controller.state()).toMatchObject({
        fixedError: "credential-reenter-required",
        credentialStatus: { anthropic: status.refreshedState ?? "missing" },
      });
    });
    expect(document.body.querySelector("#onboarding-error")?.textContent).toBe(
      "That saved key could not be used. Enter it again to continue.",
    );
    expect(
      document.body
        .querySelectorAll("button")
        .some((button) => button.textContent === "Retry saved keys"),
    ).toBe(false);
    controller.dispose();
  });

  it.each([
    {
      state: "configured",
      runtimeState: "stored-inactive",
    },
    {
      state: "re-prompt",
      runtimeState: null,
    },
  ] as const)("does not offer retry for an unrelated $state status", async (status) => {
    const document = new FakeDocument();
    const baseBridge = bridge(async () => ({
      status: "configured",
      runtimeReady: true,
    }));
    baseBridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    baseBridge.credentialStatuses.mockResolvedValue([
      { slot: "anthropic", state: status.state, runtimeState: status.runtimeState },
    ]);
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: baseBridge,
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });

    await controller.open();

    expect(
      document.body
        .querySelectorAll("button")
        .some((button) => button.textContent === "Retry saved keys"),
    ).toBe(false);
    controller.dispose();
  });

  it("uses fixed generic copy when a credential write throws", async () => {
    const document = new FakeDocument();
    const exceptionDetail = "write exception detail must stay private";
    const baseBridge = bridge(async () => ({
      status: "configured",
      runtimeReady: true,
    }));
    const onboardingBridge: OnboardingBridge = {
      ...baseBridge,
      async writeCredential() {
        throw new Error(exceptionDetail);
      },
    };
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: onboardingBridge,
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });
    await controller.open();
    const passwordInput = passwordInputFor(document, "anthropic");
    passwordInput.value = randomUUID();

    buttonWithText(document, "Continue").dispatch("click");

    await vi.waitFor(() => expect(controller.state().fixedError).toBe("credential-save-failed"));
    expect(document.body.querySelector("#onboarding-error")?.textContent).toBe(
      "That key could not be saved. Try entering it again.",
    );
    expect(document.body.textContent).not.toContain(exceptionDetail);
    expect(controller.state().step).toBe("coach-keys");
    expect(passwordInput.value).toBe("");
    expect(baseBridge.credentialStatuses).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("explains when a saved key's post-write status cannot be refreshed", async () => {
    const document = new FakeDocument();
    const exceptionDetail = "status exception detail must stay private";
    const baseBridge = bridge(async () => ({
      status: "configured",
      runtimeReady: true,
    }));
    baseBridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error(exceptionDetail));
    const onboardingBridge: OnboardingBridge = {
      ...baseBridge,
      async writeCredential({ slot }) {
        return { slot, status: "refused", reason: "runtime-unavailable" };
      },
    };
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: onboardingBridge,
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });
    await controller.open();
    const passwordInput = passwordInputFor(document, "anthropic");
    passwordInput.value = randomUUID();

    buttonWithText(document, "Continue").dispatch("click");

    await vi.waitFor(() =>
      expect(controller.state().fixedError).toBe("credential-status-unavailable"),
    );
    expect(document.body.querySelector("#onboarding-error")?.textContent).toBe(
      "That key was saved, but its status could not be refreshed. Close and reopen Setup to check again.",
    );
    expect(document.body.textContent).not.toContain(exceptionDetail);
    expect(controller.state().step).toBe("coach-keys");
    expect(passwordInput.value).toBe("");
    expect(baseBridge.credentialStatuses).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("accepts an active key when only the unrelated ChatGPT status refresh fails", async () => {
    const document = new FakeDocument();
    const exceptionDetail = "ChatGPT status detail must stay private";
    const baseBridge = bridge(async () => ({ status: "refused", reason: "cancelled" }));
    baseBridge.writeCredential = async ({ slot }) => ({
      slot,
      status: "configured",
      runtimeReady: true,
    });
    baseBridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ slot: "anthropic", state: "configured", runtimeState: "active" }]);
    baseBridge.chatGptStatus
      .mockResolvedValueOnce({ state: "configured", runtimeReady: true })
      .mockRejectedValueOnce(new Error(exceptionDetail));
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: baseBridge,
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });
    await controller.open();
    changeControl(document, "onboarding-llm-provider", "anthropic");
    passwordInputFor(document, "anthropic").value = randomUUID();

    buttonWithText(document, "Continue").dispatch("click");

    await vi.waitFor(() => expect(controller.state().step).toBe("training-data"));
    expect(controller.state().fixedError).toBeNull();
    expect(controller.state().chatGptRuntimeReady).toBe(false);
    expect(document.body.textContent).not.toContain(exceptionDetail);
    controller.dispose();
  });

  it("advances after a configured key write and refreshed active status", async () => {
    const document = new FakeDocument();
    const baseBridge = bridge(async () => ({
      status: "configured",
      runtimeReady: true,
    }));
    baseBridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    baseBridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ slot: "anthropic", state: "configured", runtimeState: "active" }]);
    let credentialWriteCount = 0;
    const onboardingBridge: OnboardingBridge = {
      ...baseBridge,
      async writeCredential({ slot }) {
        credentialWriteCount += 1;
        return { slot, status: "configured", runtimeReady: true };
      },
    };
    const onComplete = vi.fn();
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: onboardingBridge,
      opener: elementBoundary(document.createElement("button")),
      onComplete,
    });
    await controller.open();
    const passwordInput = passwordInputFor(document, "anthropic");
    passwordInput.value = randomUUID();

    buttonWithText(document, "Continue").dispatch("click");

    await vi.waitFor(() => expect(controller.state().step).toBe("training-data"));
    expect(passwordInput.value).toBe("");
    expect(credentialWriteCount).toBe(1);
    expect(baseBridge.credentialStatuses).toHaveBeenCalledTimes(2);
    expect(onComplete).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("discloses distinct credential storage without starting sign-in, writing, or advancing", async () => {
    const document = new FakeDocument();
    const onboardingBridge = bridge(async () => ({
      status: "configured",
      runtimeReady: true,
    }));
    const controller = mountOnboarding({
      document: documentBoundary(document),
      bridge: onboardingBridge,
      opener: elementBoundary(document.createElement("button")),
      onComplete: vi.fn(),
    });
    await controller.open();
    const stateBeforeReading = controller.state();

    const disclosure = document.body.querySelector(".onboarding-copy");
    expect(disclosure?.textContent).toContain("ChatGPT sign-in is saved in a local profile file.");
    expect(disclosure?.textContent).toContain("API keys are encrypted by macOS.");
    expect(disclosure?.textContent).toContain(
      "The local coaching service uses your choice to contact the provider.",
    );

    expect(onboardingBridge.chatGptLogin).not.toHaveBeenCalled();
    expect(onboardingBridge.writeCredential).not.toHaveBeenCalled();
    expect(controller.state()).toEqual(stateBeforeReading);
    expect(controller.state().step).toBe("coach-keys");
  });

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
    expect(chatGptLogin.writeCredential).not.toHaveBeenCalled();
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
        schemaVersion: 2,
        files: { total: 2, imported: 1, quarantined: 1 },
        changes: {
          rawFilesInserted: 1,
          sourceRecordsInserted: 1,
          sourceRecordsUpdated: 0,
          relinkedSourceRecords: 0,
        },
        publication: { scope: "activities-and-streams", status: "available" },
      })
      .mockResolvedValueOnce({
        schemaVersion: 2,
        files: { total: 2, imported: 0, quarantined: 2 },
        changes: {
          rawFilesInserted: 0,
          sourceRecordsInserted: 0,
          sourceRecordsUpdated: 0,
          relinkedSourceRecords: 0,
        },
        publication: { scope: "activities-and-streams", status: "available" },
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
      "Local library import: 1 ride file imported. 1 ride file quarantined. Coaching access to activities and streams is available.",
    );

    controller.importDroppedFiles(["/synthetic/quarantined.fit"]);
    await vi.waitFor(() => expect(onboardingBridge.importFiles).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "Local library import failed. 0 ride files imported. 2 ride files quarantined. No new ride files are available for coaching.",
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

  it.each([
    {
      source: "file-only",
      statuses: [],
      importRide: true,
      requiresProviderSync: false,
      readyCopy: "Ride files saved to your local library",
    },
    {
      source: "platform-only",
      statuses: [{ slot: "intervals-icu", state: "configured", runtimeState: "active" }] as const,
      importRide: false,
      requiresProviderSync: true,
      readyCopy: "Training data connected",
    },
    {
      source: "mixed",
      statuses: [{ slot: "intervals-icu", state: "configured", runtimeState: "active" }] as const,
      importRide: true,
      requiresProviderSync: true,
      readyCopy: "Training data connected",
    },
  ] as const)(
    "hands off the transient sync requirement for $source setup",
    async ({ statuses, importRide, requiresProviderSync, readyCopy }) => {
      const document = new FakeDocument();
      const onboardingBridge = bridge(async () => ({
        status: "configured",
        runtimeReady: true,
      }));
      onboardingBridge.credentialStatuses.mockResolvedValue(statuses);
      onboardingBridge.importFiles.mockResolvedValue({
        schemaVersion: 2,
        files: { total: 1, imported: 1, quarantined: 0 },
        changes: {
          rawFilesInserted: 1,
          sourceRecordsInserted: 1,
          sourceRecordsUpdated: 0,
          relinkedSourceRecords: 0,
        },
        publication: { scope: "activities-and-streams", status: "available" },
      });
      const onComplete = vi.fn();
      const controller = mountOnboarding({
        document: documentBoundary(document),
        bridge: onboardingBridge,
        opener: elementBoundary(document.createElement("button")),
        onComplete,
      });

      await controller.open();
      buttonWithText(document, "Continue").dispatch("click");
      await vi.waitFor(() => expect(controller.state().step).toBe("training-data"));
      if (importRide) {
        controller.importDroppedFiles(["/synthetic/setup.fit"]);
        await vi.waitFor(() => expect(controller.state().importedRideFileCount).toBe(1));
      }
      buttonWithText(document, "Continue").dispatch("click");
      await vi.waitFor(() => expect(controller.state().step).toBe("safety-intake"));
      radioInputFor(document, "prior-bsi", "No").dispatch("change");
      radioInputFor(document, "injury-status", "No current injury").dispatch("change");
      buttonWithText(document, "Continue").dispatch("click");
      await vi.waitFor(() => expect(controller.state().step).toBe("ready"));
      expect(
        document.body.querySelector(".ready-preview")?.children.map((child) => child.textContent),
      ).toEqual(["Keys secured", readyCopy, "Safety context saved"]);
      buttonWithText(document, "Finish setup").dispatch("click");

      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
      expect(onComplete).toHaveBeenCalledWith({
        providerConfigured: true,
        trainingDataConfigured: true,
        intakeSaved: true,
        requiresProviderSync,
      });
      controller.dispose();
    },
  );

  it("does not start a dropped import while the training-data step is submitting", async () => {
    const document = new FakeDocument();
    const baseBridge = bridge(async () => ({
      status: "configured",
      runtimeReady: true,
    }));
    const pendingWrite = deferred<CredentialWriteResult>();
    let credentialWriteCount = 0;
    const onboardingBridge: OnboardingBridge = {
      ...baseBridge,
      writeCredential() {
        credentialWriteCount += 1;
        return pendingWrite.promise;
      },
    };
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
    intervalsInput!.value = randomUUID();

    buttonWithText(document, "Continue").dispatch("click");
    await vi.waitFor(() => expect(credentialWriteCount).toBe(1));
    controller.importDroppedFiles(["/synthetic/during-submit.fit"]);
    expect(onboardingBridge.importFiles).not.toHaveBeenCalled();

    pendingWrite.resolve({ slot: "intervals-icu", status: "configured", runtimeReady: true });
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
      schemaVersion: 2,
      files: { total: 2, imported: 1, quarantined: 1 },
      changes: {
        rawFilesInserted: 1,
        sourceRecordsInserted: 1,
        sourceRecordsUpdated: 0,
        relinkedSourceRecords: 0,
      },
      publication: { scope: "activities-and-streams", status: "available" },
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
      "Local library import: 1 ride file imported. 1 ride file quarantined. Coaching access to activities and streams is available.",
    );

    controller.close();
    expect(presentationChanges).toHaveBeenLastCalledWith(false);
    controller.dispose();
  });
});
