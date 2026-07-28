let opener: HTMLElement | null = null;

export function registerSetupOpener(element: HTMLElement | null): void {
  opener = element;
}

export function focusSetupOpener(): void {
  opener?.focus();
}
