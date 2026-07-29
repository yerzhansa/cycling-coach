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
