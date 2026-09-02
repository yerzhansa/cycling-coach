import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import { launchDesktopFixture, type RunningDesktopFixture } from "../helpers/desktop-fixture.js";
import { PlanCreationBackend } from "../helpers/plan-creation-backend.js";

const token = "d".repeat(43);
const ordinaryPrompt = "How should I pace a steady endurance ride?";
const ordinaryCoachReply = "Keep the effort conversational and finish feeling fresh.";

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
  const scratch = await mkdtemp(join(tmpdir(), "plan-creation-discard-"));
  const backend = new PlanCreationBackend(join(scratch, "store.db"));
  let fixture: RunningDesktopFixture | undefined;
  try {
    await backend.open();
    await backend.seedUnrelatedPlans();
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

async function waitForVersion(backend: PlanCreationBackend, version: number): Promise<void> {
  await expect.poll(async () => (await backend.card())?.version).toBe(version);
}

async function startAndAnswerGoal(scenario: Scenario): Promise<void> {
  await scenario.page.getByRole("button", { name: "Start a Plan", exact: true }).click();
  await waitForVersion(scenario.backend, 1);
  await scenario.page.getByRole("button", { name: "Improve without an event" }).click();
  await waitForVersion(scenario.backend, 2);
  await expect(
    scenario.page.getByRole("heading", { name: "How long should this Fitness Plan be?" }),
  ).toBeVisible();
}

async function openDiscardConfirmation(page: Page) {
  const discard = page.getByRole("button", { name: "Discard", exact: true });
  await discard.click();
  const keepCreating = page.getByRole("button", { name: "Keep creating", exact: true });
  await expect(page.getByRole("heading", { name: "Discard this Plan creation?" })).toBeVisible();
  await expect(
    page.getByText(
      "No Plan is created. Your active Plan, Schedule, training restrictions, closed Plans, saved preferences, and chat history are unchanged.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Discard creation" })).toBeVisible();
  await expect(keepCreating).toBeFocused();
  await expect(page.locator("#message")).toBeDisabled();
  return { discard, keepCreating };
}

