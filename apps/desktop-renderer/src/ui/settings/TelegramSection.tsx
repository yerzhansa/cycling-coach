import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import type {
  TelegramControlStatus,
  TelegramSettingsState,
} from "../../settings/telegram-controller.js";
import { settingsMutationActive } from "../../state/settings-slice.js";
import { useEnduragentStore } from "../../state/store.js";
import styles from "./SettingsView.module.css";

function content(state: TelegramSettingsState) {
  if (state.status === "ready" || state.status === "working" || state.status === "error") {
    return state;
  }
  return null;
}

function channelLabel(status: TelegramControlStatus): string {
  if (status.channel.state === "online") return "Online";
  if (status.channel.state === "starting") return "Connecting";
  if (status.channel.state === "suspended") return "Paused while asleep";
  if (status.channel.state === "offline-retrying") return "Reconnecting";
  if (status.channel.state === "conflict") return "Polling conflict";
  if (status.channel.state === "invalid-token") return "Token rejected";
  if (status.channel.state === "transfer-required") return "Transfer required";
  if (status.channel.state === "failed") return "Needs attention";
  if (status.channel.state === "waiting-for-credential") return "Needs bot token";
  return "Off";
}

function channelTone(status: TelegramControlStatus): "active" | "failed" | "idle" {
  if (status.channel.state === "online") return "active";
  if (
    status.channel.state === "conflict" ||
    status.channel.state === "invalid-token" ||
    status.channel.state === "transfer-required" ||
    status.channel.state === "failed"
  ) {
    return "failed";
  }
  return "idle";
}

function attentionCopy(status: TelegramControlStatus): string | null {
  if (status.channel.state === "conflict") {
    return "Another app or deployment is polling this bot. Stop it there, then choose Check again. Different bots can still run at the same time.";
  }
  if (status.channel.state === "transfer-required") {
    return "This bot belongs to another Enduragent installation or hosted deployment. Remove it there, then paste its token here again.";
  }
  if (status.channel.state === "invalid-token") {
    return "Telegram rejected the saved token. Ask BotFather for a fresh token, copy it, then replace it from the clipboard.";
  }
  if (status.channel.state === "failed") {
    if (status.channel.errorCode === "telegram-credential-encryption-unavailable") {
      return "Secure token storage is unavailable. Quit and reopen Enduragent, unlock or approve Keychain access, then choose Check again.";
    }
    if (status.channel.errorCode === "telegram-credential-unsafe-backend") {
      return "No secure credential backend is available, so Enduragent refused to read or change the saved bot token without encryption. Quit and reopen Enduragent, then choose Check again.";
    }
    if (status.channel.errorCode === "telegram-credential-unavailable") {
      return "The saved bot token could not be read from secure storage. Quit and reopen Enduragent, then choose Check again. If it still cannot be read, replace the bot token.";
    }
    if (status.channel.errorCode === "telegram-credential-storage-failed") {
      return "The encrypted bot credential could not be saved. Check local disk access and try again.";
    }
    if (status.channel.errorCode === "telegram-settings-storage-uncertain") {
      return "Telegram settings may not have been saved completely. Keep Telegram unchanged and choose Check again before trying another action.";
    }
    if (status.channel.errorCode === "telegram-daemon-unavailable") {
      return "The local coaching service is unavailable. Keep Enduragent open, then choose Check again.";
    }
    if (status.channel.errorCode === "telegram-drain-required") {
      return "A Telegram reply is still finishing. Wait a moment, then try again.";
    }
    if (status.channel.errorCode === "telegram-home-mismatch") {
      return "Desktop is connected to a different athlete home. Restart Enduragent, then check again.";
    }
    return "Telegram could not start. Keep Enduragent open, check the internet connection, then choose Check again.";
  }
  if (status.channel.state === "offline-retrying") {
    return "Telegram is temporarily offline. Enduragent will retry while this Mac is awake and online.";
  }
  return null;
}

function pairingFailureCopy(status: TelegramControlStatus): string | null {
  if (status.pairing.state === "expired") {
    return "The pairing code expired before it was used. Create a new code when you are ready.";
  }
  if (status.pairing.state !== "failed") return null;
  if (status.pairing.errorCode === "telegram-pairing-storage-uncertain") {
    return "The primary Telegram user may have been saved, but Enduragent could not verify storage. Restart Enduragent and check Telegram before pairing again.";
  }
  if (status.pairing.errorCode === "telegram-pairing-storage-failed") {
    return "The primary Telegram user could not be saved. Check local disk access and try pairing again.";
  }
  if (status.pairing.errorCode === "telegram-pairing-refused") {
    return "Pairing was refused because this bot already has a primary user.";
  }
  return "Pairing is unavailable until the Telegram bot can connect.";
}

