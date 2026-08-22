import { Fragment, useEffect, useRef, type ReactElement, type RefObject } from "react";
import type { DesktopCredentialId } from "../../onboarding/bridge.js";
import { DESKTOP_CREDENTIAL_SLOTS } from "../../onboarding/constants.js";
import { onboardingCredentialMutationActive } from "../../onboarding/controller.js";
import { claudeCliPresentation } from "../../onboarding/credential-presentation.js";
import { PLATFORM_COPY } from "../../platform-copy.js";
import type {
  CredentialSettingsEntry,
  CredentialSettingsState,
} from "../../settings/credential-controller.js";
import {
  credentialChangesBlocked,
  repairRequiredCredential,
} from "../../settings/credential-controller.js";
import { settingsMutationActive } from "../../state/settings-slice.js";
import { useEnduragentStore } from "../../state/store.js";
import { SetupRow } from "../onboarding/SetupRow.js";
import { BUTTON_DANGER_QUIET_SM, BUTTON_QUIET_SM } from "../onboarding/SetupCard.js";
import { InlineConfirmation } from "../shared/InlineConfirmation.js";
import { credentialRuntimeLabel } from "./copy.js";
import { settingsStyles as styles } from "./styles.js";

export const SETUP_CREDENTIAL_EDIT_EVENT = "enduragent:edit-credential";

export interface SetupCredentialEditDetail {
  readonly credential: DesktopCredentialId;
}

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

export function desktopCredentialId(
  provider: string | null | undefined,
): DesktopCredentialId | null {
  if (provider === "openai-codex") return provider;
  return DESKTOP_CREDENTIAL_SLOTS.find((credential) => credential === provider) ?? null;
}

function entryFor(
  state: CredentialSettingsState,
  credential: DesktopCredentialId,
): CredentialSettingsEntry | null {
  return content(state)?.entries.find((entry) => entry.credential === credential) ?? null;
}

function openCredentialEditor(credential: DesktopCredentialId): void {
  const selector =
    credential === "intervals-icu"
      ? '[data-setup-trigger="training"]'
      : '[data-setup-trigger="ai"]';
  const trigger = document.querySelector<HTMLButtonElement>(selector);
  trigger?.focus();
  if (credential === "intervals-icu") {
    trigger?.click();
    return;
  }
  trigger?.dispatchEvent(
    new CustomEvent<SetupCredentialEditDetail>(SETUP_CREDENTIAL_EDIT_EVENT, {
      bubbles: true,
      detail: { credential },
    }),
  );
}

export function CredentialDeleteButton(props: {
  readonly credential: DesktopCredentialId;
  readonly buttonRef?: RefObject<HTMLButtonElement | null>;
}): ReactElement | null {
  const state = useEnduragentStore((store) => store.settings.credentials);
  const mutating = useEnduragentStore((store) => settingsMutationActive(store.settings));
  const setupLoading = useEnduragentStore((store) => store.onboarding.loading);
  const onboardingMutating = useEnduragentStore((store) =>
    onboardingCredentialMutationActive(store.onboarding),
  );
  const port = useEnduragentStore((store) => store.settingsPorts?.credentials ?? null);
  const ownButton = useRef<HTMLButtonElement>(null);
  const button = props.buttonRef ?? ownButton;
  const entry = entryFor(state, props.credential);
  const intervalsConnected = useEnduragentStore(
    (store) => store.onboarding.wizard.credentialStatus["intervals-icu"] === "configured",
  );
  const target = "focus" in state ? state.focus : null;
  const confirmation = content(state)?.confirmation ?? null;
  const repairRequired = repairRequiredCredential(state) !== null;
  const intervalsFallback = props.credential === "intervals-icu" && intervalsConnected;

  useEffect(() => {
    if (target?.target === "delete" && target.credential === props.credential) {
      button.current?.focus();
    }
  }, [props.credential, target]);

  if (entry === null && !intervalsFallback) return null;
  const provider = entry?.provider ?? "Intervals.icu";
  return (
    <button
      type="button"
      ref={button}
      data-setup-delete={props.credential}
      className={BUTTON_DANGER_QUIET_SM}
      disabled={
        port === null ||
        state.status === "loading" ||
        mutating ||
        setupLoading ||
        onboardingMutating ||
        confirmation !== null ||
        repairRequired
      }
      aria-label={
        props.credential === "intervals-icu"
          ? "Delete the Intervals.icu connection"
          : `Delete the ${provider} credential`
      }
      onClick={() => port?.requestDelete(props.credential)}
    >
      Delete
    </button>
  );
}

