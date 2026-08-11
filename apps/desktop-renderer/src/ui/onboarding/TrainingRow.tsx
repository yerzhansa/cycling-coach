import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import type { OnboardingActions, OnboardingSurfaceState } from "../../onboarding/controller.js";
import { credentialPresentation } from "../../onboarding/credential-presentation.js";
import { errorSection } from "../../onboarding/lanes.js";
import {
  credentialChangesBlocked,
  repairRequiredCredential,
} from "../../settings/credential-controller.js";
import {
  nonTelegramSettingsMutationActive,
  settingsMutationActive,
} from "../../state/settings-slice.js";
import { useEnduragentStore } from "../../state/store.js";
import {
  IMPORT_FILES_LABEL,
  INTERVALS_PANEL_HINT,
  RETRY_SAVED_KEYS_LABEL,
  TRAINING_CANCEL_LABEL,
  TRAINING_CONNECT_TITLE,
  TRAINING_ROW_SUBTITLES,
  TRAINING_ROW_TITLE,
  TRAINING_ROW_TOOLTIP,
  TRAINING_TRIGGER_LABELS,
  TRAINING_USE_COPIED_KEY_LABEL,
} from "./copy.js";
import { InfoTip } from "./InfoTip.js";
import {
  CredentialDeleteButton,
  CredentialDeleteConfirmation,
} from "../settings/CredentialsSection.js";
import {
  BUTTON_OUTLINE_SM,
  BUTTON_QUIET_SM,
  BUTTON_SOLID_SM,
  SETUP_LINK_BUTTON,
} from "./SetupCard.js";
import { SetupError, SetupRow, SetupSubPanel } from "./SetupRow.js";

