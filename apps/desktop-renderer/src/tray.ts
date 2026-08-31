import { presentTrayTelegramStatus } from "./tray-status";

const telegramCopy = document.querySelector<HTMLElement>("#telegram-status-copy");
const telegramTag = document.querySelector<HTMLElement>("#telegram-status-tag");

if (telegramCopy === null || telegramTag === null) throw new TypeError("missing tray status nodes");

const unsubscribe = window.enduragentTray.onTelegramStatus((status) => {
  const presentation = presentTrayTelegramStatus(status);
  telegramCopy.textContent = presentation.copy;
  telegramTag.textContent = presentation.tag;
  telegramTag.dataset.tone = presentation.tone;
});

window.addEventListener("pagehide", unsubscribe, { once: true });
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.close();
});
