import { expect, test } from "./fixtures/desktop-app.js";

test("launches a deterministic isolated desktop shell", async ({ desktop }) => {
  await expect(desktop.page).toHaveTitle("Enduragent");
  await expect(desktop.page.locator("#root")).toHaveCount(1);
  const shell = desktop.page.locator("[data-shell]");
  await expect(shell).toBeVisible();
  await expect(shell).toHaveAttribute("data-onboarding", "settled", { timeout: 30_000 });
  await expect(shell).toHaveAttribute("data-shell", /^(app|gate)$/);
  await expect(desktop.page.locator("body")).not.toContainText(desktop.paths.athleteHome);
  await expect
    .poll(() => desktop.application.evaluate(({ app }) => app.getPath("userData")))
    .toBe(desktop.paths.userData);
});
