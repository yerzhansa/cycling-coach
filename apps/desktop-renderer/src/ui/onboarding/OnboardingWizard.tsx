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
  SETUP_HEADING,
} from "./copy.js";
import { IntakeRows } from "./IntakeRows.js";
import { intakeComplete } from "../../onboarding/machine.js";
import { credentialChangesBlocked } from "../../settings/credential-controller.js";
import { settingsMutationActive } from "../../state/settings-slice.js";
import { BUTTON_PRIMARY, SetupCard } from "./SetupCard.js";
import { SetupError } from "./SetupRow.js";
import { TrainingRow } from "./TrainingRow.js";

export type SetupPlacement = "chat" | "settings";

export function SetupPanel(props: { readonly placement: SetupPlacement }): ReactElement {
  const surface = useEnduragentStore((state) => state.onboarding);
  const actions = useEnduragentStore((state) => state.onboardingActions);
  const credentialMutationBlocked = useEnduragentStore((state) =>
    credentialChangesBlocked(state.settings.credentials, settingsMutationActive(state.settings)),
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
    wizard.busy ||
    surface.rideImport.status === "running" ||
    !readiness.provider ||
    !readiness.trainingData ||
    !intakeComplete(wizard.intake);
  const outstanding = !readiness.provider
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
      className="setup-panel mx-auto w-full max-w-[760px]"
      data-setup-host={props.placement}
      aria-busy={surface.loading ? "true" : undefined}
    >
      <h2
        id="setup-panel-title"
        tabIndex={-1}
        className="mb-4 text-[21px] font-medium tracking-tight focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ink"
      >
        {SETUP_HEADING}
      </h2>
      <SetupCard>
        <AiRow surface={surface} actions={actions} placement={props.placement} />
        <TrainingRow surface={surface} actions={actions} placement={props.placement} />
        {props.placement === "settings" ? (
          <AdditionalCredentialRows
            primaryAiCredential={primaryAiCredential}
            primaryAiProvider={surface.configuration?.active?.provider ?? null}
          />
        ) : null}
        <IntakeRows surface={surface} actions={actions} />
        {props.placement === "settings" ? <CredentialSettingsFeedback /> : null}
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
      <footer className="mt-3.5 flex items-center justify-between gap-3 border-t border-line pt-3.5">
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
