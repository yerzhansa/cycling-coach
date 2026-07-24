import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type {
  OnboardingLlmConfiguration,
  OnboardingLlmProviderConfiguration,
  OnboardingLlmSelectionResult,
} from "../src/onboarding/bridge.js";
import { CUSTOM_MODEL_SELECTION } from "../src/onboarding/constants.js";
import {
  createProviderModelSettingsController,
  type ProviderModelFormState,
  type ProviderModelSettingsController,
  type ProviderModelSettingsView,
} from "../src/settings/provider-model-controller.js";
import { createProviderModelSettingsView } from "../src/settings/provider-model-view.js";
import { createAthleteSettingsView } from "../src/settings/athlete-view.js";
import { createResidentSettingsShell } from "../src/settings/shell.js";
import { createSessionSettingsView } from "../src/settings/session-view.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const PROVIDERS = [
  {
    provider: "anthropic",
    defaultModel: "claude-sonnet",
    models: [
      { value: "claude-sonnet", label: "Claude Sonnet" },
      { value: "claude-opus", label: "Claude Opus" },
    ],
  },
  {
    provider: "openai",
    defaultModel: "gpt-standard",
    models: [
      { value: "gpt-standard", label: "GPT Standard" },
      { value: "gpt-reasoning", label: "GPT Reasoning", hint: "More deliberate" },
    ],
  },
] as const satisfies readonly OnboardingLlmProviderConfiguration[];

function configuration(
  active: OnboardingLlmConfiguration["active"] = {
    provider: "anthropic",
    model: "claude-sonnet",
  },
): OnboardingLlmConfiguration {
  return { schemaVersion: 1, providers: PROVIDERS, active };
}

function fakeView() {
  let handlers:
    | {
        readonly onOpen: () => void;
        readonly onClose: () => void;
        readonly onRetry: () => void;
        readonly onProviderChange: (provider: string) => void;
        readonly onModelChange: (model: string) => void;
        readonly onCustomModelChange: (model: string) => void;
        readonly onSave: () => void;
        readonly onOpenSetup: () => void;
      }
    | undefined;
  const view: ProviderModelSettingsView = {
    bind: vi.fn((value) => {
      handlers = value;
    }),
    open: vi.fn(),
    close: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    view,
    open: () => handlers?.onOpen(),
    close: () => handlers?.onClose(),
    retry: () => handlers?.onRetry(),
    provider: (value: string) => handlers?.onProviderChange(value),
    model: (value: string) => handlers?.onModelChange(value),
    customModel: (value: string) => handlers?.onCustomModelChange(value),
    save: () => handlers?.onSave(),
    openSetup: () => handlers?.onOpenSetup(),
  };
}

function createSubject(input: {
  readonly load?: () => Promise<OnboardingLlmConfiguration>;
  readonly apply?: () => Promise<OnboardingLlmSelectionResult>;
  readonly openSetup?: () => void;
}) {
  const subject = fakeView();
  const load = input.load ?? vi.fn(async () => configuration());
  const apply =
    input.apply ??
    vi.fn(async () => ({ status: "configured" as const, runtimeReady: true as const }));
  const controller = createProviderModelSettingsController({
    load,
    apply,
    openSetup: input.openSetup ?? vi.fn(),
    view: subject.view,
  });
  return { controller, subject, load, apply };
}

function formState(controller: ProviderModelSettingsController) {
  const state = controller.state();
  if (
    state.status !== "ready" &&
    state.status !== "saving" &&
    state.status !== "saved" &&
    !(state.status === "error" && state.kind === "save")
  ) {
    throw new Error(`Expected form state, received ${state.status}`);
  }
  return state;
}

