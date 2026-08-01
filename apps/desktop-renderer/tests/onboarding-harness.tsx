import { act, render, type RenderResult } from "@testing-library/react";
import { vi } from "vitest";
import type { OnboardingBridge, OnboardingLlmConfiguration } from "../src/onboarding/bridge.js";
import {
  createOnboardingController,
  type OnboardingController,
} from "../src/onboarding/controller.js";
import type { ChatGptLoginResult, OnboardingCompletion } from "../src/onboarding/machine.js";
import type { RideImportController } from "../src/ride-import.js";
import { createOnboardingViewAdapter } from "../src/state/adapters/onboarding.js";
import { credentialDrafts } from "../src/state/credential-drafts.js";
import { CLOSED_ONBOARDING } from "../src/state/onboarding-slice.js";
import { useEnduragentStore } from "../src/state/store.js";
import { OnboardingWizard } from "../src/ui/onboarding/OnboardingWizard.js";

export interface MountedWizard {
  readonly controller: OnboardingController;
  readonly focusOpener: ReturnType<typeof vi.fn<() => void>>;
  readonly rendered: RenderResult;
  open(): Promise<void>;
}

export function resetOnboardingStore(): void {
  useEnduragentStore.setState({
    onboarding: CLOSED_ONBOARDING,
    onboardingActions: null,
  });
}

export function mountWizard(input: {
  readonly bridge: OnboardingBridge;
  readonly rideImports?: RideImportController;
  readonly onRideImportPresentationChange?: (presenting: boolean) => void;
  readonly onComplete?: (completion: OnboardingCompletion) => void;
}): MountedWizard {
  const focusOpener = vi.fn<() => void>();
  const adapter = createOnboardingViewAdapter({
    publish: (next) => useEnduragentStore.getState().setOnboarding(next),
  });
  const controller = createOnboardingController({
    bridge: input.bridge,
    credentials: credentialDrafts,
    view: adapter.view,
    ...(input.rideImports === undefined ? {} : { rideImports: input.rideImports }),
    ...(input.onRideImportPresentationChange === undefined
      ? {}
      : { onRideImportPresentationChange: input.onRideImportPresentationChange }),
    focusOpener,
    onComplete: input.onComplete ?? vi.fn(),
  });
  useEnduragentStore.getState().bindOnboardingActions(controller);
  const rendered = render(<OnboardingWizard />);

  return {
    controller,
    focusOpener,
    rendered,
    async open() {
      await act(async () => {
        await controller.open();
      });
    },
  };
}

export function passwordInput(slot: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(`input[data-slot="${slot}"]`);
  if (input === null) throw new Error(`Password input not found: ${slot}`);
  return input;
}

export function control<T extends HTMLElement>(id: string): T {
  const element = document.querySelector<T>(`#${id}`);
  if (element === null) throw new Error(`Control not found: ${id}`);
  return element;
}

export function credentialBadge(slot: string): HTMLElement {
  const badge = passwordInput(slot).parentElement?.querySelector<HTMLElement>(".credential-state");
  if (badge === null || badge === undefined) throw new Error(`Badge not found: ${slot}`);
  return badge;
}

export function credentialBadges(): readonly HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".credential-state"));
}

export function errorText(): string {
  return document.querySelector("#onboarding-error")?.textContent ?? "";
}

export function retryButtons(): readonly HTMLButtonElement[] {
  return Array.from(document.querySelectorAll("button")).filter(
    (button) => button.textContent === "Retry saved keys",
  );
}

export function seedSecret(slot: string, secret: string): HTMLInputElement {
  const input = passwordInput(slot);
  input.value = secret;
  return input;
}

