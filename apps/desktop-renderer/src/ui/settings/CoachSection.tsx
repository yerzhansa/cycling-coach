import { useEffect, useRef, type ReactElement } from "react";
import {
  CUSTOM_MODEL_SELECTION,
  ONBOARDING_LLM_PROVIDER_LABELS,
} from "../../onboarding/constants.js";
import type {
  ProviderModelFormState,
  ProviderModelSettingsState,
} from "../../settings/provider-model-controller.js";
import { settingsMutationActive } from "../../state/settings-slice.js";
import { useEnduragentStore } from "../../state/store.js";
import { COACH_SAVE_ERROR_COPY, COACH_VALIDATION_COPY } from "./copy.js";
import styles from "./SettingsView.module.css";

function formState(state: ProviderModelSettingsState): ProviderModelFormState | null {
  if (
    state.status === "ready" ||
    state.status === "saving" ||
    state.status === "saved" ||
    (state.status === "error" && state.kind === "save")
  ) {
    return state;
  }
  return null;
}

function modelLabel(form: ProviderModelFormState): string {
  const draft = form.draft;
  if (draft === null) return "";
  if (draft.modelChoice === CUSTOM_MODEL_SELECTION) {
    return draft.customModel.trim() || "Choose a model";
  }
  return (
    draft.provider.models.find((model) => model.value === draft.modelChoice)?.label ??
    draft.modelChoice
  );
}

function routeLabel(form: ProviderModelFormState): string | null {
  if (form.draft !== null) {
    return `${ONBOARDING_LLM_PROVIDER_LABELS[form.draft.provider.provider]} → ${modelLabel(form)}`;
  }
  if (form.active === null) return null;
  return `${ONBOARDING_LLM_PROVIDER_LABELS[form.active.provider]} → ${form.active.model}`;
}

function feedbackCopy(state: ProviderModelSettingsState): string | null {
  if (state.status === "closed" || state.status === "loading") return "Loading coach settings…";
  if (state.status === "error" && state.kind === "load") {
    return "Coach settings aren’t available right now. Try again.";
  }
  if (state.status === "saving") return "Saving coach settings…";
  if (state.status === "saved") return "Coach settings saved.";
  if (state.status === "error" && state.kind === "save") return COACH_SAVE_ERROR_COPY[state.reason];
  return null;
}

