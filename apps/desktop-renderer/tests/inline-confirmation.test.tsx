import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { BUTTON_COMPACT_QUIET_SM, BUTTON_DANGER_SOLID_SM } from "../src/ui/shared/buttons.js";
import { InlineConfirmation } from "../src/ui/shared/InlineConfirmation.js";

function ReturnFocusHarness(): ReactElement {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const cancel = (): void => {
    setOpen(false);
    queueMicrotask(() => trigger.current?.focus());
  };

  return (
    <>
      <button type="button" ref={trigger} onClick={() => setOpen(true)}>
        Delete
      </button>
      {open ? (
        <InlineConfirmation
          name="return-focus"
          title="Delete the connection?"
          copy="Saved credentials will be removed."
          confirmLabel="Delete connection"
          focusTarget={null}
          onCancel={cancel}
          onConfirm={() => {}}
        />
      ) : null}
    </>
  );
}

describe("inline confirmation", () => {
  it("focuses Cancel first and keeps the destructive action second", () => {
    const view = render(
      <InlineConfirmation
        name="ordering"
        title="Delete the connection?"
        copy="Saved credentials will be removed."
        confirmLabel="Delete connection"
        focusTarget={null}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );

    const group = screen.getByRole("group", { name: "Delete the connection?" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Cancel", "Delete connection"]);
    expect(buttons[0]).toHaveFocus();
    expect(group.parentElement).toHaveClass("bg-sunk");
    expect(buttons[0]?.className).toBe(BUTTON_COMPACT_QUIET_SM);
    expect(buttons[1]?.className).toBe(BUTTON_DANGER_SOLID_SM);

    view.rerender(
      <InlineConfirmation
        name="ordering"
        title="Delete the connection?"
        copy="Saved credentials will be removed."
        confirmLabel="Delete connection"
        focusTarget="confirm"
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(buttons[1]).toHaveFocus();
  });

  it("lets a caller restore the initiating control after Cancel or Escape", async () => {
    const user = userEvent.setup();
    render(<ReturnFocusHarness />);
    const trigger = screen.getByRole("button", { name: "Delete" });

    await user.click(trigger);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(trigger).toHaveFocus());

    await user.click(trigger);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("group", { name: "Delete the connection?" })).toBeNull();
  });

  it("ignores Escape while focus is in an editable control", () => {
    const onCancel = vi.fn();
    render(
      <>
        <input aria-label="Key" />
        <textarea aria-label="Note" />
        <select aria-label="Choice">
          <option>One</option>
        </select>
        <div contentEditable suppressContentEditableWarning>
          <span tabIndex={0}>Editable copy</span>
        </div>
        <InlineConfirmation
          name="editable-focus"
          title="Delete the connection?"
          copy="Saved credentials will be removed."
          confirmLabel="Delete connection"
          focusTarget={null}
          onCancel={onCancel}
          onConfirm={() => {}}
        />
      </>,
    );

    const editableControls = [
      screen.getByRole("textbox", { name: "Key" }),
      screen.getByRole("textbox", { name: "Note" }),
      screen.getByRole("combobox", { name: "Choice" }),
      screen.getByText("Editable copy"),
    ];
    for (const control of editableControls) {
      control.focus();
      fireEvent.keyDown(document, { key: "Escape" });
    }
    expect(onCancel).not.toHaveBeenCalled();

    screen.getByRole("button", { name: "Cancel" }).focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
