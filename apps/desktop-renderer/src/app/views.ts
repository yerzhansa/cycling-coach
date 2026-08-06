import {
  Activity,
  History,
  ListChecks,
  MessageSquare,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

export type ViewId = "chat" | "archive" | "training" | "setup" | "settings";
export type StoredViewId = Exclude<ViewId, "setup">;

export const REACT_CHAT_REGION = "react-chat-region";

export interface ViewDefinition {
  readonly id: ViewId;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly title: string;
  readonly page: LazyExoticComponent<ComponentType> | typeof REACT_CHAT_REGION;
}

export const VIEWS: readonly ViewDefinition[] = Object.freeze([
  {
    id: "chat",
    label: "Chat",
    icon: MessageSquare,
    title: "Chat",
    page: REACT_CHAT_REGION,
  },
  {
    id: "archive",
    label: "Past chats",
    icon: History,
    title: "Past chats",
    page: lazy(async () => ({
      default: (await import("../ui/archive/ArchiveView.js")).ArchiveView,
    })),
  },
  {
    id: "training",
    label: "Training",
    icon: Activity,
    title: "Training",
    page: lazy(async () => ({
      default: (await import("../ui/training/TrainingView.js")).TrainingView,
    })),
  },
  {
    id: "setup",
    label: "Setup",
    icon: ListChecks,
    title: "Setup",
    page: lazy(async () => ({
      default: (await import("../ui/onboarding/OnboardingWizard.js")).OnboardingWizard,
    })),
  },
  {
    id: "settings",
    label: "Settings",
    icon: Settings,
    title: "Settings",
    page: lazy(async () => ({
      default: (await import("../ui/settings/SettingsView.js")).SettingsView,
    })),
  },
]);
