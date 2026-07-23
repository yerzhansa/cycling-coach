import {
  CoachClientDisconnectedError,
  CoachClientProtocolError,
  type CoachClient,
} from "@enduragent/coach-client";
import { SaveIntakeRpcParamsSchema } from "@enduragent/coach-contract";
import "./chat/styles.css";
import "./training-context/styles.css";
import "./spend-meter/styles.css";
import "./release-notes/styles.css";
import "./update/styles.css";
import "./settings/styles.css";
import "./onboarding/onboarding.css";
import "./ride-import.css";
import { createChatController } from "./chat/controller.js";
import { mountChatView } from "./chat/view.js";
import { createDesktopCoachClientProvider } from "./coach-client.js";
import { createFirstSyncController, type FirstSyncState } from "./first-sync.js";
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
import {
  createRideImportController,
  mountResidentRideImport,
  subscribeToDroppedRideImports,
} from "./ride-import.js";

function one<T extends Element>(selector: string, kind: { new (): T }): T {
  const matches = document.querySelectorAll(selector);
  if (matches.length !== 1 || !(matches[0] instanceof kind)) {
    throw new TypeError(`Desktop shell host is invalid: ${selector}`);
  }
  return matches[0];
}

const conversation = one(".conversation", HTMLElement);
const thread = one(".thread", HTMLElement);
const composerHost = one(".composer-wrap", HTMLElement);
const spine = one(".data-spine", HTMLElement);
const drawer = one(".drawer", HTMLDialogElement);
const topbar = one(".topbar", HTMLElement);
const spendRoot = one(".spend-meter", HTMLElement);
conversation.classList.add("desktop-shell");

const topbarActions = document.createElement("div");
topbarActions.className = "topbar-actions";
topbar.insertBefore(topbarActions, spendRoot);
const connectionStatus = document.createElement("span");
connectionStatus.className = "connection-status";
connectionStatus.setAttribute("role", "status");
connectionStatus.textContent = "Connecting…";
topbarActions.append(connectionStatus, spendRoot);
window.addEventListener("enduragent-lifecycle", (event) => {
  document.documentElement.dataset.rpc = event.detail.status;
  connectionStatus.textContent =
    event.detail.status === "ready"
      ? "Connected"
      : event.detail.status === "recovering"
        ? "Reconnecting…"
        : event.detail.status === "terminal"
          ? "Connection unavailable"
          : "Closing…";
});
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
const mountedChat = mountChatView({
  conversation,
  thread,
  composerHost,
  actionHost: topbarActions,
});
const spendController = createSpendMeterController({
  clients,
  view: createSpendMeterView({ root: spendRoot, noticeHost: mountedChat.noticeHost }),
});
const message = one("#message", HTMLTextAreaElement);
const chatController = createChatController({
  clients,
  view: mountedChat.view,
  refreshTrainingContext: () => trainingContextController.refresh(),
  refreshSpend: () => spendController.refresh(),
});
mountedChat.bind({
  onSubmit: (message) => void chatController.submit(message),
  onRetry: () => void chatController.retryInterrupted(),
  onOpenNewConversation: () => void chatController.openNewConversation(),
  onCancelNewConversation: () => chatController.cancelNewConversation(),
  onConfirmNewConversation: () => void chatController.confirmNewConversation(),
});
mountedTrainingContext.bind({
  onUnitsPreferenceChange: (value) => void trainingContextController.setUnitsPreference(value),
  onSyncRequest: (kind) => void manualSyncController.activate(kind),
});

let firstSyncElement: HTMLElement | undefined;
let firstSyncController: ReturnType<typeof createFirstSyncController>;

function renderFirstSync(state: FirstSyncState): void {
  if (state.status === "idle" || state.status === "ready") {
    firstSyncElement?.remove();
    firstSyncElement = undefined;
    return;
  }
  const section = firstSyncElement ?? document.createElement("section");
  section.className = "first-sync";
  section.dataset.state = state.status;
  section.setAttribute("aria-labelledby", "first-sync-title");
  section.replaceChildren();
  const mark = document.createElement("div");
  mark.className = "first-sync__mark";
  mark.setAttribute("aria-hidden", "true");
  const body = document.createElement("div");
  body.className = "first-sync__body";
  const eyebrow = document.createElement("p");
  eyebrow.className = "first-sync__eyebrow";
  eyebrow.textContent = "Getting your coach ready";
  const title = document.createElement("h2");
  title.id = "first-sync-title";
  const detail = document.createElement("p");
  detail.className = "first-sync__detail";
  if (state.status === "syncing") {
    title.textContent = "Syncing your training history…";
    detail.textContent =
      "You can keep Enduragent open while rides, wellness, and calendar data are added.";
    const track = document.createElement("div");
    track.className = "first-sync__track";
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", "Syncing training history");
    body.append(eyebrow, title, detail, track);
  } else if (state.kind === "protocol") {
    title.textContent = "Enduragent needs to reconnect safely";
    detail.textContent = "Quit and reopen Enduragent.";
    body.append(eyebrow, title, detail);
  } else {
    title.textContent = "We couldn’t finish syncing";
    detail.textContent = "Your saved progress is safe.";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "first-sync__retry";
    retry.textContent = "Retry sync";
    retry.addEventListener("click", () => {
      retry.disabled = true;
      void firstSyncController.retry();
    });
    body.append(eyebrow, title, detail, retry);
  }
  section.append(mark, body);
  if (firstSyncElement === undefined) thread.append(section);
  firstSyncElement = section;
}

firstSyncController = createFirstSyncController({
  coordinator: trainingSyncCoordinator,
  focusComposer() {
    message.focus();
  },
  render: renderFirstSync,
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
const providerModelSettingsController = createProviderModelSettingsController({
  load: () => window.enduragentAuth.llmConfiguration(),
  apply: (selection) => window.enduragentAuth.applyLlmSelection(selection),
  openSetup: () => setup.click(),
  view: createProviderModelSettingsView({
    document,
    actionHost: topbarActions,
    before: setup,
  }),
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

window.addEventListener(
  "pagehide",
  () => {
    releaseNotesController.dispose();
    desktopUpdateController.dispose();
    providerModelSettingsController.dispose();
    disposeDroppedRideImports();
    onboarding.dispose();
    residentRideImport.dispose();
    firstSyncController.dispose();
    manualSyncController.dispose();
    trainingSyncCoordinator.dispose();
    chatController.dispose();
    spendController.dispose();
    mountedChat.dispose();
    trainingContextController.dispose();
    mountedTrainingContext.dispose();
    void clients.close();
  },
  { once: true },
);
