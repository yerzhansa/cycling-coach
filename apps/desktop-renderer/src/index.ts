import {
  CoachClientDisconnectedError,
  CoachClientProtocolError,
  type CoachClient,
} from "@enduragent/coach-client";
import { SaveIntakeRpcParamsSchema } from "@enduragent/coach-contract";
import "./chat/styles.css";
import "./training-context/styles.css";
import "./spend-meter/styles.css";
import "./onboarding/onboarding.css";
import { createChatController } from "./chat/controller.js";
import { mountChatView } from "./chat/view.js";
import { createDesktopCoachClientProvider } from "./coach-client.js";
import { createFirstSyncController, type FirstSyncState } from "./first-sync.js";
import { validateImportPaths, type OnboardingBridge } from "./onboarding/bridge.js";
import { mountOnboarding } from "./onboarding/mount.js";
import { createTrainingContextController } from "./training-context/controller.js";
import { mountTrainingContextView } from "./training-context/view.js";
import { createSpendMeterController } from "./spend-meter/controller.js";
import { createSpendMeterView } from "./spend-meter/view.js";

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
const mountedChat = mountChatView({ conversation, thread, composerHost });
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
});
mountedTrainingContext.bind({
  onUnitsPreferenceChange: (value) => void trainingContextController.setUnitsPreference(value),
});

let firstSyncElement: HTMLElement | undefined;
let firstSyncController: ReturnType<typeof createFirstSyncController>;

function renderFirstSync(state: FirstSyncState): void {
  if (state.status === "idle") {
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
  } else if (state.status === "ready") {
    title.textContent = "Training history is ready";
    detail.textContent = "Your coach is ready when you are.";
    body.append(eyebrow, title, detail);
    void trainingContextController.refresh();
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

let syncNeedsReconnect = false;
let syncFailedClient: CoachClient | undefined;
firstSyncController = createFirstSyncController({
  async callSync(options) {
    let client: CoachClient | undefined;
    try {
      client = syncNeedsReconnect
        ? await clientAfterFailure(syncFailedClient)
        : await clients.getClient();
      syncNeedsReconnect = false;
      syncFailedClient = undefined;
      return await client.call("sync", {}, options);
    } catch (error) {
      if (error instanceof CoachClientDisconnectedError) {
        syncNeedsReconnect = true;
        syncFailedClient = client;
      }
      throw error;
    }
  },
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
  writeCredential: (value) => window.enduragentAuth.writeCredential(value),
  chatGptStatus: () => window.enduragentAuth.chatgptStatus(),
  chatGptLogin: () => window.enduragentAuth.chatgptLogin(),
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
topbar.insertBefore(setup, topbar.lastElementChild);
const onboarding = mountOnboarding({
  document,
  bridge: onboardingBridge,
  opener: setup,
  onComplete: (completion) => void firstSyncController.start(completion),
});
setup.addEventListener("click", () => void onboarding.open());

void trainingContextController.start();
spendController.start();
void onboarding.open();
void clients.getClient().then(
  () => {
    document.documentElement.dataset.rpc = "connected";
  },
  () => {
    document.documentElement.dataset.rpc = "failed";
  },
);

window.addEventListener(
  "pagehide",
  () => {
    onboarding.dispose();
    firstSyncController.dispose();
    chatController.dispose();
    spendController.dispose();
    mountedChat.dispose();
    trainingContextController.dispose();
    mountedTrainingContext.dispose();
    void clients.close();
  },
  { once: true },
);
