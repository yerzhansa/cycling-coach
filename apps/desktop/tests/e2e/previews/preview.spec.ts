import { expect, test as base, type Page, type TestInfo } from "@playwright/test";
import { coverage } from "../../../../desktop-renderer/preview/catalogue";
import baseline from "./baseline.json" with { type: "json" };
import { preferencesContract as settingsContract } from "../../../../../tools/ui-verification/contracts";
import {
  checkStructure,
  compareStructure,
  probeStructure,
  type StructuralContract,
} from "../../../../../tools/ui-verification/structure";

async function openStory(page: Page, info: TestInfo, id: string): Promise<void> {
  const theme = info.project.name.endsWith("dark") ? "dark" : "light";
  await page.goto(`/iframe.html?id=${id}&viewMode=story&globals=theme:${theme};palette:patrol`);
  await expect(page.locator("#preview-stage")).toHaveAttribute("data-scenario", id);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.locator(".sb-errordisplay")).not.toBeVisible();
}

async function misalignSecondRow(page: Page): Promise<void> {
  const row = page.locator('[aria-label="Preferences"] > .settings-row').nth(1);
  await row.evaluate((element) => {
    element.style.paddingLeft = "40px";
  });
  await expect(row).toHaveCSS("padding-left", "40px");
}

const test = base.extend<{ isolation: undefined }>({
  isolation: [
    async ({ context, page }, use, info) => {
      const unexpected: string[] = [];
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === "http://127.0.0.1:5187") await route.continue();
        else {
          unexpected.push(url.origin);
          await route.abort();
        }
      });
      const errors: string[] = [];
      expect(context.browser()?.version(), "Baseline browser version").toBe(baseline.browser);
      page.on("pageerror", (error) => errors.push(error.message));
      info.annotations.push({
        type: "pending-coverage",
        description: coverage
          .filter((entry) => entry.kind === "pending")
          .map((entry) => `${entry.id}: ${entry.dependency}`)
          .join("\n"),
      });
      await info.attach("environment", {
        body: JSON.stringify({
          platform: process.platform,
          architecture: process.arch,
          browser: context.browser()?.version(),
          viewport: info.project.use.viewport,
          locale: "en-US",
          timezone: "UTC",
          palette: "patrol",
        }),
        contentType: "application/json",
      });
      const identity = await context.request.get("http://127.0.0.1:5187/preview-source.json");
      expect(identity.ok()).toBe(true);
      const metadata: unknown = await identity.json();
      expect(metadata).toMatchObject({ mode: "build", graphCoverage: "complete-build" });
      await info.attach("source", { body: await identity.body(), contentType: "application/json" });
      await use(undefined);
      expect(unexpected, "Unexpected network destinations").toEqual([]);
      expect(errors, "Browser runtime errors").toEqual([]);
      expect(
        await page.evaluate(() => Object.keys(localStorage)),
        "Preview storage writes",
      ).toEqual([]);
      expect(
        await page.evaluate(() => "enduragentAuth" in window),
        "Native bridge must be absent",
      ).toBe(false);
    },
    { auto: true },
  ],
});

for (const { id } of coverage.filter((entry) => entry.kind === "ready")) {
  test(`${id} renders production content`, async ({ page }, info) => {
    await openStory(page, info, id);
    if (id.startsWith("desktop--")) {
      const title = id.includes("settings")
        ? "Settings"
        : id.includes("training")
          ? "Training"
          : "Chat";
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    } else if (id.startsWith("shared-select")) {
      const select = page.getByRole("combobox", { name: "Training day" });
      await expect(select).toBeVisible();
      if (id.endsWith("disabled")) await expect(select).toBeDisabled();
    } else {
      await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
      if (id.endsWith("busy"))
        await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
      if (id.endsWith("disabled"))
        await expect(
          page.getByRole("button", { name: "Remove all credentials", exact: true }),
        ).toBeDisabled();
    }
    if (id === "desktop--settings-preferences") {
      if (process.env.UI_PREVIEW_DEFECT === "second-row") {
        await misalignSecondRow(page);
      }
      const snapshot = await page.evaluate(probeStructure, settingsContract.anchors);
      expect.soft(checkStructure(snapshot, settingsContract)).toEqual([]);
      await info.attach("structure", {
        body: JSON.stringify(snapshot),
        contentType: "application/json",
      });
    }
    await expect(page.locator("#preview-stage")).toHaveScreenshot(`${id}.png`);
  });
}

test("shared select owns its icon and keyboard selection", async ({ page }, info) => {
  await openStory(page, info, "shared-select--default");
  const trigger = page.getByRole("combobox", { name: "Training day" });
  await expect(trigger).toContainText("Wednesday");
  await expect(trigger.locator("svg")).toHaveCount(1);
  const inset = await trigger.evaluate((element) => {
    const icon = element.querySelector("svg");
    if (icon === null) throw new Error("Select icon is missing");
    const style = getComputedStyle(element);
    return {
      actual: element.getBoundingClientRect().right - icon.getBoundingClientRect().right,
      expected: parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth),
    };
  });
  expect(inset.actual).toBeCloseTo(inset.expected, 1);
  await expect(trigger).toHaveScreenshot("select.png");
  await trigger.press("ArrowDown");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("confirmation focuses Cancel and keeps action order", async ({ page }, info) => {
  await openStory(page, info, "shared-inline-confirmation--default");
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  const contract = {
    anchors: [
      {
        name: "cancel",
        selector: "[data-inline-confirmation] button:first-child",
        count: { exact: 1 },
      },
      {
        name: "confirm",
        selector: "[data-inline-confirmation] button:last-child",
        count: { exact: 1 },
      },
    ],
    rules: [{ kind: "action-order", actions: ["cancel", "confirm"] }],
  } satisfies StructuralContract;
  expect(checkStructure(await page.evaluate(probeStructure, contract.anchors), contract)).toEqual(
    [],
  );
  await expect(page.locator("[data-inline-confirmation]")).toHaveScreenshot("confirmation.png");
});

test("second-row regression fails structure and image comparison, then recovers", async ({
  page,
}, info) => {
  await openStory(page, info, "desktop--settings-preferences");
  const original = await page.evaluate(probeStructure, settingsContract.anchors);
  expect(checkStructure(original, settingsContract)).toEqual([]);
  const image = await page.locator("#preview-stage").screenshot({ animations: "disabled" });
  await misalignSecondRow(page);
  const defective = await page.evaluate(probeStructure, settingsContract.anchors);
  const failures = checkStructure(defective, settingsContract);
  expect(
    failures.some(
      (failure) => failure.anchor === "labels[1]" && failure.property === "left-alignment",
    ),
  ).toBe(true);
  expect(compareStructure(original, defective, settingsContract.anchors).length).toBeGreaterThan(0);
  expect(
    (await page.locator("#preview-stage").screenshot({ animations: "disabled" })).equals(image),
  ).toBe(false);
  await info.attach("intentional-defect", {
    body: JSON.stringify(failures),
    contentType: "application/json",
  });
  await info.attach("intentional-defect-image", {
    body: await page.locator("#preview-stage").screenshot(),
    contentType: "image/png",
  });
  await page.reload();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  expect(
    checkStructure(await page.evaluate(probeStructure, settingsContract.anchors), settingsContract),
  ).toEqual([]);
  await expect(page.locator("#preview-stage")).toHaveScreenshot(
    "desktop--settings-preferences.png",
  );
});
