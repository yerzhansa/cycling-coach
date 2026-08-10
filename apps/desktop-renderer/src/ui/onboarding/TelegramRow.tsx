import { useEffect, useRef, useState, type ReactElement } from "react";
import type {
  TelegramControlStatus,
  TelegramSettingsFeedback,
  TelegramSettingsState,
} from "../../settings/telegram-controller.js";
import { settingsMutationActive, type TelegramSettingsPort } from "../../state/settings-slice.js";
import { useEnduragentStore } from "../../state/store.js";
import {
  TELEGRAM_AVAILABILITY_COPY,
  TELEGRAM_CREATE_COPY_AFTER_BOTFATHER,
  TELEGRAM_CREATE_TITLE,
  TELEGRAM_OPTIONAL_LABEL,
  TELEGRAM_REMOVE_COPY,
  TELEGRAM_REMOVE_TITLE,
  TELEGRAM_REPLACEMENT_COPY,
  TELEGRAM_ROW_TITLE,
  TELEGRAM_VERIFIED_PREFIX,
} from "./copy.js";
import { BUTTON_DANGER_SM, BUTTON_QUIET_SM, BUTTON_SOLID_SM } from "./SetupCard.js";
import { SetupRow, SetupSubPanel } from "./SetupRow.js";

type TelegramPanel = "closed" | "token" | "remove";
type TelegramAction = "paste-token" | "remove";
type TelegramAttemptPhase = "requested" | "working" | "settled";

interface TelegramAttempt {
  readonly action: TelegramAction;
  readonly feedbackBefore: TelegramSettingsFeedback | null;
  readonly feedback: TelegramSettingsFeedback | null;
  readonly panelDismissed: boolean;
  readonly phase: TelegramAttemptPhase;
  readonly verifiedUsernameBefore: string | null;
}

type TelegramIdentity =
  | { readonly kind: "verified"; readonly username: string }
  | { readonly kind: "missing" | "unknown" };

const persistedTelegramAttempts = new WeakMap<TelegramSettingsPort, TelegramAttempt>();

function content(state: TelegramSettingsState) {
  if (state.status === "ready" || state.status === "working" || state.status === "error") {
    return state;
  }
  return null;
}

function identity(telegram: TelegramControlStatus | null): TelegramIdentity {
  if (telegram?.credentialConfigured === true && telegram.bot.state !== "unconfigured") {
    return { kind: "verified", username: telegram.bot.username };
  }
  if (
    telegram?.credentialConfigured === false &&
    telegram.bot.state === "unconfigured" &&
    (telegram.channel.state === "disabled" || telegram.channel.state === "waiting-for-credential")
  ) {
    return { kind: "missing" };
  }
  return { kind: "unknown" };
}

function sameFeedback(
  left: TelegramSettingsFeedback | null,
  right: TelegramSettingsFeedback | null,
): boolean {
  return left?.tone === right?.tone && left?.message === right?.message;
}

function fallbackFeedback(action: TelegramAction): TelegramSettingsFeedback {
  return {
    tone: "error",
    message:
      action === "paste-token"
        ? "The copied token was not applied. The current Telegram bot is unchanged."
        : "The Telegram bot was not removed from this Mac.",
  };
}

function applied(attempt: TelegramAttempt, state: TelegramSettingsState): boolean {
  const current = content(state);
  if (state.status !== "ready" || current?.feedback?.tone !== "success") return false;
  const currentIdentity = identity(current.telegram);
  return attempt.action === "paste-token"
    ? currentIdentity.kind === "verified"
    : currentIdentity.kind === "missing";
}

function persistAttempt(
  port: TelegramSettingsPort | null,
  attempt: TelegramAttempt | null,
): TelegramAttempt | null {
  if (port === null) return attempt;
  if (attempt === null) persistedTelegramAttempts.delete(port);
  else persistedTelegramAttempts.set(port, attempt);
  return attempt;
}

