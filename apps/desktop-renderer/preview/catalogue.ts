export const catalogue = [
  {
    id: "desktop--chat-empty",
    kind: "ready",
    title: "Chat · empty",
    consumers: ["ui/chat/ChatView.tsx"],
  },
  {
    id: "desktop--chat-syncing",
    kind: "ready",
    title: "Chat · syncing",
    consumers: ["ui/chat/ChatView.tsx", "ui/chat/FirstSyncCard.tsx"],
  },
  {
    id: "desktop--chat-sync-failed",
    kind: "ready",
    title: "Chat · sync failure",
    consumers: ["ui/chat/ChatView.tsx", "ui/chat/FirstSyncCard.tsx"],
  },
  {
    id: "desktop--settings-preferences",
    kind: "ready",
    title: "Settings · preferences",
    consumers: ["ui/settings/PreferencesSection.tsx", "ui/settings/AppearanceControl.tsx"],
  },
  {
    id: "desktop--training-unavailable",
    kind: "ready",
    title: "Training · unavailable",
    consumers: ["ui/training/TrainingView.tsx"],
  },
  {
    id: "plan.question.goal",
    kind: "pending",
    title: "Plan · goal question",
    consumers: ["ui/chat/PlanCreationQuestionCard.tsx"],
    dependency:
      "END-6. Integrate the existing question component with its owning Plan creation slice 2 after its approved delivery dependency clears. Preserve END-6, END-7, END-8 order.",
  },
  {
    id: "plan.discard",
    kind: "pending",
    title: "Plan · discard",
    consumers: ["ui/chat/PlanCreationCards.tsx"],
    dependency:
      "END-7. Existing Plan creation slice 3 owns discard and focus restoration after slice 2.",
  },
] as const;

export type Scenario = (typeof catalogue)[number];
export type ReadyScenario = Extract<Scenario, { readonly kind: "ready" }>;

export const coverage = [
  ...catalogue,
  {
    id: "shared-select--default",
    kind: "ready",
    title: "Select · default",
    consumers: [
      "components/ui/select.tsx",
      "ui/settings/CoachSection.tsx",
      "ui/onboarding/IntakeRows.tsx",
    ],
  },
  {
    id: "shared-select--disabled",
    kind: "ready",
    title: "Select · disabled",
    consumers: ["components/ui/select.tsx", "ui/settings/CoachSection.tsx"],
  },
  {
    id: "shared-inline-confirmation--default",
    kind: "ready",
    title: "Confirmation · default",
    consumers: [
      "ui/shared/InlineConfirmation.tsx",
      "ui/settings/CredentialsSection.tsx",
      "ui/settings/TelegramSection.tsx",
    ],
  },
  {
    id: "shared-inline-confirmation--busy",
    kind: "ready",
    title: "Confirmation · busy",
    consumers: ["ui/shared/InlineConfirmation.tsx", "ui/settings/CredentialsSection.tsx"],
  },
  {
    id: "shared-inline-confirmation--disabled",
    kind: "ready",
    title: "Confirmation · disabled",
    consumers: ["ui/shared/InlineConfirmation.tsx", "ui/settings/TelegramSection.tsx"],
  },
] as const;

export function scenarioById(id: string): Scenario {
  const scenario = catalogue.find((entry) => entry.id === id);
  if (scenario === undefined) throw new Error(`Unknown preview scenario: ${id}`);
  return scenario;
}
