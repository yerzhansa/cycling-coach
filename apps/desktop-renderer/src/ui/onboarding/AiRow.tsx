import { Menu } from "@base-ui/react/menu";
import { isKeylessProvider } from "@enduragent/coach-contract";
import { Check } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  CUSTOM_MODEL_SELECTION,
  DESKTOP_CREDENTIAL_SLOTS,
  ONBOARDING_LLM_PROVIDER_LABELS,
} from "../../onboarding/constants.js";
import {
  setupStatusKnown,
  type OnboardingActions,
  type OnboardingSurfaceState,
} from "../../onboarding/controller.js";
import { chatGptReady, chatGptSignedIn, chatGptUiPhase } from "../../onboarding/machine.js";
import {
  aiRowCopy,
  apiKeyProviders,
  claudeCliNote,
  errorSection,
  laneForProvider,
  offeredLanes,
  type SetupLane,
} from "../../onboarding/lanes.js";
import { llmSelectionFromDraft, type LlmSelectionDraft } from "../../onboarding/selection.js";
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
  AI_CANCEL_LABEL,
  AI_PANEL_ANNOUNCEMENTS,
  AI_ROW_TOOLTIP,
  AI_ROW_UNSET,
  AI_SAVE_LABEL,
  AI_TRIGGER_LABELS,
  API_KEY_PANEL_HINT,
  CHATGPT_CANCEL_LABEL,
  CHATGPT_CANCEL_SIGN_IN_LABEL,
  CHATGPT_ACTIVATION_FAILURE_COPY,
  CHATGPT_PANEL_HINT,
  CHATGPT_PHASE_COPY,
  CHATGPT_REFUSAL_COPY,
  CHATGPT_RETRY_ACTIVATION_LABEL,
  CHATGPT_SIGN_IN_LABEL,
  CLAUDE_CLI_RECHECK_LABEL,
  ERROR_COPY,
  SETUP_LANE_LABELS,
  SETUP_LANE_MENU_HINTS,
  SETUP_MENU_LABEL,
  SETUP_ROW_CHECKING_SUBTITLE,
} from "./copy.js";
import { CredentialField } from "./CredentialField.js";
import { InfoTip } from "./InfoTip.js";
import {
  CredentialDeleteButton,
  CredentialDeleteConfirmation,
  SETUP_CREDENTIAL_EDIT_EVENT,
  desktopCredentialId,
  type SetupCredentialEditDetail,
} from "../settings/CredentialsSection.js";
import {
  BUTTON_OUTLINE_SM,
  BUTTON_QUIET_SM,
  BUTTON_SOLID_SM,
  SETUP_FIELD_CLASS,
  SETUP_HINT_CLASS,
  SETUP_LABEL_CLASS,
} from "./SetupCard.js";
import { SetupError, SetupRow, SetupSubPanel } from "./SetupRow.js";

const ENDPOINT_MODE_COPY = [
  ["automatic", "Keep current, or use provider default"],
  ["default", "Reset to provider default"],
  ["custom", "Use a custom endpoint"],
] as const;

const MENU_ITEM_CLASS =
  "flex w-full cursor-pointer items-start gap-[9px] rounded-md px-[9px] py-[7px] text-left text-ink outline-none data-highlighted:bg-[color-mix(in_srgb,var(--ink)_7%,transparent)]";

const MENU_ACTION_CLASS =
  "mt-1.5 cursor-pointer text-xs font-medium text-ink-2 underline underline-offset-[3px] outline-none data-highlighted:text-ink";

