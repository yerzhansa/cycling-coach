import type { ReactElement } from "react";
import {
  ADVANCED_MODEL_CREDENTIAL_SLOTS,
  PRIMARY_MODEL_CREDENTIAL_SLOTS,
} from "../../onboarding/constants.js";
import {
  credentialSlotStatus,
  type OnboardingActions,
  type OnboardingSurfaceState,
} from "../../onboarding/controller.js";
import { CHATGPT_REFUSAL_COPY } from "./copy.js";
import { CredentialField } from "./CredentialField.js";
import { LlmSelectionPanel } from "./LlmSelectionPanel.js";
import styles from "./OnboardingWizard.module.css";

function ChatGptLane(props: {
  readonly surface: OnboardingSurfaceState;
  readonly actions: OnboardingActions | null;
  readonly disabled: boolean;
}): ReactElement {
  const wizard = props.surface.wizard;
  const active = wizard.chatGptState === "configured" && wizard.chatGptRuntimeReady;
  const stored = wizard.chatGptState === "configured" && !wizard.chatGptRuntimeReady;
  const signIn = (label: string): ReactElement => (
    <button
      type="button"
      className={`${styles.primaryButton} ${styles.laneButton}`}
      disabled={props.disabled}
      onClick={() => {
        props.actions?.startChatGptLogin();
      }}
    >
      {label}
    </button>
  );

  return (
    <section className={styles.lane}>
      <div className={`${styles.laneHeading} chatgpt-lane-heading`}>
        <strong>ChatGPT subscription</strong>
        <span
          className={`${styles.badge} credential-state`}
          data-state={active ? "configured" : stored ? "stored-inactive" : "missing"}
        >
          {active ? "Configured" : stored ? "Saved · Not in use" : "No API key"}
        </span>
      </div>
      <p className={styles.laneCopy}>Requires a paid ChatGPT plan. No API key needed.</p>
      {wizard.chatGptState === "pending" ? (
        <button type="button" className={`${styles.primaryButton} ${styles.laneButton}`} disabled>
          Finish signing in in your browser…
        </button>
      ) : active ? (
        <>
          <p className={styles.laneReady}>ChatGPT is ready.</p>
          {signIn("Sign in again")}
        </>
      ) : (
        <>
          {wizard.chatGptState === "refused" && wizard.chatGptRefusal !== null ? (
            <p className={styles.laneRefused} aria-live="polite">
              {CHATGPT_REFUSAL_COPY[wizard.chatGptRefusal]}
            </p>
          ) : null}
          {wizard.chatGptState === "configured" ? (
            <p className={styles.laneCopy}>
              Your ChatGPT sign-in is saved. Sign in again to activate it.
            </p>
          ) : null}
          {signIn(
            wizard.chatGptState === "absent" ? "Sign in with ChatGPT" : "Retry ChatGPT sign-in",
          )}
        </>
      )}
    </section>
  );
}

export function CoachKeysStep(props: {
  readonly surface: OnboardingSurfaceState;
  readonly actions: OnboardingActions | null;
  readonly disabled: boolean;
}): ReactElement {
  const surface = props.surface;

  return (
    <>
      <p className={styles.kicker}>Coach keys</p>
      <h2 id="onboarding-title" className={styles.title} tabIndex={-1}>
        Choose how your coach thinks
      </h2>
      <p className={`${styles.copy} onboarding-copy`}>
        ChatGPT sign-in is saved in a local profile file. API keys are encrypted by macOS. The local
        coaching service uses your choice to contact the provider.
      </p>
      <LlmSelectionPanel surface={surface} actions={props.actions} />
      <ChatGptLane surface={surface} actions={props.actions} disabled={props.disabled} />
      <div className={styles.divider}>or use an API key</div>
      <div className={styles.credentials}>
        {PRIMARY_MODEL_CREDENTIAL_SLOTS.map((provider) => (
          <CredentialField
            key={provider.id}
            slot={provider.id}
            label={provider.label}
            hint={provider.hint}
            status={credentialSlotStatus(surface, provider.id)}
            disabled={surface.wizard.busy}
          />
        ))}
      </div>
      <details className={styles.advanced}>
        <summary className={styles.summary}>Advanced providers</summary>
        <div className={styles.credentials}>
          {ADVANCED_MODEL_CREDENTIAL_SLOTS.map((provider) => (
            <CredentialField
              key={provider.id}
              slot={provider.id}
              label={provider.label}
              status={credentialSlotStatus(surface, provider.id)}
              disabled={surface.wizard.busy}
            />
          ))}
        </div>
      </details>
    </>
  );
}
