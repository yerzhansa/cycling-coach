import type { Meta, StoryObj } from "@storybook/react-vite";
import { catalogue } from "./catalogue";

function PendingCoverage() {
  return (
    <div>
      {catalogue
        .filter((scenario) => scenario.kind === "pending")
        .map((scenario) => (
          <section key={scenario.id}>
            <h2>{scenario.title}</h2>
            <p role="status">{scenario.dependency}</p>
          </section>
        ))}
    </div>
  );
}

const meta = { title: "Coverage", component: PendingCoverage } satisfies Meta<
  typeof PendingCoverage
>;
export default meta;
export const Pending: StoryObj<typeof meta> = {};
