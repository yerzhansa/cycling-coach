import type { ChatGptLoginRefusalReason } from "../../onboarding/constants.js";
import type { SetupLane } from "../../onboarding/lanes.js";
import type { ChatGptUiPhase, OnboardingErrorCode } from "../../onboarding/machine.js";

export const ERROR_COPY: Readonly<Record<OnboardingErrorCode, string>> = {
  "credential-required": "Sign in with ChatGPT or add at least one model key to continue.",
  "credential-save-failed": "That key could not be saved. Try entering it again.",
  "invalid-input": "That key was not accepted. Check it and enter it again.",
  "encryption-unavailable":
    "macOS encryption is unavailable. Make sure Keychain is available, then try again.",
  "unsafe-backend": "The app cannot safely store that key with the current storage backend.",
  "storage-failed":
    "The app could not confirm that key was saved securely. Check that secure storage is available and try again.",
  "storage-uncertain":
    "The app could not prove which saved key will survive a restart. Re-enter the key before continuing.",
  "runtime-unavailable":
    "That key was saved, but it is not active yet. Choose Retry saved keys to activate it.",
  "credential-status-unavailable":
    "That key was saved, but its status could not be refreshed. Check the setup area again.",
  "credential-reenter-required": "That saved key could not be used. Enter it again to continue.",
  "configuration-unavailable":
    "Coach choices are unavailable right now. Check the setup area again.",
  "model-selection-required": "Choose a model or enter a custom model name.",
  "endpoint-invalid": "Enter a valid HTTPS endpoint, or a loopback HTTP endpoint.",
  "model-runtime-unavailable":
    "Your provider choice is saved, but it is not active yet. Try activating it again.",
  "training-account-mismatch":
    "That intervals.icu key belongs to a different athlete than the training history already stored. Switching accounts is not supported yet.",
  "intervals-clipboard-unavailable":
    "Enduragent couldn’t read an API key from the clipboard. Copy it in Intervals.icu, then try again.",
  "intervals-clipboard-clear-failed":
    "The API key wasn’t saved because Enduragent couldn’t safely clear it from the clipboard. Copy it again, then try again.",
  "intervals-key-rejected":
    "Intervals.icu didn’t accept the copied API key. Copy a current API key, then try again.",
  "intervals-validation-unavailable":
    "Enduragent couldn’t verify the copied API key with Intervals.icu. Check your connection, then try again.",
  "intervals-owner-unavailable":
    "Enduragent couldn’t confirm that the copied API key matches the training data on this Mac. Try again when training data is available.",
  "intervals-storage-uncertain":
    "Enduragent couldn’t confirm whether the copied API key was saved. Reload credential status before trying again.",
  "intervals-runtime-unavailable":
    "The copied API key couldn’t be activated. Copy it in Intervals.icu, then try again.",
  "intervals-runtime-uncertain":
    "Enduragent couldn’t confirm whether the copied API key is active. Reload credential status before trying again.",
  "training-data-required": "Connect intervals.icu or import at least one ride file.",
  "intake-incomplete": "Answer the required safety questions to continue.",
  "intake-save-failed": "Your answers could not be saved. Please try again.",
};

export const CLAUDE_CLI_LANE_COPY =
  "Uses the Claude Code CLI already installed and signed in on this Mac. No API key needed.";

export const CLAUDE_CLI_RECHECK_LABEL = "Check again";

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

export const SETUP_HEADING = "Get your coach running before you can chat";
export const SETUP_SETTINGS_HEADING = "Setup";

export const SETUP_CHAT_SUBTITLE =
  "Connect what your coach needs. Telegram is optional and never blocks Chat.";

export const SETUP_STATUS_UNAVAILABLE_COPY =
  "Setup status couldn’t be loaded. Check that Enduragent is running, then try again.";

export const RETRY_SETUP_STATUS_LABEL = "Retry setup status";

export const SETUP_MENU_LABEL = "AI that powers your coach";

export const SETUP_LANE_LABELS = {
  "claude-cli": "Claude Code",
  "openai-codex": "ChatGPT subscription",
  "api-key": "API key",
} as const satisfies Readonly<Record<SetupLane, string>>;

export const SETUP_LANE_MENU_HINTS = {
  "claude-cli": "Detected on this Mac",
  "openai-codex": "Use the plan you already pay for",
  "api-key": "9 providers · pay per use",
} as const satisfies Readonly<Record<SetupLane, string>>;

export const AI_ROW_UNSET = {
  title: "AI that powers your coach",
  subtitle: "Required — Enduragent doesn't include one",
} as const;

export const AI_ROW_PREFIX = "Powers your coach";

export const AI_ROW_PENDING = {
  "claude-cli": "sign in from a terminal to finish",
  "openai-codex": "sign in to finish",
  "api-key": "add a key to finish",
} as const satisfies Readonly<Record<SetupLane, string>>;

