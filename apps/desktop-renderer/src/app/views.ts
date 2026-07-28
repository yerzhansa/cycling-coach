import { lazy, type ComponentType, type LazyExoticComponent } from "react";

export type ViewId = "chat" | "training" | "settings";

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
    id: "settings",
    label: "Settings",
    glyph: "⚙",
    title: "Settings",
    page: lazy(async () => ({
      default: (await import("../ui/settings/SettingsView.js")).SettingsView,
    })),
  },
]);

export function viewById(id: ViewId): ViewDefinition {
  return VIEWS.find((view) => view.id === id) ?? VIEWS[0];
}
