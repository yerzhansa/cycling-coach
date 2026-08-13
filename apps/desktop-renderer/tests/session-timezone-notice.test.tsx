import type { CoachClient } from "@enduragent/coach-client";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopCoachClientProvider } from "../src/coach-client.js";
import {
  createSessionTimezoneNoticeController,
  type SessionTimezoneBridge,
} from "../src/session-timezone.js";
import { useEnduragentStore } from "../src/state/store.js";
import { TimezoneNoticeCard } from "../src/ui/chat/TimezoneNoticeCard.js";

const HARARE = "Africa/Harare";
const QYZYLORDA = "Asia/Qyzylorda";

function providerWith(call: (method: string, request: unknown) => Promise<unknown>): {
  readonly clients: DesktopCoachClientProvider;
  readonly calls: Array<{ readonly method: string; readonly request: unknown }>;
} {
  const calls: Array<{ method: string; request: unknown }> = [];
  const client = {
    handshake: {} as never,
    call: async (method: string, request: unknown) => {
      calls.push({ method, request });
      return call(method, request);
    },
    close: vi.fn(async () => {}),
  } as unknown as CoachClient;
  return {
    clients: {
      getClient: vi.fn(async () => client),
      reconnect: vi.fn(async () => client),
      close: vi.fn(async () => {}),
    },
    calls,
  };
}

function appliedSession(): unknown {
  return {
    schemaVersion: 3,
    status: "applied",
    applied: { llm: false, intervals: false, session: true },
  };
}

function createSubject(input: {
  readonly notice: DesktopSessionTimezoneNotice;
  readonly recorded?: boolean;
}) {
  const records: DesktopSessionTimezoneSource[] = [];
  const bridge: SessionTimezoneBridge = {
    sessionTimezoneNotice: async () => input.notice,
    recordSessionTimezoneSource: async (source) => {
      records.push(source);
      return input.recorded ?? true;
    },
  };
  const provider = providerWith(async () => appliedSession());
  const controller = createSessionTimezoneNoticeController({
    bridge,
    clients: provider.clients,
    view: { render: (next) => useEnduragentStore.getState().setSessionTimezoneNotice(next) },
  });
  useEnduragentStore.getState().bindSessionTimezoneActions({
    keepStored: () => controller.keepStored(),
    useHost: () => controller.useHost(),
  });
  return { controller, records, calls: provider.calls };
}

describe("session timezone reconciliation notice", () => {
  beforeEach(() => {
    useEnduragentStore.getState().setSessionTimezoneNotice({ status: "hidden" });
    useEnduragentStore.getState().bindSessionTimezoneActions(null);
  });

  afterEach(() => {
    cleanup();
    useEnduragentStore.getState().setSessionTimezoneNotice({ status: "hidden" });
    useEnduragentStore.getState().bindSessionTimezoneActions(null);
  });

  it("shows the notice once and records user when the athlete keeps the stored zone", async () => {
    const subject = createSubject({
      notice: { status: "reconcile", stored: HARARE, host: QYZYLORDA },
    });
    render(<TimezoneNoticeCard />);
    await act(async () => {
      await subject.controller.start();
    });

    expect(screen.getByRole("heading", { name: `This computer says ${QYZYLORDA}` })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: `Keep ${HARARE}` }));

    await waitFor(() => {
      expect(subject.records).toEqual(["user"]);
    });
    expect(subject.calls).toEqual([]);
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: /This computer says/ })).toBeNull();
    });
  });

  it("adopts the host zone through the runtime and records auto when the athlete matches the computer", async () => {
    const subject = createSubject({
      notice: { status: "reconcile", stored: HARARE, host: QYZYLORDA },
    });
    render(<TimezoneNoticeCard />);
    await act(async () => {
      await subject.controller.start();
    });

    await userEvent.click(screen.getByRole("button", { name: `Use ${QYZYLORDA}` }));

    await waitFor(() => {
      expect(subject.records).toEqual(["auto"]);
    });
    expect(subject.calls).toEqual([
      { method: "configureRuntime", request: { session: { timezone: QYZYLORDA } } },
    ]);
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: /This computer says/ })).toBeNull();
    });
  });

  it("renders no notice when the main process reports nothing to reconcile", async () => {
    const subject = createSubject({ notice: { status: "none" } });
    render(<TimezoneNoticeCard />);
    await act(async () => {
      await subject.controller.start();
    });

    expect(screen.queryByRole("heading", { name: /This computer says/ })).toBeNull();
    expect(subject.records).toEqual([]);
  });

  it("renders the secondary action before the primary one", async () => {
    const subject = createSubject({
      notice: { status: "reconcile", stored: HARARE, host: QYZYLORDA },
    });
    render(<TimezoneNoticeCard />);
    await act(async () => {
      await subject.controller.start();
    });

    const labels = screen.getAllByRole("button").map((button) => button.textContent);
    expect(labels).toEqual([`Keep ${HARARE}`, `Use ${QYZYLORDA}`]);
  });
});