export const TEST_LLM_CONFIGURATION: OnboardingLlmConfiguration = {
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
      models: [{ value: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
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

export type TestBridge = OnboardingBridge & {
  readonly credentialStatuses: ReturnType<typeof vi.fn<OnboardingBridge["credentialStatuses"]>>;
  readonly retryFailedCredentials: ReturnType<
    typeof vi.fn<OnboardingBridge["retryFailedCredentials"]>
  >;
  readonly llmConfiguration: ReturnType<typeof vi.fn<OnboardingBridge["llmConfiguration"]>>;
  readonly applyLlmSelection: ReturnType<typeof vi.fn<OnboardingBridge["applyLlmSelection"]>>;
  readonly chatGptStatus: ReturnType<typeof vi.fn<OnboardingBridge["chatGptStatus"]>>;
  readonly chatGptLogin: ReturnType<typeof vi.fn<OnboardingBridge["chatGptLogin"]>>;
  readonly claudeCliStatus: ReturnType<typeof vi.fn<OnboardingBridge["claudeCliStatus"]>>;
  readonly claudeCliRecheck: ReturnType<typeof vi.fn<OnboardingBridge["claudeCliRecheck"]>>;
  readonly writeCredential: ReturnType<typeof vi.fn<OnboardingBridge["writeCredential"]>>;
  readonly importFiles: ReturnType<typeof vi.fn<OnboardingBridge["importFiles"]>>;
  readonly chooseImportFiles: ReturnType<typeof vi.fn<OnboardingBridge["chooseImportFiles"]>>;
  readonly onDroppedImportFiles: ReturnType<typeof vi.fn<OnboardingBridge["onDroppedImportFiles"]>>;
  readonly saveIntake: ReturnType<typeof vi.fn<OnboardingBridge["saveIntake"]>>;
};

export function testBridge(login: () => Promise<ChatGptLoginResult>): TestBridge {
  return {
    credentialStatuses: vi.fn<OnboardingBridge["credentialStatuses"]>(async () => []),
    retryFailedCredentials: vi.fn<OnboardingBridge["retryFailedCredentials"]>(async () => []),
    writeCredential: vi.fn<OnboardingBridge["writeCredential"]>(async ({ slot }) => ({
      slot,
      status: "configured",
      runtimeReady: true,
    })),
    llmConfiguration: vi.fn<OnboardingBridge["llmConfiguration"]>(
      async () => TEST_LLM_CONFIGURATION,
    ),
    applyLlmSelection: vi.fn<OnboardingBridge["applyLlmSelection"]>(async () => ({
      status: "configured",
      runtimeReady: true,
    })),
    chatGptStatus: vi.fn<OnboardingBridge["chatGptStatus"]>(async () => ({
      state: "configured",
      runtimeReady: true,
    })),
    chatGptLogin: vi.fn<OnboardingBridge["chatGptLogin"]>(login),
    claudeCliStatus: vi.fn<OnboardingBridge["claudeCliStatus"]>(async () => ({
      state: "not-logged-in",
    })),
    claudeCliRecheck: vi.fn<OnboardingBridge["claudeCliRecheck"]>(async () => ({
      state: "not-logged-in",
    })),
    chooseImportFiles: vi.fn<OnboardingBridge["chooseImportFiles"]>(async () => []),
    onDroppedImportFiles: vi.fn<OnboardingBridge["onDroppedImportFiles"]>(() => () => {}),
    importFiles: vi.fn<OnboardingBridge["importFiles"]>(async () => ({
      schemaVersion: 2,
      files: { total: 0, imported: 0, quarantined: 0 },
      changes: {
        rawFilesInserted: 0,
        sourceRecordsInserted: 0,
        sourceRecordsUpdated: 0,
        relinkedSourceRecords: 0,
      },
      publication: { scope: "activities-and-streams", status: "available" },
    })),
    saveIntake: vi.fn<OnboardingBridge["saveIntake"]>(async () => {}),
  };
}

export function importResult(input: {
  readonly total: number;
  readonly imported: number;
  readonly quarantined: number;
}) {
  return {
    schemaVersion: 2 as const,
    files: input,
    changes: {
      rawFilesInserted: input.imported,
      sourceRecordsInserted: input.imported,
      sourceRecordsUpdated: 0,
      relinkedSourceRecords: 0,
    },
    publication: { scope: "activities-and-streams" as const, status: "available" as const },
  };
}
