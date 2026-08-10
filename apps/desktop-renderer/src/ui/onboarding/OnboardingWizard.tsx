import { useEffect, useRef, type ReactElement } from "react";
import { rideImportStatusCopy } from "../../ride-import.js";
import { useEnduragentStore } from "../../state/store.js";
import {
  AdditionalCredentialRows,
  CredentialSettingsFeedback,
  desktopCredentialId,
} from "../settings/CredentialsSection.js";
import { AiRow } from "./AiRow.js";
import {
  CHATGPT_PHASE_COPY,
  ERROR_COPY,
  FOOTER_NOTE,
  OUTSTANDING_NOTE,
  PRIMARY_LABEL,
  RETRY_SETUP_STATUS_LABEL,
  SETUP_CHAT_SUBTITLE,
  SETUP_HEADING,
  SETUP_SETTINGS_HEADING,
  SETUP_STATUS_UNAVAILABLE_COPY,
} from "./copy.js";
import { IntakeRows } from "./IntakeRows.js";
import { intakeComplete } from "../../onboarding/machine.js";
import { credentialChangesBlocked } from "../../settings/credential-controller.js";
import {
  nonTelegramSettingsMutationActive,
  settingsMutationActive,
} from "../../state/settings-slice.js";
import { BUTTON_PRIMARY, SetupCard } from "./SetupCard.js";
import { SetupError } from "./SetupRow.js";
import { TelegramRow } from "./TelegramRow.js";
import { TrainingRow } from "./TrainingRow.js";
import styles from "./OnboardingWizard.module.css";
import settingsStyles from "../settings/SettingsView.module.css";

export type SetupPlacement = "chat" | "settings";