async function discardPlanCreation(page: Page): Promise<void> {
  await openDiscardConfirmation(page);
  await page.getByRole("button", { name: "Discard creation" }).click();
  await expect(page.getByText("Plan creation discarded", { exact: true })).toBeVisible();
  await expect(page.locator('[data-parity="discarded.record"]')).toBeVisible();
  await expect(
    page.getByText(
      "No Plan was created. Your active Plan, Schedule, training restrictions, saved preferences, and chat history are unchanged.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Start a Plan" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Message your coach" })).toBeEnabled();
}

async function sendOrdinaryTurn(page: Page): Promise<void> {
  await page.getByRole("combobox", { name: "Message your coach" }).fill(ordinaryPrompt);
  await page.getByRole("button", { name: "Send message" }).click();
  const conversation = page.getByRole("log", { name: "Coach conversation" });
  await expect(conversation.getByText(ordinaryPrompt, { exact: true })).toBeVisible();
  await expect(conversation.getByText(ordinaryCoachReply, { exact: true })).toBeVisible();
}

async function expectNoPlanCreationSummaries(page: Page): Promise<void> {
  await expect(page.locator('[data-parity="summary.row"]')).toHaveCount(0);
  await expect(page.locator('[data-parity="progress.card"]')).toHaveCount(0);
}

test("cancels and then persists discarding an unfinished Plan Creation", async ({ playwright }) => {
  const scenario = await launch(playwright);
  try {
    await startAndAnswerGoal(scenario);
    const beforeDiscard = await scenario.backend.inspectDiscard();
    expect(beforeDiscard.creations).toHaveLength(1);
    expect(beforeDiscard.creations[0]).toMatchObject({
      status: "in-progress",
      version: 2,
      terminalAtMs: null,
    });
    expect(beforeDiscard.answers).toHaveLength(1);

    const { discard } = await openDiscardConfirmation(scenario.page);
    await scenario.fixture.pressKey("Escape");
    await expect(scenario.page.getByRole("button", { name: "Discard creation" })).toHaveCount(0);
    await expect(discard).toBeFocused();
    await expect(scenario.backend.inspectDiscard()).resolves.toEqual(beforeDiscard);

    await discardPlanCreation(scenario.page);
    const start = scenario.page.getByRole("button", { name: "Start a Plan" });
    await expect(start).toBeFocused();
    const afterDiscard = await scenario.backend.inspectDiscard();
    expect(afterDiscard.creations).toEqual([
      {
        ...beforeDiscard.creations[0],
        status: "discarded",
        version: 3,
        terminalAtMs: expect.any(Number),
      },
    ]);
    expect(afterDiscard.answers).toEqual(beforeDiscard.answers);
    await expectNoPlanCreationSummaries(scenario.page);

    await relaunch(scenario, playwright);
    await expect(scenario.page.getByRole("button", { name: "Start a Plan" })).toBeVisible();
    await expectNoPlanCreationSummaries(scenario.page);
  } finally {
    await close(scenario);
  }
});

test("preserves an ordinary Chat turn after discard and relaunch", async ({ playwright }) => {
  const scenario = await launch(playwright);
  try {
    await sendOrdinaryTurn(scenario.page);
    await startAndAnswerGoal(scenario);
    const unrelatedBeforeDiscard = await scenario.backend.inspectUnrelated();
    expect(unrelatedBeforeDiscard.activePlans).toHaveLength(1);
    expect(unrelatedBeforeDiscard.closedPlans).toHaveLength(1);
    expect(unrelatedBeforeDiscard.pastChats).toHaveLength(1);
    expect(unrelatedBeforeDiscard.transcript).toHaveLength(1);
    await discardPlanCreation(scenario.page);
    await expect(scenario.backend.inspectUnrelated()).resolves.toEqual(unrelatedBeforeDiscard);
    await expect(scenario.page.getByText(ordinaryPrompt, { exact: true })).toBeVisible();
    await expect(scenario.page.getByText(ordinaryCoachReply, { exact: true })).toBeVisible();

    await relaunch(scenario, playwright);
    await expect(scenario.backend.inspectUnrelated()).resolves.toEqual(unrelatedBeforeDiscard);
    await expect(scenario.page.getByRole("button", { name: "Start a Plan" })).toBeVisible();
    await expect(scenario.page.getByText(ordinaryPrompt, { exact: true })).toBeVisible();
    await expect(scenario.page.getByText(ordinaryCoachReply, { exact: true })).toBeVisible();
  } finally {
    await close(scenario);
  }
});

test("starts a distinct Plan Creation after discard", async ({ playwright }) => {
  const scenario = await launch(playwright);
  try {
    await startAndAnswerGoal(scenario);
    const beforeDiscard = await scenario.backend.inspectDiscard();
    const discardedId = beforeDiscard.creations[0]?.id;
    if (discardedId === undefined) throw new TypeError("Plan Creation row is unavailable");
    await discardPlanCreation(scenario.page);

    await scenario.page.getByRole("button", { name: "Start a Plan" }).click();
    await expect(
      scenario.page.getByRole("heading", {
        name: "What do you want this Plan to prepare you for?",
      }),
    ).toBeVisible();
    await expect(
      scenario.page.getByText("Plan creation discarded", { exact: true }),
    ).toBeVisible();
    const restarted = await scenario.backend.inspectDiscard();
    expect(restarted.creations).toHaveLength(2);
    expect(restarted.creations[0]).toMatchObject({ id: discardedId, status: "discarded" });
    expect(restarted.creations[1]).toMatchObject({ status: "in-progress", terminalAtMs: null });
    expect(restarted.creations[1]?.id).not.toBe(discardedId);
  } finally {
    await close(scenario);
  }
});
