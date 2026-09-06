import { expect, test } from "@playwright/test";
import { coverage } from "../../../../desktop-renderer/preview/catalogue";
import { verifyStoryCoverage } from "../../../../../tools/ui-verification/coverage";

declare global {
  interface Window {
    __uiCoverageStorageWrites?: readonly { readonly method: string; readonly key: string }[];
    __uiCoverageNavigationToken?: string;
  }
}

test("built Storybook index exactly covers the ready catalogue", async ({ request }, info) => {
  const response = await request.get("/index.json");
  expect(response.ok()).toBe(true);
  const index: unknown = await response.json();
  const result = verifyStoryCoverage(index, coverage);
  await info.attach("verified-catalogue-coverage", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
});

test("Settings controls remain ephemeral and story navigation resets their state", async ({
  page,
}, info) => {
  const theme = info.project.name.endsWith("dark") ? "dark" : "light";
  const changedTheme = theme === "light" ? "dark" : "light";
  const label = (value: string) => (value === "dark" ? "Dark" : "Light");
  await page.addInitScript(() => {
    if (window.top === window) return;
    const writes: { method: string; key: string }[] = [];
    window.__uiCoverageStorageWrites = writes;
    const originalSet = Storage.prototype.setItem;
    const originalRemove = Storage.prototype.removeItem;
    const originalClear = Storage.prototype.clear;
    Storage.prototype.setItem = function (key, value) {
      writes.push({ method: "setItem", key });
      originalSet.call(this, key, value);
    };
    Storage.prototype.removeItem = function (key) {
      writes.push({ method: "removeItem", key });
      originalRemove.call(this, key);
    };
    Storage.prototype.clear = function () {
      writes.push({ method: "clear", key: "*" });
      originalClear.call(this);
    };
  });
  await page.goto(
    `/?path=/story/desktop--settings-preferences&globals=theme:${theme};palette:patrol`,
  );
  const frame = page.frameLocator("#storybook-preview-iframe");
  const stage = frame.locator("#preview-stage");
  await expect(stage).toHaveAttribute("data-scenario", "desktop--settings-preferences");
  await expect(frame.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  const appearance = frame.getByRole("group", { name: "Appearance", exact: true });
  const palettes = frame.getByRole("group", { name: "App palette", exact: true });
  await expect(appearance.getByRole("button", { name: label(theme), exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    palettes.getByRole("button", { name: "Use the Patrol palette", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const initialBrand = await frame
    .locator("html")
    .evaluate((element) => getComputedStyle(element).getPropertyValue("--brand"));
  await appearance.getByRole("button", { name: label(changedTheme), exact: true }).click();
  await expect(frame.locator("html")).toHaveAttribute("data-theme", changedTheme);
  await expect(
    appearance.getByRole("button", { name: label(changedTheme), exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await palettes.getByRole("button", { name: "Use the Moss palette", exact: true }).click();
  await expect(
    palettes.getByRole("button", { name: "Use the Moss palette", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    await frame
      .locator("html")
      .evaluate((element) => getComputedStyle(element).getPropertyValue("--brand")),
  ).not.toBe(initialBrand);
  expect(await frame.locator("html").evaluate(() => window.__uiCoverageStorageWrites)).toEqual([]);
  await frame.locator("html").evaluate(() => {
    window.__uiCoverageNavigationToken = "same-preview-document";
  });
  await page.getByRole("link", { name: "Chat Empty", exact: true }).click();
  await expect(stage).toHaveAttribute("data-scenario", "desktop--chat-empty");
  await expect(frame.getByRole("heading", { name: "Chat", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Settings Preferences", exact: true }).click();
  await expect(stage).toHaveAttribute("data-scenario", "desktop--settings-preferences");
  await expect(appearance.getByRole("button", { name: label(theme), exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    palettes.getByRole("button", { name: "Use the Patrol palette", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(frame.locator("html")).toHaveAttribute("data-theme", theme);
  expect(await frame.locator("html").evaluate(() => window.__uiCoverageNavigationToken)).toBe(
    "same-preview-document",
  );
  expect(await frame.locator("html").evaluate(() => window.__uiCoverageStorageWrites)).toEqual([]);
  expect(
    await frame
      .locator("html")
      .evaluate((element) => getComputedStyle(element).getPropertyValue("--brand")),
  ).toBe(initialBrand);
});
