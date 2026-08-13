import { describe, expect, it, vi } from "vitest";
import { CoachClientDisconnectedError, type CoachClient } from "@enduragent/coach-client";
import type { RuntimeConfigSnapshot } from "@enduragent/coach-contract";
import type { DesktopCoachClientProvider } from "../src/coach-client.js";
import {
  createSessionSettingsController,
  percentTextForRatio,
  type SessionSettingField,
  type SessionSettingsController,
  type SessionSettingsView,
} from "../src/settings/session-controller.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function snapshot(
  overrides: Partial<RuntimeConfigSnapshot["session"]> = {},
): RuntimeConfigSnapshot {
  return {
    schemaVersion: 3,
    llm: {
      provider: "anthropic",
      model: "claude-sonnet",
      credential_configured: true,
    },
    intervals: {
      athlete_id: "0",
      credential_configured: true,
      managedByEnvironment: { athleteId: false },
    },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "UTC",
      managedByEnvironment: {
        historyTokenBudgetRatio: false,
        idleMinutes: false,
        dailyResetHour: false,
        resetArchiveRetentionDays: false,
        timezone: false,
      },
      ...overrides,
    },
  };
}

function fakeView() {
  let handlers:
    | {
        readonly onRetry: () => void;
        readonly onChange: (field: SessionSettingField, value: string) => void;
        readonly onSave: () => void;
      }
    | undefined;
  const view: SessionSettingsView = {
    bind: vi.fn((next) => {
      handlers = next;
    }),
    render: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    view,
    retry: () => handlers?.onRetry(),
    change: (field: SessionSettingField, value: string) => handlers?.onChange(field, value),
    save: () => handlers?.onSave(),
  };
}

function clientWith(call: (method: string, request: unknown) => Promise<unknown>): CoachClient {
  return {
    handshake: {} as never,
    call,
    close: vi.fn(async () => {}),
  } as unknown as CoachClient;
}

function providerWith(client: CoachClient): DesktopCoachClientProvider {
  return {
    getClient: vi.fn(async () => client),
    reconnect: vi.fn(async () => client),
    close: vi.fn(async () => {}),
  };
}

