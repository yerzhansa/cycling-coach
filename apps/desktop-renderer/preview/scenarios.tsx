import type { ReactElement } from "react";
import { READY_ONBOARDING } from "../src/state/onboarding-slice";
import { useEnduragentStore } from "../src/state/store";
import { applyPalette, type Appearance, type ResolvedTheme } from "../src/theme/applyPalette";
import { paletteById } from "../src/theme/palettes";
import { ChatView } from "../src/ui/chat/ChatView";
import { PreferencesSection } from "../src/ui/settings/PreferencesSection";
import { Page } from "../src/ui/shared/Page";
import { TrainingView } from "../src/ui/training/TrainingView";
import type { ReadyScenario } from "./catalogue";

export function initializeScenario(input: {
  readonly scenario: ReadyScenario;
  readonly theme: ResolvedTheme;
  readonly paletteId: string;
}): void {
  const stamp = (appearance: Appearance, paletteId: string): void => {
    const theme = appearance === "system" ? input.theme : appearance;
    applyPalette({
      root: document.documentElement,
      palette: paletteById(paletteId),
      appearance: theme,
    });
    useEnduragentStore.setState({ theme, appearance, paletteId });
  };
  useEnduragentStore.setState({
    onboarding: READY_ONBOARDING,
    onboardingStartupSettled: true,
    activeView:
      input.scenario.id === "desktop--training-unavailable"
        ? "training"
        : input.scenario.id === "desktop--settings-preferences"
          ? "settings"
          : "chat",
    firstSync:
      input.scenario.id === "desktop--chat-syncing"
        ? { status: "syncing" }
        : input.scenario.id === "desktop--chat-sync-failed"
          ? { status: "failed", kind: "protocol", retryable: false }
          : { status: "idle" },
    setAppearance: (appearance) => stamp(appearance, useEnduragentStore.getState().paletteId),
    setPaletteId: (paletteId) => stamp(useEnduragentStore.getState().appearance, paletteId),
  });
  stamp(input.theme, input.paletteId);
}

export function ScenarioView({ scenario }: { readonly scenario: ReadyScenario }): ReactElement {
  switch (scenario.id) {
    case "desktop--chat-empty":
    case "desktop--chat-syncing":
    case "desktop--chat-sync-failed":
      return <ChatView />;
    case "desktop--settings-preferences":
      return (
        <Page title="Settings">
          <PreferencesSection />
        </Page>
      );
    case "desktop--training-unavailable":
      return <TrainingView />;
  }
}
