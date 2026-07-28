import {
  CoachClientDisconnectedError,
  CoachClientProtocolError,
  type CoachClient,
} from "@enduragent/coach-client";
import { SaveIntakeRpcParamsSchema } from "@enduragent/coach-contract";
import { flushSync } from "react-dom";
import "./styles.css";
import "./chat/styles.css";
import "./training-context/styles.css";
import "./onboarding/onboarding.css";
import "./ride-import.css";
import { createChatController } from "./chat/controller.js";
import { createDesktopCoachClientProvider } from "./coach-client.js";
import { createFirstSyncController } from "./first-sync.js";
import { createChatViewAdapter } from "./state/adapters/chat.js";
import { createFirstSyncViewAdapter } from "./state/adapters/first-sync.js";
import { createReleaseNotesSettingsAdapter } from "./state/adapters/release-notes.js";
import {
  createAthleteSettingsAdapter,
  createConversationSettingsAdapter,
  createCoachSettingsAdapter,
  createCredentialSettingsAdapter,
} from "./state/adapters/settings.js";
import { createSpendSettingsAdapter } from "./state/adapters/spend.js";
import { createUpdateSettingsAdapter } from "./state/adapters/update.js";
import { useEnduragentStore } from "./state/store.js";
import { validateImportPaths, type OnboardingBridge } from "./onboarding/bridge.js";
import { createOnboardingCompletionController } from "./onboarding/completion.js";
import { mountOnboarding } from "./onboarding/mount.js";
import {
  createTrainingContextController,
  type TrainingContextView,
} from "./training-context/controller.js";
import { createManualSyncController } from "./training-context/manual-sync.js";
import { mountTrainingContextView } from "./training-context/view.js";
import { createTrainingSyncCoordinator } from "./training-sync.js";
import { createSpendMeterController } from "./spend-meter/controller.js";
import { createReleaseNotesController } from "./release-notes/controller.js";
import { createDesktopUpdateController } from "./update/controller.js";
import { createProviderModelSettingsController } from "./settings/provider-model-controller.js";
import { createAthleteSettingsController } from "./settings/athlete-controller.js";
import { createSessionSettingsController } from "./settings/session-controller.js";
import { createCredentialSettingsController } from "./settings/credential-controller.js";
import {
  createRideImportController,
  mountResidentRideImport,
  subscribeToDroppedRideImports,
} from "./ride-import.js";

export interface LegacyHosts {
  readonly topbar: HTMLElement;
  readonly spine: HTMLElement;
  readonly drawer: HTMLDialogElement;
}

export type Disposer = () => void;

function focusComposer(): void {
  const composer = document.querySelector("#message");
  if (composer instanceof HTMLTextAreaElement) composer.focus();
}

