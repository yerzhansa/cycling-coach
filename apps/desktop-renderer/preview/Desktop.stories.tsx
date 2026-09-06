import type { Meta, StoryObj } from "@storybook/react-vite";
import { scenarioById } from "./catalogue";
import { initializeScenario, ScenarioView } from "./scenarios";

const meta = {
  title: "Desktop",
  component: ScenarioView,
  parameters: { controls: { exclude: ["scenario"] } },
  beforeEach: (context) => {
    const scenario = context.args.scenario;
    if (scenario === undefined) throw new Error("Story scenario is missing");
    const theme: unknown = context.globals.theme;
    const paletteId: unknown = context.globals.palette;
    if (theme !== "light" && theme !== "dark") throw new Error("Invalid preview theme");
    if (typeof paletteId !== "string") throw new Error("Invalid preview palette");
    initializeScenario({ scenario, theme, paletteId });
  },
} satisfies Meta<typeof ScenarioView>;

export default meta;
type Story = StoryObj<typeof meta>;

function args(id: string) {
  const scenario = scenarioById(id);
  if (scenario.kind !== "ready") throw new Error(`Pending preview: ${id}`);
  return { scenario };
}

export const ChatEmpty: Story = { args: args("desktop--chat-empty") };
export const ChatSyncing: Story = { args: args("desktop--chat-syncing") };
export const ChatSyncFailed: Story = { args: args("desktop--chat-sync-failed") };
export const SettingsPreferences: Story = { args: args("desktop--settings-preferences") };
export const TrainingUnavailable: Story = { args: args("desktop--training-unavailable") };
