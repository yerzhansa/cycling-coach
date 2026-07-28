import { useEffect, useRef, type ReactElement } from "react";
import type { DesktopCredentialId } from "../../onboarding/bridge.js";
import type { CredentialSettingsState } from "../../settings/credential-controller.js";
import { settingsMutationActive } from "../../state/settings-slice.js";
import { useEnduragentStore } from "../../state/store.js";
import { credentialRuntimeLabel } from "./copy.js";
import styles from "./SettingsView.module.css";

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
  return null;
}

export function CredentialsSection(): ReactElement {
  const state = useEnduragentStore((store) => store.settings.credentials);
  const mutating = useEnduragentStore((store) => settingsMutationActive(store.settings));
  const port = useEnduragentStore((store) => store.settingsPorts?.credentials ?? null);
  const deleteButtons = useRef(new Map<DesktopCredentialId, HTMLButtonElement>());
  const confirmationCancel = useRef<HTMLButtonElement>(null);
  const confirmationDelete = useRef<HTMLButtonElement>(null);
  const openSetup = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const target = "focus" in state ? state.focus : null;
    if (target === null || target === undefined) return;
    if (target.target === "confirmation-cancel") confirmationCancel.current?.focus();
    else if (target.target === "confirmation-delete") confirmationDelete.current?.focus();
    else if (target.target === "setup") openSetup.current?.focus();
    else if (target.target === "delete") deleteButtons.current.get(target.credential)?.focus();
  }, [state]);

  const entries = content(state)?.entries ?? [];
  const confirmation = content(state)?.confirmation ?? null;
  const deleting = state.status === "deleting";
  const loading = state.status === "closed" || state.status === "loading";
  const loadError = state.status === "error" && state.kind === "load";
  const recoveryAvailable = "recoveryAvailable" in state && state.recoveryAvailable;
  const announcement = loading
    ? "Loading saved credentials…"
    : "announcement" in state
      ? state.announcement
      : "";

  return (
    <>
      <h2 className={styles.heading}>Credentials</h2>
      <section className={styles.group} aria-label="Credentials">
        <p className={styles.note}>
          Review credentials saved on this Mac. Credential values are never shown.
        </p>
        {entries.length === 0 ? (
          <p className={styles.empty}>
            {loading || loadError ? "" : "No local credentials are stored."}
          </p>
        ) : (
          <ul className={styles.list}>
            {entries.map((entry) => (
              <li key={entry.credential} className={styles.item} data-credential={entry.credential}>
                <div className={styles.itemIdentity}>
                  <div className={styles.rowTitle}>{entry.provider}</div>
                  <div className={styles.itemKind}>{entry.kind}</div>
                </div>
                <span className={styles.runtime} data-state={entry.runtimeState}>
                  {credentialRuntimeLabel(entry.runtimeState)}
                </span>
                {confirmation === entry.credential ? (
                  <div
                    className={styles.confirmation}
                    role="group"
                    aria-labelledby={`credential-confirm-${entry.credential}`}
                  >
                    <p
                      className={styles.confirmationTitle}
                      id={`credential-confirm-${entry.credential}`}
                    >
                      Delete the {entry.provider} credential?
                    </p>
                    <p className={styles.confirmationCopy}>
                      This removes it from this Mac only. Enduragent will stop using it if it is
                      active. Your provider account is unchanged.
                    </p>
                    <div className={styles.confirmationActions}>
                      <button
                        type="button"
                        ref={confirmationCancel}
                        className={styles.button}
                        disabled={mutating}
                        onClick={() => {
                          port?.cancelDelete();
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        ref={confirmationDelete}
                        className={`${styles.button} ${styles.danger}`}
                        disabled={deleting ? false : mutating}
                        aria-disabled={deleting ? "true" : undefined}
                        aria-label={`Confirm deletion of the ${entry.provider} credential`}
                        onClick={() => {
                          if (deleting) return;
                          port?.confirmDelete();
                        }}
                      >
                        Delete credential
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    ref={(element) => {
                      if (element === null) deleteButtons.current.delete(entry.credential);
                      else deleteButtons.current.set(entry.credential, element);
                    }}
                    className={styles.button}
                    disabled={mutating}
                    aria-label={`Delete the ${entry.provider} credential`}
                    onClick={() => {
                      port?.requestDelete(entry.credential);
                    }}
                  >
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {announcement.length === 0 ? null : (
          <p className={styles.feedback} role="status" aria-live="polite" aria-atomic="true">
            {announcement}
          </p>
        )}
        {loadError || recoveryAvailable ? (
          <div className={styles.actions}>
            {loadError ? (
              <button
                type="button"
                className={styles.button}
                disabled={mutating}
                onClick={() => {
                  port?.retry();
                }}
              >
                Reconnect &amp; reload
              </button>
            ) : null}
            {recoveryAvailable ? (
              <button
                type="button"
                ref={openSetup}
                className={styles.button}
                disabled={mutating}
                onClick={() => {
                  port?.openSetup();
                }}
              >
                Open Setup
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
    </>
  );
}