export function CoachSection(): ReactElement {
  const state = useEnduragentStore((store) => store.settings.coach);
  const mutating = useEnduragentStore((store) => settingsMutationActive(store.settings));
  const port = useEnduragentStore((store) => store.settingsPorts?.coach ?? null);
  const customModel = useRef<HTMLInputElement>(null);
  const focusCustomModel = useRef(false);

  const editable = formState(state);
  const draft = editable?.draft ?? null;
  const custom = draft?.modelChoice === CUSTOM_MODEL_SELECTION;

  useEffect(() => {
    if (!focusCustomModel.current) return;
    focusCustomModel.current = false;
    if (custom) customModel.current?.focus();
  }, [custom]);

  const loadError = state.status === "error" && state.kind === "load";
  const credentialRequired =
    state.status === "error" && state.kind === "save" && state.reason === "credential-required";
  const saving = state.status === "saving";
  const canSave =
    editable !== null && draft !== null && editable.dirty && editable.validationError === null;
  const feedback = feedbackCopy(state);
  const routeSummary = editable === null ? null : routeLabel(editable);
  const route = routeSummary ?? "Not configured";
  const routeState =
    routeSummary === null ? "Not active" : editable?.dirty === true ? "Unsaved" : "Active";
  const validation =
    editable?.validationError == null ? "" : COACH_VALIDATION_COPY[editable.validationError];

  return (
    <>
      <h2 className={styles.heading}>Coach</h2>
      <section className={styles.group} aria-label="Coach">
        <div className={styles.row}>
          <div className={styles.label}>
            <div className={styles.rowTitle}>Coach route</div>
            <div className={styles.rowDetail}>{route}</div>
          </div>
          <span className={styles.runtime} data-state={routeSummary === null ? "failed" : "active"}>
            {routeState}
          </span>
        </div>
        {editable === null ? null : (
          <>
            <div className={styles.row}>
              <label className={styles.label} htmlFor="coach-provider">
                <span className={styles.rowTitle}>Provider</span>
                <span className={styles.rowDetail}>
                  {editable.active === null
                    ? "Active coach settings are unavailable or not configured."
                    : `Currently active: ${ONBOARDING_LLM_PROVIDER_LABELS[editable.active.provider]} · ${editable.active.model}`}
                </span>
              </label>
              <select
                id="coach-provider"
                className={styles.control}
                value={draft?.provider.provider ?? ""}
                disabled={mutating}
                onChange={(event) => {
                  port?.changeProvider(event.target.value);
                }}
              >
                {draft === null ? (
                  <option value="" disabled>
                    Choose a provider
                  </option>
                ) : null}
                {editable.providers.map((entry) => (
                  <option key={entry.provider} value={entry.provider}>
                    {ONBOARDING_LLM_PROVIDER_LABELS[entry.provider]}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.row}>
              <label className={styles.label} htmlFor="coach-model">
                <span className={styles.rowTitle}>Model</span>
              </label>
              <select
                id="coach-model"
                className={styles.control}
                value={draft?.modelChoice ?? ""}
                disabled={mutating || draft === null}
                onChange={(event) => {
                  focusCustomModel.current = event.target.value === CUSTOM_MODEL_SELECTION;
                  port?.changeModel(event.target.value);
                }}
              >
                {draft === null ? (
                  <option value="">Choose a provider first</option>
                ) : (
                  <>
                    {draft.provider.models.map((entry) => (
                      <option key={entry.value} value={entry.value}>
                        {entry.hint === undefined ? entry.label : `${entry.label} · ${entry.hint}`}
                      </option>
                    ))}
                    <option value={CUSTOM_MODEL_SELECTION}>Other model…</option>
                  </>
                )}
              </select>
            </div>
            {custom && draft !== null ? (
              <div className={`${styles.row} ${styles.rowStacked}`}>
                <label className={styles.rowTitle} htmlFor="coach-custom-model">
                  Custom model name
                </label>
                <input
                  id="coach-custom-model"
                  ref={customModel}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  className={`${styles.control} ${styles.controlWide}`}
                  value={draft.customModel}
                  disabled={mutating}
                  aria-invalid={editable.validationError === null ? undefined : "true"}
                  aria-describedby="coach-model-validation"
                  onChange={(event) => {
                    port?.changeCustomModel(event.target.value);
                  }}
                />
                <p className={styles.error} id="coach-model-validation" aria-live="polite">
                  {validation}
                </p>
              </div>
            ) : null}
            <div className={styles.row}>
              <div className={styles.label}>
                <div className={styles.rowTitle}>Endpoint</div>
                <div className={styles.rowDetail}>
                  Enduragent picks the provider’s endpoint for this route.
                </div>
              </div>
              <span className={styles.amount}>Automatic</span>
            </div>
          </>
        )}
        {feedback === null ? null : (
          <p className={styles.feedback} role="status" aria-live="polite" aria-atomic="true">
            {feedback}
          </p>
        )}
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
              Retry
            </button>
          ) : null}
          {credentialRequired ? (
            <button
              type="button"
              className={styles.button}
              disabled={mutating}
              onClick={() => {
                port?.openSetup();
              }}
            >
              Review setup
            </button>
          ) : null}
          <button
            type="button"
            className={styles.primary}
            disabled={mutating || !canSave}
            onClick={() => {
              port?.save();
            }}
          >
            {saving ? "Saving…" : "Save coach route"}
          </button>
        </div>
      </section>
    </>
  );
}