describe("provider and model settings controller", () => {
  it("opens with visible loading state before resolving a known active model", async () => {
    const gate = deferred<OnboardingLlmConfiguration>();
    const { controller, subject } = createSubject({ load: vi.fn(() => gate.promise) });

    const pending = controller.activate();

    expect(subject.view.open).toHaveBeenCalled();
    expect(controller.state()).toEqual({ status: "loading" });
    expect(subject.view.render).toHaveBeenLastCalledWith({ status: "loading" });

    gate.resolve(configuration());
    await pending;
    expect(formState(controller)).toMatchObject({
      status: "ready",
      active: { provider: "anthropic", model: "claude-sonnet" },
      draft: {
        provider: { provider: "anthropic" },
        modelChoice: "claude-sonnet",
        customModel: "",
      },
      dirty: false,
      validationError: null,
    });
  });

  it("represents an unknown active model as Other without making it dirty", async () => {
    const { controller } = createSubject({
      load: vi.fn(async () => configuration({ provider: "anthropic", model: "claude-future" })),
    });

    await controller.activate();

    expect(formState(controller)).toMatchObject({
      status: "ready",
      draft: {
        modelChoice: CUSTOM_MODEL_SELECTION,
        customModel: "claude-future",
      },
      dirty: false,
      validationError: null,
    });
  });

  it("leaves active:null unconfigured until the athlete chooses a provider", async () => {
    const { controller, subject } = createSubject({
      load: vi.fn(async () => configuration(null)),
    });

    await controller.activate();
    expect(formState(controller)).toMatchObject({
      status: "ready",
      active: null,
      draft: null,
      dirty: false,
    });

    subject.provider("openai");
    expect(formState(controller)).toMatchObject({
      draft: {
        provider: { provider: "openai" },
        modelChoice: "gpt-standard",
      },
      dirty: true,
    });
  });

  it("uses each provider default first and retains a previously edited provider draft", async () => {
    const { controller, subject } = createSubject({});
    await controller.activate();

    subject.provider("openai");
    expect(formState(controller).draft).toMatchObject({
      provider: { provider: "openai" },
      modelChoice: "gpt-standard",
    });
    subject.model(CUSTOM_MODEL_SELECTION);
    subject.customModel("  gpt-private  ");
    subject.provider("anthropic");
    subject.model("claude-opus");
    subject.provider("openai");

    expect(formState(controller).draft).toMatchObject({
      provider: { provider: "openai" },
      modelChoice: CUSTOM_MODEL_SELECTION,
      customModel: "  gpt-private  ",
    });
  });

  it("validates trimmed custom model names for presence, length, and control characters", async () => {
    const { controller, subject, apply } = createSubject({});
    await controller.activate();
    subject.model(CUSTOM_MODEL_SELECTION);
    expect(formState(controller).validationError).toBe("model-required");

    subject.customModel(`valid\u0007name`);
    expect(formState(controller).validationError).toBe("model-control-characters");

    subject.customModel(`valid\u0085name`);
    expect(formState(controller).validationError).toBe("model-control-characters");

    subject.customModel("x".repeat(513));
    expect(formState(controller).validationError).toBe("model-too-long");
    subject.save();
    await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();

    subject.customModel(`  ${"x".repeat(512)}  `);
    expect(formState(controller).validationError).toBeNull();

    subject.save();
    await vi.waitFor(() => expect(controller.state().status).toBe("saved"));
    expect(apply).toHaveBeenCalledWith({
      provider: "anthropic",
      model: "x".repeat(512),
      endpoint: { mode: "automatic" },
    });

    subject.customModel("  claude-private  ");
    expect(formState(controller)).toMatchObject({
      validationError: null,
      dirty: true,
    });
  });

  it("submits the exact automatic-endpoint payload once and makes success current", async () => {
    const gate = deferred<OnboardingLlmSelectionResult>();
    const apply = vi.fn(() => gate.promise);
    const { controller, subject } = createSubject({ apply });
    await controller.activate();
    subject.model(CUSTOM_MODEL_SELECTION);
    subject.customModel("  claude-private  ");

    subject.save();
    subject.save();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply).toHaveBeenCalledWith({
      provider: "anthropic",
      model: "claude-private",
      endpoint: { mode: "automatic" },
    });
    expect(controller.state().status).toBe("saving");

    gate.resolve({ status: "configured", runtimeReady: true });
    await vi.waitFor(() => expect(controller.state().status).toBe("saved"));
    expect(formState(controller)).toMatchObject({
      status: "saved",
      active: { provider: "anthropic", model: "claude-private" },
      dirty: false,
    });
  });

  it.each(["invalid-input", "credential-required", "runtime-unavailable"] as const)(
    "retains the draft after %s and allows Save to retry",
    async (reason) => {
      const apply = vi
        .fn()
        .mockResolvedValueOnce({ status: "refused", reason })
        .mockResolvedValueOnce({ status: "configured", runtimeReady: true });
      const { controller, subject } = createSubject({ apply });
      await controller.activate();
      subject.provider("openai");
      subject.model("gpt-reasoning");

      subject.save();
      await vi.waitFor(() =>
        expect(controller.state()).toMatchObject({
          status: "error",
          kind: "save",
          reason,
          draft: {
            provider: { provider: "openai" },
            modelChoice: "gpt-reasoning",
          },
          dirty: true,
        }),
      );

      subject.save();
      await vi.waitFor(() => expect(controller.state().status).toBe("saved"));
      expect(apply).toHaveBeenCalledTimes(2);
    },
  );

  it("closes Settings before opening Setup for credential recovery", async () => {
    const sequence: string[] = [];
    const { controller, subject } = createSubject({
      apply: vi.fn(
        async (): Promise<OnboardingLlmSelectionResult> => ({
          status: "refused",
          reason: "credential-required",
        }),
      ),
      openSetup: () => sequence.push("setup"),
    });
    vi.mocked(subject.view.close).mockImplementation(() => sequence.push("close"));
    await controller.activate();
    subject.provider("openai");
    subject.save();
    await vi.waitFor(() => expect(controller.state().status).toBe("error"));

    subject.openSetup();

    expect(sequence).toEqual(["close", "setup"]);
    expect(controller.state()).toEqual({ status: "closed" });
  });

  it("ignores a stale load after close and reopen", async () => {
    const first = deferred<OnboardingLlmConfiguration>();
    const second = deferred<OnboardingLlmConfiguration>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { controller } = createSubject({ load });
    const firstOpen = controller.activate();
    controller.close();
    const secondOpen = controller.activate();

    first.resolve(configuration({ provider: "anthropic", model: "claude-future" }));
    await firstOpen;
    expect(controller.state()).toEqual({ status: "loading" });

    second.resolve(configuration({ provider: "openai", model: "gpt-standard" }));
    await secondOpen;
    expect(formState(controller)).toMatchObject({
      status: "ready",
      draft: { provider: { provider: "openai" }, modelChoice: "gpt-standard" },
    });
  });

  it("ignores a stale save after close and a fresh reload", async () => {
    const saveGate = deferred<OnboardingLlmSelectionResult>();
    const load = vi
      .fn()
      .mockResolvedValueOnce(configuration())
      .mockResolvedValueOnce(configuration({ provider: "openai", model: "gpt-standard" }));
    const { controller, subject } = createSubject({
      load,
      apply: vi.fn(() => saveGate.promise),
    });
    await controller.activate();
    subject.model("claude-opus");
    subject.save();
    await vi.waitFor(() => expect(controller.state().status).toBe("saving"));
    controller.close();
    await controller.activate();

    saveGate.resolve({ status: "configured", runtimeReady: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(formState(controller)).toMatchObject({
      status: "ready",
      active: { provider: "openai", model: "gpt-standard" },
      draft: { provider: { provider: "openai" }, modelChoice: "gpt-standard" },
    });
  });

  it.each(["load", "save"] as const)(
    "does not render a stale %s completion after disposal",
    async (operation) => {
      const loadGate = deferred<OnboardingLlmConfiguration>();
      const saveGate = deferred<OnboardingLlmSelectionResult>();
      const { controller, subject } = createSubject({
        load: operation === "load" ? vi.fn(() => loadGate.promise) : undefined,
        apply: vi.fn(() => saveGate.promise),
      });
      const pending = controller.activate();
      if (operation === "save") {
        await pending;
        subject.model("claude-opus");
        subject.save();
        await vi.waitFor(() => expect(controller.state().status).toBe("saving"));
      }
      const renders = vi.mocked(subject.view.render).mock.calls.length;
      controller.dispose();
      if (operation === "load") loadGate.resolve(configuration());
      else saveGate.resolve({ status: "configured", runtimeReady: true });
      await Promise.resolve();
      await Promise.resolve();

      expect(subject.view.render).toHaveBeenCalledTimes(renders);
      expect(subject.view.dispose).toHaveBeenCalledOnce();
      expect(controller.state()).toEqual({ status: "closed" });
    },
  );

  it("maps a rejected load to a retryable loading cycle", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("private detail"))
      .mockResolvedValueOnce(configuration());
    const { controller, subject } = createSubject({ load });
    await controller.activate();
    expect(controller.state()).toEqual({
      status: "error",
      kind: "load",
      reason: "configuration-unavailable",
    });

    subject.retry();
    await vi.waitFor(() => expect(controller.state().status).toBe("ready"));
    expect(load).toHaveBeenCalledTimes(2);
  });
});

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Set<(event: never) => void>>();
  parent: FakeElement | undefined;
  className = "";
  disabled = false;
  hidden = false;
  open = false;
  id = "";
  type = "";
  value = "";
  htmlFor = "";
  autocomplete = "";
  private ownText = "";

  constructor(
    readonly tagName: string,
    private readonly document: FakeDocument,
  ) {}

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.ownText = value;
    for (const child of this.children) child.parent = undefined;
    this.children.splice(0);
  }

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
    if (index === -1) this.children.push(node);
    else this.children.splice(index, 0, node);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of this.children) child.parent = undefined;
    this.children.splice(0);
    this.ownText = "";
    this.append(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(name: string, listener: (event: never) => void): void {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name: string, listener: (event: never) => void): void {
    this.listeners.get(name)?.delete(listener);
  }

  dispatch(name: string, event: Record<string, unknown> = {}): void {
    const value = {
      target: this,
      preventDefault() {},
      shiftKey: false,
      ...event,
    };
    for (const listener of this.listeners.get(name) ?? []) listener(value as never);
  }

  click(): void {
    if (!this.disabled) this.dispatch("click");
  }

  focus(): void {
    if (!this.disabled) this.document.activeElement = this;
  }

  showModal(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
  }

  remove(): void {
    if (this.parent === undefined) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = undefined;
  }
}

