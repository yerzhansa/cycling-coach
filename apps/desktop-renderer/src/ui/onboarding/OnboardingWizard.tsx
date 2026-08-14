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
  ERROR_COPY,
  FOOTER_NOTE,
  PRIMARY_LABEL,
  RETRY_SETUP_STATUS_LABEL,
  SETUP_DISCLAIMER,
  SETUP_GATE_SUBTITLE,
  SETUP_HEADING,
  SETUP_SETTINGS_HEADING,
  SETUP_STATUS_UNAVAILABLE_COPY,
} from "./copy.js";
import { IntakeRows } from "./IntakeRows.js";
import { intakeComplete } from "../../onboarding/machine.js";
import {
  credentialChangesBlocked,
  repairRequiredCredential,
} from "../../settings/credential-controller.js";
import {
  nonTelegramSettingsMutationActive,
  settingsMutationActive,
} from "../../state/settings-slice.js";
import { BUTTON_PRIMARY, SetupCard } from "./SetupCard.js";
import { SetupError } from "./SetupRow.js";
import { TrainingRow } from "./TrainingRow.js";
import settingsStyles from "../settings/SettingsView.module.css";

export type SetupPlacement = "gate" | "settings";

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
  const credentialFeedbackVisible = useEnduragentStore((state) => {
    const credentials = state.settings.credentials;
    return (
      props.placement === "settings" ||
      credentials.status !== "closed" ||
      repairRequiredCredential(credentials) !== null
    );
  });
  const panel = useRef<HTMLElement>(null);
  const focused = useRef(-1);

  useEffect(() => {
    if (focused.current === surface.focusSeq) return;
    focused.current = surface.focusSeq;
    panel.current?.querySelector<HTMLElement>("#setup-panel-title")?.focus();
  }, [surface.focusSeq]);

  const wizard = surface.wizard;
  const readiness = surface.readiness;
  const gateUnavailable = props.placement === "gate" && surface.loadUnavailable;
  const intakeAnswered = readiness.intake || intakeComplete(wizard.intake);
  const requiredReadyCount = [readiness.provider, readiness.trainingData, intakeAnswered].filter(
    Boolean,
  ).length;
  const requiredSetupReady = requiredReadyCount === 3;
  const activeCredential = desktopCredentialId(surface.configuration?.active?.provider);
  const primaryAiCredential =
    activeCredential === surface.draft?.provider.provider ? activeCredential : null;
  const importCopy = rideImportStatusCopy(surface.rideImport);
  const blocked =
    credentialMutationBlocked ||
    surface.loading ||
    surface.loadUnavailable ||
    wizard.busy ||
    surface.rideImport.status === "running" ||
    !readiness.provider ||
    !readiness.trainingData ||
    !intakeComplete(wizard.intake);
  return (
    <section
      ref={panel}
      className={`setup-panel mx-auto w-full ${props.placement === "gate" ? "max-w-[680px]" : "max-w-[760px]"}`}
      data-setup-host={props.placement}
      aria-busy={surface.loading ? "true" : undefined}
    >
      {props.placement === "gate" ? (
        <header className="mb-[22px] flex flex-wrap items-end justify-between gap-5">
          <div>
            <h1
              id="setup-panel-title"
              tabIndex={-1}
              className="text-[27px] leading-[1.16] font-[590] tracking-[-0.035em] outline-none"
            >
              {SETUP_HEADING}
            </h1>
            <p className="mt-2 max-w-[520px] text-[13.5px] text-ink-2">{SETUP_GATE_SUBTITLE}</p>
          </div>
          {gateUnavailable ? null : (
            <span
              className={`inline-flex h-ctl-sm flex-none items-center gap-2 rounded-full border px-row text-xs ${requiredSetupReady ? "border-ok/35 bg-ok/10 text-ok" : "border-line-2 bg-surface text-ink-2"}`}
              data-setup-readiness={requiredReadyCount}
              data-state={requiredSetupReady ? "ready" : "pending"}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <span
                className={`size-2 rounded-full ring-4 ${requiredSetupReady ? "bg-ok ring-ok/10" : "bg-warn ring-warn/10"}`}
                data-setup-readiness-dot={requiredSetupReady ? "ready" : "pending"}
                aria-hidden="true"
              />
              {requiredReadyCount} of 3 required ready
            </span>
          )}
        </header>
      ) : (
        <h2 id="setup-panel-title" tabIndex={-1} className={settingsStyles.heading}>
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
      {gateUnavailable ? null : (
        <SetupCard>
          <AiRow surface={surface} actions={actions} placement={props.placement} />
          <TrainingRow surface={surface} actions={actions} placement={props.placement} />
          {props.placement === "settings" ? (
            <AdditionalCredentialRows
              primaryAiCredential={primaryAiCredential}
              primaryAiProvider={surface.configuration?.active?.provider ?? null}
            />
          ) : null}
          <IntakeRows surface={surface} actions={actions} placement={props.placement} />
          {credentialFeedbackVisible ? <CredentialSettingsFeedback /> : null}
        </SetupCard>
      )}
      {props.placement === "gate" && !surface.loadUnavailable ? (
        <footer className="mt-[18px] flex flex-wrap items-center gap-3">
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
          <SetupError surface={surface} section="footer" />
          <span className="ml-auto text-xs text-ink-2">{FOOTER_NOTE}</span>
        </footer>
      ) : null}
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
      <p className="onboarding-error-announcer sr-only" role="status" aria-live="polite">
        {wizard.fixedError === null ? "" : ERROR_COPY[wizard.fixedError]}
      </p>
      {props.placement === "gate" ? (
        <p className="mt-5 text-[11px] leading-normal text-ink-2">{SETUP_DISCLAIMER}</p>
      ) : null}
    </section>
  );
}

export function OnboardingWizard(): ReactElement | null {
  const open = useEnduragentStore((state) => state.onboarding.open);
  return open ? <SetupPanel placement="gate" /> : null;
}