export const AI_TRIGGER_LABELS = {
  unset: "Choose what powers your coach",
  set: "Change what powers your coach",
} as const;

export const AI_SAVE_LABEL = "Save API key";

export const AI_CANCEL_LABEL = "Cancel API key setup";

export const CHATGPT_CANCEL_LABEL = "Cancel ChatGPT setup";

export const AI_PANEL_ANNOUNCEMENTS = {
  chatgpt: "ChatGPT sign-in opened below this row.",
  "api-key": "API key setup opened below this row.",
} as const;

export const AI_ROW_TOOLTIP = {
  label: "About the AI that powers your coach",
  lead: "Enduragent has no AI of its own",
  body: "It runs on a ChatGPT subscription, a Claude Code sign-in, or an API key you supply. Whichever you pick stays on this Mac.",
} as const;

export const CHATGPT_SIGN_IN_LABEL = "Sign in with ChatGPT";

export const CHATGPT_CANCEL_SIGN_IN_LABEL = "Cancel sign-in";

export const CHATGPT_RETRY_ACTIVATION_LABEL = "Retry activation";

export const CHATGPT_ACTIVATION_FAILURE_COPY =
  "Signed in, but the coach could not be activated. Retry without signing in again.";

export const CHATGPT_PHASE_COPY: Readonly<
  Record<Exclude<ChatGptUiPhase, "idle" | "login-failed" | "activation-failed">, string>
> = {
  "waiting-for-browser": "Waiting for browser…",
  "completing-sign-in": "Completing sign-in…",
  "signed-in": "Signed in",
  "activating-coach": "Activating coach…",
  ready: "Ready",
};

export const CHATGPT_PANEL_HINT =
  "Opens OpenAI's sign-in page in your browser — you type your password there, not here. Needs a paid plan.";

export const API_KEY_PANEL_HINT =
  "Created in the provider's console, billed per use — usually cents per conversation.";

export const TRAINING_ROW_TITLE = "Intervals.icu";

export const TRAINING_ROW_SUBTITLES = {
  connected: "Connected · where your rides come from",
  missing: "Required · where your rides come from",
} as const;

export const TRAINING_ROW_TOOLTIP = {
  label: "About Intervals.icu",
  lead: "Intervals.icu",
  body: "A free training site that already holds your rides. Enduragent reads them from there instead of talking to your watch or head-unit vendor directly. You need a free account with your watch or head unit connected to it, then copy its API key.",
} as const;

export const TRAINING_TRIGGER_LABELS = {
  disconnected: "Connect Intervals.icu",
} as const;

export const TRAINING_CANCEL_LABEL = "Cancel Intervals.icu setup";

export const TRAINING_CONNECT_TITLE = "Connect Intervals.icu";

export const INTERVALS_PANEL_HINT =
  "In Intervals.icu, open Settings → Developer Settings, copy the API key, then return here. Enduragent reads it without showing it.";

export const TRAINING_USE_COPIED_KEY_LABEL = "Use copied API key";

export const IMPORT_FILES_LABEL = "Import ride files instead";

export const TELEGRAM_ROW_TITLE = "Telegram";

export const TELEGRAM_OPTIONAL_LABEL = "Optional";

export const TELEGRAM_AVAILABILITY_COPY =
  "Telegram works while Enduragent is running and this Mac is awake and online.";

export const TELEGRAM_VERIFIED_PREFIX = "Bot verified";

export const TELEGRAM_CREATE_TITLE = "Create a bot with BotFather";

export const TELEGRAM_CREATE_COPY_AFTER_BOTFATHER =
  "for a bot, copy its token, then return here. Enduragent reads and verifies the token directly from the clipboard; the token is never shown.";

export const TELEGRAM_CREATE_COPY = `Ask @BotFather ${TELEGRAM_CREATE_COPY_AFTER_BOTFATHER}`;

export const TELEGRAM_DELETE_TITLE = "Delete the Telegram connection?";

export const TELEGRAM_DELETE_COPY =
  "This turns Telegram off and deletes the encrypted token and allowed-user access from this Mac. The Telegram bot and chat remain in Telegram.";

export const RETRY_SAVED_KEYS_LABEL = "Retry saved keys";

export const RETRY_INTAKE_SAVE_LABEL = "Retry saving answers";

export const FOOTER_NOTE = "Everything stays on this Mac.";

export const OUTSTANDING_NOTE = {
  coach: "Choose what powers your coach to finish.",
  training: "Connect intervals.icu to finish.",
  intake: "Answer the injury question to finish.",
  clearance: "Confirm clinician clearance above to finish.",
} as const;

export const PRIMARY_LABEL = "Start coaching";
