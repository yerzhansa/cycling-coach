import type { ReactElement } from "react";
import type {
  AthleteSettingsFormState,
  AthleteSettingsState,
} from "../../settings/athlete-controller.js";
import { settingsMutationActive } from "../../state/settings-slice.js";
import { useEnduragentStore } from "../../state/store.js";
import {
  ATHLETE_SAVE_ERROR_COPY,
  ATHLETE_VALIDATION_COPY,
  MANAGED_BY_ENVIRONMENT_COPY,
} from "./copy.js";
import styles from "./SettingsView.module.css";

function formState(state: AthleteSettingsState): AthleteSettingsFormState | null {
  if (
    state.status === "ready" ||
    state.status === "refreshing" ||
    state.status === "saving" ||
    state.status === "saved" ||
    (state.status === "error" && state.kind === "save")
  ) {
    return state;
  }
  return null;
}

function feedbackCopy(state: AthleteSettingsState): string | null {
  if (state.status === "closed" || state.status === "loading") {
    return "Loading training account settings…";
  }
  if (state.status === "refreshing") {
    return "Reconnecting and checking the current training account…";
  }
  if (state.status === "error" && state.kind === "load") {
    return "Training account settings aren’t available. Reconnect and reload.";
  }
  if (state.status === "saving") return "Saving athlete ID…";
  if (state.status === "saved") return "Athlete ID saved.";
  if (state.status === "error" && state.kind === "save") {
    return ATHLETE_SAVE_ERROR_COPY[state.reason];
  }
  return null;
}

export function TrainingAccountSection(): ReactElement {
  const state = useEnduragentStore((store) => store.settings.athlete);
  const mutating = useEnduragentStore((store) => settingsMutationActive(store.settings));
  const port = useEnduragentStore((store) => store.settingsPorts?.athlete ?? null);

  const editable = formState(state);
  const busy =
    mutating ||
    state.status === "refreshing" ||
    state.status === "loading" ||
    state.status === "closed";
  const externallyManaged = editable?.effective.managedByEnvironment.athleteId === true;
  const credentialMissing = editable !== null && !editable.effective.credential_configured;
  const locked = editable === null || credentialMissing || externallyManaged;
  const saving = state.status === "saving";
  const retryVisible = state.status === "error" && (state.kind === "load" || state.kind === "save");
  const credentialRequired =
    credentialMissing ||
    (state.status === "error" && state.kind === "save" && state.reason === "credential-required");
  const validation =
    editable?.validationError == null ? "" : ATHLETE_VALIDATION_COPY[editable.validationError];
  const feedback = feedbackCopy(state);
  const describedBy = [
    "athlete-id-help",
    ...(externallyManaged ? ["athlete-id-managed"] : []),
    ...(credentialMissing ? ["athlete-id-credential"] : []),
    ...(validation.length > 0 ? ["athlete-id-validation"] : []),
  ].join(" ");

  return (
    <>
      <h2 className={styles.heading}>Training account</h2>
      <section className={styles.group} aria-label="Training account">
        <p className={styles.note}>
          This may only identify the currently connected training account. It cannot switch
          accounts.
        </p>
        {editable === null ? null : (
          <div className={`${styles.row} ${styles.rowStacked}`}>
            <label className={styles.rowTitle} htmlFor="athlete-id">
              Athlete ID
            </label>
            <input
              id="athlete-id"
              type="text"
              autoComplete="off"
              spellCheck={false}
              className={`${styles.control} ${styles.controlWide}`}
              value={editable.draft}
              disabled={busy || locked}
              aria-invalid={editable.validationError === null ? undefined : "true"}
              aria-describedby={describedBy}
              onChange={(event) => {
                port?.change(event.target.value);
              }}
            />
            <p className={styles.help} id="athlete-id-help">
              Use the exact identifier associated with the credential already connected in Setup.
            </p>
            {externallyManaged ? (
              <p className={styles.help} id="athlete-id-managed">
                {MANAGED_BY_ENVIRONMENT_COPY}
              </p>
            ) : null}
            {credentialMissing ? (
              <p className={styles.help} id="athlete-id-credential">
                No training account credential is connected. Open setup to connect one.
              </p>
            ) : null}
            <p className={styles.error} id="athlete-id-validation" aria-live="polite">
              {validation}
            </p>
          </div>
        )}
        {feedback === null ? null : (
          <p className={styles.feedback} role="status" aria-live="polite" aria-atomic="true">
            {feedback}
          </p>
        )}
        <div className={styles.actions}>
          {retryVisible ? (
            <button
              type="button"
              className={styles.button}
              disabled={busy}
              onClick={() => {
                port?.retry();
              }}
            >
              Reconnect &amp; reload
            </button>
          ) : null}
          {credentialRequired ? (
            <button
              type="button"
              className={styles.button}
              disabled={busy}
              onClick={() => {
                port?.openSetup();
              }}
            >
              Open setup
            </button>
          ) : null}
          <button
            type="button"
            className={styles.primary}
            disabled={
              busy ||
              editable === null ||
              !editable.dirty ||
              editable.validationError !== null ||
              locked
            }
            onClick={() => {
              port?.save();
            }}
          >
            {saving ? "Saving…" : "Save athlete ID"}
          </button>
        </div>
      </section>
    </>
  );
}
