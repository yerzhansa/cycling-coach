export interface ProviderAuthFailure {
  readonly providerAuthFailure: true;
}

export function markProviderAuthFailure<E extends Error>(err: E): E & ProviderAuthFailure {
  return Object.assign(err, { providerAuthFailure: true as const });
}

export function isProviderAuthFailure(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { providerAuthFailure?: unknown }).providerAuthFailure === true
  );
}
