import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "./helpers/desktop-fixture.js";

const hasLoopback = await new Promise<boolean>((resolveAvailability) => {
  const server = createServer();
  server.once("error", () => resolveAvailability(false));
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    server.close(() => resolveAvailability(true));
  });
});

const token = "t".repeat(43);
const fixtures: RunningDesktopFixture[] = [];

const script: DesktopFixtureScript = {
  onRequest() {
    throw new TypeError("unexpected fixture request");
  },
};

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe.skipIf(process.platform !== "darwin" || !hasLoopback)("onboarding live", () => {
  it("opens the setup wizard on first run and dismisses it with Escape", async () => {
    const fixture = await launchDesktopFixture({
      script,
      token,
      width: 1440,
      height: 900,
      colorScheme: "light",
      reducedMotion: false,
    });
    fixtures.push(fixture);
    const observed = await fixture.evaluate<{
      readonly present: boolean;
      readonly covers: boolean;
      readonly title: string;
      readonly dismissed: boolean;
      readonly focusRestored: boolean;
    }>(`
      const deadline = Date.now() + 10000;
      while (!document.querySelector(".onboarding") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const dialog = document.querySelector(".onboarding");
      const scrim = document.querySelector(".onboarding-scrim");
      const rect = scrim ? scrim.getBoundingClientRect() : { width: 0, height: 0 };
      const midpoint = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      const present = dialog !== null;
      const covers =
        rect.width >= window.innerWidth &&
        rect.height >= window.innerHeight &&
        (midpoint === scrim || scrim.contains(midpoint));
      const title = document.querySelector("#onboarding-title")?.textContent ?? "";
      dialog?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 60));
      return {
        present,
        covers,
        title,
        dismissed: document.querySelector(".onboarding") === null,
        focusRestored: document.activeElement?.textContent?.includes("Settings") === true,
      };
    `);
    expect(observed).toEqual({
      present: true,
      covers: true,
      title: "Choose how your coach thinks",
      dismissed: true,
      focusRestored: true,
    });
  });
});
