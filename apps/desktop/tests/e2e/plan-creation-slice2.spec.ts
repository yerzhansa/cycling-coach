import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import type { PlanCreationCardModel } from "@enduragent/coach-contract";
import { launchDesktopFixture, type RunningDesktopFixture } from "../helpers/desktop-fixture.js";
import { PlanCreationBackend } from "../helpers/plan-creation-backend.js";

const token = "d".repeat(43);

interface Scenario {
  readonly backend: PlanCreationBackend;
  readonly fixture: RunningDesktopFixture;
  readonly scratch: string;
  browser: Browser;
  page: Page;
}

type Playwright = PlaywrightWorkerArgs["playwright"];

async function connect(playwright: Playwright, fixture: RunningDesktopFixture) {
  const browser = await playwright.chromium.connectOverCDP(fixture.remoteDebuggingUrl);
  const page = browser
    .contexts()[0]
    ?.pages()
    .find((candidate) => candidate.url().startsWith("enduragent://app/"));
  if (page === undefined) throw new TypeError("Plan Creation renderer is unavailable");
  await expect(page.locator("[data-shell]")).toHaveAttribute("data-onboarding", "settled", {
    timeout: 30_000,
  });
  return { browser, page };
}

async function launch(playwright: Playwright): Promise<Scenario> {
  const scratch = await mkdtemp(join(tmpdir(), "plan-creation-"));
  const backend = new PlanCreationBackend(join(scratch, "store.db"));
  let fixture: RunningDesktopFixture | undefined;
  try {
    await backend.open();
    fixture = await launchDesktopFixture({
      script: backend.script,
      token,
      width: 1180,
      height: 820,
      colorScheme: "light",
      reducedMotion: true,
      hidden: true,
      routeChatAttachmentComposer: true,
    });
    return { backend, fixture, scratch, ...(await connect(playwright, fixture)) };
  } catch (error) {
    try {
      await fixture?.close();
    } finally {
      try {
        await backend.close();
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
    throw error;
  }
}

async function relaunch(scenario: Scenario, playwright: Playwright): Promise<void> {
  await scenario.browser.close();
  await scenario.fixture.relaunch(() => scenario.backend.reopen());
  Object.assign(scenario, await connect(playwright, scenario.fixture));
}

async function close(scenario: Scenario): Promise<void> {
  await scenario.browser.close().catch(() => {});
  try {
    await expect(scenario.fixture.close()).resolves.toEqual({ livePids: [], listenerCount: 0 });
  } finally {
    try {
      await scenario.backend.close();
    } finally {
      await rm(scenario.scratch, { recursive: true, force: true });
    }
  }
}

async function requireCard(backend: PlanCreationBackend): Promise<PlanCreationCardModel> {
  const card = await backend.card();
  if (card === null) throw new TypeError("Plan Creation Card is unavailable");
  return card;
}

async function waitForVersion(
  backend: PlanCreationBackend,
  version: number,
): Promise<PlanCreationCardModel> {
  await expect.poll(async () => (await backend.card())?.version).toBe(version);
  return requireCard(backend);
}

async function choose(page: Page, backend: PlanCreationBackend, version: number, answer: string) {
  await page.locator(`[data-parity="choice.row"][data-answer="${answer}"]`).click();
  return waitForVersion(backend, version);
}

async function startFitnessGoal(scenario: Scenario): Promise<void> {
  await scenario.page.getByRole("button", { name: "Start a Plan", exact: true }).click();
  await waitForVersion(scenario.backend, 1);
  await choose(scenario.page, scenario.backend, 2, "fitness");
}

async function answerThroughBaseline(scenario: Scenario): Promise<void> {
  await startFitnessGoal(scenario);
  await choose(scenario.page, scenario.backend, 3, "8");
  await choose(scenario.page, scenario.backend, 4, "flexible");
  await scenario.page.locator('[data-answer="hours-6"]').click();
  await scenario.page.locator('[data-parity="availability.longest"]').fill("2");
  await scenario.page.getByRole("button", { name: "Continue", exact: true }).click();
  await waitForVersion(scenario.backend, 5);
  await choose(scenario.page, scenario.backend, 6, "asap");
  await choose(scenario.page, scenario.backend, 7, "none");
  await choose(scenario.page, scenario.backend, 8, "regular");
}

async function answerAuthoredSuccess(scenario: Scenario): Promise<void> {
  await scenario.page.locator('[data-parity="choice.custom"][data-answer="custom"]').click();
  await expect(scenario.page.locator('[data-parity="composer"]')).toHaveCount(0);
  const editor = scenario.page.locator('[data-parity="custom.textarea"]');
  await editor.fill("Ride four steady hours");
  await scenario.page.getByRole("button", { name: "Continue", exact: true }).click();
  await waitForVersion(scenario.backend, 9);
}

async function answerRestriction(scenario: Scenario): Promise<void> {
  await scenario.page.locator('[data-answer="no-hard-training"]').click();
  expect((await requireCard(scenario.backend)).version).toBe(9);
  await scenario.page.getByLabel("Optional end date", { exact: true }).fill("1998-11-01");
  await scenario.page.getByRole("button", { name: "Continue", exact: true }).click();
  await waitForVersion(scenario.backend, 10);
  const card = await requireCard(scenario.backend);
  expect(card.readiness).toBe("ready");
  expect(card.openQuestion).toBeNull();
}

async function completeFitnessGoal(scenario: Scenario): Promise<void> {
  await answerThroughBaseline(scenario);
  await answerAuthoredSuccess(scenario);
  await answerRestriction(scenario);
}

async function installStaleExpectedVersionHook(
  fixture: RunningDesktopFixture,
  expectedVersion: number,
): Promise<void> {
  await fixture.evaluate<void>(`
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      if (typeof data !== "string") return originalSend.call(this, data);
      let frame;
      try {
        frame = JSON.parse(data);
      } catch {
        return originalSend.call(this, data);
      }
      if (frame.method !== "plan_creation.answer") return originalSend.call(this, data);
      WebSocket.prototype.send = originalSend;
      frame.params.expectedVersion = ${expectedVersion};
      return originalSend.call(this, JSON.stringify(frame));
    };
  `);
}

test("completes the Fitness Goal with an authored success answer", async ({ playwright }) => {
  const scenario = await launch(playwright);
  try {
    await completeFitnessGoal(scenario);
    const progress = scenario.page.getByRole("region", { name: "Plan Creation progress" });
    await expect(
      progress.getByText("The essentials are complete. Draft preview arrives in a later update.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(scenario.page.getByRole("button", { name: "Send message" })).toBeEnabled();
    const answers = await scenario.backend.answers();
    expect(answers.map((answer) => answer.answer_key)).toEqual([
      "goal",
      "plan-length",
      "schedule-mode",
      "availability",
      "start-timing",
      "commitments",
      "baseline",
      "success",
      "restriction",
    ]);
    expect(answers).toHaveLength(9);
    for (const answer of answers) {
      expect(answer.scope).toBe("plan-creation");
      expect(JSON.parse(answer.value_json)).toMatchObject({ source: { kind: "athlete" } });
    }
    expect(JSON.parse(answers.at(-1)?.value_json ?? "null")).toMatchObject({
      answer: {
        kind: "restriction",
        restriction: { kind: "no-hard-training", endDate: "1998-11-01" },
      },
    });
  } finally {
    await close(scenario);
  }
});

test("edits the goal, pauses, and resumes the Event success Card", async ({ playwright }) => {
  const scenario = await launch(playwright);
  try {
    await completeFitnessGoal(scenario);
    const persisted = await scenario.backend.answers();
    const beforeEdit = await requireCard(scenario.backend);
    const goal = beforeEdit.answeredSummaries.find((summary) => summary.answerKey === "goal");
    if (goal === undefined) throw new TypeError("Goal summary is unavailable");
    await scenario.page.getByRole("button", { name: `Edit ${goal.title}`, exact: true }).click();
    await expect(scenario.page.locator('[data-answer="fitness"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await scenario.page.locator('[data-answer="event-not-listed"]').click();
    await expect(scenario.page.locator('[data-parity="composer"]')).toHaveCount(0);
    await scenario.page
      .getByRole("textbox", { name: "Event name", exact: true })
      .fill("Highland Classic");
    await scenario.page.getByLabel("Event date", { exact: true }).fill("1998-06-20");
    await scenario.page.getByRole("button", { name: "Continue", exact: true }).click();
    const changed = await waitForVersion(scenario.backend, 11);
    expect(changed.answeredSummaries.map((summary) => summary.answerKey)).toEqual([
      "goal",
      "schedule-mode",
      "availability",
      "start-timing",
      "commitments",
      "baseline",
      "restriction",
    ]);
    const editedRows = await scenario.backend.answers();
    expect(editedRows.slice(0, 9)).toEqual(persisted);
    expect(editedRows.at(-1)?.answer_key).toBe("goal");
    await scenario.page.getByRole("button", { name: "Later", exact: true }).click();
    await expect(scenario.page.getByRole("button", { name: "Send message" })).toBeEnabled();
    await relaunch(scenario, playwright);
    await expect(
      scenario.page.locator('[data-parity="question.card"][data-question="success"]'),
    ).toHaveCount(0);
    const continueButton = scenario.page.getByRole("button", { name: "Continue", exact: true });
    await continueButton.click();
    await expect(
      scenario.page.locator('[data-parity="question.card"][data-question="success"]'),
    ).toBeVisible();
    await choose(scenario.page, scenario.backend, 12, "finish-comfortably");
    const ready = await requireCard(scenario.backend);
    expect(ready.readiness).toBe("ready");
    expect(ready.openQuestion).toBeNull();
    expect(await scenario.backend.answers()).toHaveLength(11);
  } finally {
    await close(scenario);
  }
});

test("reinstalls the live Card after a stale-version rejection", async ({ playwright }) => {
  const scenario = await launch(playwright);
  try {
    await startFitnessGoal(scenario);
    const staleCard = await requireCard(scenario.backend);
    await installStaleExpectedVersionHook(scenario.fixture, staleCard.version - 1);
    await scenario.page.locator('[data-answer="8"]').click();
    await expect(
      scenario.page.locator('[data-parity="question.card"][data-question="plan-length"]'),
    ).toBeVisible();
    await expect(scenario.page.getByRole("alert")).toHaveText(
      "Plan Creation couldn’t save that. Try again.",
    );
    await expect.poll(async () => (await scenario.backend.card())?.version).toBe(staleCard.version);
    expect((await scenario.backend.answers()).map((row) => row.answer_key)).toEqual(["goal"]);
  } finally {
    await close(scenario);
  }
});