export function SetupPanel(props: { readonly placement: SetupPlacement }): ReactElement {
  const surface = useEnduragentStore((state) => state.onboarding);
  const actions = useEnduragentStore((state) => state.onboardingActions);
  const credentialMutationBlocked = useEnduragentStore((state) =>
    credentialChangesBlocked(
      state.settings.credentials,
      props.placement === "settings"
        ? settingsMutationActive(state.settings)
        : nonTelegramSettingsMutationActive(state.settings),
    ),
  );
  const panel = useRef<HTMLElement>(null);
  const focused = useRef(-1);

  useEffect(() => {
    if (focused.current === surface.focusSeq) return;
    focused.current = surface.focusSeq;
    panel.current?.querySelector<HTMLElement>("#setup-panel-title")?.focus();
  }, [surface.focusSeq]);

  const wizard = surface.wizard;
  const readiness = surface.readiness;
  const requiredReadyCount =
    surface.loading || surface.loadUnavailable
      ? 0
      : [
          readiness.provider,
          readiness.trainingData,
          readiness.intake || intakeComplete(wizard.intake),
        ].filter(Boolean).length;
  const activeCredential = desktopCredentialId(surface.configuration?.active?.provider);
  const primaryAiCredential =
    activeCredential === surface.draft?.provider.provider ? activeCredential : null;
  const importCopy = rideImportStatusCopy(surface.rideImport);
  const actionStatus = surface.actionStatus ?? (wizard.busy || surface.loading ? "working" : null);
  const actionStatusCopy =
    actionStatus === null
      ? ""
      : actionStatus === "working"
        ? surface.loading
          ? "Checking setup…"
          : "Working…"
        : CHATGPT_PHASE_COPY[actionStatus];
  const blocked =
    credentialMutationBlocked ||
    surface.loading ||
    surface.loadUnavailable ||
    wizard.busy ||
    surface.rideImport.status === "running" ||
    !readiness.provider ||
    !readiness.trainingData ||
    !intakeComplete(wizard.intake);
  const outstanding = surface.loadUnavailable
    ? null
    : !readiness.provider
      ? "coach"
      : !readiness.trainingData
        ? "training"
        : !readiness.intake && !intakeComplete(wizard.intake)
          ? wizard.intake.injuryStatus === null
            ? "intake"
            : "clearance"
          : null;

  return (
    <section
      ref={panel}
      className={`setup-panel mx-auto w-full ${props.placement === "chat" ? styles.chatPanel : "max-w-[760px]"}`}
      data-setup-host={props.placement}
      aria-busy={surface.loading ? "true" : undefined}
    >
      {props.placement === "chat" ? (
        <header className={`${styles.chatHeader} flex flex-wrap justify-between`}>
          <div>
            <h2
              id="setup-panel-title"
              tabIndex={-1}
              className={`${styles.chatTitle} focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ink`}
            >
              {SETUP_HEADING}
            </h2>
            <p className={`${styles.chatSubtitle} text-ink-2`}>{SETUP_CHAT_SUBTITLE}</p>
          </div>
          <span
            className={`inline-flex h-[29px] flex-none items-center gap-2 rounded-full border px-2.5 text-xs ${requiredReadyCount === 3 ? "border-[color-mix(in_srgb,var(--ok)_34%,transparent)] bg-[color-mix(in_srgb,var(--ok)_8%,transparent)] text-ok" : "border-line-2 bg-surface text-ink-2"}`}
            data-setup-readiness={requiredReadyCount}
            data-state={requiredReadyCount === 3 ? "ready" : "pending"}
            role="status"
            aria-live="polite"
          >
            <span
              className={`size-[7px] rounded-full ${requiredReadyCount === 3 ? "bg-ok" : "bg-warn"}`}
              aria-hidden="true"
            />
            {requiredReadyCount} of 3 required ready
          </span>
        </header>
      ) : (
        <h2
          id="setup-panel-title"
          tabIndex={-1}
          className={`${settingsStyles.heading} focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ink`}
        >
          {SETUP_SETTINGS_HEADING}
        </h2>
      )}
      {surface.loadUnavailable ? (
        <div
          className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line-2 bg-surface px-3 py-2.5"
          data-setup-load-unavailable
          role="status"
          aria-live="polite"
        >
          <span className="text-[13px] text-ink-2">{SETUP_STATUS_UNAVAILABLE_COPY}</span>
          <button
            type="button"
            className={BUTTON_PRIMARY}
            disabled={surface.loading}
            onClick={() => {
              void actions?.refresh();
            }}
          >
            {RETRY_SETUP_STATUS_LABEL}
          </button>
        </div>
      ) : null}
      <SetupCard>
        <AiRow surface={surface} actions={actions} placement={props.placement} />
        <TrainingRow surface={surface} actions={actions} placement={props.placement} />
        {props.placement === "chat" ? <TelegramRow /> : null}
        {props.placement === "settings" ? (
          <AdditionalCredentialRows
            primaryAiCredential={primaryAiCredential}
            primaryAiProvider={surface.configuration?.active?.provider ?? null}
          />
        ) : null}
        <IntakeRows surface={surface} actions={actions} placement={props.placement} />
        {props.placement === "settings" ? <CredentialSettingsFeedback /> : null}
        {props.placement === "chat" ? (
          <footer className={styles.chatFooter}>
            <span className="text-xs text-ink-2">{FOOTER_NOTE}</span>
            <SetupError surface={surface} section="footer" />
            {outstanding === null ? null : (
              <span data-setup-outstanding={outstanding} className="text-xs text-ink-2">
                {OUTSTANDING_NOTE[outstanding]}
              </span>
            )}
            <button
              type="button"
              className={BUTTON_PRIMARY}
              disabled={blocked}
              onClick={() => {
                actions?.finish();
              }}
            >
              {PRIMARY_LABEL}
            </button>
          </footer>
        ) : null}
      </SetupCard>
      <p
        className="import-status mt-2 min-h-[18px] text-xs text-ink-2"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        hidden={importCopy.length === 0}
        data-state={surface.rideImport.status}
      >
        {importCopy}
      </p>
      <p
        className="onboarding-action-status mt-1.5 text-xs text-ink-2"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        hidden={actionStatus === null}
        data-state={actionStatus ?? "idle"}
      >
        {actionStatusCopy}
      </p>
      <p className="onboarding-error-announcer sr-only" role="status" aria-live="polite">
        {wizard.fixedError === null ? "" : ERROR_COPY[wizard.fixedError]}
      </p>
    </section>
  );
}

export function OnboardingWizard(): ReactElement | null {
  const open = useEnduragentStore((state) => state.onboarding.open);
  return open ? <SetupPanel placement="chat" /> : null;
}