export function AiRow(props: {
  readonly surface: OnboardingSurfaceState;
  readonly actions: OnboardingActions | null;
  readonly placement: "chat" | "settings";
}): ReactElement {
  const { surface, actions } = props;
  const wizard = surface.wizard;
  const configuration = surface.configuration;
  const draft = surface.draft;
  const busy = wizard.busy;
  const credentialSettings = useEnduragentStore((state) => state.settings.credentials);
  const settingsMutating = useEnduragentStore((state) =>
    props.placement === "settings"
      ? settingsMutationActive(state.settings)
      : nonTelegramSettingsMutationActive(state.settings),
  );
  const repairRequired = repairRequiredCredential(credentialSettings) !== null;
  const controlsDisabled =
    busy ||
    surface.loading ||
    surface.loadUnavailable ||
    credentialChangesBlocked(credentialSettings, settingsMutating);
  const provider = draft?.provider.provider ?? null;
  const parsedDraft = llmSelectionFromDraft(draft ?? undefined);
  const activeCredential = desktopCredentialId(configuration?.active?.provider);
  const primaryCredential = activeCredential === provider ? activeCredential : null;
  const activeLane = laneForProvider(provider);
  const [picked, setPicked] = useState<SetupLane | null>(null);
  const [restoreDraft, setRestoreDraft] = useState<LlmSelectionDraft | null>(null);
  const [panelLane, setPanelLane] = useState<SetupLane | null>(null);
  const [operation, setOperation] = useState<"provider-requested" | "provider-running" | null>(
    null,
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const draftIsActive =
    surface.readiness.provider &&
    parsedDraft.error === null &&
    configuration?.active?.provider === parsedDraft.selection.provider &&
    configuration.active.model === parsedDraft.selection.model;
  const activeProviderOutsideCatalogue =
    configuration?.active !== null &&
    configuration?.active !== undefined &&
    !configuration.providers.some((entry) => entry.provider === configuration.active?.provider);
  const showsActiveProviderOutsideCatalogue =
    surface.readiness.provider && activeProviderOutsideCatalogue && picked === null;
  const ready = draftIsActive || showsActiveProviderOutsideCatalogue;
  const chatGptPhase = chatGptUiPhase(wizard);
  const chatGptStored = chatGptSignedIn(wizard);
  const chatGptIsReady = chatGptReady(wizard);
  const chatGptLoginPending =
    chatGptPhase === "waiting-for-browser" || chatGptPhase === "completing-sign-in";
  const chatGptActivating = chatGptPhase === "activating-coach";

  useEffect(() => {
    if (operation === "provider-requested") {
      const ownsStart = surface.lastCommit === "provider";
      if (busy && ownsStart) {
        setOperation("provider-running");
      } else if (!busy) {
        setOperation(null);
      }
      return;
    }
    if (operation !== null && !busy) {
      const succeeded = wizard.fixedError === null && operation === "provider-running" && ready;
      if (succeeded) {
        setPanelLane(null);
        setPicked(null);
        setRestoreDraft(null);
      }
      setOperation(null);
    }
  }, [busy, operation, ready, surface.lastCommit, wizard.fixedError]);

  useEffect(() => {
    if (chatGptPhase !== "ready" || panelLane !== "openai-codex") return;
    setPanelLane(null);
    setPicked(null);
    setRestoreDraft(null);
  }, [chatGptPhase, panelLane]);

  useEffect(() => {
    const trigger = triggerRef.current;
    if (trigger === null) return;
    const editCredential = (event: Event): void => {
      const credential = (event as CustomEvent<SetupCredentialEditDetail>).detail?.credential;
      if (controlsDisabled || credential === undefined) {
        return;
      }
      const next = configuration?.providers.find((entry) => entry.provider === credential);
      const nextLane = laneForProvider(next?.provider);
      if (next === undefined || nextLane === null) return;
      if (panelLane === null) setRestoreDraft(draft === null ? null : { ...draft });
      actions?.selectProvider(next.provider);
      setPicked(nextLane);
      setPanelLane(nextLane);
    };
    trigger.addEventListener(SETUP_CREDENTIAL_EDIT_EVENT, editCredential);
    return () => trigger.removeEventListener(SETUP_CREDENTIAL_EDIT_EVENT, editCredential);
  }, [actions, configuration, controlsDisabled, credentialSettings, draft, panelLane]);

  const activeProviderStored =
    (provider !== null &&
      isKeylessProvider(provider) &&
      provider !== "codex-agent" &&
      (provider !== "openai-codex" || chatGptStored)) ||
    DESKTOP_CREDENTIAL_SLOTS.some(
      (slot) => slot === provider && wizard.credentialStatus[slot] === "configured",
    );
  const hasActiveSelection = configuration?.active?.provider === provider && activeProviderStored;
  const lane =
    picked ??
    (showsActiveProviderOutsideCatalogue
      ? null
      : draftIsActive || hasActiveSelection
        ? activeLane
        : null);
  const autoChatGptPanel =
    panelLane === null && provider === "openai-codex" && chatGptStored && !chatGptIsReady;
  const panel = repairRequired
    ? null
    : (panelLane === "openai-codex" && chatGptPhase !== "ready") || autoChatGptPanel
      ? "chatgpt"
      : panelLane === "api-key"
        ? "api-key"
        : null;
  const lanes = offeredLanes(configuration, wizard, lane);
  const note = claudeCliNote(configuration, wizard);
  const statusKnown = setupStatusKnown(surface);
  const copy = !statusKnown
    ? { title: AI_ROW_UNSET.title, subtitle: SETUP_ROW_CHECKING_SUBTITLE }
    : showsActiveProviderOutsideCatalogue
      ? {
          title: ONBOARDING_LLM_PROVIDER_LABELS[configuration.active!.provider],
          subtitle: "Connected · powers your coach",
        }
      : aiRowCopy(lane, wizard, ready);
  const hasDisplayedProvider = lane !== null || showsActiveProviderOutsideCatalogue;
  const keyProviders = apiKeyProviders(configuration);
  const keySlot = DESKTOP_CREDENTIAL_SLOTS.find((slot) => slot === draft?.provider.provider);
  const ownsError = errorSection(wizard.fixedError, surface.lastCommit) === "provider";
  const describedBy = ownsError ? "onboarding-error" : undefined;

  const providerForLane = (next: SetupLane): string | null => {
    if (next !== "api-key") return next;
    const anthropic = keyProviders.find((entry) => entry.provider === "anthropic");
    return (anthropic ?? keyProviders[0])?.provider ?? null;
  };

  const choose = (next: SetupLane): void => {
    const opensPanel = next === "api-key" || (next === "openai-codex" && !chatGptIsReady);
    if (opensPanel && panelLane === null) {
      setRestoreDraft(draft === null ? null : { ...draft });
    } else if (!opensPanel) {
      setRestoreDraft(null);
    }
    const target = providerForLane(next);
    const switchesLane = next !== lane;
    if (switchesLane) setPicked(next);
    const canActivateKeylessLane =
      isKeylessProvider(next) && (next !== "openai-codex" || chatGptStored);
    const reactivatesCurrentKeylessProvider =
      target === provider && !ready && canActivateKeylessLane;
    if (
      target !== null &&
      ((switchesLane && target !== provider) || reactivatesCurrentKeylessProvider) &&
      actions !== null
    ) {
      if (canActivateKeylessLane && next !== "openai-codex") {
        setOperation("provider-requested");
      }
      actions.selectProvider(target);
    }
    setPanelLane(opensPanel ? next : null);
  };

  const revert = (restoreFocus = true): void => {
    if (restoreDraft !== null) {
      actions?.selectProvider(restoreDraft.provider.provider);
      actions?.selectModel(restoreDraft.modelChoice);
      actions?.setCustomModel(restoreDraft.customModel);
      actions?.setEndpointMode(restoreDraft.endpointMode);
      actions?.setCustomEndpoint(restoreDraft.customEndpoint);
    }
    setPicked(null);
    setRestoreDraft(null);
    setPanelLane(null);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!repairRequired) return;
    if (restoreDraft !== null) {
      actions?.selectProvider(restoreDraft.provider.provider);
      actions?.selectModel(restoreDraft.modelChoice);
      actions?.setCustomModel(restoreDraft.customModel);
      actions?.setEndpointMode(restoreDraft.endpointMode);
      actions?.setCustomEndpoint(restoreDraft.customEndpoint);
    }
    setPicked(null);
    setRestoreDraft(null);
    setPanelLane(null);
  }, [actions, repairRequired, restoreDraft]);

  const revertLane = laneForProvider(restoreDraft?.provider.provider ?? null);
  const revertLabel = revertLane === null ? "Cancel" : `Keep ${SETUP_LANE_LABELS[revertLane]}`;

  const save = (): void => {
    if (actions === null || controlsDisabled) return;
    setOperation("provider-requested");
    actions.saveModelKey();
  };

  const login = (): void => {
    if (actions === null || controlsDisabled || chatGptLoginPending || chatGptActivating) return;
    actions.startChatGptLogin();
  };

  const chatGptPrimaryLabel = chatGptLoginPending
    ? CHATGPT_PHASE_COPY[chatGptPhase]
    : chatGptActivating
      ? CHATGPT_PHASE_COPY["activating-coach"]
      : chatGptStored && !chatGptIsReady
        ? CHATGPT_RETRY_ACTIVATION_LABEL
        : CHATGPT_SIGN_IN_LABEL;
  const chatGptStatusCopy =
    chatGptPhase === "waiting-for-browser" || chatGptPhase === "completing-sign-in"
      ? CHATGPT_PHASE_COPY[chatGptPhase]
      : chatGptPhase === "signed-in"
        ? CHATGPT_PHASE_COPY["signed-in"]
        : chatGptPhase === "activating-coach"
          ? `${CHATGPT_PHASE_COPY["signed-in"]} · ${CHATGPT_PHASE_COPY["activating-coach"]}`
          : chatGptPhase === "ready"
            ? CHATGPT_PHASE_COPY.ready
            : chatGptPhase === "activation-failed"
              ? CHATGPT_ACTIVATION_FAILURE_COPY
              : null;

  return (
    <>
      <SetupRow
        id="ai"
        status={!statusKnown ? "none" : ready ? "ready" : "pending"}
        title={copy.title}
        subtitle={copy.subtitle}
        announce={panel === null ? "" : AI_PANEL_ANNOUNCEMENTS[panel]}
        info={
          <InfoTip
            label={AI_ROW_TOOLTIP.label}
            lead={AI_ROW_TOOLTIP.lead}
            body={AI_ROW_TOOLTIP.body}
          />
        }
        trailing={
          !statusKnown ? null : (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Menu.Root>
                <Menu.Trigger
                  ref={triggerRef}
                  data-setup-trigger="ai"
                  disabled={controlsDisabled || chatGptActivating}
                  aria-label={
                    hasDisplayedProvider ? AI_TRIGGER_LABELS.set : AI_TRIGGER_LABELS.unset
                  }
                  className={!hasDisplayedProvider ? BUTTON_OUTLINE_SM : BUTTON_QUIET_SM}
                >
                  {hasDisplayedProvider ? "Change" : "Choose"}
                </Menu.Trigger>
                <Menu.Portal>
                  <Menu.Positioner side="bottom" align="end" sideOffset={6}>
                    <Menu.Popup
                      data-setup-menu="ai"
                      className="w-[262px] rounded-md border border-line-2 bg-surface p-[5px] shadow-elev-3"
                    >
                      <Menu.RadioGroup value={lane}>
                        <Menu.GroupLabel className="px-[9px] pt-1.5 pb-1 text-[11px] font-semibold tracking-wider text-ink-2 uppercase">
                          {SETUP_MENU_LABEL}
                        </Menu.GroupLabel>
                        {lanes.map((entry) => (
                          <Menu.RadioItem
                            key={entry}
                            value={entry}
                            data-lane={entry}
                            closeOnClick
                            disabled={controlsDisabled}
                            className={MENU_ITEM_CLASS}
                            onClick={() => {
                              choose(entry);
                            }}
                          >
                            <span className="mt-px grid size-[15px] shrink-0 place-items-center text-ok">
                              <Menu.RadioItemIndicator>
                                <Check size={11} strokeWidth={3.2} aria-hidden="true" />
                              </Menu.RadioItemIndicator>
                            </span>
                            <span className="min-w-0 flex-1">
                              <b className="block text-[13.5px] font-medium">
                                {SETUP_LANE_LABELS[entry]}
                              </b>
                              <i className="mt-px block text-xs text-ink-2 not-italic">
                                {SETUP_LANE_MENU_HINTS[entry]}
                              </i>
                            </span>
                          </Menu.RadioItem>
                        ))}
                      </Menu.RadioGroup>
                      {note === null ? null : (
                        <div className="mt-1 border-t border-line px-[9px] pt-2 pb-1">
                          <p
                            data-setup-note="claude-cli"
                            className="text-[11.5px] leading-normal text-ink-2"
                          >
                            {note}
                          </p>
                          <Menu.Item
                            disabled={controlsDisabled}
                            className={MENU_ACTION_CLASS}
                            onClick={() => {
                              actions?.recheckClaudeCli();
                            }}
                          >
                            {CLAUDE_CLI_RECHECK_LABEL}
                          </Menu.Item>
                        </div>
                      )}
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.Root>
              {props.placement === "settings" && primaryCredential !== null ? (
                <CredentialDeleteButton credential={primaryCredential} />
              ) : null}
            </div>
          )
        }
      />
      {props.placement === "settings" && primaryCredential !== null ? (
        <CredentialDeleteConfirmation credential={primaryCredential} />
      ) : null}
      {panel === "chatgpt" ? (
        <SetupSubPanel name="chatgpt">
          <div className="flex flex-wrap items-center gap-2">
            {autoChatGptPanel && !chatGptLoginPending ? null : (
              <button
                type="button"
                className={BUTTON_QUIET_SM}
                disabled={
                  chatGptLoginPending ? surface.loading : controlsDisabled || chatGptActivating
                }
                {...(chatGptLoginPending
                  ? { "aria-label": CHATGPT_CANCEL_SIGN_IN_LABEL }
                  : revertLane === null
                    ? { "aria-label": CHATGPT_CANCEL_LABEL }
                    : {})}
                onClick={() => {
                  if (chatGptLoginPending) actions?.cancelChatGptLogin();
                  else revert();
                }}
              >
                {chatGptLoginPending ? CHATGPT_CANCEL_SIGN_IN_LABEL : revertLabel}
              </button>
            )}
            <button
              type="button"
              className={BUTTON_SOLID_SM}
              disabled={controlsDisabled || chatGptLoginPending || chatGptActivating}
              onClick={() => {
                if (chatGptStored) actions?.retryChatGptActivation();
                else login();
              }}
            >
              {chatGptPrimaryLabel}
            </button>
          </div>
          {chatGptStatusCopy === null ? null : (
            <p
              className={`mt-[7px] text-[11.5px] ${chatGptPhase === "activation-failed" ? "text-danger" : "text-ink-2"}`}
              role="status"
              aria-live="polite"
              aria-atomic="true"
              data-chatgpt-phase={chatGptPhase}
            >
              {chatGptStatusCopy}
            </p>
          )}
          {wizard.chatGptRefusal !== null ? (
            <p className="mt-[7px] text-[11.5px] text-danger" aria-live="polite">
              {CHATGPT_REFUSAL_COPY[wizard.chatGptRefusal]}
            </p>
          ) : null}
          <span className={SETUP_HINT_CLASS}>{CHATGPT_PANEL_HINT}</span>
          <SetupError surface={surface} section="provider" />
        </SetupSubPanel>
      ) : null}
      {panel === "api-key" ? (
        <SetupSubPanel name="api-key">
          {configuration === null || draft === null ? (
            <p className="text-[13px] text-ink-2">{ERROR_COPY["configuration-unavailable"]}</p>
          ) : (
            <>
              <label className={SETUP_LABEL_CLASS} htmlFor="onboarding-llm-provider">
                Provider
              </label>
              <select
                id="onboarding-llm-provider"
                className={SETUP_FIELD_CLASS}
                disabled={controlsDisabled}
                value={draft.provider.provider}
                onChange={(event) => {
                  actions?.selectProvider(event.target.value);
                }}
              >
                {keyProviders.map((entry) => (
                  <option key={entry.provider} value={entry.provider}>
                    {ONBOARDING_LLM_PROVIDER_LABELS[entry.provider]}
                  </option>
                ))}
              </select>
              {keySlot === undefined ? null : (
                <div className="mt-[11px]">
                  <CredentialField
                    slot={keySlot}
                    label={`${ONBOARDING_LLM_PROVIDER_LABELS[draft.provider.provider]} API key`}
                    disabled={controlsDisabled}
                    {...(describedBy === undefined ? {} : { describedBy })}
                    onEnter={save}
                  />
                </div>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={BUTTON_QUIET_SM}
                  disabled={controlsDisabled}
                  aria-label={AI_CANCEL_LABEL}
                  onClick={() => revert()}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={BUTTON_SOLID_SM}
                  disabled={controlsDisabled}
                  aria-label={AI_SAVE_LABEL}
                  onClick={save}
                >
                  Save
                </button>
              </div>
              <span className={SETUP_HINT_CLASS}>{API_KEY_PANEL_HINT}</span>
              <details className="mt-2">
                <summary className="cursor-pointer py-1.5 text-xs text-ink-2">Advanced</summary>
                <div className="grid gap-[11px] pt-1.5">
                  <div>
                    <label className={SETUP_LABEL_CLASS} htmlFor="onboarding-llm-model">
                      Model
                    </label>
                    <select
                      id="onboarding-llm-model"
                      className={SETUP_FIELD_CLASS}
                      disabled={controlsDisabled}
                      value={draft.modelChoice}
                      onChange={(event) => {
                        actions?.selectModel(event.target.value);
                      }}
                    >
                      {draft.provider.models.map((model) => (
                        <option key={model.value} value={model.value}>
                          {model.hint === undefined
                            ? model.label
                            : `${model.label} · ${model.hint}`}
                        </option>
                      ))}
                      <option value={CUSTOM_MODEL_SELECTION}>Other model…</option>
                    </select>
                  </div>
                  {draft.modelChoice === CUSTOM_MODEL_SELECTION ? (
                    <div>
                      <label className={SETUP_LABEL_CLASS} htmlFor="onboarding-custom-model">
                        Custom model name
                      </label>
                      <input
                        id="onboarding-custom-model"
                        className={SETUP_FIELD_CLASS}
                        type="text"
                        autoComplete="off"
                        maxLength={512}
                        disabled={controlsDisabled}
                        value={draft.customModel}
                        aria-describedby={describedBy}
                        onChange={(event) => {
                          actions?.setCustomModel(event.target.value);
                        }}
                      />
                    </div>
                  ) : null}
                  {draft.provider.defaultBaseUrl === undefined ? null : (
                    <>
                      <div>
                        <label className={SETUP_LABEL_CLASS} htmlFor="onboarding-endpoint-mode">
                          Endpoint
                        </label>
                        <select
                          id="onboarding-endpoint-mode"
                          className={SETUP_FIELD_CLASS}
                          disabled={controlsDisabled}
                          value={draft.endpointMode}
                          onChange={(event) => {
                            actions?.setEndpointMode(event.target.value);
                          }}
                        >
                          {ENDPOINT_MODE_COPY.map(([value, entry]) => (
                            <option key={value} value={value}>
                              {entry}
                            </option>
                          ))}
                        </select>
                      </div>
                      {draft.endpointMode === "custom" ? (
                        <div>
                          <label className={SETUP_LABEL_CLASS} htmlFor="onboarding-custom-endpoint">
                            Custom endpoint
                          </label>
                          <input
                            id="onboarding-custom-endpoint"
                            className={SETUP_FIELD_CLASS}
                            type="url"
                            autoComplete="off"
                            maxLength={4096}
                            disabled={controlsDisabled}
                            value={draft.customEndpoint}
                            aria-describedby={describedBy}
                            onChange={(event) => {
                              actions?.setCustomEndpoint(event.target.value);
                            }}
                          />
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </details>
            </>
          )}
          <SetupError surface={surface} section="provider" />
        </SetupSubPanel>
      ) : null}
      {panel === null && ownsError ? (
        <SetupSubPanel name="ai-error">
          <SetupError surface={surface} section="provider" />
        </SetupSubPanel>
      ) : null}
    </>
  );
}