function parseSenderId(value: string): number | null {
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/u.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 10 ? parsed : null;
}

export function TelegramSection(): ReactElement {
  const state = useEnduragentStore((store) => store.settings.telegram);
  const mutating = useEnduragentStore((store) => settingsMutationActive(store.settings));
  const port = useEnduragentStore((store) => store.settingsPorts?.telegram ?? null);
  const [senderDraft, setSenderDraft] = useState("");
  const [senderError, setSenderError] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const replaceTrigger = useRef<HTMLButtonElement>(null);
  const replaceCancel = useRef<HTMLButtonElement>(null);
  const removeCancel = useRef<HTMLButtonElement>(null);
  const current = content(state);
  const telegram = current?.telegram ?? null;
  const allowedSenders = current?.allowedSenders ?? null;
  const feedback = current?.feedback ?? null;
  const healthAnnouncement = current?.healthAnnouncement ?? "";
  const loading = state.status === "closed" || state.status === "loading";
  const working = state.status === "working";
  const busy = mutating || loading || working;
  const botUsername =
    telegram === null || telegram.bot.state === "unconfigured" ? null : telegram.bot.username;
  const attention = telegram === null ? null : attentionCopy(telegram);
  const pairingFailure = telegram === null ? null : pairingFailureCopy(telegram);
  const paired = telegram?.pairing.state === "paired";
  const needsCheck =
    telegram?.channel.state === "conflict" ||
    telegram?.channel.state === "transfer-required" ||
    telegram?.channel.state === "failed" ||
    telegram?.channel.state === "offline-retrying";

  useEffect(() => {
    if (confirmReplace) replaceCancel.current?.focus();
  }, [confirmReplace]);

  useEffect(() => {
    if (confirmRemove) removeCancel.current?.focus();
  }, [confirmRemove]);

  useEffect(() => {
    if (telegram?.credentialConfigured !== true) {
      setConfirmReplace(false);
      setConfirmRemove(false);
    }
  }, [telegram?.credentialConfigured]);

  const submitSender = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const senderId = parseSenderId(senderDraft);
    if (senderId === null) {
      setSenderError("Enter a numeric Telegram user ID with at least two digits.");
      return;
    }
    setSenderError(null);
    setSenderDraft("");
    port?.addSender(senderId);
  };

  return (
    <>
      <h2 className={styles.heading}>Channels</h2>
      <section className={styles.group} aria-label="Telegram">
        <div className={styles.telegramIntro}>
          <div>
            <p className={styles.telegramIntroTitle}>Telegram</p>
            <p className={styles.rowDetail}>
              A dedicated bot is recommended. It creates a new @username and Telegram chat; visible
              history from a previous bot does not move. Athlete memory, training data and plans are
              shared.
            </p>
          </div>
          {telegram === null ? null : (
            <span className={styles.runtime} data-state={channelTone(telegram)}>
              {channelLabel(telegram)}
            </span>
          )}
        </div>
        <p className={styles.note}>
          Telegram works only while Enduragent and its local coaching service are running, and this
          Mac is awake and online.
        </p>
        <span className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">
          {healthAnnouncement}
        </span>
        {telegram?.channel.state === "suspended" ? (
          <p className={styles.note}>Telegram polling resumes when this Mac wakes.</p>
        ) : null}

        {telegram?.gapWarning.state === "possible-message-loss" ? (
          <div className={styles.telegramWarning} role="alert">
            <div>
              <p className={styles.confirmationTitle}>Check Telegram for missed messages</p>
              <p className={styles.confirmationCopy}>
                The bot resumed after a long gap, so messages sent during that time may not have
                reached Enduragent. Check the Telegram chat before clearing this warning.
              </p>
            </div>
            <button
              type="button"
              className={styles.button}
              disabled={busy}
              onClick={() => {
                port?.acknowledgeGapWarning();
              }}
            >
              Acknowledge
            </button>
          </div>
        ) : null}

        {attention === null ? null : (
          <div className={styles.telegramAttention} role="alert">
            <p>{attention}</p>
            <div className={styles.inlineActions}>
              {needsCheck ? (
                <button
                  type="button"
                  className={styles.button}
                  disabled={busy}
                  onClick={() => {
                    port?.reconcile();
                  }}
                >
                  Check again
                </button>
              ) : null}
            </div>
          </div>
        )}

        {telegram?.credentialConfigured === true && botUsername !== null ? (
          <div className={styles.row}>
            <div className={styles.label}>
              <div className={styles.rowTitle}>@{botUsername}</div>
              <div className={styles.rowDetail}>
                {paired
                  ? "Paired with a primary Telegram user"
                  : "Bot verified; starting pairing turns Telegram on"}
              </div>
            </div>
            <div className={styles.inlineActions}>
              <button
                type="button"
                ref={replaceTrigger}
                className={styles.button}
                disabled={busy}
                onClick={() => {
                  setConfirmReplace(true);
                }}
              >
                Replace token from clipboard
              </button>
              {paired ? (
                telegram.channel.desiredState === "enabled" ? (
                  <button
                    type="button"
                    className={styles.button}
                    disabled={busy}
                    onClick={() => {
                      port?.disable();
                    }}
                  >
                    Turn off
                  </button>
                ) : (
                  <button
                    type="button"
                    className={[styles.button, styles.primary].join(" ")}
                    disabled={busy}
                    onClick={() => {
                      port?.enable();
                    }}
                  >
                    Turn on
                  </button>
                )
              ) : null}
            </div>
          </div>
        ) : (
          <div className={[styles.row, styles.rowStacked].join(" ")}>
            <div>
              <div className={styles.rowTitle}>Create a bot with BotFather</div>
              <div className={styles.rowDetail}>
                Ask{" "}
                <a
                  className={styles.telegramLink}
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  @BotFather
                </a>{" "}
                for a bot, copy its token, then return here. Enduragent reads the token directly
                from the clipboard; there is no token field.
              </div>
            </div>
            <div className={styles.inlineActions}>
              <button
                type="button"
                className={[styles.button, styles.primary].join(" ")}
                disabled={busy}
                onClick={() => {
                  port?.pasteToken();
                }}
              >
                Paste token from clipboard
              </button>
              {state.status === "error" && state.kind === "load" ? (
                <button
                  type="button"
                  className={styles.button}
                  disabled={busy}
                  onClick={() => {
                    port?.retry();
                  }}
                >
                  Retry
                </button>
              ) : null}
            </div>
          </div>
        )}

        {telegram?.credentialConfigured === true && confirmReplace ? (
          <div
            className={styles.telegramRemoveConfirmation}
            role="group"
            aria-labelledby="telegram-replace-title"
            aria-describedby="telegram-replace-warning"
          >
            <div>
              <p className={styles.confirmationTitle} id="telegram-replace-title">
                Replace @{botUsername}?
              </p>
              <p className={styles.confirmationCopy} id="telegram-replace-warning">
                The same bot keeps its pairing and on/off choice. A different bot resets allowed
                users, turns Telegram off, and must be paired again. An invalid token leaves the
                current bot unchanged.
              </p>
            </div>
            <div className={styles.confirmationActions}>
              <button
                type="button"
                ref={replaceCancel}
                className={styles.button}
                disabled={busy}
                onClick={() => {
                  setConfirmReplace(false);
                  queueMicrotask(() => replaceTrigger.current?.focus());
                }}
              >
                Cancel replacement
              </button>
              <button
                type="button"
                className={[styles.button, styles.primary].join(" ")}
                disabled={busy}
                onClick={() => {
                  setConfirmReplace(false);
                  port?.pasteToken();
                }}
              >
                Read and verify clipboard token
              </button>
            </div>
          </div>
        ) : null}

        {telegram?.bot.state === "webhook-removal-required" ? (
          <div className={styles.telegramAttention} role="alert">
            <div>
              <p className={styles.confirmationTitle}>Remove the existing webhook</p>
              <p className={styles.confirmationCopy}>
                Telegram cannot deliver to a webhook and this Mac at the same time. This explicit
                action keeps pending updates and lets Desktop begin polling.
              </p>
            </div>
            <button
              type="button"
              className={styles.button}
              disabled={busy}
              onClick={() => {
                port?.removeWebhook();
              }}
            >
              Remove webhook
            </button>
          </div>
        ) : null}

        {telegram?.bot.state === "ready" && telegram.pairing.state === "awaiting-code" ? (
          <div className={styles.pairingCard}>
            <p className={styles.confirmationTitle}>Pair your Telegram account</p>
            <p className={styles.confirmationCopy}>
              Send this code as a private message to @{telegram.bot.username}. The first account to
              send it becomes the primary user, and the bot stays online.
            </p>
            <output className={styles.pairingCode} aria-label="Telegram pairing code">
              {telegram.pairing.code}
            </output>
            <p className={styles.pairingMeta}>
              Expires{" "}
              {new Date(telegram.pairing.expiresAt).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
            </p>
            <button
              type="button"
              className={styles.button}
              disabled={busy}
              onClick={() => {
                port?.cancelPairing();
              }}
            >
              Cancel pairing
            </button>
          </div>
        ) : null}

        {telegram?.bot.state === "ready" &&
        telegram.pairing.state !== "paired" &&
        telegram.pairing.state !== "awaiting-code" ? (
          <div className={styles.row}>
            <div className={styles.label}>
              <div className={styles.rowTitle}>Pair the primary user</div>
              <div className={styles.rowDetail}>
                {pairingFailure ??
                  "A one-minute code ensures only the person with access to this Mac can claim the bot."}
              </div>
            </div>
            <button
              type="button"
              className={[styles.button, styles.primary].join(" ")}
              disabled={busy}
              onClick={() => {
                port?.beginPairing();
              }}
            >
              {telegram.pairing.state === "expired"
                ? "Create new code and turn on"
                : "Start pairing and turn on"}
            </button>
          </div>
        ) : null}

        {paired ? (
          <details className={styles.telegramAdvanced}>
            <summary className={styles.telegramSummary}>Advanced · allowed users</summary>
            {current?.senderLoadFailed === true ? (
              <p className={styles.error}>
                Allowed users could not be loaded. Enduragent will try again automatically.
              </p>
            ) : allowedSenders === null ? (
              <p className={styles.help}>Loading allowed users…</p>
            ) : (
              <ul className={styles.list} aria-label="Allowed Telegram users">
                {allowedSenders.senders.map((sender) => (
                  <li key={sender.senderId} className={styles.item}>
                    <div className={styles.itemIdentity}>
                      <div className={styles.rowTitle}>{sender.senderId}</div>
                      <div className={styles.itemKind}>
                        {sender.role === "primary"
                          ? "Primary user · required"
                          : "Additional allowed user"}
                      </div>
                    </div>
                    {sender.role === "additional" ? (
                      <button
                        type="button"
                        className={styles.button}
                        disabled={busy}
                        aria-label={"Remove Telegram user " + sender.senderId}
                        onClick={() => {
                          port?.removeSender(sender.senderId);
                        }}
                      >
                        Remove
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <form className={styles.senderForm} onSubmit={submitSender}>
              <label className={styles.rowTitle} htmlFor="telegram-sender-id">
                Add a Telegram user ID
              </label>
              <div className={styles.senderEditor}>
                <input
                  id="telegram-sender-id"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  className={[styles.control, styles.senderId].join(" ")}
                  value={senderDraft}
                  disabled={busy}
                  aria-invalid={senderError === null ? undefined : "true"}
                  aria-describedby="telegram-sender-help telegram-sender-error"
                  onChange={(event) => {
                    setSenderDraft(event.target.value);
                    setSenderError(null);
                  }}
                />
                <button type="submit" className={styles.button} disabled={busy}>
                  Add user
                </button>
              </div>
              <p className={styles.help} id="telegram-sender-help">
                Add only people you trust to use your coach and shared athlete data.
              </p>
              <p className={styles.error} id="telegram-sender-error" aria-live="polite">
                {senderError ?? ""}
              </p>
            </form>
          </details>
        ) : null}

        {feedback === null ? null : (
          <p
            className={styles.feedback}
            role={feedback.tone === "error" ? "alert" : "status"}
            aria-live={feedback.tone === "error" ? undefined : "polite"}
            aria-atomic="true"
          >
            {feedback.message}
          </p>
        )}

        {telegram?.credentialConfigured === true ? (
          confirmRemove ? (
            <div
              className={styles.telegramRemoveConfirmation}
              role="group"
              aria-labelledby="telegram-remove-title"
            >
              <div>
                <p className={styles.confirmationTitle} id="telegram-remove-title">
                  Remove @{botUsername} from this Mac?
                </p>
                <p className={styles.confirmationCopy}>
                  This turns the bot off, removes its encrypted token and allowed-user access from
                  this Mac. The Telegram bot and its chat remain in Telegram.
                </p>
              </div>
              <div className={styles.confirmationActions}>
                <button
                  type="button"
                  ref={removeCancel}
                  className={styles.button}
                  disabled={busy}
                  onClick={() => {
                    setConfirmRemove(false);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={[styles.button, styles.danger].join(" ")}
                  disabled={busy}
                  onClick={() => {
                    port?.remove();
                  }}
                >
                  Remove Telegram bot
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.actions}>
              <button
                type="button"
                className={[styles.button, styles.danger].join(" ")}
                disabled={busy}
                onClick={() => {
                  setConfirmRemove(true);
                }}
              >
                Remove bot from this Mac
              </button>
            </div>
          )
        ) : null}
      </section>
    </>
  );
}
