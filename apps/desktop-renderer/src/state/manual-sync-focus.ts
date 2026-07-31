let target: HTMLElement | null = null;
let fallback: HTMLElement | null = null;

export function setManualSyncFocusTarget(element: HTMLElement | null): void {
  target = element;
}

export function setManualSyncFocusFallback(element: HTMLElement | null): void {
  fallback = element;
}

function focusable(element: HTMLElement | null): boolean {
  if (element === null || !element.isConnected || element.hidden) return false;
  return !(element instanceof HTMLButtonElement && element.disabled);
}

export function restoreManualSyncFocus(): void {
  if (target === null) return;
  const element = focusable(target) ? target : focusable(fallback) ? fallback : null;
  if (element === null) return;
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