export function TrainingRow(props: {
  readonly surface: OnboardingSurfaceState;
  readonly actions: OnboardingActions | null;
  readonly placement: "chat" | "settings";
}): ReactElement {
  const { surface, actions } = props;
  const wizard = surface.wizard;
  const busy = wizard.busy;
  const credentialSettings = useEnduragentStore((state) => state.settings.credentials);
  const credentialPort = useEnduragentStore((state) => state.settingsPorts?.credentials ?? null);
  const settingsMutating = useEnduragentStore((state) =>
    props.placement === "settings"
      ? settingsMutationActive(state.settings)
      : nonTelegramSettingsMutationActive(state.settings),
  );
  const repairCredential = repairRequiredCredential(credentialSettings);
  const repairRequired = repairCredential !== null;
  const controlsDisabled =
    busy ||
    surface.loading ||
    surface.loadUnavailable ||
    credentialChangesBlocked(credentialSettings, settingsMutating);
  const importing = surface.rideImport.status === "running";
  const connected = wizard.credentialStatus["intervals-icu"] === "configured";
  const retryable = surface.statuses.some(
    (entry) => entry.slot === "intervals-icu" && credentialPresentation(entry).retryable,
  );
  const ownsError = errorSection(wizard.fixedError, surface.lastCommit) === "training";
  const [open, setOpen] = useState(false);
  const [connectPhase, setConnectPhase] = useState<"idle" | "connecting">("idle");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const repairFeedbackRef = useRef<HTMLDivElement>(null);
  const focusHeadingAfterOpen = useRef<"delete" | "trigger" | null>(null);
  const panelId = "onboarding-training-panel";
  const credentialFocus = "focus" in credentialSettings ? credentialSettings.focus : null;

  useEffect(() => {
    if (connectPhase === "idle" || busy || surface.lastCommit !== "training") return;
    if (connected) {
      setOpen(false);
      deleteRef.current?.focus();
    }
    setConnectPhase("idle");
  }, [busy, connected, connectPhase, surface.lastCommit]);

  useEffect(() => {
    if (!repairRequired) return;
    setOpen(false);
    setConnectPhase("idle");
  }, [repairRequired]);

  useLayoutEffect(() => {
    if (connected || credentialFocus?.target !== "setup-open") return;
    focusHeadingAfterOpen.current = "delete";
    setOpen(true);
  }, [connected, credentialFocus]);

  useLayoutEffect(() => {
    const reason = focusHeadingAfterOpen.current;
    if (!open || reason === null) return;
    headingRef.current?.focus();
    if (reason === "delete") {
      if (credentialPort === null) return;
      credentialPort.setupOpened();
    }
    focusHeadingAfterOpen.current = null;
  }, [credentialPort, open]);

  useEffect(() => {
    if (
      props.placement === "chat" &&
      repairCredential === "intervals-icu" &&
      credentialFocus?.target === "feedback"
    ) {
      repairFeedbackRef.current?.focus();
    }
  }, [credentialFocus, props.placement, repairCredential]);

  const subtitle = connected ? TRAINING_ROW_SUBTITLES.connected : TRAINING_ROW_SUBTITLES.missing;

  const connect = (): void => {
    if (actions === null || controlsDisabled || importing) return;
    setConnectPhase("connecting");
    actions.connectTrainingData();
  };

  return (
    <>
      <SetupRow
        id="training"
        status={connected ? "ready" : "pending"}
        title={TRAINING_ROW_TITLE}
        subtitle={subtitle}
        info={
          <InfoTip
            label={TRAINING_ROW_TOOLTIP.label}
            lead={TRAINING_ROW_TOOLTIP.lead}
            body={TRAINING_ROW_TOOLTIP.body}
          />
        }
        trailing={
          connected ? (
            <CredentialDeleteButton credential="intervals-icu" buttonRef={deleteRef} />
          ) : (
            <button
              ref={triggerRef}
              type="button"
              data-setup-trigger="training"
              className={BUTTON_OUTLINE_SM}
              disabled={controlsDisabled}
              aria-expanded={open}
              aria-label={TRAINING_TRIGGER_LABELS.disconnected}
              {...(open ? { "aria-controls": panelId } : {})}
              onClick={() => {
                if (open) {
                  setOpen(false);
                  return;
                }
                focusHeadingAfterOpen.current = "trigger";
                setOpen(true);
              }}
            >
              Connect
            </button>
          )
        }
      />
      <CredentialDeleteConfirmation credential="intervals-icu" />
      {!connected && open && !repairRequired ? (
        <SetupSubPanel name="training" id={panelId}>
          <div className="flex min-w-0 flex-wrap items-center gap-x-7 gap-y-3">
            <div className="min-w-52 flex-1">
              <h3
                ref={headingRef}
                tabIndex={-1}
                className="m-0 text-[13.5px] font-medium text-ink focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ink"
              >
                {TRAINING_CONNECT_TITLE}
              </h3>
              <p className="mt-1 mb-0 text-xs text-ink-2">{INTERVALS_PANEL_HINT}</p>
            </div>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                className={BUTTON_QUIET_SM}
                disabled={controlsDisabled}
                aria-label={TRAINING_CANCEL_LABEL}
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className={BUTTON_SOLID_SM}
                disabled={controlsDisabled || importing}
                onClick={connect}
              >
                {connectPhase === "idle" ? TRAINING_USE_COPIED_KEY_LABEL : "Connecting…"}
              </button>
            </div>
          </div>
          <button
            type="button"
            className={SETUP_LINK_BUTTON}
            disabled={controlsDisabled || importing}
            onClick={() => {
              actions?.chooseImportFiles();
            }}
          >
            {IMPORT_FILES_LABEL}
          </button>
          <SetupError surface={surface} section="training" />
        </SetupSubPanel>
      ) : null}
      {connected && (retryable || ownsError) ? (
        <SetupSubPanel name="training-recovery">
          {retryable ? (
            <button
              type="button"
              className={SETUP_LINK_BUTTON}
              disabled={controlsDisabled || importing}
              onClick={() => {
                if (actions === null) return;
                setConnectPhase("connecting");
                actions.retrySavedKeys();
              }}
            >
              {RETRY_SAVED_KEYS_LABEL}
            </button>
          ) : null}
          <SetupError surface={surface} section="training" />
        </SetupSubPanel>
      ) : null}
      {!connected && !open && ownsError ? (
        <SetupSubPanel name="training-error">
          <SetupError surface={surface} section="training" />
        </SetupSubPanel>
      ) : null}
      {props.placement === "chat" && repairCredential === "intervals-icu" ? (
        <SetupSubPanel name="training-repair">
          <div
            ref={repairFeedbackRef}
            tabIndex={-1}
            className="focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ink"
          >
            <p className="m-0 text-xs text-ink-2" role="status" aria-live="polite">
              {"announcement" in credentialSettings && credentialSettings.announcement.length > 0
                ? credentialSettings.announcement
                : "Credential status must be reloaded before training setup can continue."}
            </p>
            <button
              type="button"
              className={SETUP_LINK_BUTTON}
              disabled={settingsMutating || credentialSettings.status === "loading"}
              onClick={() => credentialPort?.retry()}
            >
              Reload credential status
            </button>
          </div>
        </SetupSubPanel>
      ) : null}
    </>
  );
}
