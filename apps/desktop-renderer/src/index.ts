import type { CoachClient, CoachClientTerminalEnvelope } from "@enduragent/coach-client";
import {
  CoachClientDisconnectedError,
  CoachClientProtocolError,
  CoachRpcRemoteError,
  connectCoachClient,
} from "@enduragent/coach-client";
import type { TurnEvent } from "@enduragent/coach-contract";
import { createOnboardingBridge } from "./onboarding/bridge.js";
import { mountOnboarding } from "./onboarding/mount.js";
import "./onboarding/onboarding.css";
import { createChatTurn, reduceChatTurn, type ChatTurnState } from "./turn-state.js";

const DESKTOP_CHAT_ID = "desktop" as const;
const thread = document.querySelector<HTMLDivElement>(".thread")!;
const composer = document.querySelector<HTMLFormElement>(".composer")!;
const message = document.querySelector<HTMLTextAreaElement>("#message")!;
const submit = composer.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const drawer = document.querySelector<HTMLElement>(".drawer")!;
const drawerToggle = document.querySelector<HTMLButtonElement>(".drawer-toggle")!;
const drawerClose = document.querySelector<HTMLButtonElement>(".drawer-close")!;
const topbar = document.querySelector<HTMLElement>(".topbar")!;

const setup = document.createElement("button");
setup.type = "button";
setup.className = "setup-button";
setup.textContent = "Setup";
topbar.insertBefore(setup, topbar.lastElementChild);
const onboarding = mountOnboarding({
  document,
  bridge: createOnboardingBridge(),
  opener: setup,
  onComplete: () => message.focus(),
});
setup.addEventListener("click", () => void onboarding.open());
void onboarding.open();

let connectionMaterialPromise: ReturnType<EnduragentAuth["getDaemonConnection"]> | undefined;
let clientPromise: Promise<CoachClient> | undefined;

function connectionMaterial() {
  connectionMaterialPromise ??= window.enduragentAuth.getDaemonConnection().then((connection) => {
    const url = new URL(connection.url);
    if (
      url.protocol !== "ws:" ||
      url.hostname !== "127.0.0.1" ||
      url.port === "" ||
      !/^\d+$/.test(url.port) ||
      url.pathname !== "/rpc" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      !/^[A-Za-z0-9_-]{43}$/.test(connection.token)
    ) {
      throw new CoachClientProtocolError();
    }
    return connection;
  });
  return connectionMaterialPromise;
}

function coachClient(): Promise<CoachClient> {
  clientPromise ??= connectionMaterial().then((connection) => connectCoachClient(connection));
  return clientPromise;
}

function setDrawerOpen(open: boolean): void {
  drawer.classList.toggle("open", open);
  drawer.setAttribute("aria-hidden", String(!open));
  drawerToggle.setAttribute("aria-expanded", String(open));
  if (open) drawerClose.focus();
  else drawerToggle.focus();
}

drawerToggle.addEventListener("click", () => setDrawerOpen(true));
drawerClose.addEventListener("click", () => setDrawerOpen(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && drawer.classList.contains("open")) setDrawerOpen(false);
});

function appendMessage(className: string, text: string): HTMLElement {
  const element = document.createElement("div");
  element.className = className;
  element.textContent = text;
  return element;
}

function createTurnRow(
  state: ChatTurnState,
  includeUser: boolean,
): {
  readonly row: HTMLElement;
  readonly assistant: HTMLElement;
} {
  const row = document.createElement("article");
  row.className = "turn";
  if (includeUser) row.append(appendMessage("message user-message", state.userText));
  const assistant = appendMessage("message assistant-message", "");
  row.append(assistant);
  thread.append(row);
  row.scrollIntoView({ block: "end" });
  return { row, assistant };
}

function renderAssistant(input: {
  readonly state: ChatTurnState;
  readonly row: HTMLElement;
  readonly assistant: HTMLElement;
  readonly retry: () => void;
}): void {
  const delivery = input.state.assistant;
  input.assistant.replaceChildren();
  input.assistant.removeAttribute("aria-label");
  input.row.classList.toggle("interrupted", delivery.status === "aborted");
  if (delivery.status === "failed") {
    input.assistant.textContent = delivery.message;
    return;
  }
  input.assistant.append(document.createTextNode(delivery.text));
  if (delivery.status === "aborted") {
    input.assistant.setAttribute("aria-label", "Response interrupted");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "retry";
    retry.textContent = "Retry";
    retry.addEventListener(
      "click",
      () => {
        retry.disabled = true;
        input.retry();
      },
      { once: true },
    );
    input.assistant.append(retry);
  }
}

async function startTurn(userText: string, includeUser = true): Promise<void> {
  let state = createChatTurn(userText);
  const elements = createTurnRow(state, includeUser);
  const generation = { active: true };
  const render = (): void => {
    renderAssistant({
      state,
      ...elements,
      retry: () => {
        void startTurn(userText, false);
      },
    });
  };
  render();
  let client: CoachClient;
  try {
    client = await coachClient();
  } catch {
    state = reduceChatTurn(state, { type: "protocol-failure" });
    render();
    submit.disabled = false;
    message.disabled = false;
    return;
  }
  let terminal: CoachClientTerminalEnvelope | undefined;
  const call = client.call(
    "chat",
    { chatId: DESKTOP_CHAT_ID, message: userText },
    {
      onEvent(event: TurnEvent) {
        if (!generation.active) return;
        state = reduceChatTurn(state, { type: "event", event });
        render();
      },
      onNotificationEnvelope() {},
      onTerminalEnvelope(envelope) {
        if (generation.active) terminal = envelope;
      },
    },
  );
  submit.disabled = false;
  message.disabled = false;
  try {
    const result = await call;
    if (!generation.active || terminal === undefined) return;
    state = reduceChatTurn(state, { type: "success", text: result.text });
    render();
  } catch (error) {
    if (!generation.active) return;
    if (error instanceof CoachClientDisconnectedError) {
      generation.active = false;
      clientPromise = undefined;
      state = reduceChatTurn(state, { type: "abort" });
      render();
      return;
    }
    state = reduceChatTurn(state, {
      type: error instanceof CoachClientProtocolError ? "protocol-failure" : "remote-failure",
    });
    if (error instanceof CoachRpcRemoteError)
      state = reduceChatTurn(state, { type: "remote-failure" });
    render();
  } finally {
    generation.active = false;
  }
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = message.value;
  if (!/\S/u.test(text) || submit.disabled) return;
  submit.disabled = true;
  message.disabled = true;
  message.value = "";
  void startTurn(text);
});

message.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

void coachClient().then(
  () => {
    document.documentElement.dataset.rpc = "connected";
  },
  () => {
    document.documentElement.dataset.rpc = "failed";
  },
);