class FakeDocument {
  readonly body = new FakeElement("body", this);
  activeElement: FakeElement | null = this.body;

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

function find(root: FakeElement, predicate: (node: FakeElement) => boolean): FakeElement {
  const value = [root, ...descendants(root)].find(predicate);
  if (value === undefined) throw new Error("Element not found");
  return value;
}

function readyState(
  overrides: Partial<ProviderModelFormState & { readonly status: "ready" }> = {},
): ProviderModelFormState & { readonly status: "ready" } {
  return {
    status: "ready",
    providers: PROVIDERS,
    active: { provider: "anthropic", model: "claude-sonnet" },
    draft: {
      provider: PROVIDERS[0],
      modelChoice: "claude-opus",
      customModel: "",
    },
    dirty: true,
    validationError: null,
    ...overrides,
  };
}

describe("provider and model settings view", () => {
  it("announces loading, empty, saved, and refusal states in athlete-facing copy", () => {
    const document = new FakeDocument();
    const actionHost = new FakeElement("div", document);
    document.body.append(actionHost);
    const view = createProviderModelSettingsView({
      document: document as never,
      actionHost: actionHost as never,
    });
    view.open();
    view.render({ status: "loading" });
    const dialog = find(document.body, (node) => node.tagName === "dialog");
    const close = find(dialog, (node) => node.className === "provider-model-settings__close");
    expect(dialog.open).toBe(true);
    expect(document.activeElement).toBe(close);
    expect(dialog.textContent).toContain("Loading coach settings…");

    view.render({
      status: "ready",
      providers: PROVIDERS,
      active: null,
      draft: null,
      dirty: false,
      validationError: null,
    });
    const provider = find(dialog, (node) => node.id === "provider-model-settings-provider");
    const route = find(dialog, (node) => node.className === "coach-route");
    const save = find(dialog, (node) => node.className === "provider-model-settings__save");
    expect(provider.value).toBe("");
    expect(route.textContent).toContain("Not configured");
    expect(route.attributes.get("aria-label")).toBe("Coach route: not configured.");
    expect(dialog.textContent).toContain(
      "Active coach settings are unavailable or not configured.",
    );
    expect(save.disabled).toBe(true);

    view.render({
      ...readyState(),
      status: "saved",
      active: { provider: "anthropic", model: "claude-opus" },
      dirty: false,
    });
    expect(dialog.textContent).toContain("Coach settings saved.");
    expect(route.textContent).toContain("Anthropic→Claude OpusActive");
    expect(save.disabled).toBe(true);

    for (const [reason, copy] of [
      [
        "invalid-input",
        "That provider or model wasn’t accepted. Check the model name and try again.",
      ],
      [
        "credential-required",
        "This provider needs a saved credential before it can coach you. Open Setup to add one.",
      ],
      ["runtime-unavailable", "Coach settings couldn’t become active. Try saving again."],
    ] as const) {
      view.render({
        ...readyState(),
        status: "error",
        kind: "save",
        reason,
      });
      expect(dialog.textContent).toContain(copy);
    }
  });

  it("renders Other, disables every dialog control while saving, traps focus, and guards close", () => {
    const document = new FakeDocument();
    const actionHost = new FakeElement("div", document);
    document.body.append(actionHost);
    const view = createProviderModelSettingsView({
      document: document as never,
      actionHost: actionHost as never,
    });
    const onClose = vi.fn(() => view.close());
    view.bind({
      onOpen: vi.fn(),
      onClose,
      onRetry: vi.fn(),
      onProviderChange: vi.fn(),
      onModelChange: vi.fn(),
      onCustomModelChange: vi.fn(),
      onSave: vi.fn(),
      onOpenSetup: vi.fn(),
    });
    view.open();
    const dialog = find(document.body, (node) => node.tagName === "dialog");
    const close = find(dialog, (node) => node.className === "provider-model-settings__close");
    const save = find(dialog, (node) => node.className === "provider-model-settings__save");
    const custom = find(dialog, (node) => node.id === "provider-model-settings-custom-model");
    const customField = find(dialog, (node) =>
      node.className.includes("provider-model-settings__custom"),
    );
    view.render({
      ...readyState(),
      active: { provider: "anthropic", model: "claude-future" },
      draft: {
        provider: PROVIDERS[0],
        modelChoice: CUSTOM_MODEL_SELECTION,
        customModel: "claude-future",
      },
      dirty: false,
    });
    expect(customField.hidden).toBe(false);
    expect(custom.value).toBe("claude-future");
    expect(custom.attributes.has("aria-invalid")).toBe(false);

    view.render({
      ...readyState(),
      draft: {
        provider: PROVIDERS[0],
        modelChoice: CUSTOM_MODEL_SELECTION,
        customModel: "",
      },
      validationError: "model-required",
    });
    expect(custom.attributes.get("aria-invalid")).toBe("true");
    const validation = find(dialog, (node) => node.id === "provider-model-settings-validation");
    expect(validation.attributes.get("aria-live")).toBe("polite");
    expect(validation.attributes.get("aria-atomic")).toBe("true");

    view.render({ ...readyState(), status: "saving" });
    const controls = descendants(dialog).filter((node) =>
      ["button", "select", "input"].includes(node.tagName),
    );
    expect(controls.every((control) => control.disabled)).toBe(true);
    const preventDefault = vi.fn();
    dialog.dispatch("cancel", { preventDefault });
    dialog.dispatch("click", { target: dialog });
    expect(preventDefault).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);

    view.render(readyState());
    save.focus();
    dialog.dispatch("keydown", { key: "Tab", preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(document.activeElement).toBe(close);
    dialog.dispatch("cancel", { preventDefault });
    expect(onClose).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(false);
    const opener = find(actionHost, (node) => node.className === "provider-model-settings-button");
    expect(opener.attributes.get("aria-label")).toBe("Coach settings");
    expect(document.activeElement).toBe(opener);

    view.open();
    dialog.dispatch("click", { target: dialog });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(dialog.open).toBe(false);
  });

  it("ships compact topbar, mobile dialog, and reduced-motion treatment", async () => {
    const styles = await readFile(new URL("../src/settings/styles.css", import.meta.url), "utf8");
    expect(styles).toContain("@media (max-width: 760px)");
    expect(styles).toContain('content: "Coach"');
    expect(styles).toContain("@media (max-width: 440px)");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain("animation: none");
  });
});

describe("resident settings shell", () => {
  it("hosts three independent forms, shares mutation state, and contains focus", () => {
    const document = new FakeDocument();
    const actionHost = new FakeElement("div", document);
    document.body.append(actionHost);
    const shell = createResidentSettingsShell({
      document: document as never,
      actionHost: actionHost as never,
    });
    expect(document.body.textContent).toContain("review the currently connected training account");
    const providerView = createProviderModelSettingsView({
      document: document as never,
      shell,
    });
    const athleteView = createAthleteSettingsView({
      document: document as never,
      shell,
    });
    const sessionView = createSessionSettingsView({
      document: document as never,
      shell,
    });
    const onClose = vi.fn(() => shell.close());
    shell.bind({ onOpen: vi.fn(), onClose });
    providerView.render(readyState());
    athleteView.render({
      status: "ready",
      effective: {
        athlete_id: "current-athlete",
        credential_configured: true,
        managedByEnvironment: { athleteId: false },
      },
      draft: "candidate-athlete",
      dirty: true,
      validationError: null,
    });
    sessionView.render({
      status: "ready",
      effective: {
        timezone: "UTC",
        dailyResetHour: 4,
        idleMinutes: 0,
        resetArchiveRetentionDays: 0,
        historyTokenBudgetRatio: 0.3,
        managedByEnvironment: {
          timezone: true,
          dailyResetHour: false,
          idleMinutes: false,
          resetArchiveRetentionDays: false,
          historyTokenBudgetRatio: false,
        },
      },
      draft: {
        timezone: "UTC",
        dailyResetHour: "5",
        idleMinutes: "0",
        resetArchiveRetentionDays: "0",
        historyTokenBudgetRatio: "30",
      },
      dirtyFields: new Set(["dailyResetHour"]),
      validationErrors: {},
    });

    const opener = find(actionHost, (node) => node.className === "provider-model-settings-button");
    opener.click();
    const dialogs = descendants(document.body).filter((node) => node.tagName === "dialog");
    expect(dialogs).toHaveLength(1);
    const dialog = dialogs[0]!;
    expect(dialog.textContent).toContain("Provider & model");
    expect(dialog.textContent).toContain("Training account");
    expect(dialog.textContent).toContain("Conversation & time");
    expect(descendants(dialog).filter((node) => node.tagName === "fieldset")).toHaveLength(3);

    const timezone = find(dialog, (node) => node.id === "session-settings-timezone");
    const timezoneManaged = find(dialog, (node) => node.id === "session-settings-timezone-managed");
    expect(timezone.disabled).toBe(true);
    expect(timezoneManaged.hidden).toBe(false);
    expect(timezoneManaged.textContent).toContain("Managed by an environment variable");
    expect(timezone.attributes.get("aria-describedby")).toContain(
      "session-settings-timezone-managed",
    );
    const sessionFeedback = find(dialog, (node) => node.className === "session-settings__feedback");
    expect(sessionFeedback.attributes.get("aria-live")).toBe("polite");
    expect(sessionFeedback.attributes.get("aria-atomic")).toBe("true");
    const dailyResetError = find(
      dialog,
      (node) => node.id === "session-settings-dailyResetHour-error",
    );
    expect(dailyResetError.attributes.get("aria-live")).toBe("polite");
    expect(dailyResetError.attributes.get("aria-atomic")).toBe("true");

    sessionView.render({
      status: "saving",
      effective: {
        timezone: "UTC",
        dailyResetHour: 4,
        idleMinutes: 0,
        resetArchiveRetentionDays: 0,
        historyTokenBudgetRatio: 0.3,
        managedByEnvironment: {
          timezone: true,
          dailyResetHour: false,
          idleMinutes: false,
          resetArchiveRetentionDays: false,
          historyTokenBudgetRatio: false,
        },
      },
      draft: {
        timezone: "UTC",
        dailyResetHour: "5",
        idleMinutes: "0",
        resetArchiveRetentionDays: "0",
        historyTokenBudgetRatio: "30",
      },
      dirtyFields: new Set(["dailyResetHour"]),
      validationErrors: {},
    });
    const provider = find(dialog, (node) => node.id === "provider-model-settings-provider");
    const athlete = find(dialog, (node) => node.id === "athlete-settings-id");
    const close = find(dialog, (node) => node.className === "provider-model-settings__close");
    expect(provider.disabled).toBe(true);
    expect(athlete.disabled).toBe(true);
    expect(close.disabled).toBe(true);
    const preventDefault = vi.fn();
    dialog.dispatch("cancel", { preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);

    sessionView.render({
      status: "ready",
      effective: {
        timezone: "UTC",
        dailyResetHour: 5,
        idleMinutes: 0,
        resetArchiveRetentionDays: 0,
        historyTokenBudgetRatio: 0.3,
        managedByEnvironment: {
          timezone: true,
          dailyResetHour: false,
          idleMinutes: false,
          resetArchiveRetentionDays: false,
          historyTokenBudgetRatio: false,
        },
      },
      draft: {
        timezone: "UTC",
        dailyResetHour: "5",
        idleMinutes: "0",
        resetArchiveRetentionDays: "0",
        historyTokenBudgetRatio: "30",
      },
      dirtyFields: new Set(),
      validationErrors: {},
    });
    const sessionSave = find(dialog, (node) => node.className === "session-settings__save");
    sessionSave.disabled = false;
    sessionSave.focus();
    dialog.dispatch("keydown", { key: "Tab", preventDefault });
    expect(document.activeElement).toBe(close);
    dialog.dispatch("cancel", { preventDefault });
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(opener);

    sessionView.dispose();
    athleteView.dispose();
    providerView.dispose();
    shell.dispose();
  });
});
