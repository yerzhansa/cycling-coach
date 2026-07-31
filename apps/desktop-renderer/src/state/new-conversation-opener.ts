let opener: HTMLElement | null = null;

export function registerNewConversationOpener(element: HTMLElement | null): void {
  opener = element;
}

export function focusNewConversationOpener(): void {
  opener?.focus();
}
