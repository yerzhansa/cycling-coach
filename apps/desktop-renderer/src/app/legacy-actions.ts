export const LEGACY_NEW_CONVERSATION_SELECTOR = "button.new-conversation-button";

export function findLegacyNewConversationButton(): HTMLButtonElement | null {
  const found = document.querySelector(LEGACY_NEW_CONVERSATION_SELECTOR);
  return found instanceof HTMLButtonElement ? found : null;
}

export function startLegacyNewConversation(): boolean {
  const button = findLegacyNewConversationButton();
  if (button === null) return false;
  button.click();
  return true;
}
