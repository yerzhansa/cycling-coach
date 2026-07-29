import { lazy, type ComponentType, type LazyExoticComponent } from "react";

export type ViewId = "chat" | "training" | "setup" | "settings";
export type StoredViewId = Exclude<ViewId, "setup">;

export const REACT_CHAT_REGION = "react-chat-region";

export interface ViewDefinition {
  readonly id: ViewId;
  readonly label: string;
  readonly glyph: string;
  readonly title: string;
  readonly page: LazyExoticComponent<ComponentType> | typeof REACT_CHAT_REGION;
}

export const VIEWS: readonly ViewDefinition[] = Object.freeze([
  {
    id: "chat",
    label: "Chat",
    glyph: "◆",
    title: "Chat",
    page: REACT_CHAT_REGION,
  },
  {
    id: "training",
    label: "Training",
    glyph: "▲",
    title: "Training",
    page: lazy(async () => ({
      default: (await import("../ui/training/TrainingView.js")).TrainingView,
    })),
  },
  {
    id: "setup",
    label: "Setup",
    glyph: "●",
    title: "Setup",
    page: lazy(async () => ({
      default: (await import("../ui/onboarding/OnboardingWizard.js")).OnboardingWizard,
    })),
  },
  {
    id: "settings",
    label: "Settings",
    glyph: "⚙",
    title: "Settings",
    page: lazy(async () => ({
      default: (await import("../ui/settings/SettingsView.js")).SettingsView,
    })),
  },
]);