function restoreAttempt(
  port: TelegramSettingsPort | null,
  state: TelegramSettingsState,
): TelegramAttempt | null {
  if (port === null) return null;
  const current = content(state);
  const feedback = current?.feedback ?? null;
  let attempt = persistedTelegramAttempts.get(port) ?? null;
  if (
    attempt === null &&
    state.status === "working" &&
    (state.operation === "paste-token" || state.operation === "remove")
  ) {
    const currentIdentity = identity(current?.telegram ?? null);
    attempt = {
      action: state.operation,
      feedbackBefore: null,
      feedback: null,
      panelDismissed: false,
      phase: "working",
      verifiedUsernameBefore: currentIdentity.kind === "verified" ? currentIdentity.username : null,
    };
    return persistAttempt(port, attempt);
  }
  if (attempt === null) return null;
  if (state.status === "closed" || state.status === "loading") return attempt;
  if (state.status === "working") {
    if (state.operation !== attempt.action) return persistAttempt(port, null);
    attempt = { ...attempt, feedback: null, phase: "working" };
    return persistAttempt(port, attempt);
  }
  if (attempt.phase === "settled") {
    if (sameFeedback(feedback, attempt.feedback)) return attempt;
    return identity(current?.telegram ?? null).kind === "unknown"
      ? attempt
      : persistAttempt(port, null);
  }
  if (attempt.phase === "requested" && sameFeedback(feedback, attempt.feedbackBefore)) {
    return persistAttempt(port, null);
  }
  if (applied(attempt, state)) return persistAttempt(port, null);
  attempt = {
    ...attempt,
    feedback: feedback ?? fallbackFeedback(attempt.action),
    phase: "settled",
  };
  return persistAttempt(port, attempt);
}

