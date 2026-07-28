import type { ReactElement } from "react";
import type { OnboardingActions, OnboardingSurfaceState } from "../../onboarding/controller.js";
import {
  CUSTOM_MODEL_SELECTION,
  ONBOARDING_LLM_PROVIDER_LABELS,
} from "../../onboarding/constants.js";
import { ERROR_COPY } from "./copy.js";
import styles from "./OnboardingWizard.module.css";

const ENDPOINT_MODE_COPY = [
  ["automatic", "Keep current, or use provider default"],
  ["default", "Reset to provider default"],
  ["custom", "Use a custom endpoint"],
] as const;

export function LlmSelectionPanel(props: {
  readonly surface: OnboardingSurfaceState;
  readonly actions: OnboardingActions | null;
}): ReactElement {
  const { configuration, draft } = props.surface;
  const busy = props.surface.wizard.busy;
  const actions = props.actions;

  return (
    <section className={styles.selection} aria-labelledby="llm-selection-heading">
      <h2 id="llm-selection-heading" className={styles.selectionHeading}>
        Choose provider and model
      </h2>
      <p className={styles.selectionCopy}>
        Your selected provider becomes active when you continue. Other saved keys stay available but
        inactive.
      </p>
      <div className={styles.selectionPanel}>
        {configuration === null || draft === null ? (
          <p className={styles.selectionCopy}>{ERROR_COPY["configuration-unavailable"]}</p>
        ) : (
          <>
            <label className={styles.selectionField} htmlFor="onboarding-llm-provider">
              <span className={styles.selectionLabel}>Active coach provider</span>
              <select
                id="onboarding-llm-provider"
                className={styles.control}
                disabled={busy}
                value={draft.provider.provider}
                onChange={(event) => {
                  actions?.selectProvider(event.target.value);
                }}
              >
                {configuration.providers.map((provider) => (
                  <option key={provider.provider} value={provider.provider}>
                    {ONBOARDING_LLM_PROVIDER_LABELS[provider.provider]}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.selectionField} htmlFor="onboarding-llm-model">
              <span className={styles.selectionLabel}>Model</span>
              <select
                id="onboarding-llm-model"
                className={styles.control}
                disabled={busy}
                value={draft.modelChoice}
                onChange={(event) => {
                  actions?.selectModel(event.target.value);
                }}
              >
                {draft.provider.models.map((model) => (
                  <option key={model.value} value={model.value}>
                    {model.hint === undefined ? model.label : `${model.label} · ${model.hint}`}
                  </option>
                ))}
                <option value={CUSTOM_MODEL_SELECTION}>Other model…</option>
              </select>
            </label>
            {draft.modelChoice === CUSTOM_MODEL_SELECTION ? (
              <label className={styles.selectionField} htmlFor="onboarding-custom-model">
                <span className={styles.selectionLabel}>Custom model name</span>
                <input
                  id="onboarding-custom-model"
                  className={styles.control}
                  type="text"
                  autoComplete="off"
                  maxLength={512}
                  disabled={busy}
                  value={draft.customModel}
                  aria-describedby="onboarding-error"
                  onChange={(event) => {
                    actions?.setCustomModel(event.target.value);
                  }}
                />
              </label>
            ) : null}
            {draft.provider.defaultBaseUrl === undefined ? null : (
              <>
                <label className={styles.selectionField} htmlFor="onboarding-endpoint-mode">
                  <span className={styles.selectionLabel}>Endpoint</span>
                  <select
                    id="onboarding-endpoint-mode"
                    className={styles.control}
                    disabled={busy}
                    value={draft.endpointMode}
                    onChange={(event) => {
                      actions?.setEndpointMode(event.target.value);
                    }}
                  >
                    {ENDPOINT_MODE_COPY.map(([value, copy]) => (
                      <option key={value} value={value}>
                        {copy}
                      </option>
                    ))}
                  </select>
                </label>
                <p className={styles.selectionCopy}>
                  Provider default: {draft.provider.defaultBaseUrl}
                </p>
                {draft.endpointMode === "custom" ? (
                  <label className={styles.selectionField} htmlFor="onboarding-custom-endpoint">
                    <span className={styles.selectionLabel}>Custom endpoint</span>
                    <input
                      id="onboarding-custom-endpoint"
                      className={styles.control}
                      type="url"
                      autoComplete="off"
                      maxLength={4096}
                      disabled={busy}
                      value={draft.customEndpoint}
                      aria-describedby="onboarding-error"
                      onChange={(event) => {
                        actions?.setCustomEndpoint(event.target.value);
                      }}
                    />
                  </label>
                ) : null}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
