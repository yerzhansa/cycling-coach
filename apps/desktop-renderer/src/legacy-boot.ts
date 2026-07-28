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
import "./spend-meter/styles.css";
import "./release-notes/styles.css";
import "./update/styles.css";
import "./settings/styles.css";
import "./onboarding/onboarding.css";
import "./ride-import.css";
import { createChatController } from "./chat/controller.js";
import { createDesktopCoachClientProvider } from "./coach-client.js";
import { createFirstSyncController } from "./first-sync.js";
import { createChatViewAdapter } from "./state/adapters/chat.js";
import { createFirstSyncViewAdapter } from "./state/adapters/first-sync.js";
import { useEnduragentStore } from "./state/store.js";
import { validateImportPaths, type OnboardingBridge } from "./onboarding/bridge.js";
import { createOnboardingCompletionController } from "./onboarding/completion.js";
import { mountOnboarding } from "./onboarding/mount.js";
import { createTrainingContextController } from "./training-context/controller.js";
import { createManualSyncController } from "./training-context/manual-sync.js";
import { mountTrainingContextView } from "./training-context/view.js";
import { createTrainingSyncCoordinator } from "./training-sync.js";
import { createSpendMeterController } from "./spend-meter/controller.js";
import { createSpendMeterView } from "./spend-meter/view.js";
import { createReleaseNotesController } from "./release-notes/controller.js";
import { createReleaseNotesView } from "./release-notes/view.js";
import { createDesktopUpdateController } from "./update/controller.js";
import { createDesktopUpdateView } from "./update/view.js";
import { createProviderModelSettingsController } from "./settings/provider-model-controller.js";
import { createProviderModelSettingsView } from "./settings/provider-model-view.js";
import { createAthleteSettingsController } from "./settings/athlete-controller.js";
import { createAthleteSettingsView } from "./settings/athlete-view.js";
import { createResidentSettingsShell } from "./settings/shell.js";
import { createSessionSettingsController } from "./settings/session-controller.js";
import { createSessionSettingsView } from "./settings/session-view.js";
import { createCredentialSettingsController } from "./settings/credential-controller.js";
import { createCredentialSettingsView } from "./settings/credential-view.js";
import {
  createRideImportController,
  mountResidentRideImport,
  subscribeToDroppedRideImports,
} from "./ride-import.js";

export interface LegacyHosts {
  readonly noticeHost: HTMLElement;
  readonly topbar: HTMLElement;
  readonly spendRoot: HTMLElement;
  readonly spine: HTMLElement;
  readonly drawer: HTMLDialogElement;
}

export type Disposer = () => void;

function focusComposer(): void {
  const composer = document.querySelector("#message");
  if (composer instanceof HTMLTextAreaElement) composer.focus();
}

