import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { InlineConfirmation } from "../src/ui/shared/InlineConfirmation";

const meta = {
  title: "Shared/Inline confirmation",
  component: InlineConfirmation,
  args: {
    name: "fictional-credential",
    title: "Remove all credentials?",
    copy: "This removes every saved AI credential, ChatGPT profile, Intervals.icu key, Telegram token, and the shared encryption key from this Mac. Accounts and imported data remain unchanged.",
    confirmLabel: "Remove all credentials",
    focusTarget: "cancel",
    onCancel: fn(),
    onConfirm: fn(),
  },
} satisfies Meta<typeof InlineConfirmation>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Busy: Story = { args: { confirmBusy: true, cancelDisabled: true } };
export const Disabled: Story = { args: { confirmDisabled: true } };
