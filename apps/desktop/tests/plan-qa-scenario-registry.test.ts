import { createServer } from "node:net";
import { PlanReadModelSchema, PlanScenarioIdSchema } from "@enduragent/coach-contract";
import { describe, expect, it } from "vitest";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "./helpers/desktop-fixture.js";
import {
  PLAN_OWNED_SCENARIO_IDS,
  PLAN_QA_SCENARIOS,
  assertPlanQaTransition,
  createPlanQaSeedModel,
  planQaOutcomeError,
  planQaOutcomeIsRejected,
  planQaScenario,
  planQaSeedScenarioId,
  planQaTransitionResult,
  resolvePlanQaTransition,
} from "./helpers/plan-qa-scenario-registry.js";
import {
  createPlanQaFixtureModel,
  createPlanQaFixtureScript,
  createPlanQaHydratedModel,
} from "./helpers/plan-qa-live.js";

const fixtureToken = "q".repeat(43);
const hasLoopback = await new Promise<boolean>((resolveAvailability) => {
  const server = createServer();
  server.once("error", () => resolveAvailability(false));
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    server.close(() => resolveAvailability(true));
  });
});

async function waitForPlanRender(
  fixture: RunningDesktopFixture,
  scenarioId: string,
): Promise<{
  readonly rpcScenarioId: string;
  readonly rpcTransitions: readonly string[];
  readonly markers: readonly string[];
  readonly headings: readonly string[];
  readonly actions: readonly string[];
  readonly genericFallback: boolean;
}> {
  return fixture.evaluate(`
    const scenarioId = ${JSON.stringify(scenarioId)};
    const waitFor = async (read) => {
      for (let attempt = 0; attempt < 240; attempt += 1) {
        const value = await read();
        if (value) return value;
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      const visibleScenarios = [...document.querySelectorAll('[data-plan-scenario]')]
        .map((element) => element.getAttribute('data-plan-scenario'))
        .filter(Boolean)
        .join(',');
      const bodyText = document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 500);
      throw new Error(
        \`timed out waiting for rendered Plan scenario \${scenarioId}; visible=\${visibleScenarios}; body=\${bodyText}\`,
      );
    };
    const nav = await waitFor(() => document.querySelector('nav[aria-label="Main navigation"]'));
    const buttons = [...nav.querySelectorAll('button')];
    const chat = buttons.find((button) => button.textContent?.trim() === 'Chat');
    const plan = buttons.find((button) => button.textContent?.trim().startsWith('Plan'));
    if (!(chat instanceof HTMLButtonElement) || !(plan instanceof HTMLButtonElement)) {
      throw new Error('Plan fixture navigation is unavailable');
    }
    chat.click();
    plan.click();
    const result = await waitFor(async () => {
      const candidate = await window.enduragentAuth.getPlanState();
      return candidate.status === 'ready' && candidate.state.scenarioId === scenarioId
        ? candidate
        : null;
    });
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    const marker = document.querySelector(\`[data-plan-scenario="\${scenarioId}"]\`);
    const visible = (element) => {
      const style = getComputedStyle(element);
      return !element.closest('[hidden]') && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const scope = marker?.closest('.plan-view') ?? document.querySelector('.plan-view') ?? document;
    const headings = [...scope.querySelectorAll('h1,h2,h3,[role="heading"]')]
      .filter(visible)
      .map((element) => element.textContent?.replace(/\\s+/g, ' ').trim() ?? '')
      .filter(Boolean);
    const actions = [...scope.querySelectorAll('button,a[href],input[type="file"]')]
      .filter(visible)
      .map((element) => {
        const label = element.getAttribute('aria-label') ?? element.textContent ?? '';
        return label.replace(/\\s+/g, ' ').trim();
      })
      .filter(Boolean);
    return {
      rpcScenarioId: result.state.scenarioId,
      rpcTransitions: result.state.transitions.map((guard) => guard.transitionId),
      markers: [...document.querySelectorAll('[data-plan-scenario]')]
        .filter(visible)
        .map((element) => element.getAttribute('data-plan-scenario') ?? '')
        .filter(Boolean),
      headings,
      actions,
      genericFallback: document.body.textContent?.includes('Your Plan is available.') ?? false,
    };
  `);
}

