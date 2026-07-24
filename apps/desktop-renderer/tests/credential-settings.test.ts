import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfigSnapshot } from "@enduragent/coach-contract";
import type { DesktopCoachClientProvider } from "../src/coach-client.js";
import type { CredentialDeleteResult, DesktopCredentialId } from "../src/onboarding/bridge.js";
import type { ChatGptStatus, CredentialSlotStatus } from "../src/onboarding/machine.js";
import {
  createCredentialSettingsController,
  type CredentialSettingsState,
  type CredentialSettingsView,
} from "../src/settings/credential-controller.js";
import { createCredentialSettingsView } from "../src/settings/credential-view.js";
import { createResidentSettingsShell } from "../src/settings/shell.js";

function runtime(
  llm: RuntimeConfigSnapshot["llm"] = {
    provider: "anthropic",
    model: "synthetic-model",
    credential_configured: true,
  },
  intervals: RuntimeConfigSnapshot["intervals"] = {
    athlete_id: "synthetic-athlete",
    credential_configured: true,
    managedByEnvironment: { athleteId: false },
  },
): RuntimeConfigSnapshot {
  return {
    schemaVersion: 3,
    llm,
    intervals,
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "UTC",
      managedByEnvironment: {
        historyTokenBudgetRatio: false,
        idleMinutes: false,
        dailyResetHour: false,
        resetArchiveRetentionDays: false,
        timezone: false,
      },
    },
  };
}

function fakeView() {
  let handlers:
    | {
        readonly onRetry: () => void;
        readonly onRequestDelete: (credential: DesktopCredentialId) => void;
        readonly onCancelDelete: () => void;
        readonly onConfirmDelete: () => void;
        readonly onOpenSetup: () => void;
      }
    | undefined;
  const view: CredentialSettingsView = {
    bind: vi.fn((next) => {
      handlers = next;
    }),
    render: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    view,
    requestDelete: (credential: DesktopCredentialId) => handlers?.onRequestDelete(credential),
    cancelDelete: () => handlers?.onCancelDelete(),
    confirmDelete: () => handlers?.onConfirmDelete(),
    openSetup: () => handlers?.onOpenSetup(),
  };
}

function createSubject(input: {
  readonly runtime?: RuntimeConfigSnapshot;
  readonly statuses?: readonly CredentialSlotStatus[];
  readonly chatGpt?: ChatGptStatus;
  readonly deletion?: CredentialDeleteResult;
  readonly openSetup?: () => void;
}) {
  let activeRuntime = input.runtime ?? runtime();
  let statuses =
    input.statuses ??
    ([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
      { slot: "openrouter", state: "configured", runtimeState: "stored-inactive" },
    ] satisfies readonly CredentialSlotStatus[]);
  const chatGpt = input.chatGpt ?? { state: "configured", runtimeReady: false };
  const subject = fakeView();
  const client = {
    call: vi.fn(async () => activeRuntime),
  };
  const clients = {
    getClient: vi.fn(async () => client),
    reconnect: vi.fn(async () => client),
  } as unknown as DesktopCoachClientProvider;
  const deleteCredential = vi.fn(async ({ credential }: { credential: DesktopCredentialId }) => {
    const result =
      input.deletion ??
      ({
        credential,
        status: "deleted",
        cleanupPending: false,
      } satisfies CredentialDeleteResult);
    if (result.status === "deleted") {
      statuses = statuses.filter((status) => status.slot !== credential);
      if (credential === activeRuntime.llm.provider) {
        activeRuntime = runtime(
          { ...activeRuntime.llm, credential_configured: false },
          activeRuntime.intervals,
        );
      }
    }
    return result;
  });
  const controller = createCredentialSettingsController({
    clients,
    loadStatuses: async () => statuses,
    loadChatGptStatus: async () => chatGpt,
    deleteCredential,
    openSetup: input.openSetup ?? vi.fn(),
    beginMutation: () => vi.fn(),
    view: subject.view,
  });
  return { controller, subject, deleteCredential };
}

function content(state: CredentialSettingsState) {
  if (
    state.status === "ready" ||
    state.status === "confirming" ||
    state.status === "deleting" ||
    state.status === "deleted" ||
    (state.status === "error" && state.kind === "delete")
  ) {
    return state;
  }
  throw new Error(`Expected credential content, received ${state.status}`);
}