export function CredentialDeleteConfirmation(props: {
  readonly credential: DesktopCredentialId;
}): ReactElement | null {
  const state = useEnduragentStore((store) => store.settings.credentials);
  const mutating = useEnduragentStore((store) => settingsMutationActive(store.settings));
  const onboardingMutating = useEnduragentStore((store) =>
    onboardingCredentialMutationActive(store.onboarding),
  );
  const port = useEnduragentStore((store) => store.settingsPorts?.credentials ?? null);
  const entry = entryFor(state, props.credential);
  const target = "focus" in state ? state.focus : null;
  const confirmation = content(state)?.confirmation ?? null;
  const deleting = state.status === "deleting";

  if (entry === null || confirmation !== props.credential) return null;
  const intervals = entry.credential === "intervals-icu";
  return (
    <InlineConfirmation
      name={`delete-${entry.credential}`}
      title={
        intervals
          ? "Delete the Intervals.icu connection?"
          : `Delete the ${entry.provider} credential?`
      }
      copy={
        intervals
          ? `Your saved API key and imported connection will be removed. Your synced rides and past chats stay on ${PLATFORM_COPY.computer}.`
          : `This removes it from ${PLATFORM_COPY.computer} only. Enduragent will stop using it if it is active. Your provider account is unchanged.`
      }
      confirmLabel={intervals ? "Delete connection" : "Delete credential"}
      {...(intervals
        ? {}
        : { confirmAriaLabel: `Confirm deletion of the ${entry.provider} credential` })}
      focusTarget={
        target?.target === "confirmation-cancel"
          ? "cancel"
          : target?.target === "confirmation-delete"
            ? "confirm"
            : null
      }
      cancelDisabled={mutating}
      confirmDisabled={mutating || onboardingMutating}
      confirmBusy={deleting}
      onCancel={() => port?.cancelDelete()}
      onConfirm={() => port?.confirmDelete()}
    />
  );
}

export function AdditionalCredentialRows(props: {
  readonly primaryAiCredential: DesktopCredentialId | null;
  readonly primaryAiProvider: string | null;
}): ReactElement | null {
  const state = useEnduragentStore((store) => store.settings.credentials);
  const mutating = useEnduragentStore((store) => settingsMutationActive(store.settings));
  const setupLoading = useEnduragentStore((store) => store.onboarding.loading);
  const onboardingMutating = useEnduragentStore((store) =>
    onboardingCredentialMutationActive(store.onboarding),
  );
  const entries = (content(state)?.entries ?? []).filter(
    (entry) =>
      entry.credential !== "intervals-icu" && entry.credential !== props.primaryAiCredential,
  );
  const changesBlocked = credentialChangesBlocked(state, mutating);
  const providerStatuses = (content(state)?.providerStatuses ?? []).filter(
    (entry) => entry.provider !== props.primaryAiProvider,
  );

  if (entries.length === 0 && providerStatuses.length === 0) return null;
  return (
    <>
      {entries.map((entry) => (
        <Fragment key={entry.credential}>
          <SetupRow
            id={`saved-${entry.credential}`}
            status="none"
            title={entry.provider}
            subtitle={`${entry.kind} · ${credentialRuntimeLabel(entry.runtimeState)}`}
            trailing={
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  className={BUTTON_QUIET_SM}
                  disabled={setupLoading || onboardingMutating || changesBlocked}
                  aria-label={`Change the ${entry.provider} credential`}
                  onClick={() => openCredentialEditor(entry.credential)}
                >
                  Change
                </button>
                <CredentialDeleteButton credential={entry.credential} />
              </div>
            }
          />
          <CredentialDeleteConfirmation credential={entry.credential} />
        </Fragment>
      ))}
      {providerStatuses.map((entry) => {
        const presentation = claudeCliPresentation(entry.state);
        return (
          <SetupRow
            key={entry.provider}
            id={`provider-${entry.provider}`}
            dataProvider={entry.provider}
            status="none"
            title={entry.label}
            subtitle={
              <>
                {entry.kind} · {presentation.badge}
                {entry.identity === null ? null : (
                  <>
                    {" "}
                    · <span data-provider-identity="">{entry.identity}</span>
                  </>
                )}
              </>
            }
          />
        );
      })}
    </>
  );
}

export function CredentialSettingsFeedback(): ReactElement | null {
  const state = useEnduragentStore((store) => store.settings.credentials);
  const mutating = useEnduragentStore((store) => settingsMutationActive(store.settings));
  const port = useEnduragentStore((store) => store.settingsPorts?.credentials ?? null);
  const feedback = useRef<HTMLDivElement>(null);
  const target = "focus" in state ? state.focus : null;
  const repairRequired = repairRequiredCredential(state);
  const loading =
    state.status === "loading" || (state.status === "closed" && repairRequired === null);
  const loadError = state.status === "error" && state.kind === "load";
  const announcement =
    "announcement" in state && state.announcement.length > 0
      ? state.announcement
      : state.status === "closed" && repairRequired !== null
        ? "Saved credential status needs to be reloaded before setup can continue."
        : loading
          ? "Loading saved credentials…"
          : "";

  useEffect(() => {
    if (target?.target === "feedback") {
      feedback.current?.focus();
      return;
    }
    if (target?.target !== "setup") return;
    const selector =
      target.credential === "intervals-icu"
        ? '[data-setup-trigger="training"]'
        : '[data-setup-trigger="ai"]';
    const action = document.querySelector<HTMLButtonElement>(selector);
    if (action !== null && !action.disabled) action.focus();
    else document.querySelector<HTMLElement>("#setup-panel-title")?.focus();
  }, [target]);

  if (announcement.length === 0 && !loadError && repairRequired === null) return null;
  return (
    <div
      ref={feedback}
      tabIndex={-1}
      className="w-full bg-sunk px-[15px] py-3 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink"
      data-credential-feedback=""
    >
      {announcement.length === 0 ? null : (
        <p className="m-0 text-xs text-ink-2" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>
      )}
      {loadError || repairRequired !== null ? (
        <button
          type="button"
          className={`${styles.button} mt-2`}
          disabled={mutating || loading}
          onClick={() => port?.retry()}
        >
          {repairRequired === null ? "Reconnect & reload" : "Reload credential status"}
        </button>
      ) : null}
    </div>
  );
}
