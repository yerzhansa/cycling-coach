import type { OnboardingSurfaceState, OnboardingView } from "../../onboarding/controller.js";

export interface OnboardingViewAdapter {
  readonly view: OnboardingView;
  dispose(): void;
}

export function createOnboardingViewAdapter(input: {
  readonly publish: (next: OnboardingSurfaceState) => void;
}): OnboardingViewAdapter {
  let disposed = false;

  return {
    view: {
      render(surface) {
        if (!disposed) input.publish(surface);
      },
    },
    dispose() {
      disposed = true;
    },
  };
}