function createSubject(input: {
  readonly client?: CoachClient;
  readonly clients?: DesktopCoachClientProvider;
  readonly beginMutation?: () => (() => void) | null;
}) {
  const subject = fakeView();
  const timezoneSaved = vi.fn(() => {});
  const client =
    input.client ??
    clientWith(async (method) => {
      if (method === "getRuntimeConfig") return snapshot();
      if (method === "configureRuntime") {
        return {
          schemaVersion: 3,
          status: "applied",
          applied: { llm: false, intervals: false, session: true },
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });
  const clients = input.clients ?? providerWith(client);
  const controller = createSessionSettingsController({
    clients,
    view: subject.view,
    beginMutation: input.beginMutation ?? (() => () => {}),
    onTimezoneSaved: timezoneSaved,
  });
  return { controller, subject, clients, client, timezoneSaved };
}

function form(controller: SessionSettingsController) {
  const state = controller.state();
  if (
    state.status !== "ready" &&
    state.status !== "refreshing" &&
    state.status !== "saving" &&
    state.status !== "saved" &&
    !(state.status === "error" && state.kind === "save")
  ) {
    throw new Error(`Expected session form state, received ${state.status}`);
  }
  return state;
}

describe("conversation and time settings controller", () => {
  it("loads all effective values and excludes environment-managed fields from edits and validation", async () => {
    const effective = snapshot({
      dailyResetHour: -4,
      managedByEnvironment: {
        historyTokenBudgetRatio: false,
        idleMinutes: false,
        dailyResetHour: true,
        resetArchiveRetentionDays: false,
        timezone: false,
      },
    });
    const call = vi.fn(async () => effective);
    const { controller, subject } = createSubject({
      client: clientWith(call),
      beginMutation: () => () => {},
    });

    await controller.activate();
    expect(form(controller)).toMatchObject({
      status: "ready",
      draft: {
        timezone: "UTC",
        dailyResetHour: "-4",
        idleMinutes: "0",
        resetArchiveRetentionDays: "0",
        historyTokenBudgetRatio: "30",
      },
      validationErrors: {},
    });

    subject.change("dailyResetHour", "9");
    expect(form(controller).draft.dailyResetHour).toBe("-4");
    expect(form(controller).dirtyFields.size).toBe(0);
  });

  it("rejects invalid values without clamping or sending a mutation", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "getRuntimeConfig") return snapshot();
      throw new Error("configure should not run");
    });
    const { controller, subject } = createSubject({ client: clientWith(call) });
    await controller.activate();

    for (const [field, value] of [
      ["timezone", "Not/AZone"],
      ["dailyResetHour", "24"],
      ["idleMinutes", "-1"],
      ["resetArchiveRetentionDays", String(Number.MAX_SAFE_INTEGER + 1)],
      ["historyTokenBudgetRatio", "0"],
    ] as const) {
      subject.change(field, value);
    }
    expect(form(controller).validationErrors).toEqual({
      timezone: "Enter a valid IANA timezone, such as Europe/London.",
      dailyResetHour: "Enter a whole hour from 0 to 23.",
      idleMinutes: "Enter a safe whole number of minutes, 0 or more.",
      resetArchiveRetentionDays: "Enter a safe whole number of days, 0 or more.",
      historyTokenBudgetRatio: "Enter a history budget above 0% and no more than 100%.",
    });
    subject.save();
    await Promise.resolve();
    expect(call).toHaveBeenCalledTimes(1);
    expect(form(controller).draft).toMatchObject({
      timezone: "Not/AZone",
      dailyResetHour: "24",
      idleMinutes: "-1",
      resetArchiveRetentionDays: String(Number.MAX_SAFE_INTEGER + 1),
      historyTokenBudgetRatio: "0",
    });
  });

  it("sends only semantically dirty fields, requires applied.session, and rereads authority", async () => {
    const calls: Array<{ readonly method: string; readonly request: unknown }> = [];
    const call = vi.fn(async (method: string, request: unknown) => {
      calls.push({ method, request });
      if (method === "configureRuntime") {
        return {
          schemaVersion: 3,
          status: "applied",
          applied: { llm: false, intervals: false, session: true },
        };
      }
      return calls.length === 1 ? snapshot() : snapshot({ idleMinutes: 45 });
    });
    const release = vi.fn();
    const beginMutation = vi.fn(() => release);
    const { controller, subject } = createSubject({
      client: clientWith(call),
      beginMutation,
    });
    await controller.activate();

    subject.change("historyTokenBudgetRatio", "30.0");
    subject.change("idleMinutes", "45");
    expect([...form(controller).dirtyFields]).toEqual(["idleMinutes"]);
    subject.save();
    await vi.waitFor(() => expect(controller.state().status).toBe("saved"));

    expect(calls).toEqual([
      { method: "getRuntimeConfig", request: {} },
      { method: "configureRuntime", request: { session: { idleMinutes: 45 } } },
      { method: "getRuntimeConfig", request: {} },
    ]);
    expect(beginMutation).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(form(controller)).toMatchObject({
      status: "saved",
      draft: { idleMinutes: "45", historyTokenBudgetRatio: "30" },
    });
    expect(form(controller).dirtyFields.size).toBe(0);
  });

  it("retains the draft when the daemon refuses to apply the session patch", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "getRuntimeConfig") return snapshot();
      return {
        schemaVersion: 3,
        status: "refused",
        reason: "managed-by-environment",
      };
    });
    const beginMutation = vi.fn(() => () => {});
    const { controller, subject } = createSubject({
      client: clientWith(call),
      beginMutation,
    });
    await controller.activate();
    subject.change("idleMinutes", "20");
    expect([...form(controller).dirtyFields]).toEqual(["idleMinutes"]);
    expect(form(controller).validationErrors).toEqual({});
    subject.save();
    expect(beginMutation).toHaveBeenCalledOnce();
    expect(controller.state().status).toBe("saving");
    await vi.waitFor(() => expect(controller.state().status).toBe("error"));

    expect(controller.state()).toMatchObject({
      status: "error",
      kind: "save",
      reason: "not-applied",
      draft: { idleMinutes: "20" },
    });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("never replays a disconnected save and reconciles the retained draft after reconnect", async () => {
    const disconnected = new CoachClientDisconnectedError(1006, "");
    const firstCall = vi.fn().mockResolvedValueOnce(snapshot()).mockRejectedValueOnce(disconnected);
    const secondCall = vi.fn(async () => snapshot({ idleMinutes: 15 }));
    const first = clientWith(firstCall);
    const second = clientWith(secondCall);
    const clients: DesktopCoachClientProvider = {
      getClient: vi.fn(async () => first),
      reconnect: vi.fn(async () => second),
      close: vi.fn(async () => {}),
    };
    const { controller, subject } = createSubject({ clients });
    await controller.activate();
    subject.change("idleMinutes", "30");
    expect([...form(controller).dirtyFields]).toEqual(["idleMinutes"]);
    expect(form(controller).validationErrors).toEqual({});
    subject.save();
    expect(controller.state().status).toBe("saving");
    await vi.waitFor(() => expect(controller.state().status).toBe("error"));
    expect(form(controller).draft.idleMinutes).toBe("30");

    subject.retry();
    await vi.waitFor(() => expect(controller.state().status).toBe("ready"));
    expect(clients.reconnect).toHaveBeenCalledOnce();
    expect(secondCall).toHaveBeenCalledExactlyOnceWith("getRuntimeConfig", {});
    expect(firstCall.mock.calls.filter(([method]) => method === "configureRuntime")).toHaveLength(
      1,
    );
    expect(secondCall).toHaveBeenCalledTimes(1);
    expect(form(controller).draft.idleMinutes).toBe("30");
    expect([...form(controller).dirtyFields]).toEqual(["idleMinutes"]);
  });

  it("does not start a save while another settings mutation owns the shell", async () => {
    const call = vi.fn(async () => snapshot());
    const { controller, subject } = createSubject({
      client: clientWith(call),
      beginMutation: () => null,
    });
    await controller.activate();
    subject.change("idleMinutes", "5");
    subject.save();
    await Promise.resolve();
    expect(call).toHaveBeenCalledExactlyOnceWith("getRuntimeConfig", {});
    expect(form(controller)).toMatchObject({
      status: "ready",
      draft: { idleMinutes: "5" },
    });
  });

  it("fences a stale load completion after the dialog closes", async () => {
    const gate = deferred<RuntimeConfigSnapshot>();
    const { controller, subject } = createSubject({
      client: clientWith(async () => gate.promise),
    });
    const pending = controller.activate();
    controller.close();
    gate.resolve(snapshot());
    await pending;
    expect(controller.state()).toEqual({ status: "closed" });
    expect(subject.view.render).toHaveBeenCalledTimes(1);
    expect(subject.view.render).toHaveBeenLastCalledWith({ status: "loading" });
  });

  it("records the athlete as the source when the saved zone equals the current host zone", async () => {
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const calls: Array<{ readonly method: string; readonly request: unknown }> = [];
    const call = vi.fn(async (method: string, request: unknown) => {
      calls.push({ method, request });
      if (method === "configureRuntime") {
        return {
          schemaVersion: 3,
          status: "applied",
          applied: { llm: false, intervals: false, session: true },
        };
      }
      return calls.length === 1 ? snapshot({ timezone: "Africa/Harare" }) : snapshot({ timezone: host });
    });
    const { controller, subject, timezoneSaved } = createSubject({ client: clientWith(call) });
    await controller.activate();

    subject.change("timezone", host);
    expect([...form(controller).dirtyFields]).toEqual(["timezone"]);
    subject.save();
    await vi.waitFor(() => expect(controller.state().status).toBe("saved"));

    expect(calls).toEqual([
      { method: "getRuntimeConfig", request: {} },
      { method: "configureRuntime", request: { session: { timezone: host } } },
      { method: "getRuntimeConfig", request: {} },
    ]);
    expect(timezoneSaved).toHaveBeenCalledOnce();
  });

  it("does not record an athlete-set source when the saved patch leaves the zone alone", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "configureRuntime") {
        return {
          schemaVersion: 3,
          status: "applied",
          applied: { llm: false, intervals: false, session: true },
        };
      }
      return snapshot();
    });
    const { controller, subject, timezoneSaved } = createSubject({ client: clientWith(call) });
    await controller.activate();

    subject.change("idleMinutes", "45");
    subject.save();
    await vi.waitFor(() => expect(controller.state().status).toBe("saved"));

    expect(timezoneSaved).not.toHaveBeenCalled();
  });

  it("keeps an unchanged displayed percentage lossless even when decimal scaling is not invertible", async () => {
    for (const ratio of [0.3, 0.3333333333333333, 0.30000000000000004, 1]) {
      const text = percentTextForRatio(ratio);
      expect(Number.isFinite(Number(text))).toBe(true);
      const call = vi.fn(async () => snapshot({ historyTokenBudgetRatio: ratio }));
      const { controller, subject } = createSubject({ client: clientWith(call) });
      await controller.activate();
      expect(form(controller).draft.historyTokenBudgetRatio).toBe(text);
      expect(form(controller).dirtyFields.size).toBe(0);
      subject.save();
      await Promise.resolve();
      expect(call).toHaveBeenCalledTimes(1);
    }
  });
});
