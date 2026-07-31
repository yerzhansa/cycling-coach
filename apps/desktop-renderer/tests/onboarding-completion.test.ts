import { describe, expect, it, vi } from "vitest";
import {
  createOnboardingCompletionController,
  type OnboardingCompletionStorage,
} from "../src/onboarding/completion.js";

const completion = {
  providerConfigured: true,
  trainingDataConfigured: true,
  intakeSaved: true,
  requiresProviderSync: true,
} as const;

const fileOnlyCompletion = { ...completion, requiresProviderSync: false } as const;

function memoryStorage(
  entries: readonly (readonly [string, string])[] = [],
): OnboardingCompletionStorage & { readonly entries: Map<string, string> } {
  const stored = new Map(entries);
  return {
    entries: stored,
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => {
      stored.set(key, value);
    },
  };
}

describe("onboarding completion", () => {
  it("opens Setup on first launch without writing a completion marker", async () => {
    const storage = memoryStorage();
    const openSetup = vi.fn(async () => {});
    const onComplete = vi.fn();
    const controller = createOnboardingCompletionController({
      storage: () => storage,
      onComplete,
    });

    await controller.openOnStartup(openSetup);

    expect(openSetup).toHaveBeenCalledOnce();
    expect(storage.entries.size).toBe(0);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("persists the exact completion marker across a fresh window decision", async () => {
    const storage = memoryStorage();
    const firstSync = vi.fn();
    const firstWindow = createOnboardingCompletionController({
      storage: () => storage,
      onComplete: firstSync,
    });

    firstWindow.complete(fileOnlyCompletion);

    expect([...storage.entries]).toEqual([
      ["enduragent.desktop.onboarding", '{"version":1,"completed":true}'],
    ]);
    expect(firstSync).toHaveBeenCalledWith(fileOnlyCompletion);

    const openSetup = vi.fn(async () => {});
    const nextWindow = createOnboardingCompletionController({
      storage: () => storage,
      onComplete: vi.fn(),
    });
    expect(nextWindow.isCompleted()).toBe(true);
    await nextWindow.openOnStartup(openSetup);

    expect(openSetup).not.toHaveBeenCalled();
  });

  it("always opens Setup for a manual replay after completion", async () => {
    const storage = memoryStorage([
      ["enduragent.desktop.onboarding", '{"version":1,"completed":true}'],
    ]);
    const openSetup = vi.fn(async () => {});
    const controller = createOnboardingCompletionController({
      storage: () => storage,
      onComplete: vi.fn(),
    });

    await controller.openOnStartup(openSetup);
    await controller.openManually(openSetup);

    expect(openSetup).toHaveBeenCalledOnce();
  });

  it.each([
    "",
    "completed",
    '{"version":1,"completed":false}',
    '{"version":2,"completed":true}',
    '{"version":1,"completed":true,"extra":true}',
  ])("opens Setup when the stored marker is malformed or inexact: %s", async (marker) => {
    const storage = memoryStorage([["enduragent.desktop.onboarding", marker]]);
    const openSetup = vi.fn(async () => {});
    const controller = createOnboardingCompletionController({
      storage: () => storage,
      onComplete: vi.fn(),
    });

    await controller.openOnStartup(openSetup);

    expect(openSetup).toHaveBeenCalledOnce();
  });

  it("opens Setup when browser storage cannot be read", async () => {
    const openSetup = vi.fn(async () => {});
    const controller = createOnboardingCompletionController({
      storage: () => {
        throw new TypeError("unavailable");
      },
      onComplete: vi.fn(),
    });

    await controller.openOnStartup(openSetup);

    expect(openSetup).toHaveBeenCalledOnce();
  });

  it("continues first sync and leaves manual Setup available when storage cannot be written", async () => {
    const storage: OnboardingCompletionStorage = {
      getItem: () => null,
      setItem: () => {
        throw new TypeError("unavailable");
      },
    };
    const firstSync = vi.fn();
    const openSetup = vi.fn(async () => {});
    const controller = createOnboardingCompletionController({
      storage: () => storage,
      onComplete: firstSync,
    });

    expect(() => controller.complete(completion)).not.toThrow();
    await controller.openManually(openSetup);

    expect(firstSync).toHaveBeenCalledWith(completion);
    expect(openSetup).toHaveBeenCalledOnce();
  });
});
