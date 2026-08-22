import { useEffect, useRef, type ReactElement } from "react";
import { APP_VERSION } from "../../app-version.js";
import type { DesktopUpdateState } from "../../update/controller.js";
import { settingsMutationActive } from "../../state/settings-slice.js";
import { useEnduragentStore } from "../../state/store.js";
import { RELEASE_NOTES_UNAVAILABLE_COPY } from "./copy.js";
import { settingsStyles as styles } from "./styles.js";

interface UpdateCopy {
  readonly action: string | null;
  readonly label: string;
  readonly announcement: string;
}

function updateCopy(state: DesktopUpdateState): UpdateCopy {
  switch (state.status) {
    case "disabled":
      return {
        action: "Updates unavailable",
        label: "Updates unavailable",
        announcement: "Updates unavailable",
      };
    case "current":
      return {
        action: "Check for updates",
        label: "Check for updates",
        announcement: "Enduragent is up to date",
      };
    case "checking":
      return {
        action: "Checking…",
        label: "Checking for updates",
        announcement: "Checking for updates",
      };
    case "downloading":
      return {
        action: "Downloading…",
        label: `Downloading update ${state.version}`,
        announcement: `Downloading update ${state.version}`,
      };
    case "downloaded":
      return {
        action: "Restart to update",
        label: `Restart to update to version ${state.version}`,
        announcement: `Restart to update to version ${state.version}`,
      };
    case "installing":
      return {
        action: "Restarting…",
        label: `Restarting to install version ${state.version}`,
        announcement: `Restarting to install version ${state.version}`,
      };
    case "failed":
      return {
        action: "Try update again",
        label: "Try update again",
        announcement:
          state.stage === "download"
            ? "Update download failed. Try again"
            : "Update check failed. Try again",
      };
    case "restart-required":
      return {
        action: null,
        label: "Restart Enduragent to resume updates",
        announcement:
          state.stage === "download"
            ? "Update download timed out. Quit and reopen Enduragent to try again."
            : "Updates could not start. Quit and reopen Enduragent to try again.",
      };
    default:
      return {
        action: "Check for updates",
        label: "Check for updates",
        announcement: "Check for updates",
      };
  }
}

export function ApplicationSection(): ReactElement {
  const update = useEnduragentStore((store) => store.settings.update);
  const releaseNotes = useEnduragentStore((store) => store.settings.releaseNotes);
  const releaseNotesOpen = useEnduragentStore((store) => store.settings.releaseNotesOpen);
  const mutating = useEnduragentStore((store) => settingsMutationActive(store.settings));
  const ports = useEnduragentStore((store) => store.settingsPorts);
  const chatActions = useEnduragentStore((store) => store.chatActions);
  const setActiveView = useEnduragentStore((store) => store.setActiveView);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeDialog = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (releaseNotesOpen && !element.open) {
      element.showModal();
      closeDialog.current?.focus();
      return;
    }
    if (!releaseNotesOpen && element.open) {
      element.close();
      opener.current?.focus();
    }
  }, [releaseNotesOpen]);

  const copy = updateCopy(update.state);
  const updateBusy =
    mutating ||
    update.actionDisabled ||
    ["disabled", "checking", "downloading", "installing"].includes(update.state.status);
  const releaseUrl =
    releaseNotes.status === "available" || releaseNotes.status === "unavailable"
      ? releaseNotes.releaseUrl
      : null;

  return (
    <>
      <h2 className={styles.heading}>Application</h2>
      <section className={styles.group} aria-label="Application">
        <div className={styles.row}>
          <div className={styles.label}>
            <div className={styles.rowTitle}>Version {APP_VERSION}</div>
            <div className={styles.rowDetail}>{copy.announcement}</div>
            <span className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">
              {copy.announcement}
            </span>
          </div>
          {update.state.status === "disabled" || copy.action === null ? null : (
            <button
              type="button"
              className={styles.button}
              title={copy.label}
              aria-label={copy.label}
              disabled={updateBusy}
              onClick={() => {
                ports?.update.activate();
              }}
            >
              {copy.action}
            </button>
          )}
        </div>
        <div className={styles.row}>
          <div className={styles.label}>
            <div className={styles.rowTitle}>What’s new</div>
            <div className={styles.rowDetail}>Athlete-facing changes in the latest release</div>
          </div>
          <button
            type="button"
            ref={opener}
            className={styles.button}
            aria-haspopup="dialog"
            aria-expanded={releaseNotesOpen}
            onClick={() => {
              ports?.releaseNotes.open();
            }}
          >
            What’s new
          </button>
        </div>
      </section>
      <h2 className={styles.heading}>Danger</h2>
      <section className={styles.group} aria-label="Danger">
        <div className={styles.row}>
          <div className={styles.label}>
            <div className={`${styles.rowTitle} ${styles.dangerTitle}`}>Reset conversation</div>
            <div className={styles.rowDetail}>
              Clears the visible conversation. Training data and saved coach memory remain.
            </div>
          </div>
          <button
            type="button"
            className={styles.danger}
            disabled={chatActions === null || mutating}
            onClick={() => {
              setActiveView("chat");
              chatActions?.openNewConversation();
            }}
          >
            Reset conversation
          </button>
        </div>
      </section>
      <dialog
        ref={dialog}
        className={styles.dialog}
        aria-labelledby="release-notes-title"
        aria-modal="true"
        aria-busy={releaseNotes.status === "loading" ? "true" : undefined}
        onCancel={(event) => {
          event.preventDefault();
          ports?.releaseNotes.close();
        }}
      >
        <header className={styles.dialogHeader}>
          <h2 id="release-notes-title">
            {releaseNotes.status === "available"
              ? `What’s new in ${releaseNotes.version}`
              : "What’s new"}
          </h2>
          <button
            type="button"
            ref={closeDialog}
            className={styles.button}
            aria-label="Close release notes"
            onClick={() => {
              ports?.releaseNotes.close();
            }}
          >
            Close
          </button>
        </header>
        <div className={styles.dialogContent} role="status" aria-live="polite" aria-atomic="true">
          {releaseNotes.status === "loading" ? <p>Loading release notes…</p> : null}
          {releaseNotes.status === "idle" ? <p>Loading release notes…</p> : null}
          {releaseNotes.status === "unavailable" ? <p>{RELEASE_NOTES_UNAVAILABLE_COPY}</p> : null}
          {releaseNotes.status === "available" ? (
            releaseNotes.notes.length === 0 ? (
              <p>No athlete-facing changes were listed for this release.</p>
            ) : (
              <ol>
                {releaseNotes.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ol>
            )
          ) : null}
        </div>
        <footer className={styles.dialogActions}>
          {releaseNotes.status === "unavailable" ? (
            <button
              type="button"
              className={styles.button}
              onClick={() => {
                ports?.releaseNotes.retry();
              }}
            >
              Retry
            </button>
          ) : null}
          {releaseUrl === null ? null : (
            <a href={releaseUrl} target="_blank" rel="noopener noreferrer">
              View full release
            </a>
          )}
        </footer>
      </dialog>
    </>
  );
}