describe("credential settings controller", () => {
  it("builds a provider, kind, and coarse-state-only list for every stored credential kind", async () => {
    const { controller } = createSubject({});

    await controller.activate();

    expect(content(controller.state()).entries).toEqual([
      {
        credential: "anthropic",
        provider: "Anthropic",
        kind: "Provider API key",
        runtimeState: "active",
      },
      {
        credential: "openai-codex",
        provider: "ChatGPT",
        kind: "ChatGPT profile",
        runtimeState: "stored-inactive",
      },
      {
        credential: "openrouter",
        provider: "OpenRouter",
        kind: "Provider API key",
        runtimeState: "stored-inactive",
      },
      {
        credential: "intervals-icu",
        provider: "intervals.icu",
        kind: "Training account key",
        runtimeState: "active",
      },
    ]);
    const serialized = JSON.stringify(content(controller.state()).entries);
    expect(serialized).not.toContain("synthetic-model");
    expect(serialized).not.toContain("synthetic-athlete");
    expect(serialized).not.toContain("length");
    expect(serialized).not.toContain("hash");
  });

  it("confirmation-gates active deletion, announces the cutover, and exposes Setup recovery", async () => {
    const openSetup = vi.fn();
    const { controller, subject, deleteCredential } = createSubject({ openSetup });
    await controller.activate();

    subject.requestDelete("anthropic");
    expect(controller.state()).toMatchObject({
      status: "confirming",
      confirmation: "anthropic",
      focus: { target: "confirmation-cancel" },
    });
    subject.cancelDelete();
    expect(controller.state()).toMatchObject({
      status: "ready",
      confirmation: null,
      announcement: "Credential deletion cancelled.",
      focus: { target: "delete", credential: "anthropic" },
    });

    subject.requestDelete("anthropic");
    subject.confirmDelete();
    await vi.waitFor(() => expect(controller.state().status).toBe("deleted"));

    expect(deleteCredential).toHaveBeenCalledOnce();
    expect(controller.state()).toMatchObject({
      status: "deleted",
      announcement: "Credential deleted locally.",
      recoveryAvailable: true,
      focus: { target: "setup" },
    });
    subject.openSetup();
    expect(openSetup).toHaveBeenCalledOnce();
    expect(controller.state()).toEqual({ status: "closed" });
  });

  it("keeps an externally managed credential listed and announces the fixed refusal", async () => {
    const { controller, subject } = createSubject({
      statuses: [],
      chatGpt: { state: "absent", runtimeReady: false },
      deletion: {
        credential: "anthropic",
        status: "refused",
        reason: "managed-by-environment",
      },
    });
    await controller.activate();

    subject.requestDelete("anthropic");
    subject.confirmDelete();
    await vi.waitFor(() => expect(controller.state().status).toBe("error"));

    expect(controller.state()).toMatchObject({
      status: "error",
      kind: "delete",
      reason: "managed-by-environment",
      confirmation: null,
      announcement: "This credential is managed outside Settings and can’t be deleted here.",
      focus: { target: "delete", credential: "anthropic" },
    });
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
  private ownText = "";

  constructor(
    readonly tagName: string,
    private readonly document: FakeDocument,
  ) {}

  get parentElement(): FakeElement | null {
    return this.parent ?? null;
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.ownText = value;
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
    this.children.splice(0);
    this.ownText = "";
    this.append(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
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
}

function descendants(root: FakeElement): FakeElement[] {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

function find(root: FakeElement, className: string): FakeElement {
  const value = [root, ...descendants(root)].find((node) => node.className === className);
  if (value === undefined) throw new Error(`Missing ${className}`);
  return value;
}

describe("credential settings view", () => {
  it("uses accessible confirmation roles, deterministic focus, announcements, and the shell trap", () => {
    const document = new FakeDocument();
    const actionHost = new FakeElement("div", document);
    document.body.append(actionHost);
    const shell = createResidentSettingsShell({
      document: document as never,
      actionHost: actionHost as never,
    });
    const view = createCredentialSettingsView({
      document: document as never,
      shell,
    });
    const handlers = {
      onRetry: vi.fn(),
      onRequestDelete: vi.fn(),
      onCancelDelete: vi.fn(),
      onConfirmDelete: vi.fn(),
      onOpenSetup: vi.fn(),
    };
    view.bind(handlers);
    shell.open();
    const entry = {
      credential: "anthropic" as const,
      provider: "Anthropic",
      kind: "Provider API key" as const,
      runtimeState: "active" as const,
    };

    view.render({
      status: "confirming",
      entries: [entry],
      confirmation: "anthropic",
      announcement: "Confirm deletion of the Anthropic credential.",
      recoveryAvailable: false,
      focus: { target: "confirmation-cancel" },
    });

    const confirmation = find(document.body, "credential-settings__confirmation");
    const cancel = find(document.body, "credential-settings__cancel-delete");
    const remove = find(document.body, "credential-settings__confirm-delete");
    const feedback = find(document.body, "credential-settings__feedback");
    expect(confirmation.attributes.get("role")).toBe("group");
    expect(confirmation.attributes.get("aria-labelledby")).toBe(
      "credential-settings-confirm-anthropic",
    );
    expect(remove.attributes.get("aria-label")).toBe(
      "Confirm deletion of the Anthropic credential",
    );
    expect(feedback.attributes.get("role")).toBe("status");
    expect(feedback.attributes.get("aria-live")).toBe("polite");
    expect(document.activeElement).toBe(cancel);

    shell.setSectionSaving("credential", true);
    view.render({
      status: "deleting",
      entries: [entry],
      confirmation: "anthropic",
      announcement: "Deleting the Anthropic credential locally…",
      recoveryAvailable: false,
      focus: { target: "confirmation-delete" },
    });
    const deleting = find(document.body, "credential-settings__confirm-delete");
    expect(document.activeElement).toBe(deleting);
    expect(deleting.attributes.get("aria-disabled")).toBe("true");
    deleting.click();
    expect(handlers.onConfirmDelete).not.toHaveBeenCalled();

    shell.setSectionSaving("credential", false);
    view.render({
      status: "deleted",
      entries: [],
      confirmation: null,
      announcement: "Credential deleted locally.",
      recoveryAvailable: true,
      focus: { target: "setup" },
    });
    const setup = find(document.body, "credential-settings__setup");
    expect(document.activeElement).toBe(setup);
    const dialog = descendants(document.body).find((node) => node.tagName === "dialog")!;
    const preventDefault = vi.fn();
    dialog.dispatch("keydown", { key: "Tab", preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(find(document.body, "provider-model-settings__close"));
  });
});
