export const DISPOSABLE_SAFE_STORAGE_CONTEXT_ENV: "ENDURAGENT_DISPOSABLE_SAFE_STORAGE_CONTEXT";

export function isDisposableSafeStorageContext(
  environment?: Readonly<Record<string, string | undefined>>,
): boolean;

export function requireDisposableSafeStorageContext(
  environment?: Readonly<Record<string, string | undefined>>,
  platform?: NodeJS.Platform,
): void;