export function bootLegacy(hosts: LegacyHosts): Disposer {
  const { noticeHost, topbar, spendRoot, spine, drawer } = hosts;

  const topbarActions = document.createElement("div");
  topbarActions.className = "topbar-actions";
  topbar.insertBefore(topbarActions, spendRoot);
  const connectionStatus = document.createElement("span");
  connectionStatus.className = "connection-status";
  connectionStatus.setAttribute("role", "status");
  connectionStatus.textContent = "Connecting…";
  topbarActions.append(connectionStatus, spendRoot);
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
  const releaseNotesController = createReleaseNotesController({
    request: () => window.enduragentAuth.releaseNotes(),
    view: createReleaseNotesView({
      document,
      actionHost: topbarActions,
      before: connectionStatus,
    }),
  });
  const desktopUpdateController = createDesktopUpdateController({
    bridge: window.enduragentAuth,
    view: createDesktopUpdateView({
      document,
      actionHost: topbarActions,
      before: connectionStatus,
    }),
  });
  void desktopUpdateController.start();

  const clients = createDesktopCoachClientProvider();
  const clientAfterFailure = async (failedClient: CoachClient | undefined) => {
    if (failedClient === undefined) return clients.reconnect();
    const current = await clients.getClient();
    return current === failedClient ? clients.reconnect() : current;
  };
  const mountedTrainingContext = mountTrainingContextView({ spine, drawer });
  const trainingContextController = createTrainingContextController({
    clients,
    view: mountedTrainingContext.view,
  });
  const trainingSyncCoordinator = createTrainingSyncCoordinator({
    clients,
    refreshTrainingContext: () => trainingContextController.refresh(),
  });
  const manualSyncController = createManualSyncController({
    coordinator: trainingSyncCoordinator,
    view: mountedTrainingContext.syncView,
  });
  const spendController = createSpendMeterController({
    clients,
    view: createSpendMeterView({ root: spendRoot, noticeHost }),
  });
  const chatAdapter = createChatViewAdapter({
    publish: (next) =>
      flushSync(() => {
        useEnduragentStore.getState().setChatSurface(next);
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
      publish: (next) => useEnduragentStore.getState().setFirstSync(next),
    }).render,
  });
  useEnduragentStore.getState().bindChatActions({
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
  setup.addEventListener(
    "click",
    () => void onboardingCompletion.openManually(() => onboarding.open()),
  );
  const settingsShell = createResidentSettingsShell({
    document,
    actionHost: topbarActions,
    before: setup,
  });
  const providerModelSettingsView = createProviderModelSettingsView({
    document,
    shell: settingsShell,
  });
  const credentialSettingsView = createCredentialSettingsView({ document, shell: settingsShell });
  const athleteSettingsView = createAthleteSettingsView({ document, shell: settingsShell });
  const sessionSettingsView = createSessionSettingsView({ document, shell: settingsShell });
  const sessionSettingsController = createSessionSettingsController({
    clients,
    beginMutation: () => settingsShell.beginMutation("session"),
    view: sessionSettingsView,
  });
  const credentialSettingsController = createCredentialSettingsController({
    clients,
    loadStatuses: () => window.enduragentAuth.credentialStatuses(),
    loadChatGptStatus: () => window.enduragentAuth.chatgptStatus(),
    deleteCredential: (value) => window.enduragentAuth.deleteCredential(value),
    openSetup: () => {
      providerModelSettingsController.close();
      credentialSettingsController.close();
      athleteSettingsController.close();
      sessionSettingsController.close();
      settingsShell.close();
      setup.click();
    },
    beginMutation: () => settingsShell.beginMutation("credential"),
    view: credentialSettingsView,
  });
  const athleteSettingsController = createAthleteSettingsController({
    clients,
    openSetup: () => {
      providerModelSettingsController.close();
      credentialSettingsController.close();
      athleteSettingsController.close();
      sessionSettingsController.close();
      settingsShell.close();
      setup.click();
    },
    beginMutation: () => settingsShell.beginMutation("athlete"),
    view: athleteSettingsView,
  });
  const providerModelSettingsController = createProviderModelSettingsController({
    load: () => window.enduragentAuth.llmConfiguration(),
    apply: (selection) => window.enduragentAuth.applyLlmSelection(selection),
    openSetup: () => {
      providerModelSettingsController.close();
      credentialSettingsController.close();
      athleteSettingsController.close();
      sessionSettingsController.close();
      settingsShell.close();
      setup.click();
    },
    beginMutation: () => settingsShell.beginMutation("provider-model"),
    view: providerModelSettingsView,
  });
  settingsShell.bind({
    onOpen() {
      void providerModelSettingsController.activate();
      void credentialSettingsController.activate();
      void athleteSettingsController.activate();
      void sessionSettingsController.activate();
    },
    onClose() {
      providerModelSettingsController.close();
      credentialSettingsController.close();
      athleteSettingsController.close();
      sessionSettingsController.close();
      settingsShell.close();
    },
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
    useEnduragentStore.getState().bindChatActions(null);
    window.removeEventListener("enduragent-lifecycle", onLifecycle);
    window.removeEventListener("pagehide", dispose);
    releaseNotesController.dispose();
    desktopUpdateController.dispose();
    providerModelSettingsController.dispose();
    credentialSettingsController.dispose();
    athleteSettingsController.dispose();
    sessionSettingsController.dispose();
    settingsShell.dispose();
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
