import type {
  AthleteSettingsSaveError,
  AthleteSettingsValidationError,
} from "../../settings/athlete-controller.js";
import type { CredentialSettingsEntry } from "../../settings/credential-controller.js";
import type { ProviderModelValidationError } from "../../settings/provider-model-controller.js";
import type { SessionSettingField } from "../../settings/session-controller.js";

export const COACH_VALIDATION_COPY: Readonly<Record<ProviderModelValidationError, string>> = {
  "model-required": "Enter a model name.",
  "model-too-long": "Model names must be 512 characters or fewer.",
  "model-control-characters": "Model names can’t contain control characters.",
};

export const COACH_SAVE_ERROR_COPY = {
  "invalid-input": "That provider or model wasn’t accepted. Check the model name and try again.",
  "credential-required":
    "This provider needs a saved credential before it can coach you. Use the setup area above to add one.",
  "runtime-unavailable": "Coach settings couldn’t become active. Try saving again.",
  "request-failed": "Coach settings couldn’t be saved right now. Try again.",
} as const;

export const ATHLETE_VALIDATION_COPY: Readonly<Record<AthleteSettingsValidationError, string>> = {
  "athlete-required": "Enter the athlete ID for the connected training account.",
  "athlete-whitespace": "Athlete IDs cannot begin or end with whitespace.",
  "athlete-too-long": "Athlete IDs must be 512 characters or fewer.",
  "athlete-control-characters": "Athlete IDs can’t contain control characters.",
};

export const ATHLETE_SAVE_ERROR_COPY: Readonly<Record<AthleteSettingsSaveError, string>> = {
  "credential-required": "Connect the training account in Setup before saving its athlete ID.",
  "ownership-unavailable":
    "The connected training account couldn’t be verified. Reconnect and reload before trying again.",
  "training-account-mismatch":
    "That athlete ID does not identify the currently connected training account.",
  "managed-by-environment": "The athlete ID is managed outside Enduragent and wasn’t changed.",
  "request-failed": "The athlete ID couldn’t be saved. Your edit is still here.",
  "not-applied": "The athlete ID wasn’t applied. Reconnect and reload before trying again.",
  "runtime-unavailable":
    "The current training account couldn’t be reloaded. Your edit is still here.",
};

export const MANAGED_BY_ENVIRONMENT_COPY =
  "Managed by an environment variable. Change it outside Enduragent.";

export interface ConversationFieldDefinition {
  readonly field: SessionSettingField;
  readonly label: string;
  readonly help: string;
  readonly type: "text" | "number";
  readonly min?: string;
  readonly max?: string;
  readonly step?: string;
  readonly suffix?: string;
}

export const CONVERSATION_FIELDS: readonly ConversationFieldDefinition[] = [
  {
    field: "timezone",
    label: "Timezone",
    help: "Use an IANA timezone, such as Europe/London. Saving one here pins it, and Enduragent keeps it even when this computer’s timezone changes.",
    type: "text",
  },
  {
    field: "dailyResetHour",
    label: "Daily reset hour",
    help: "Athlete-local hour, from 0 to 23. A change may make your next message start a fresh conversation.",
    type: "number",
    min: "0",
    max: "23",
    step: "1",
  },
  {
    field: "idleMinutes",
    label: "Idle reset",
    help: "Whole minutes without a message before the conversation resets. Use 0 to turn this off.",
    type: "number",
    min: "0",
    step: "1",
    suffix: "minutes",
  },
  {
    field: "resetArchiveRetentionDays",
    label: "Archive retention",
    help: "Whole days to keep reset archives. Use 0 to keep them forever; changes apply only to future pruning.",
    type: "number",
    min: "0",
    step: "1",
    suffix: "days",
  },
  {
    field: "historyTokenBudgetRatio",
    label: "History budget",
    help: "Share of the model context reserved for conversation history, above 0% and up to 100%.",
    type: "number",
    min: "0",
    max: "100",
    step: "any",
    suffix: "%",
  },
] as const;

export function conversationSaveErrorCopy(
  reason: "request-failed" | "not-applied" | "runtime-unavailable",
): string {
  if (reason === "not-applied") {
    return "Conversation settings weren’t applied. Reconnect and reload before trying again.";
  }
  if (reason === "runtime-unavailable") {
    return "Current conversation settings couldn’t be reloaded. Your edits are still here.";
  }
  return "Conversation settings couldn’t be saved. Your edits are still here.";
}

export function credentialRuntimeLabel(state: CredentialSettingsEntry["runtimeState"]): string {
  if (state === "active") return "Active";
  if (state === "stored-inactive") return "Saved, not active";
  return "Needs attention";
}

export const RELEASE_NOTES_UNAVAILABLE_COPY =
  "Release notes aren’t available right now. Check your connection and try again.";