export function bootLegacy(hosts: LegacyHosts): Disposer {
  const { topbar, spine, drawer } = hosts;
  const store = useEnduragentStore;

  const topbarActions = document.createElement("div");
  topbarActions.className = "topbar-actions";
  topbar.append(topbarActions);
  const connectionStatus = document.createElement("span");
  connectionStatus.className = "connection-status";
  connectionStatus.setAttribute("role", "status");
  connectionStatus.textContent = "Connecting…";
  topbarActions.append(connectionStatus);
  const onLifecycle = (event: WindowEventMap["enduragent-lifecycle"]): void => {
    document.documentElement.dataset.rpc = event.detail.status;
    connectionStatus.textContent =
      event.detail.status === "ready"
        ? "Connected"
        : event.detail.status === "recovering"
          ? "Reconnecting…"
          : event.detail.status === "terminal"
            ? "Connection unavailable"
            : "Closing…";
  };
  window.addEventListener("enduragent-lifecycle", onLifecycle);
  const releaseNotesAdapter = createReleaseNotesSettingsAdapter({
    publish: (patch) => store.getState().patchSettings(patch),
  });
  const releaseNotesController = createReleaseNotesController({
    request: () => window.enduragentAuth.releaseNotes(),
    view: releaseNotesAdapter.view,
  });
  const updateAdapter = createUpdateSettingsAdapter({
    publish: (next) => store.getState().patchSettings({ update: next }),
  });
  const desktopUpdateController = createDesktopUpdateController({
    bridge: window.enduragentAuth,
    view: updateAdapter.view,
  });
  void desktopUpdateController.start();

  const clients = createDesktopCoachClientProvider();
  const clientAfterFailure = async (failedClient: CoachClient | undefined) => {
    if (failedClient === undefined) return clients.reconnect();
    const current = await clients.getClient();
    return current === failedClient ? clients.reconnect() : current;
  };
  const mountedTrainingContext = mountTrainingContextView({ spine, drawer });
  const trainingContextView: TrainingContextView = {
    render(state) {
      mountedTrainingContext.view.render(state);
      const current = store.getState().settings.units;
      const next = state.unitsPreference;
      if (
        current.status !== next.status ||
        current.value !== next.value ||
        current.source !== next.source
      ) {
        store.getState().patchSettings({ units: next });
      }
    },
  };
  const trainingContextController = createTrainingContextController({
    clients,
    view: trainingContextView,
  });
  const trainingSyncCoordinator = createTrainingSyncCoordinator({
    clients,
    refreshTrainingContext: () => trainingContextController.refresh(),
  });
  const manualSyncController = createManualSyncController({
    coordinator: trainingSyncCoordinator,
    view: mountedTrainingContext.syncView,
  });
  const spendAdapter = createSpendSettingsAdapter({
    read: () => store.getState().settings.spend,
    publish: (next) => store.getState().patchSettings({ spend: next }),
  });
  const spendController = createSpendMeterController({
    clients,
    view: spendAdapter.view,
  });
  const chatAdapter = createChatViewAdapter({
    publish: (next) =>
      flushSync(() => {
        store.getState().setChatSurface(next);
      }),
  });
  const chatController = createChatController({
    clients,
    view: chatAdapter.view,
    refreshTrainingContext: () => trainingContextController.refresh(),
    refreshSpend: () => spendController.refresh(),
    readTranscriptPage: (request) => window.enduragentAuth.getTranscriptPage(request),
  });
  mountedTrainingContext.bind({
    onUnitsPreferenceChange: (value) => void trainingContextController.setUnitsPreference(value),
    onSyncRequest: (kind) => void manualSyncController.activate(kind),
  });

  const firstSyncController = createFirstSyncController({
    coordinator: trainingSyncCoordinator,
    focusComposer,
    render: createFirstSyncViewAdapter({
      publish: (next) => store.getState().setFirstSync(next),
    }).render,
  });
  store.getState().bindChatActions({
    submit: (message) => void chatController.submit(message),
    retry: () => void chatController.retryInterrupted(),
    loadEarlier: () => void chatController.loadEarlier(),
    retryHydration: () => void chatController.retryHydration(),
    openNewConversation: () => void chatController.openNewConversation(),
    cancelNewConversation: () => chatController.cancelNewConversation(),
    confirmNewConversation: () => void chatController.confirmNewConversation(),
    retryFirstSync: () => void firstSyncController.retry(),
  });

  let onboardingNeedsReconnect = false;
  let onboardingFailedClient: CoachClient | undefined;
  const onboardingClient = async () => {
    const client = onboardingNeedsReconnect
      ? await clientAfterFailure(onboardingFailedClient)
      : await clients.getClient();
    onboardingNeedsReconnect = false;
    onboardingFailedClient = undefined;
    return client;
  };
  const onboardingBridge: OnboardingBridge = {
    credentialStatuses: () => window.enduragentAuth.credentialStatuses(),
    retryFailedCredentials: () => window.enduragentAuth.retryFailedCredentials(),
    writeCredential: (value) => window.enduragentAuth.writeCredential(value),
    llmConfiguration: () => window.enduragentAuth.llmConfiguration(),
    applyLlmSelection: (value) => window.enduragentAuth.applyLlmSelection(value),
    chatGptStatus: () => window.enduragentAuth.chatgptStatus(),
    chatGptLogin: (value) => window.enduragentAuth.chatgptLogin(value),
    chooseImportFiles: () => window.enduragentAuth.chooseImportFiles(),
    onDroppedImportFiles: (listener) => window.enduragentAuth.onDroppedImportFiles(listener),
    async importFiles(paths, onProgress) {
      let client: CoachClient | undefined;
      try {
        client = await onboardingClient();
        return await client.call(
          "importFiles",
          { paths: [...validateImportPaths(paths)] },
          { onNotificationEnvelope: onProgress },
        );
      } catch (error) {
        if (error instanceof CoachClientDisconnectedError) {
          onboardingNeedsReconnect = true;
          onboardingFailedClient = client;
        }
        throw error;
      }
    },
    async saveIntake(value) {
      let client: CoachClient | undefined;
      try {
        client = await onboardingClient();
        const result = await client.call("saveIntake", SaveIntakeRpcParamsSchema.parse(value));
        if (!result.saved) throw new CoachClientProtocolError();
      } catch (error) {
        if (error instanceof CoachClientDisconnectedError) {
          onboardingNeedsReconnect = true;
          onboardingFailedClient = client;
        }
        throw error;
      }
    },
  };

  const setup = document.createElement("button");
  setup.type = "button";
  setup.className = "setup-button";
  setup.textContent = "Setup";
  topbarActions.insertBefore(setup, connectionStatus);
  const rideImports = createRideImportController(onboardingBridge);
  const residentRideImport = mountResidentRideImport({
    document,
    actionHost: topbarActions,
    before: connectionStatus,
    imports: rideImports,
  });
  const onboardingCompletion = createOnboardingCompletionController({
    storage: () => window.localStorage,
    onComplete: (completion) => void firstSyncController.start(completion),
  });
  const onboarding = mountOnboarding({
    document,
    bridge: onboardingBridge,
    rideImports,
    onRideImportPresentationChange: (presenting) => residentRideImport.setSuppressed(presenting),
    opener: setup,
    onComplete: (completion) => onboardingCompletion.complete(completion),
  });
  const openSetupFlow = (): void => {
    void onboardingCompletion.openManually(() => onboarding.open());
  };
  setup.addEventListener("click", openSetupFlow);
  const closePanes = (): void => {
    providerModelSettingsController.close();
    credentialSettingsController.close();
    athleteSettingsController.close();
    sessionSettingsController.close();
  };
  const openSetupFromSettings = (): void => {
    closePanes();
    store.getState().leaveSettings();
    openSetupFlow();
  };
  const coachAdapter = createCoachSettingsAdapter({
    publish: (state) => store.getState().patchSettings({ coach: state }),
  });
  const credentialAdapter = createCredentialSettingsAdapter({
    publish: (state) => store.getState().patchSettings({ credentials: state }),
  });
  const athleteAdapter = createAthleteSettingsAdapter({
    publish: (state) => store.getState().patchSettings({ athlete: state }),
  });
  const conversationAdapter = createConversationSettingsAdapter({
    publish: (state) => store.getState().patchSettings({ conversation: state }),
  });
  const sessionSettingsController = createSessionSettingsController({
    clients,
    beginMutation: () => store.getState().beginSettingsMutation("session"),
    view: conversationAdapter.view,
  });
  const credentialSettingsController = createCredentialSettingsController({
    clients,
    loadStatuses: () => window.enduragentAuth.credentialStatuses(),
    loadChatGptStatus: () => window.enduragentAuth.chatgptStatus(),
    deleteCredential: (value) => window.enduragentAuth.deleteCredential(value),
    openSetup: openSetupFromSettings,
    beginMutation: () => store.getState().beginSettingsMutation("credential"),
    view: credentialAdapter.view,
  });
  const athleteSettingsController = createAthleteSettingsController({
    clients,
    openSetup: openSetupFromSettings,
    beginMutation: () => store.getState().beginSettingsMutation("athlete"),
    view: athleteAdapter.view,
  });
  const providerModelSettingsController = createProviderModelSettingsController({
    load: () => window.enduragentAuth.llmConfiguration(),
    apply: (selection) => window.enduragentAuth.applyLlmSelection(selection),
    openSetup: openSetupFromSettings,
    beginMutation: () => store.getState().beginSettingsMutation("provider-model"),
    view: coachAdapter.view,
  });
  store.getState().bindSettingsPorts({
    panes: {
      activate() {
        void providerModelSettingsController.activate();
        void credentialSettingsController.activate();
        void athleteSettingsController.activate();
        void sessionSettingsController.activate();
      },
      close: closePanes,
    },
    coach: coachAdapter.port,
    credentials: credentialAdapter.port,
    athlete: athleteAdapter.port,
    conversation: conversationAdapter.port,
    spend: spendAdapter.port,
    update: updateAdapter.port,
    releaseNotes: releaseNotesAdapter.port,
    units: {
      set: (value) => void trainingContextController.setUnitsPreference(value),
    },
    openSetup: openSetupFromSettings,
  });
  const disposeDroppedRideImports = subscribeToDroppedRideImports({
    subscribe: onboardingBridge.onDroppedImportFiles,
    onboarding,
    resident: residentRideImport,
  });

  void trainingContextController.start();
  spendController.start();
  void chatController.start();
  void onboardingCompletion.openOnStartup(() => onboarding.open());
  void clients.getClient().then(
    () => {
      document.documentElement.dataset.rpc = "connected";
      connectionStatus.textContent = "Connected";
    },
    () => {
      document.documentElement.dataset.rpc = "failed";
      connectionStatus.textContent = "Connection unavailable";
    },
  );

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    store.getState().bindChatActions(null);
    store.getState().bindSettingsPorts(null);
    window.removeEventListener("enduragent-lifecycle", onLifecycle);
    window.removeEventListener("pagehide", dispose);
    releaseNotesController.dispose();
    desktopUpdateController.dispose();
    providerModelSettingsController.dispose();
    credentialSettingsController.dispose();
    athleteSettingsController.dispose();
    sessionSettingsController.dispose();
    disposeDroppedRideImports();
    onboarding.dispose();
    residentRideImport.dispose();
    firstSyncController.dispose();
    manualSyncController.dispose();
    trainingSyncCoordinator.dispose();
    chatController.dispose();
    spendController.dispose();
    trainingContextController.dispose();
    mountedTrainingContext.dispose();
    void clients.close();
  };
  window.addEventListener("pagehide", dispose, { once: true });
  return dispose;
}
