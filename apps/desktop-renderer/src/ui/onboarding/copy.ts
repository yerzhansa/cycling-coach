import type { ChatGptLoginRefusalReason } from "../../onboarding/constants.js";
import type { OnboardingErrorCode } from "../../onboarding/machine.js";

export const ERROR_COPY: Readonly<Record<OnboardingErrorCode, string>> = {
  "credential-required": "Sign in with ChatGPT or add at least one model key to continue.",
  "credential-save-failed": "That key could not be saved. Try entering it again.",
  "invalid-input": "That key was not accepted. Check it and enter it again.",
  "encryption-unavailable":
    "macOS encryption is unavailable. Make sure Keychain is available, then try again.",
  "unsafe-backend": "The app cannot safely store that key with the current storage backend.",
  "storage-failed":
    "The app could not confirm that key was saved securely. Check that secure storage is available and try again.",
  "runtime-unavailable":
    "That key was saved, but it is not active yet. Choose Retry saved keys to activate it.",
  "credential-status-unavailable":
    "That key was saved, but its status could not be refreshed. Close and reopen Setup to check again.",
  "credential-reenter-required": "That saved key could not be used. Enter it again to continue.",
  "configuration-unavailable":
    "Coach choices are unavailable right now. Close and reopen Setup to try again.",
  "model-selection-required": "Choose a model or enter a custom model name.",
  "endpoint-invalid": "Enter a valid HTTPS endpoint, or a loopback HTTP endpoint.",
  "model-runtime-unavailable":
    "Your provider choice is saved, but it is not active yet. Choose Continue to retry it.",
  "training-account-mismatch":
    "That intervals.icu key belongs to a different athlete than the training history already stored. Switching accounts is not supported yet.",
  "training-data-required": "Connect intervals.icu or import at least one ride file.",
  "intake-incomplete": "Answer the required safety questions to continue.",
  "intake-save-failed": "Your answers could not be saved. Please try again.",
};

export const CHATGPT_REFUSAL_COPY: Readonly<Record<ChatGptLoginRefusalReason, string>> = {
  "already-in-progress": "A ChatGPT sign-in is already in progress.",
  "callback-unavailable":
    "The local sign-in callback is unavailable. Close other sign-in flows and retry.",
  "timed-out": "ChatGPT sign-in timed out. Retry when you are ready.",
  cancelled: "ChatGPT sign-in was cancelled. You can retry.",
  "exchange-failed": "ChatGPT sign-in could not be completed. Please retry.",
  "storage-failed": "ChatGPT sign-in completed, but the profile could not be saved.",
  "runtime-unavailable": "ChatGPT sign-in was saved, but the coach could not be configured.",
};
