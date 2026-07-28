let target: HTMLElement | null = null;

export function setManualSyncFocusTarget(element: HTMLElement | null): void {
  target = element;
}

export function restoreManualSyncFocus(): void {
  const element = target;
  if (element === null || !element.isConnected || element.hidden) return;
  if (element instanceof HTMLButtonElement && element.disabled) return;
  const owner = element.ownerDocument;
  const active = owner.activeElement;
  const focusWasLost =
    active === null ||
    active === owner.body ||
    active === owner.documentElement ||
    active === element;
  if (!focusWasLost) return;
  element.focus();
}