export function TelegramRow(): ReactElement {
  const state = useEnduragentStore((store) => store.settings.telegram);
  const settings = useEnduragentStore((store) => store.settings);
  const port = useEnduragentStore((store) => store.settingsPorts?.telegram ?? null);
  const [restoredAttempt] = useState(() => restoreAttempt(port, state));
  const [panel, setPanel] = useState<TelegramPanel>(() => {
    if (restoredAttempt?.panelDismissed === true) return "closed";
    if (restoredAttempt?.action === "remove") return "remove";
    return restoredAttempt === null ? "closed" : "token";
  });
  const [attempt, setAttempt] = useState<TelegramAttempt | null>(restoredAttempt);
  const [panelFeedback, setPanelFeedback] = useState<TelegramSettingsFeedback | null>(
    restoredAttempt?.phase === "settled" ? restoredAttempt.feedback : null,
  );
  const trigger = useRef<HTMLButtonElement>(null);
  const tokenAction = useRef<HTMLButtonElement>(null);
  const retryAction = useRef<HTMLButtonElement>(null);
  const removeTrigger = useRef<HTMLButtonElement>(null);
  const removeCancel = useRef<HTMLButtonElement>(null);
  const removeConfirm = useRef<HTMLButtonElement>(null);
  const current = content(state);
  const telegram = current?.telegram ?? null;
  const feedback = current?.feedback ?? null;
  const currentIdentity = identity(telegram);
  const verifiedUsername = currentIdentity.kind === "verified" ? currentIdentity.username : null;
  const username = verifiedUsername ?? attempt?.verifiedUsernameBefore ?? null;
  const configured = username !== null;
  const identityUnknown = currentIdentity.kind === "unknown";
  const loading = state.status === "closed" || state.status === "loading";
  const busy = loading || settingsMutationActive(settings) || state.status === "working";
  const activeAttempt = attempt !== null && attempt.phase !== "settled";
  const connecting = activeAttempt && attempt.action === "paste-token";
  const removing = activeAttempt && attempt.action === "remove";
  const copiedTokenRejected =
    attempt?.action === "paste-token" &&
    attempt.phase === "settled" &&
    panelFeedback?.tone === "error" &&
    panelFeedback.message ===
      "Telegram rejected the copied token. The current Telegram bot is unchanged.";
  const authoritativeCheckRequired =
    attempt?.phase === "settled" &&
    attempt.feedback?.tone === "warning" &&
    sameFeedback(feedback, attempt.feedback);
  const mutationUnsafe = identityUnknown || authoritativeCheckRequired;
  const panelId = "onboarding-telegram-panel";

  useEffect(() => {
    if (panel === "remove") removeCancel.current?.focus();
  }, [panel]);

  useEffect(() => {
    if (attempt === null) return;
    if (state.status === "closed" || state.status === "loading") return;
    if (state.status === "working") {
      if (state.operation === attempt.action && attempt.phase !== "working") {
        const workingAttempt = persistAttempt(port, {
          ...attempt,
          feedback: null,
          phase: "working",
        });
        setAttempt(workingAttempt);
      }
      return;
    }
    if (attempt.phase === "settled") {
      const feedbackChanged = !sameFeedback(feedback, attempt.feedback);
      const recoveredFromUncertain =
        attempt.feedback?.tone === "warning" &&
        feedbackChanged &&
        ((attempt.action === "remove" && currentIdentity.kind === "missing") ||
          (attempt.action === "paste-token" && currentIdentity.kind !== "unknown"));
      if (recoveredFromUncertain) {
        persistAttempt(port, null);
        setAttempt(null);
        setPanel("closed");
        setPanelFeedback(null);
        queueMicrotask(() => trigger.current?.focus());
        return;
      }
      if (feedbackChanged && currentIdentity.kind !== "unknown") {
        persistAttempt(port, null);
        setAttempt(null);
        setPanelFeedback(null);
        queueMicrotask(() => {
          if (attempt.action === "remove") {
            if (panel === "remove") removeConfirm.current?.focus();
            else removeTrigger.current?.focus();
          } else tokenAction.current?.focus();
        });
      }
      return;
    }
    if (
      attempt.phase === "requested" &&
      sameFeedback(feedback, attempt.feedbackBefore) &&
      state.status !== "error"
    ) {
      return;
    }

    if (applied(attempt, state)) {
      persistAttempt(port, null);
      setAttempt(null);
      setPanel("closed");
      setPanelFeedback(null);
      queueMicrotask(() => trigger.current?.focus());
    } else {
      const settledFeedback = feedback ?? fallbackFeedback(attempt.action);
      const settledAttempt = persistAttempt(port, {
        ...attempt,
        feedback: settledFeedback,
        phase: "settled",
      });
      setAttempt(settledAttempt);
      setPanelFeedback(settledFeedback);
    }
  }, [attempt, currentIdentity.kind, feedback, panel, port, state]);

  const begin = (action: TelegramAction): void => {
    if (port === null || busy || activeAttempt || mutationUnsafe) return;
    setPanelFeedback(null);
    const nextAttempt = persistAttempt(port, {
      action,
      feedbackBefore: feedback,
      feedback: null,
      panelDismissed: false,
      phase: "requested",
      verifiedUsernameBefore: configured ? username : null,
    });
    setAttempt(nextAttempt);
    if (action === "paste-token") port.pasteToken();
    else port.remove();
  };

  const clearAttempt = (): void => {
    persistAttempt(port, null);
    setAttempt(null);
  };

  const dismissTokenPanel = (): void => {
    if (attempt?.phase === "settled" && attempt.feedback?.tone === "warning") {
      const dismissedAttempt = persistAttempt(port, { ...attempt, panelDismissed: true });
      setAttempt(dismissedAttempt);
    } else {
      clearAttempt();
    }
  };

  const checkAgain = (): void => {
    if (port === null || busy) return;
    port.retry();
  };

  const openTokenPanel = (): void => {
    setPanelFeedback(null);
    if (panel === "token") {
      dismissTokenPanel();
      setPanel("closed");
      return;
    }
    if (attempt?.phase === "settled") {
      const reopenedAttempt = persistAttempt(port, { ...attempt, panelDismissed: false });
      setAttempt(reopenedAttempt);
      setPanelFeedback(reopenedAttempt?.feedback ?? null);
    }
    setPanel("token");
  };

  const closeTokenPanel = (): void => {
    dismissTokenPanel();
    setPanel("closed");
    setPanelFeedback(null);
    queueMicrotask(() => trigger.current?.focus());
  };

  const cancelRemovePanel = (): void => {
    if (attempt?.phase === "settled" && attempt.feedback?.tone === "warning") {
      const recoveryAttempt = persistAttempt(port, { ...attempt, panelDismissed: false });
      setAttempt(recoveryAttempt);
      setPanel("token");
      setPanelFeedback(recoveryAttempt?.feedback ?? null);
      queueMicrotask(() => retryAction.current?.focus());
      return;
    }
    clearAttempt();
    setPanel("token");
    setPanelFeedback(null);
    queueMicrotask(() => removeTrigger.current?.focus());
  };

  const feedbackNode =
    panelFeedback === null ? null : (
      <p
        className={`mt-2 mb-0 text-[12.5px] ${panelFeedback.tone === "error" || panelFeedback.tone === "warning" ? "text-danger" : "text-ink-2"}`}
        role={panelFeedback.tone === "error" ? "alert" : "status"}
        aria-live={panelFeedback.tone === "error" ? undefined : "polite"}
        data-telegram-feedback={panelFeedback.tone}
      >
        {panelFeedback.message}
      </p>
    );

  return (
    <>
      <SetupRow
        id="telegram"
        status={configured ? "ready" : "pending"}
        title={TELEGRAM_ROW_TITLE}
        subtitle={
          <>
            {TELEGRAM_AVAILABILITY_COPY}
            {configured ? (
              <span className="mt-1 block text-ok" data-telegram-identity="">
                {TELEGRAM_VERIFIED_PREFIX} · @{username}
              </span>
            ) : null}
          </>
        }
        info={
          <span
            className="rounded-full bg-[color-mix(in_srgb,var(--brand)_10%,transparent)] px-[7px] py-0.5 text-[10px] font-semibold uppercase tracking-[0.055em] text-brand"
            data-telegram-optional=""
          >
            {TELEGRAM_OPTIONAL_LABEL}
          </span>
        }
        announce={panel === "token" ? "Telegram bot setup opened below this row." : ""}
        trailing={
          identityUnknown && !configured && panel === "closed" ? (
            <button
              ref={trigger}
              type="button"
              className={BUTTON_QUIET_SM}
              data-setup-trigger="telegram"
              disabled={busy}
              onClick={checkAgain}
            >
              Check again
            </button>
          ) : (
            <button
              ref={trigger}
              type="button"
              className={BUTTON_QUIET_SM}
              data-setup-trigger="telegram"
              disabled={busy}
              aria-expanded={panel !== "closed"}
              aria-label={configured ? "Change Telegram bot" : "Create Telegram bot"}
              {...(panel === "closed" ? {} : { "aria-controls": panelId })}
              onClick={openTokenPanel}
            >
              {configured ? "Change" : "Create"}
            </button>
          )
        }
      />
      {panel === "token" ? (
        <SetupSubPanel name="telegram" id={panelId}>
          {configured ? (
            <div role="group" aria-labelledby="onboarding-telegram-replace-title">
              <h3
                id="onboarding-telegram-replace-title"
                className="m-0 text-sm font-semibold tracking-tight"
              >
                {copiedTokenRejected
                  ? "Telegram rejected the copied token"
                  : `Replace @${username}?`}
              </h3>
              {copiedTokenRejected ? null : (
                <p className="mt-1 mb-0 max-w-[650px] text-[12.5px] text-ink-2">
                  {TELEGRAM_REPLACEMENT_COPY}
                </p>
              )}
              {feedbackNode}
              <div className="mt-3.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={BUTTON_QUIET_SM}
                  disabled={busy}
                  aria-label="Cancel Telegram bot replacement"
                  onClick={closeTokenPanel}
                >
                  Cancel
                </button>
                <button
                  ref={tokenAction}
                  type="button"
                  className={BUTTON_SOLID_SM}
                  data-telegram-action="use-token"
                  disabled={busy || mutationUnsafe}
                  onClick={() => begin("paste-token")}
                >
                  {connecting ? "Connecting…" : "Use copied token"}
                </button>
                {mutationUnsafe ? (
                  <button
                    ref={retryAction}
                    type="button"
                    className={BUTTON_QUIET_SM}
                    disabled={busy}
                    onClick={checkAgain}
                  >
                    Check again
                  </button>
                ) : null}
                <button
                  ref={removeTrigger}
                  type="button"
                  className={`${BUTTON_DANGER_SM} ml-auto`}
                  disabled={busy || mutationUnsafe}
                  onClick={() => {
                    clearAttempt();
                    setPanelFeedback(null);
                    setPanel("remove");
                  }}
                >
                  Remove bot from this Mac
                </button>
              </div>
            </div>
          ) : (
            <div
              className="flex flex-wrap items-center gap-4 sm:flex-nowrap sm:gap-6"
              role="group"
              aria-labelledby="onboarding-telegram-create-title"
            >
              <div className="min-w-0 flex-1">
                <h3
                  id="onboarding-telegram-create-title"
                  className="m-0 text-sm font-semibold tracking-tight"
                >
                  {TELEGRAM_CREATE_TITLE}
                </h3>
                <p className="mt-1 mb-0 max-w-[525px] text-[12.5px] text-ink-2">
                  Ask{" "}
                  <a
                    className="font-medium underline underline-offset-[3px] hover:text-ink"
                    href="https://t.me/BotFather"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    @BotFather
                  </a>{" "}
                  {TELEGRAM_CREATE_COPY_AFTER_BOTFATHER}
                </p>
                {feedbackNode}
              </div>
              <button
                ref={tokenAction}
                type="button"
                className={BUTTON_SOLID_SM}
                data-telegram-action="use-token"
                disabled={busy || mutationUnsafe}
                onClick={() => begin("paste-token")}
              >
                {connecting ? "Connecting…" : "Use copied token"}
              </button>
              {mutationUnsafe ? (
                <button
                  ref={retryAction}
                  type="button"
                  className={BUTTON_QUIET_SM}
                  disabled={busy}
                  onClick={checkAgain}
                >
                  Check again
                </button>
              ) : null}
            </div>
          )}
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {connecting ? "Connecting…" : removing ? "Removing…" : ""}
          </span>
        </SetupSubPanel>
      ) : null}
      {panel === "remove" ? (
        <SetupSubPanel name="telegram-remove" id={panelId}>
          <div
            role="group"
            aria-labelledby="onboarding-telegram-remove-title"
            aria-describedby="onboarding-telegram-remove-copy"
          >
            <h3
              id="onboarding-telegram-remove-title"
              className="m-0 text-sm font-semibold tracking-tight"
            >
              {TELEGRAM_REMOVE_TITLE}
            </h3>
            <p
              id="onboarding-telegram-remove-copy"
              className="mt-1 mb-0 max-w-[650px] text-[12.5px] text-ink-2"
            >
              {TELEGRAM_REMOVE_COPY}
            </p>
            {feedbackNode}
            <div className="mt-3.5 flex flex-wrap items-center gap-2">
              <button
                ref={removeCancel}
                type="button"
                className={BUTTON_QUIET_SM}
                disabled={busy}
                onClick={cancelRemovePanel}
              >
                Cancel
              </button>
              {mutationUnsafe ? (
                <button
                  ref={retryAction}
                  type="button"
                  className={BUTTON_QUIET_SM}
                  disabled={busy}
                  onClick={checkAgain}
                >
                  Check again
                </button>
              ) : null}
              <button
                ref={removeConfirm}
                type="button"
                className={BUTTON_DANGER_SM}
                disabled={busy || mutationUnsafe}
                onClick={() => begin("remove")}
              >
                {removing ? "Removing…" : "Remove bot"}
              </button>
            </div>
          </div>
        </SetupSubPanel>
      ) : null}
    </>
  );
}
