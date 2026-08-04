import {
  AI_ROW_PENDING,
  AI_ROW_PREFIX,
  AI_ROW_UNSET,
  SETUP_LANE_LABELS,
} from "../ui/onboarding/copy.js";
import type { OnboardingLlmConfiguration, OnboardingLlmProviderConfiguration } from "./bridge.js";
import { claudeCliPresentation } from "./credential-presentation.js";
import { claudeCliReady, type OnboardingErrorCode, type OnboardingState } from "./machine.js";

export const KEYLESS_SETUP_LANES = ["claude-cli", "openai-codex"] as const;

export type SetupLane = (typeof KEYLESS_SETUP_LANES)[number] | "api-key";

export type SetupErrorSection = "provider" | "training" | "intake" | "footer";

export type SetupCommit = "provider" | "training" | null;

export interface AiRowCopy {
  readonly title: string;
  readonly subtitle: string;
}

export function laneForProvider(provider: string | null | undefined): SetupLane | null {
  if (provider === null || provider === undefined) return null;
  return KEYLESS_SETUP_LANES.find((lane) => lane === provider) ?? "api-key";
}

export function apiKeyProviders(
  configuration: OnboardingLlmConfiguration | null,
): readonly OnboardingLlmProviderConfiguration[] {
  if (configuration === null) return [];
  return configuration.providers.filter((entry) => laneForProvider(entry.provider) === "api-key");
}

function offersProvider(
  configuration: OnboardingLlmConfiguration | null,
  provider: string,
): boolean {
  return configuration?.providers.some((entry) => entry.provider === provider) ?? false;
}

export function offeredLanes(
  configuration: OnboardingLlmConfiguration | null,
  wizard: OnboardingState,
  currentLane: SetupLane | null = null,
): readonly SetupLane[] {
  if (configuration === null) return [];
  const lanes: SetupLane[] = [];
  if (
    offersProvider(configuration, "claude-cli") &&
    (claudeCliReady(wizard) || currentLane === "claude-cli")
  ) {
    lanes.push("claude-cli");
  }
  if (offersProvider(configuration, "openai-codex")) lanes.push("openai-codex");
  if (apiKeyProviders(configuration).length > 0) lanes.push("api-key");
  return lanes;
}

export function aiRowCopy(
  lane: SetupLane | null,
  wizard: OnboardingState,
  ready: boolean,
): AiRowCopy {
  if (lane === null) return { title: AI_ROW_UNSET.title, subtitle: AI_ROW_UNSET.subtitle };
  const title = SETUP_LANE_LABELS[lane];
  if (!ready) return { title, subtitle: `${AI_ROW_PREFIX} · ${AI_ROW_PENDING[lane]}` };
  if (lane === "claude-cli" && wizard.claudeCliIdentity !== null) {
    return { title, subtitle: `${AI_ROW_PREFIX} · ${wizard.claudeCliIdentity}` };
  }
  return { title, subtitle: AI_ROW_PREFIX };
}

export function claudeCliNote(
  configuration: OnboardingLlmConfiguration | null,
  wizard: OnboardingState,
  currentLane: SetupLane | null = null,
): string | null {
  if (!offersProvider(configuration, "claude-cli")) return null;
  if (offeredLanes(configuration, wizard, currentLane).includes("claude-cli")) return null;
  return claudeCliPresentation(wizard.claudeCliState).detail;
}

type SectionRule = SetupErrorSection | "commit";

const ERROR_SECTIONS: Readonly<Record<OnboardingErrorCode, SectionRule>> = {
  "credential-required": "provider",
  "configuration-unavailable": "provider",
  "model-selection-required": "provider",
  "endpoint-invalid": "provider",
  "model-runtime-unavailable": "provider",
  "training-account-mismatch": "training",
  "training-data-required": "training",
  "intake-incomplete": "intake",
  "intake-save-failed": "intake",
  "credential-save-failed": "commit",
  "invalid-input": "commit",
  "encryption-unavailable": "commit",
  "unsafe-backend": "commit",
  "storage-failed": "commit",
  "runtime-unavailable": "commit",
  "credential-status-unavailable": "commit",
  "credential-reenter-required": "commit",
};

export function errorSection(
  code: OnboardingErrorCode | null,
  lastCommit: SetupCommit,
): SetupErrorSection {
  if (code === null) return "footer";
  const rule = ERROR_SECTIONS[code];
  if (rule !== "commit") return rule;
  if (lastCommit === "provider") return "provider";
  if (lastCommit === "training") return "training";
  return "footer";
}
