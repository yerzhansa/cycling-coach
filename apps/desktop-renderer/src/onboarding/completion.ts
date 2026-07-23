import type { OnboardingCompletion } from "./machine.js";

const COMPLETION_STORAGE_KEY = "enduragent.desktop.onboarding";
const COMPLETION_STORAGE_VALUE = '{"version":1,"completed":true}';

export interface OnboardingCompletionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface OnboardingCompletionController {
  openOnStartup(openSetup: () => Promise<void>): Promise<void>;
  openManually(openSetup: () => Promise<void>): Promise<void>;
  complete(completion: OnboardingCompletion): void;
}

export function createOnboardingCompletionController(options: {
  readonly storage: () => OnboardingCompletionStorage;
  readonly onComplete: (completion: OnboardingCompletion) => void;
}): OnboardingCompletionController {
  const completed = (): boolean => {
    try {
      return options.storage().getItem(COMPLETION_STORAGE_KEY) === COMPLETION_STORAGE_VALUE;
    } catch {
      return false;
    }
  };

  return {
    openOnStartup(openSetup) {
      return completed() ? Promise.resolve() : openSetup();
    },
    openManually: (openSetup) => openSetup(),
    complete(completion) {
      try {
        options.storage().setItem(COMPLETION_STORAGE_KEY, COMPLETION_STORAGE_VALUE);
      } catch {}
      options.onComplete(completion);
    },
  };
}