describe("Plan QA scenario registry", () => {
  it("owns exactly the 104 Plan scenarios with the accepted classifications", () => {
    expect(PLAN_QA_SCENARIOS).toHaveLength(104);
    expect(new Set(PLAN_OWNED_SCENARIO_IDS).size).toBe(104);
    expect(PLAN_OWNED_SCENARIO_IDS).not.toContain("PL-S099");
    expect(
      PLAN_QA_SCENARIOS.reduce<Record<string, number>>((counts, entry) => {
        counts[entry.classification] = (counts[entry.classification] ?? 0) + 1;
        return counts;
      }, {}),
    ).toEqual({ server: 59, interaction: 23, "in-flight": 21, dimension: 1 });
    for (const entry of PLAN_QA_SCENARIOS) {
      expect(PlanScenarioIdSchema.parse(entry.id)).toBe(entry.id);
      expect(entry.name).not.toBe("");
      expect(entry.entry).not.toBe("");
      expect(entry.action).not.toBe("");
      expect(entry.accessibility).not.toBe("");
      expect(entry.recovery).not.toBe("");
      expect(entry.status).toBe("executable");
      expect(entry.expectation.visibleHeading).toBe(entry.name);
      expect(entry.expectation.visibleActions).toEqual(entry.expectedTransitions);
      expect(new Set(entry.expectedTransitions).size).toBe(entry.expectedTransitions.length);
      if (entry.expectation.retryTransitionId !== null) {
        expect(entry.expectedTransitions).toContain(entry.expectation.retryTransitionId);
      }
      if (entry.expectation.dismiss !== null) {
        expect(entry.expectedTransitions).toContain("PL-T39");
        expect(planQaScenario(entry.expectation.dismiss.destinationScenarioId).status).toBe(
          "executable",
        );
        expect(entry.expectation.dismiss.focusTarget).not.toBe("");
      }
      if (entry.expectation.providerMutation) expect(entry.expectation.localMutation).toBe(true);
    }
  });

  it("advertises only actions available on the rendered state, never its entry transition", () => {
    expect(planQaScenario("PL-S002").expectedTransitions).not.toContain("PL-T06");
    expect(planQaScenario("PL-S017").expectedTransitions).not.toContain("PL-T01");
    expect(planQaScenario("PL-S037").expectedTransitions).not.toContain("PL-T11");
    for (const entry of PLAN_QA_SCENARIOS.filter(
      (candidate) => candidate.classification === "in-flight",
    )) {
      expect(entry.entryTransitionId).not.toBeNull();
      expect(entry.expectedTransitions).toEqual([]);
      expect(entry.expectation.transient).not.toBe("none");
    }
  });

  it("keeps representative cold-state actions within production transition guards", () => {
    const productionTransitions = (id: string): string[] =>
      createPlanQaSeedModel(id).transitions.map((guard) => guard.transitionId);
    expect(planQaScenario("PL-S002").expectedTransitions).toEqual(productionTransitions("PL-S002"));
    expect(planQaScenario("PL-S003").expectedTransitions).toEqual(productionTransitions("PL-S003"));
    expect(productionTransitions("PL-S016")).toEqual(
      expect.arrayContaining([...planQaScenario("PL-S016").expectedTransitions]),
    );
    expect(productionTransitions("PL-S037")).toEqual(
      expect.arrayContaining(
        planQaScenario("PL-S037").expectedTransitions.filter(
          (transitionId) => transitionId !== "PL-T33",
        ),
      ),
    );
    expect(planQaScenario("PL-S014").expectedTransitions).toEqual(productionTransitions("PL-S014"));
  });

  it("resolves every executable action and records exact retry and dismiss recovery", () => {
    for (const entry of PLAN_QA_SCENARIOS) {
      for (const transitionId of entry.expectedTransitions) {
        if (transitionId === "PL-T39") continue;
        const result = resolvePlanQaTransition(entry.id, transitionId);
        expect(planQaScenario(result.terminalScenarioId).status).toBe("executable");
        for (const progressScenarioId of result.progressScenarioIds) {
          expect(planQaScenario(progressScenarioId).classification).toBe("in-flight");
        }
      }
      if (entry.expectation.retryTransitionId !== null) {
        const success = resolvePlanQaTransition(entry.id, entry.expectation.retryTransitionId);
        const failure = resolvePlanQaTransition(entry.id, entry.expectation.retryTransitionId, {
          outcome: "failure",
        });
        expect(planQaScenario(success.terminalScenarioId).status).toBe("executable");
        expect(planQaScenario(failure.terminalScenarioId).status).toBe("executable");
      }
      if (entry.expectation.dismiss !== null) {
        expect(
          resolvePlanQaTransition(entry.id, "PL-T39", {
            destinationScenarioId: entry.expectation.dismiss.destinationScenarioId,
          }).terminalScenarioId,
        ).toBe(entry.expectation.dismiss.destinationScenarioId);
      }
    }
  });

  it("models interaction, progress, and display scenarios from a real cold source", () => {
    for (const entry of PLAN_QA_SCENARIOS) {
      const seedId = planQaSeedScenarioId(entry.id);
      expect(planQaScenario(seedId).cold).toBe(true);
      expect(PlanReadModelSchema.parse(createPlanQaSeedModel(entry.id)).scenarioId).toBe(seedId);
    }
    expect(planQaScenario("PL-S011")).toMatchObject({
      classification: "dimension",
      sourceScenarioId: "PL-S004",
      theme: "dark",
    });
    expect(planQaScenario("PL-S010")).toMatchObject({
      classification: "server",
      sourceScenarioId: "PL-S037",
      cold: false,
    });
  });

  it("hydrates every requested Plan scenario as its exact renderer state", () => {
    for (const scenarioId of PLAN_OWNED_SCENARIO_IDS) {
      const model = PlanReadModelSchema.parse(createPlanQaHydratedModel(scenarioId));
      expect(model.scenarioId).toBe(scenarioId);
      expect(model.transitions.map((guard) => guard.transitionId)).toEqual(
        planQaScenario(scenarioId).expectedTransitions,
      );
    }
  });

  it.skipIf(process.platform !== "darwin" || !hasLoopback)(
    "smoke-renders every exact Plan scenario through the built Desktop fixture",
    async () => {
      let activeScript = createPlanQaFixtureScript("PL-S001");
      let activeScenarioId = "PL-S001";
      const switchingScript: DesktopFixtureScript = {
        onRequest: (request) => {
          const candidate = request as {
            readonly method?: unknown;
          };
          if (candidate.method === "executePlanTransition") {
            return [
              JSON.stringify({
                status: "completed",
                state: createPlanQaHydratedModel(activeScenarioId),
              }),
            ];
          }
          return activeScript.onRequest(request);
        },
      };
      const fixture = await launchDesktopFixture({
        script: switchingScript,
        token: fixtureToken,
        width: 1180,
        height: 820,
        colorScheme: "light",
        reducedMotion: true,
        hidden: true,
      });
      try {
        for (const entry of PLAN_QA_SCENARIOS) {
          activeScenarioId = entry.id;
          activeScript = createPlanQaFixtureScript(entry.id);
          const rendered = await waitForPlanRender(fixture, entry.id);
          expect(rendered.rpcScenarioId, entry.id).toBe(entry.id);
          expect(rendered.rpcTransitions, entry.id).toEqual(entry.expectedTransitions);
          if (rendered.markers.length > 0) expect(rendered.markers, entry.id).toContain(entry.id);
          expect(rendered.headings.length, entry.id).toBeGreaterThan(0);
          expect(rendered.genericFallback, entry.id).toBe(false);
          if (entry.expectedTransitions.length > 0) {
            expect(rendered.actions.length, entry.id).toBeGreaterThan(0);
          }
        }
      } finally {
        expect(await fixture.close()).toEqual({ livePids: [], listenerCount: 0 });
      }
    },
    180_000,
  );

  it("holds requested in-flight renderer states instead of completing their entry action", () => {
    const held = [
      "PL-S024",
      "PL-S033",
      "PL-S035",
      "PL-S038",
      "PL-S040",
      "PL-S047",
      "PL-S049",
      "PL-S054",
      "PL-S057",
      "PL-S064",
      "PL-S068",
      "PL-S091",
      "PL-S098",
    ] as const;
    for (const scenarioId of held) {
      expect(planQaSeedScenarioId(scenarioId)).not.toBe(scenarioId);
      expect(planQaScenario(scenarioId)).toMatchObject({
        classification: "in-flight",
        expectedTransitions: [],
      });
      expect(createPlanQaHydratedModel(scenarioId).scenarioId).toBe(scenarioId);
    }
  });

  it("hydrates the implementation-driving renderer facts without a generic fallback", () => {
    expect(createPlanQaFixtureModel("PL-S004")).toMatchObject({
      data: {
        plan: {
          phaseSummary: ["Build", "Recovery", "Taper", "Race"],
          ftpWatts: 282,
        },
        todayWorkout: {
          powerTargetW: { min: 130, max: 165 },
          cue: "Keep the pedals light.",
        },
      },
    });
    expect(createPlanQaFixtureModel("PL-S010")).toMatchObject({
      scenarioId: "PL-S010",
      reconciliation: { status: "verified", created: 5, pending: 0, failed: 0 },
    });
    expect(createPlanQaFixtureModel("PL-S028")).toMatchObject({
      scenarioId: "PL-S028",
      attention: {
        count: 2,
        destination: "list",
        items: [
          { id: "workout-match:workout-6", scenarioId: "PL-S021" },
          { id: "workout-drift:workout-3", scenarioId: "PL-S032" },
        ],
      },
    });
    for (const scenarioId of ["PL-S032", "PL-S033", "PL-S034", "PL-S035", "PL-S036"]) {
      expect(createPlanQaFixtureModel(scenarioId)).toMatchObject({
        scenarioId,
        data: {
          selectedWorkoutId: "workout-3",
          selectedWorkout: { drift: { status: "detected", eventId: "event-outside-edit" } },
        },
      });
    }
    expect(createPlanQaFixtureModel("PL-S045")).toMatchObject({
      scenarioId: "PL-S045",
      data: {
        plan: { startDate: "1998-07-15", targetDate: "1998-10-07" },
        startDate: { raceWeekday: 3, raceDayOfPlanWeek: 1 },
      },
    });
    expect(createPlanQaFixtureModel("PL-S067")).toMatchObject({
      scenarioId: "PL-S067",
      data: {
        course: {
          status: "missing-elevation",
          candidate: { elevationGainM: null, elevationStatus: "unavailable" },
        },
      },
    });
    expect(createPlanQaFixtureModel("PL-S074")).toMatchObject({
      data: { readiness: { feasibility: { verdict: "at-risk" } } },
    });
    expect(createPlanQaFixtureModel("PL-S075")).toMatchObject({
      data: { readiness: { courseEstimate: { status: "unavailable" } } },
    });
    expect(createPlanQaFixtureModel("PL-S076")).toMatchObject({
      data: { readiness: { form: { status: "unavailable" } } },
    });
    expect(createPlanQaFixtureModel("PL-S077")).toMatchObject({
      data: { readiness: { courseEstimate: { status: "changed" } } },
    });
    expect(createPlanQaFixtureModel("PL-S078")).toMatchObject({
      data: { readiness: { taperRefusal: { kept: "Race opener · 0:30" } } },
    });
    expect(createPlanQaFixtureModel("PL-S094")).toMatchObject({
      lifecycle: "ended",
      data: { outcomeAvailable: true },
    });
    expect(createPlanQaFixtureModel("PL-S014")).toMatchObject({
      data: {
        raceOutcome: "completed",
        raceOutcomeDetails: { outcome: "completed", result: "Front third" },
      },
    });
    expect(createPlanQaFixtureModel("PL-S096")).toMatchObject({
      data: {
        raceOutcome: "not-completed",
        raceOutcomeDetails: { outcome: "not-completed", raceDate: "1998-10-04" },
      },
    });
    expect(createPlanQaFixtureModel("PL-S100")).toMatchObject({
      data: { weeklyReview: { status: "delivered", id: "weekly-review-qa" } },
    });
    expect(createPlanQaFixtureModel("PL-S101")).toMatchObject({
      data: { selectedHistoryId: "history-adjustment" },
    });
  });

  it("opens the exact item selected from the multi-item attention list", () => {
    expect(
      resolvePlanQaTransition("PL-S028", "PL-T34", {
        attentionId: "workout-match:workout-6",
      }),
    ).toEqual({ progressScenarioIds: [], terminalScenarioId: "PL-S021" });
    expect(
      resolvePlanQaTransition("PL-S028", "PL-T34", {
        attentionId: "workout-drift:workout-3",
      }),
    ).toEqual({ progressScenarioIds: [], terminalScenarioId: "PL-S032" });
  });

  it("completes a scripted Plan coach turn instead of leaving the composer busy", async () => {
    const script = createPlanQaFixtureScript();
    await script.onRequest({
      jsonrpc: "2.0",
      method: "executePlanTransition",
      params: {
        transitionId: "PL-T01",
        commandId: "start-coach",
        sourceConversationId: null,
      },
    });
    const frames = await script.onRequest({
      jsonrpc: "2.0",
      method: "executePlanTransition",
      params: {
        transitionId: "PL-T05",
        commandId: "coach-command",
        conversationId: "00000000000000000000000001",
        text: "I can train four days each week.",
      },
    });
    const parsed = frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
    expect(parsed).toHaveLength(3);
    expect(parsed.slice(0, 2).map((frame) => frame.event)).toMatchObject([
      { turnEvent: { type: "turn-start" } },
      { turnEvent: { type: "final-text" } },
    ]);
    const terminal = parsed.at(-1) as {
      readonly status: string;
      readonly state: { readonly data: { readonly messages: readonly unknown[] } };
    };
    expect(terminal.status).toBe("completed");
    expect(terminal.state.data.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "athlete", text: "I can train four days each week." }),
        expect.objectContaining({
          role: "coach",
          text: "Thanks — I have that. What else should we update?",
        }),
      ]),
    );
  });

  it("returns accepted FTP to the ready Plan coach on the adapter refresh", async () => {
    const script = createPlanQaFixtureScript("PL-S003");
    const acceptedFrames = await script.onRequest({
      jsonrpc: "2.0",
      method: "executePlanTransition",
      params: {
        transitionId: "PL-T04",
        commandId: "save-ftp",
        conversationId: "00000000000000000000000001",
        source: "manual",
        watts: 282,
      },
    });
    expect(JSON.parse(acceptedFrames.at(-1)!) as unknown).toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S062" },
    });

    const refreshedFrames = await script.onRequest({
      jsonrpc: "2.0",
      method: "getPlanState",
      params: {},
    });
    expect(JSON.parse(refreshedFrames.at(-1)!) as unknown).toMatchObject({
      status: "ready",
      state: {
        scenarioId: "PL-S016",
        data: { readyToCreateDraft: true, course: { status: "omitted" } },
      },
    });
  });

  it("returns a scripted Proposal drawer to its exact active source and focus target", async () => {
    const script = createPlanQaFixtureScript("PL-S010");
    const selectedProposalReturn = {
      sourceScenarioId: "PL-S010",
      returnFocusId: "workout-row-workout-6",
    };
    const openedFrames = await script.onRequest({
      jsonrpc: "2.0",
      method: "executePlanTransition",
      params: {
        transitionId: "PL-T17",
        commandId: "open-proposal",
        planId: "plan-qa",
        proposalId: "proposal-qa",
        selectedProposalReturn,
      },
    });
    expect(JSON.parse(openedFrames.at(-1)!) as unknown).toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S007",
        data: { selectedProposalReturn },
      },
    });

    const closedFrames = await script.onRequest({
      jsonrpc: "2.0",
      method: "executePlanTransition",
      params: {
        transitionId: "PL-T39",
        commandId: "close-proposal",
        action: "back",
        sourceScenarioId: "PL-S007",
        destinationScenarioId: "PL-S010",
        returnFocusId: "workout-row-workout-6",
        selectedProposalReturn,
      },
    });
    expect(JSON.parse(closedFrames.at(-1)!) as unknown).toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S010",
        data: { returnFocusId: "workout-row-workout-6" },
      },
    });
  });

  it("returns a scripted attention drawer to the exact attention item", async () => {
    const script = createPlanQaFixtureScript("PL-S028");
    const attentionId = "workout-match:workout-6";
    const openedFrames = await script.onRequest({
      jsonrpc: "2.0",
      method: "executePlanTransition",
      params: {
        transitionId: "PL-T34",
        commandId: "open-attention",
        attentionId,
      },
    });
    expect(JSON.parse(openedFrames.at(-1)!) as unknown).toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S021",
        data: {
          selectedWorkoutId: "workout-6",
          selectedWorkoutSourceScenarioId: "PL-S028",
        },
      },
    });

    const closedFrames = await script.onRequest({
      jsonrpc: "2.0",
      method: "executePlanTransition",
      params: {
        transitionId: "PL-T39",
        commandId: "close-attention",
        action: "back",
        sourceScenarioId: "PL-S021",
        destinationScenarioId: "PL-S028",
        returnFocusId: `plan-attention-${attentionId}`,
      },
    });
    expect(JSON.parse(closedFrames.at(-1)!) as unknown).toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S028",
        data: { returnFocusId: `plan-attention-${attentionId}` },
      },
    });
  });

  it("executes the local approval and reconciliation chain without skipping the local state", () => {
    expect(resolvePlanQaTransition("PL-S002", "PL-T11")).toEqual({
      progressScenarioIds: [],
      terminalScenarioId: "PL-S037",
    });
    expect(resolvePlanQaTransition("PL-S037", "PL-T12")).toEqual({
      progressScenarioIds: ["PL-S038"],
      terminalScenarioId: "PL-S043",
    });
    expect(resolvePlanQaTransition("PL-S039", "PL-T12", { outcome: "repeated-failure" })).toEqual({
      progressScenarioIds: ["PL-S040"],
      terminalScenarioId: "PL-S041",
    });
    expect(resolvePlanQaTransition("PL-S053", "PL-T24")).toEqual({
      progressScenarioIds: ["PL-S052", "PL-S054"],
      terminalScenarioId: "PL-S056",
    });
  });

  it("rejects failed mutating operations without replacing their durable source state", () => {
    const cases = [
      ["PL-S016", "PL-T06", "PL-S016"],
      ["PL-S103", "PL-T06", "PL-S103"],
      ["PL-S002", "PL-T07", "PL-S002"],
      ["PL-S002", "PL-T11", "PL-S002"],
      ["PL-S032", "PL-T15", "PL-S032"],
      ["PL-S032", "PL-T16", "PL-S032"],
      ["PL-S007", "PL-T18", "PL-S007"],
      ["PL-S095", "PL-T30", "PL-S095"],
    ] as const;
    for (const outcome of ["failure", "repeated-failure", "validation"] as const) {
      expect(planQaOutcomeIsRejected(outcome)).toBe(true);
      expect(planQaOutcomeError(outcome).message).not.toBe("");
      expect(planQaTransitionResult(outcome, createPlanQaSeedModel("PL-S002"))).toMatchObject({
        status: "rejected",
        state: { scenarioId: "PL-S002" },
      });
      for (const [sourceScenarioId, transitionId, recoveryScenarioId] of cases) {
        expect(resolvePlanQaTransition(sourceScenarioId, transitionId, { outcome })).toEqual({
          progressScenarioIds: [],
          terminalScenarioId: recoveryScenarioId,
        });
      }
    }
    expect(planQaOutcomeIsRejected("success")).toBe(false);
    expect(planQaOutcomeIsRejected("not-completed")).toBe(false);
    expect(planQaTransitionResult("success", createPlanQaSeedModel("PL-S002"))).toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S002" },
    });
  });

  it("keeps Back destinations exact and rejects unknown scenarios or transitions", () => {
    expect(resolvePlanQaTransition("PL-S021", "PL-T14").terminalScenarioId).toBe("PL-S004");
    expect(
      resolvePlanQaTransition("PL-S021", "PL-T39", { destinationScenarioId: "PL-S004" })
        .terminalScenarioId,
    ).toBe("PL-S004");
    expect(() => planQaScenario("PL-S099")).toThrow("unknown Plan-owned QA Scenario");
    expect(() => planQaScenario("PL-S999")).toThrow("unknown Plan-owned QA Scenario");
    expect(() => assertPlanQaTransition("PL-S001", "PL-T22")).toThrow("unexpected PL-T22");
    expect(() => assertPlanQaTransition("PL-S001", "PL-T99")).toThrow("unknown Plan transition");
    expect(() => resolvePlanQaTransition("PL-S021", "PL-T39")).toThrow("destinationScenarioId");
  });

  it("keeps an incomplete interview in coach until intake and Course choice are ready", () => {
    expect(resolvePlanQaTransition("PL-S017", "PL-T05")).toEqual({
      progressScenarioIds: [],
      terminalScenarioId: "PL-S017",
    });
    expect(
      resolvePlanQaTransition("PL-S017", "PL-T05", {
        intakeStatus: "ready",
        courseChoice: "undecided",
      }),
    ).toMatchObject({ terminalScenarioId: "PL-S017" });
    expect(
      resolvePlanQaTransition("PL-S017", "PL-T05", {
        intakeStatus: "ready",
        courseChoice: "resolved",
      }),
    ).toMatchObject({ terminalScenarioId: "PL-S016" });
    expect(
      resolvePlanQaTransition("PL-S079", "PL-T05", {
        intakeStatus: "ready",
        courseChoice: "resolved",
      }),
    ).toMatchObject({ terminalScenarioId: "PL-S103" });
    expect(
      resolvePlanQaTransition("PL-S017", "PL-T03", { intakeStatus: "incomplete" }),
    ).toMatchObject({ terminalScenarioId: "PL-S017" });
    expect(resolvePlanQaTransition("PL-S017", "PL-T03", { intakeStatus: "ready" })).toMatchObject({
      terminalScenarioId: "PL-S016",
    });
  });

  it("validates the accepted Plan coach close destinations", () => {
    expect(
      resolvePlanQaTransition("PL-S017", "PL-T39", { destinationScenarioId: "PL-S001" }),
    ).toMatchObject({ terminalScenarioId: "PL-S001" });
    expect(
      resolvePlanQaTransition("PL-S079", "PL-T39", { destinationScenarioId: "PL-S004" }),
    ).toMatchObject({ terminalScenarioId: "PL-S004" });
    expect(() =>
      resolvePlanQaTransition("PL-S017", "PL-T39", { destinationScenarioId: "PL-S004" }),
    ).toThrow("invalid PL-T39 destination");
    expect(() =>
      resolvePlanQaTransition("PL-S079", "PL-T39", { destinationScenarioId: "PL-S001" }),
    ).toThrow("invalid PL-T39 destination");
  });

  it("uses the accepted Course choice and short-block date facts in production-built seeds", () => {
    const ready = createPlanQaSeedModel("PL-S016");
    expect(ready.data).toMatchObject({
      readyToCreateDraft: true,
      course: { status: "omitted" },
    });
    expect(planQaSeedScenarioId("PL-S050")).toBe("PL-S002");
    expect(resolvePlanQaTransition("PL-S002", "PL-T08").terminalScenarioId).toBe("PL-S050");
  });

  it("renders the Course-aware Draft with the accepted attached Course", () => {
    expect(createPlanQaFixtureModel("PL-S070")).toMatchObject({
      scenarioId: "PL-S070",
      projection: "draft",
      data: {
        course: {
          status: "ready",
          accepted: {
            fileName: "gran-fondo-almaty.gpx",
            format: "gpx",
            distanceM: 120_000,
            elevationGainM: 1_850,
          },
        },
      },
    });
  });
});
