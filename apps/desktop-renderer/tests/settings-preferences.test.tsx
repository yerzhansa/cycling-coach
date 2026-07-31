import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { SettingsView } from "../src/ui/settings/SettingsView.js";
import { useEnduragentStore } from "../src/state/store.js";
import { PALETTES } from "../src/theme/palettes.js";
import { APPEARANCE_STORAGE_KEY, PALETTE_STORAGE_KEY } from "../src/theme/preferences.js";
import { setPrefersDark } from "./matchmedia.js";

function resetStore(): void {
  useEnduragentStore.setState({ paletteId: "patrol", appearance: "system", theme: "light" });
}

describe("settings preferences", () => {
  beforeEach(() => {
    resetStore();
  });

  it("offers one swatch per palette and marks the active one", () => {
    render(<SettingsView />);

    const swatches = screen.getAllByRole("button", { name: /^Use the .+ palette$/u });
    expect(swatches).toHaveLength(PALETTES.length);
    expect(screen.getByRole("button", { name: "Use the Patrol palette" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("applies and persists a palette choice", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByRole("button", { name: "Use the Velodrome palette" }));

    expect(useEnduragentStore.getState().paletteId).toBe("velodrome");
    expect(localStorage.getItem(PALETTE_STORAGE_KEY)).toBe("velodrome");
    expect(document.documentElement.style.getPropertyValue("--brand")).toBe("#bc3a2b");
    expect(screen.getByRole("button", { name: "Use the Velodrome palette" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Use the Patrol palette" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("applies and persists an appearance choice", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    const group = screen.getByRole("group", { name: "Appearance" });

    await user.click(screen.getByRole("button", { name: "Dark" }));

    expect(useEnduragentStore.getState().appearance).toBe("dark");
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#0f1520");
    expect(group).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Light" }));

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#f2f5f8");
  });

  it("follows the system colour scheme when the appearance is System", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    setPrefersDark(true);
    await user.click(screen.getByRole("button", { name: "System" }));

    expect(useEnduragentStore.getState().appearance).toBe("system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
