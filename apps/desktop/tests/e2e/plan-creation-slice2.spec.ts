import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import type { PlanCreationCardModel } from "@enduragent/coach-contract";
import {
  createPlanCreationRepository,
  type PlanCreationRepository,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import {
  createPlanCreationOperations,
  type PlanCreationHost,
} from "../../../../packages/coach/src/plan-creation-operations.js";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "../helpers/desktop-fixture.js";
import { createPlanQaFixtureScript } from "../helpers/plan-qa-live.js";

const token = "d".repeat(43);
const emptyAttachmentComposer = {
  schemaVersion: 1,
  capabilities: {
    schemaVersion: 1,
    active: { provider: "test", model: "text-only", transport: "test" },
    documents: { enabled: true, extensions: ["pdf", "txt", "csv", "docx"] },
    completedActivities: { enabled: true, extensions: ["fit", "tcx", "gpx"] },
    plannedWorkouts: { enabled: true, extensions: ["zwo", "erg", "mrc"] },
    images: {
      enabled: false,
      mediaTypes: [],
      reason: "model_incompatible",
      source: "maintained_catalogue",
      checkedAt: "1998-09-02T00:00:00.000Z",
    },
  },
  draft: null,
} as const;

interface ScriptRequest {
  readonly method: string;
  readonly params: unknown;
}

interface StoredAnswerRow {
  readonly sequence: number;
  readonly creation_version: number;
  readonly answer_key: string;
  readonly scope: string;
  readonly value_json: string;
}

const response = (value: unknown): readonly string[] => [JSON.stringify(value)];

class PlanCreationBackend {
  readonly script: DesktopFixtureScript;
  private store: (SqlStore & MigratorStore) | undefined;
  private repository: PlanCreationRepository | undefined;
  private host: PlanCreationHost | undefined;
  private sequence = 0;
  private instant = 883_612_800_000;

  constructor(private readonly databasePath: string) {
    const base = createPlanQaFixtureScript();
    this.script = {
      onRequest: async (value) => {
        const request = value as ScriptRequest;
        if (request.method === "getChatAttachmentComposer") {
          return response(emptyAttachmentComposer);
        }
        if (request.method === "resumePlanningRequests") return response({ deliveries: [] });
        if (request.method === "listPlanningRequests") {
          return response({ deliveries: [], planCreation: await this.requireHost().readCard() });
        }
        if (request.method === "plan_creation.start") {
          return response(
            await this.requireHost()["plan_creation.start"](
              request.params as Parameters<PlanCreationHost["plan_creation.start"]>[0],
            ),
          );
        }
        if (request.method === "plan_creation.answer") {
          return response(
            await this.requireHost()["plan_creation.answer"](
              request.params as Parameters<PlanCreationHost["plan_creation.answer"]>[0],
            ),
          );
        }
        return base.onRequest(value);
      },
    };
  }

  async open(): Promise<void> {
    this.store = openSqliteStorage(this.databasePath);
    await runMigrations(this.store, MIGRATIONS);
    this.repository = createPlanCreationRepository(this.store);
    this.host = createPlanCreationOperations({
      repository: this.repository,
      identity: {
        deviceId: async () => "fixture-device",
        newUlid: () => `${++this.sequence}`.padStart(26, "0"),
        hlcStamp: () => ({ physicalMs: this.instant++, counter: 0 }),
      },
      crypto: globalThis.crypto,
      eventCandidates: { read: async () => [] },
      today: () => "1998-01-01",
    });
  }

  async reopen(): Promise<void> {
    await this.close();
    await this.open();
  }

  async close(): Promise<void> {
    await this.store?.close();
    this.store = undefined;
    this.repository = undefined;
    this.host = undefined;
  }

  async card(): Promise<PlanCreationCardModel | null> {
    return this.requireHost().readCard();
  }

  async answers(): Promise<readonly StoredAnswerRow[]> {
    return (await this.requireStore().all(
      "SELECT sequence,creation_version,answer_key,scope,value_json FROM plan_creation_answer ORDER BY sequence",
    )) as unknown as readonly StoredAnswerRow[];
  }

  private requireStore(): SqlStore & MigratorStore {
    if (this.store === undefined) throw new TypeError("Plan Creation store is closed");
    return this.store;
  }

  private requireHost(): PlanCreationHost {
    if (this.host === undefined) throw new TypeError("Plan Creation host is closed");
    return this.host;
  }
}

interface Scenario {
  readonly backend: PlanCreationBackend;
  readonly fixture: RunningDesktopFixture;
  readonly scratch: string;
  browser: Browser;
  page: Page;
}

type Playwright = PlaywrightWorkerArgs["playwright"];
type AnswerKey = PlanCreationCardModel["answeredSummaries"][number]["answerKey"];
type AnswerSummary = PlanCreationCardModel["answeredSummaries"][number];
type OpenQuestion = NonNullable<PlanCreationCardModel["openQuestion"]>;
type OpenQuestionKind = OpenQuestion["kind"];

async function connect(playwright: Playwright, fixture: RunningDesktopFixture) {
  const browser = await playwright.chromium.connectOverCDP(fixture.remoteDebuggingUrl);
  const context = browser.contexts()[0];
  const page = context
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
  await backend.open();
  const fixture = await launchDesktopFixture({
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
}

async function relaunch(scenario: Scenario, playwright: Playwright): Promise<void> {
  await scenario.browser.close();
  await scenario.fixture.relaunch(() => scenario.backend.reopen());
  Object.assign(scenario, await connect(playwright, scenario.fixture));
}

async function close(scenario: Scenario): Promise<void> {
  await scenario.browser.close().catch(() => {});
  await scenario.fixture.close().catch(() => {});
  await scenario.backend.close().catch(() => {});
  await rm(scenario.scratch, { recursive: true, force: true });
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

function summaryEditButton(page: Page, summary: AnswerSummary) {
  return page.getByRole("button", { name: `Edit ${summary.title}`, exact: true });
}

async function expectSummary(page: Page, card: PlanCreationCardModel, answerKey: AnswerKey) {
  const summary = card.answeredSummaries.find((candidate) => candidate.answerKey === answerKey);
  if (summary === undefined) throw new TypeError(`Missing ${answerKey} summary`);
  await expect(summaryEditButton(page, summary)).toBeVisible();
  return summary;
}

async function expectQuestion<K extends OpenQuestionKind>(
  scenario: Scenario,
  card: PlanCreationCardModel,
  kind: K,
): Promise<Extract<OpenQuestion, { readonly kind: K }>> {
  const question = card.openQuestion;
  if (question?.kind !== kind) throw new TypeError(`Expected ${kind}`);
  const heading = scenario.page.getByRole("heading", { name: question.prompt, exact: true });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  return question as Extract<OpenQuestion, { readonly kind: K }>;
}

async function submitAndExpectQuestion<K extends OpenQuestionKind>(
  scenario: Scenario,
  answerKey: AnswerKey,
  nextKind: K,
  submit: () => Promise<void>,
): Promise<Extract<OpenQuestion, { readonly kind: K }>> {
  const before = await requireCard(scenario.backend);
  await submit();
  const card = await waitForVersion(scenario.backend, before.version + 1);
  await expectSummary(scenario.page, card, answerKey);
  return expectQuestion(scenario, card, nextKind);
}

async function startFitnessGoal(scenario: Scenario): Promise<void> {
  await scenario.page.getByRole("button", { name: "Start a Plan", exact: true }).click();
  const started = await waitForVersion(scenario.backend, 1);
  await expectQuestion(scenario, started, "goal-question");
  await scenario.page
    .getByRole("button", { name: "Improve without an event", exact: true })
    .click();
  await scenario.page
    .getByRole("textbox", { name: "Goal outcome", exact: true })
    .fill("Build steady power");
  await submitAndExpectQuestion(scenario, "goal", "success-question", () =>
    scenario.page.getByRole("button", { name: "Confirm goal", exact: true }).click(),
  );
}

async function answerSuccess(scenario: Scenario): Promise<void> {
  await scenario.page.getByRole("button", { name: "Something else", exact: true }).click();
  await scenario.page
    .getByRole("textbox", { name: "Success meaning", exact: true })
    .fill("Ride four steady hours");
  await submitAndExpectQuestion(scenario, "success", "plan-length-question", () =>
    scenario.page.getByRole("button", { name: "Confirm success", exact: true }).click(),
  );
}

async function answerPlanLength(scenario: Scenario): Promise<void> {
  const card = await requireCard(scenario.backend);
  const question = await expectQuestion(scenario, card, "plan-length-question");
  const option = question.options.find((candidate) => candidate.weeks === 8);
  if (option === undefined) throw new TypeError("Eight-week Plan length is unavailable");
  await submitAndExpectQuestion(scenario, "plan-length", "start-timing-question", async () => {
    await scenario.page.locator(`input[name="weeks"][value="${option.weeks}"]`).click();
    await scenario.page.getByRole("button", { name: "Confirm length", exact: true }).click();
  });
}

async function answerStartTiming(scenario: Scenario): Promise<void> {
  await submitAndExpectQuestion(scenario, "start-timing", "schedule-mode-question", async () => {
    await scenario.page
      .locator('input[name="timing"][value="as-soon-as-possible"]')
      .click();
    await scenario.page.getByRole("button", { name: "Confirm start", exact: true }).click();
  });
}

async function answerScheduleMode(scenario: Scenario): Promise<void> {
  const card = await requireCard(scenario.backend);
  const question = await expectQuestion(scenario, card, "schedule-mode-question");
  const option = question.options.find((candidate) => candidate.mode === "flexible");
  if (option === undefined) throw new TypeError("Flexible Schedule is unavailable");
  await submitAndExpectQuestion(scenario, "schedule-mode", "availability-question", async () => {
    await scenario.page.getByRole("radio", { name: option.label }).click();
    await scenario.page.getByRole("button", { name: "Confirm Schedule", exact: true }).click();
  });
}

async function answerThroughScheduleMode(scenario: Scenario): Promise<void> {
  await startFitnessGoal(scenario);
  await answerSuccess(scenario);
  await answerPlanLength(scenario);
  await answerStartTiming(scenario);
  await answerScheduleMode(scenario);
}

async function answerAvailability(scenario: Scenario): Promise<void> {
  const card = await requireCard(scenario.backend);
  const question = await expectQuestion(scenario, card, "availability-question");
  await scenario.page.getByRole("spinbutton", { name: /Weekly.*hours/u }).fill("6");
  await scenario.page
    .getByRole("spinbutton", { name: "Longest Workout hours", exact: true })
    .fill("2");
  expect(question.derivedPoolNote).toContain("3");
  await expect(scenario.page.getByText(question.derivedPoolNote, { exact: true })).toBeVisible();
  await submitAndExpectQuestion(scenario, "availability", "commitments-question", () =>
    scenario.page.getByRole("button", { name: "Confirm availability", exact: true }).click(),
  );
  const answered = await requireCard(scenario.backend);
  const summary = answered.answeredSummaries.find(
    (candidate) => candidate.answerKey === "availability",
  );
  if (summary === undefined) throw new TypeError("Availability summary is unavailable");
  expect(summary.detail).toContain("3 Workouts in the flexible pool");
  await expect(
    scenario.page
      .getByRole("region", { name: "Plan Creation progress" })
      .getByText(summary.detail, { exact: true }),
  ).toBeVisible();
}

async function answerCommitments(scenario: Scenario): Promise<void> {
  await submitAndExpectQuestion(scenario, "commitments", "baseline-question", () =>
    scenario.page.getByRole("button", { name: "Nothing fixed", exact: true }).click(),
  );
}

async function answerBaseline(scenario: Scenario): Promise<void> {
  const card = await requireCard(scenario.backend);
  const question = await expectQuestion(scenario, card, "baseline-question");
  const option = question.options.find((candidate) => candidate.baseline === "regular");
  if (option === undefined) throw new TypeError("Regular baseline is unavailable");
  await submitAndExpectQuestion(scenario, "baseline", "restriction-question", async () => {
    await scenario.page.locator('input[name="baseline"][value="regular"]').click();
    await scenario.page.getByRole("button", { name: "Confirm baseline", exact: true }).click();
  });
}

async function answerRestriction(scenario: Scenario): Promise<void> {
  const before = await requireCard(scenario.backend);
  const question = await expectQuestion(scenario, before, "restriction-question");
  const option = question.options.find((candidate) => candidate.kind === "none");
  if (option === undefined) throw new TypeError("No-restriction answer is unavailable");
  await scenario.page.locator('input[name="restriction"][value="none"]').click();
  await scenario.page.getByRole("button", { name: "Confirm restriction", exact: true }).click();
  const card = await waitForVersion(scenario.backend, before.version + 1);
  await expectSummary(scenario.page, card, "restriction");
  expect(card.readiness).toBe("ready");
  expect(card.openQuestion).toBeNull();
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

test("completes the essential Fitness Goal answers and persists their sources", async ({
  playwright,
}) => {
  const scenario = await launch(playwright);
  try {
    await answerThroughScheduleMode(scenario);
    await answerAvailability(scenario);
    await answerCommitments(scenario);
    await answerBaseline(scenario);
    await answerRestriction(scenario);
    const progress = scenario.page.getByRole("region", { name: "Plan Creation progress" });
    await expect(
      progress.getByText("The essentials are complete. Draft preview arrives in a later update.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      scenario.page.getByRole("button", { name: "Send message", exact: true }),
    ).toBeEnabled();
    const answers = await scenario.backend.answers();
    expect(answers.map((answer) => answer.answer_key)).toEqual([
      "goal",
      "success",
      "plan-length",
      "start-timing",
      "schedule-mode",
      "availability",
      "commitments",
      "baseline",
      "restriction",
    ]);
    expect(answers).toHaveLength(9);
    for (const answer of answers) {
      expect(answer.scope).toBe("plan-creation");
      expect(JSON.parse(answer.value_json)).toMatchObject({ source: { kind: "athlete" } });
    }
  } finally {
    await close(scenario);
  }
});

test("edits the goal, pauses, and resumes the next unanswered Card after relaunch", async ({
  playwright,
}) => {
  const scenario = await launch(playwright);
  try {
    await answerThroughScheduleMode(scenario);
    await answerAvailability(scenario);
    await answerCommitments(scenario);
    await answerBaseline(scenario);
    await answerRestriction(scenario);
    const persisted = await scenario.backend.answers();
    expect(persisted).toHaveLength(9);
    const beforeEdit = await requireCard(scenario.backend);
    const goal = beforeEdit.answeredSummaries.find((summary) => summary.answerKey === "goal");
    const success = beforeEdit.answeredSummaries.find((summary) => summary.answerKey === "success");
    const planLength = beforeEdit.answeredSummaries.find(
      (summary) => summary.answerKey === "plan-length",
    );
    if (goal === undefined || success === undefined || planLength === undefined) {
      throw new TypeError("Editable summaries are unavailable");
    }
    await summaryEditButton(scenario.page, goal).click();
    await expect(
      scenario.page.getByRole("textbox", { name: "Goal outcome", exact: true }),
    ).toBeFocused();
    await scenario.page.getByRole("button", { name: "Cancel", exact: true }).click();
    await scenario.page.getByRole("button", { name: "Something else", exact: true }).click();
    await scenario.page
      .getByRole("textbox", { name: "Event name", exact: true })
      .fill("Highland Classic");
    await scenario.page.getByLabel("Event date", { exact: true }).fill("1998-06-20");
    const eventSuccess = await submitAndExpectQuestion(scenario, "goal", "success-question", () =>
      scenario.page.getByRole("button", { name: "Confirm goal", exact: true }).click(),
    );
    const editedRows = await scenario.backend.answers();
    expect(editedRows).toHaveLength(10);
    expect(editedRows.slice(0, 9)).toEqual(persisted);
    expect(editedRows.at(-1)?.answer_key).toBe("goal");
    await expect(summaryEditButton(scenario.page, success)).toHaveCount(0);
    await expect(summaryEditButton(scenario.page, planLength)).toHaveCount(0);
    const retained = await requireCard(scenario.backend);
    await expectSummary(scenario.page, retained, "start-timing");
    await expectSummary(scenario.page, retained, "schedule-mode");
    await scenario.page.getByRole("button", { name: "Later", exact: true }).click();
    await expect(
      scenario.page.getByRole("button", { name: "Send message", exact: true }),
    ).toBeEnabled();
    await expect(
      scenario.page.getByRole("button", { name: "Continue", exact: true }),
    ).toBeVisible();
    await relaunch(scenario, playwright);
    const restored = await requireCard(scenario.backend);
    await expectSummary(scenario.page, restored, "goal");
    await expectSummary(scenario.page, restored, "start-timing");
    await expectSummary(scenario.page, restored, "schedule-mode");
    const successHeading = scenario.page.getByRole("heading", {
      name: eventSuccess.prompt,
      exact: true,
    });
    const continueButton = scenario.page.getByRole("button", { name: "Continue", exact: true });
    await expect(successHeading).not.toBeVisible();
    await expect(continueButton).toBeVisible();
    await continueButton.click();
    await expect(successHeading).toBeVisible();
    await expect(successHeading).toBeFocused();
    if (eventSuccess.input.kind !== "event-finish") {
      throw new TypeError("Event success choices are unavailable");
    }
    const finish = eventSuccess.input.options.find(
      (option) => option.choice === "finish-comfortably",
    );
    if (finish === undefined) throw new TypeError("Finish comfortably is unavailable");
    const beforeSuccess = await requireCard(scenario.backend);
    await scenario.page.getByRole("button", { name: finish.label, exact: true }).click();
    const ready = await waitForVersion(scenario.backend, beforeSuccess.version + 1);
    expect(ready.readiness).toBe("ready");
    expect(ready.openQuestion).toBeNull();
    expect(await scenario.backend.answers()).toHaveLength(11);
  } finally {
    await close(scenario);
  }
});

test("reinstalls the live Card after a stale-version rejection without duplicate answers", async ({
  playwright,
}) => {
  const scenario = await launch(playwright);
  try {
    await startFitnessGoal(scenario);
    const staleCard = await requireCard(scenario.backend);
    await installStaleExpectedVersionHook(scenario.fixture, staleCard.version - 1);
    await scenario.page.getByRole("button", { name: "Something else", exact: true }).click();
    await scenario.page
      .getByRole("textbox", { name: "Success meaning", exact: true })
      .fill("A stale duplicate");
    await scenario.page.getByRole("button", { name: "Confirm success", exact: true }).click();
    await expectQuestion(scenario, staleCard, "success-question");
    await expect(scenario.page.getByRole("alert")).toHaveText(
      "Plan Creation couldn’t save that. Try again.",
    );
    await expect.poll(async () => (await scenario.backend.card())?.version).toBe(staleCard.version);
    const answers = await scenario.backend.answers();
    expect(answers.map((row) => row.answer_key)).toEqual(["goal"]);
  } finally {
    await close(scenario);
  }
});
