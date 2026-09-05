import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../src/components/ui/select";

const options = [
  { value: "mon", label: "Monday" },
  { value: "wed", label: "Wednesday" },
  { value: "sat", label: "Saturday" },
];

function DaySelect({ disabled }: { readonly disabled: boolean }) {
  return (
    <Select items={options} defaultValue="wed" disabled={disabled}>
      <SelectTrigger aria-label="Training day">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(({ value, label }) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const meta = {
  title: "Shared/Select",
  component: DaySelect,
  args: { disabled: false },
} satisfies Meta<typeof DaySelect>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Disabled: Story = { args: { disabled: true } };
