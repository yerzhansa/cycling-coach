import { describe, expect, it, vi } from "vitest";
import type {
  ChatQueueRunResult,
  ChatQueueSnapshot,
  CoachTurnEventNotificationEnvelope,
  TurnEvent,
} from "@enduragent/coach-contract";
import type { CoachClient, CoachClientCallOptions } from "@enduragent/coach-client";
import {
  CHAT_QUEUE_REMOVE_FAILURE_COPY,
  createChatController,
  type ChatViewControls,
} from "../src/chat/controller.js";
import type { DesktopCoachClientProvider } from "../src/coach-client.js";
import type { ChatState } from "../src/turn-state.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function notification(
  method: "resumeChatQueue" | "runQueuedCommand" | "retryQueuedTurn",
  event: TurnEvent,
): CoachTurnEventNotificationEnvelope {
  return {
    jsonrpc: "2.0",
    method: "coach.turnEvent",
    params: { requestId: 1, requestMethod: method, turnId: event.turnId, event },
  };
}

function deliver(
  method: "resumeChatQueue" | "runQueuedCommand" | "retryQueuedTurn",
  options: CoachClientCallOptions<"chat">,
  event: TurnEvent,
): void {
  options.onNotificationEnvelope?.(notification(method, event));
  options.onEvent?.(event);
}

function harness(client: CoachClient, canChat: () => boolean = () => true) {
  const states: ChatState[] = [];
  const controls: ChatViewControls[] = [];
  const provider: DesktopCoachClientProvider = {
    getClient: vi.fn(async () => client),
    reconnect: vi.fn(async () => client),
    close: vi.fn(async () => {}),
  };
  const controller = createChatController({
    clients: provider,
    view: {
      render: (state, nextControls) => {
        states.push(structuredClone(state));
        if (nextControls !== undefined) controls.push(structuredClone(nextControls));
      },
    },
    refreshTrainingContext: async () => {},
    refreshSpend: async () => {},
    canChat,
  });
  return { controller, states, controls };
}

describe("durable chat queue controller", () => {
  it("projects neither a queue row nor athlete text before durable enqueue acknowledgment", async () => {
    const enqueue = deferred<ChatQueueSnapshot>();
    const run = deferred<ChatQueueRunResult>();
    let runOptions: CoachClientCallOptions<"chat"> | undefined;
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method, _request, options) => {
        if (method === "enqueueChatMessage") return enqueue.promise as never;
        if (method === "resumeChatQueue") {
          runOptions = options as CoachClientCallOptions<"chat">;
          return run.promise as never;
        }
        if (method === "getCoachDecision") return Promise.resolve({ decision: null }) as never;
        if (method === "hasSession") return Promise.resolve({ hasSession: false }) as never;
        if (method === "getChatQueue")
          return Promise.resolve({ schemaVersion: 1, revision: 0, items: [] }) as never;
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller, states } = harness(client);
    await controller.start();
    const submission = controller.submit("Hello");
    await Promise.resolve();
    expect(states.at(-1)?.queued).toEqual([]);
    expect(states.at(-1)?.messages).toEqual([]);

    enqueue.resolve({
      schemaVersion: 1,
      revision: 1,
      items: [
        {
          queuedMessageId: "queued-1",
          submissionId: "submission-1",
          text: "Hello",
          kind: "ordinary",
          position: 0,
          restored: false,
        },
      ],
    });
    await vi.waitFor(() => expect(runOptions).toBeDefined());
    expect(states.at(-1)?.messages).toMatchObject([
      { role: "athlete", text: "Hello" },
      { role: "coach" },
    ]);
    expect(states.at(-1)?.queued).toHaveLength(1);

    const start = { type: "turn-start", turnId: "turn-1", chatId: "desktop" } as const;
    const final = { type: "final-text", turnId: "turn-1", text: "Hi" } as const;
    deliver("resumeChatQueue", runOptions!, start);
    expect(states.at(-1)?.queued).toEqual([]);
    expect(states.at(-1)?.messages.filter((message) => message.role === "athlete")).toHaveLength(1);
    deliver("resumeChatQueue", runOptions!, final);
    runOptions!.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: {} });
    run.resolve({
      snapshot: { schemaVersion: 1, revision: 2, items: [] },
      response: { text: "Hi" },
    });
    await submission;
    await vi.waitFor(() => expect(states.at(-1)?.queued).toEqual([]));
    expect(states.at(-1)?.queued).toEqual([]);
    expect(states.at(-1)?.messages).toMatchObject([
      { role: "athlete", text: "Hello" },
      { role: "coach", text: "Hi", delivery: "complete" },
    ]);
  });

  it("uses collision-resistant submission ids across renderer relaunches", async () => {
    const submissionIds: string[] = [];
    let revision = 0;
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn(async (method, request, options) => {
        if (method === "enqueueChatMessage") {
          const input = request as { submissionId: string; text: string };
          submissionIds.push(input.submissionId);
          revision += 1;
          return {
            schemaVersion: 1,
            revision,
            items: [
              {
                queuedMessageId: `queued-${revision}`,
                submissionId: input.submissionId,
                text: input.text,
                kind: "ordinary",
                position: 0,
                restored: false,
              },
            ],
          } as never;
        }
        if (method === "resumeChatQueue") {
          (options as CoachClientCallOptions<"chat">).onTerminalEnvelope?.({
            jsonrpc: "2.0",
            id: revision,
            result: {},
          });
          return {
            snapshot: { schemaVersion: 1, revision, items: [] },
          } as never;
        }
        if (method === "getCoachDecision") return { decision: null } as never;
        if (method === "hasSession") return { hasSession: false } as never;
        if (method === "getChatQueue") return { schemaVersion: 1, revision, items: [] } as never;
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const first = harness(client).controller;
    await first.start();
    await first.submit("First launch");
    const second = harness(client).controller;
    await second.start();
    await second.submit("Second launch");
    expect(submissionIds).toHaveLength(2);
    expect(submissionIds[0]).not.toBe(submissionIds[1]);
    expect(submissionIds.every((id) => /^[0-9a-f-]{36}$/u.test(id))).toBe(true);
  });

  it("holds restored commands for Run command and ignores stale snapshots", async () => {
    const restored: ChatQueueSnapshot = {
      schemaVersion: 1,
      revision: 4,
      items: [
        {
          queuedMessageId: "command-1",
          submissionId: "submission-1",
          text: "/review",
          kind: "slash-command",
          position: 0,
          restored: true,
        },
      ],
    };
    const calls: string[] = [];
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn(async (method, _request, options) => {
        calls.push(method);
        if (method === "getCoachDecision") return { decision: null } as never;
        if (method === "hasSession") return { hasSession: false } as never;
        if (method === "getChatQueue") return restored as never;
        if (method === "runQueuedCommand") {
          const stream = options as CoachClientCallOptions<"chat">;
          deliver("runQueuedCommand", stream, {
            type: "turn-start",
            turnId: "turn-2",
            chatId: "desktop",
          });
          deliver("runQueuedCommand", stream, {
            type: "final-text",
            turnId: "turn-2",
            text: "Review",
          });
          stream.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 2, result: {} });
          return {
            snapshot: { schemaVersion: 1, revision: 5, items: [] },
            response: { text: "Review" },
          } as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller, states } = harness(client);
    await controller.resume();
    expect(calls).not.toContain("resumeChatQueue");
    expect(states.at(-1)?.queued).toMatchObject([{ id: "command-1", restored: true }]);

    await controller.runQueuedCommand("command-1");
    expect(calls).toContain("runQueuedCommand");
    expect(states.at(-1)?.queued).toEqual([]);
  });

  it("auto-resumes restored ordinary work and discards a blocked no-response run", async () => {
    const queued: ChatQueueSnapshot = {
      schemaVersion: 1,
      revision: 1,
      items: [
        {
          queuedMessageId: "queued-1",
          submissionId: "submission-1",
          text: "Restored",
          kind: "ordinary",
          position: 0,
          restored: true,
        },
      ],
    };
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn(async (method, _request, options) => {
        if (method === "getCoachDecision") return { decision: null } as never;
        if (method === "hasSession") return { hasSession: true } as never;
        if (method === "getChatQueue") return queued as never;
        if (method === "resumeChatQueue") {
          (options as CoachClientCallOptions<"chat">).onTerminalEnvelope?.({
            jsonrpc: "2.0",
            id: 1,
            result: {},
          });
          return { snapshot: queued } as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller, states } = harness(client);
    await controller.start();
    expect(vi.mocked(client.call).mock.calls.some(([method]) => method === "resumeChatQueue")).toBe(
      true,
    );
    expect(states.at(-1)?.status).toBe("idle");
    expect(states.at(-1)?.messages).toEqual([]);
    expect(states.at(-1)?.queued).toMatchObject([{ text: "Restored" }]);
  });

  it("blocks Send after queue hydration fails and recovers through reconnect retry", async () => {
    let queueReads = 0;
    let enqueueCalls = 0;
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn(async (method, request, options) => {
        if (method === "getCoachDecision") return { decision: null } as never;
        if (method === "hasSession") return { hasSession: false } as never;
        if (method === "getChatQueue") {
          queueReads += 1;
          if (queueReads === 1) throw new Error("transient queue read failure");
          return { schemaVersion: 1, revision: 0, items: [] } as never;
        }
        if (method === "enqueueChatMessage") {
          enqueueCalls += 1;
          const input = request as { submissionId: string; text: string };
          return {
            schemaVersion: 1,
            revision: 1,
            items: [
              {
                queuedMessageId: "queued-1",
                submissionId: input.submissionId,
                text: input.text,
                kind: "ordinary",
                position: 0,
                restored: false,
              },
            ],
          } as never;
        }
        if (method === "resumeChatQueue") {
          (options as CoachClientCallOptions<"chat">).onTerminalEnvelope?.({
            jsonrpc: "2.0",
            id: 1,
            result: {},
          });
          return { snapshot: { schemaVersion: 1, revision: 1, items: [] } } as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller } = harness(client);
    await controller.start();
    await expect(controller.submit("Blocked")).resolves.toBe(false);
    expect(enqueueCalls).toBe(0);
    await controller.retryDecision();
    await expect(controller.submit("Allowed")).resolves.toBe(true);
    expect(enqueueCalls).toBe(1);
  });

  it("keeps a queued row visible until durable removal is acknowledged", async () => {
    const removal = deferred<ChatQueueSnapshot>();
    const queued: ChatQueueSnapshot = {
      schemaVersion: 1,
      revision: 1,
      items: [
        {
          queuedMessageId: "command-1",
          submissionId: "submission-1",
          text: "/review",
          kind: "slash-command",
          position: 0,
          restored: true,
        },
      ],
    };
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method) => {
        if (method === "getCoachDecision") return Promise.resolve({ decision: null }) as never;
        if (method === "hasSession") return Promise.resolve({ hasSession: true }) as never;
        if (method === "getChatQueue") return Promise.resolve(queued) as never;
        if (method === "removeQueuedChatMessage") return removal.promise as never;
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller, states } = harness(client);
    await controller.start();

    controller.removeQueued("command-1");
    expect(states.at(-1)?.queued).toMatchObject([{ id: "command-1" }]);

    removal.resolve({ schemaVersion: 1, revision: 2, items: [] });
    await vi.waitFor(() => expect(states.at(-1)?.queued).toEqual([]));
  });

  it("keeps a queued row and reports visible feedback when durable removal fails", async () => {
    const queued: ChatQueueSnapshot = {
      schemaVersion: 1,
      revision: 1,
      items: [
        {
          queuedMessageId: "command-1",
          submissionId: "submission-1",
          text: "/review",
          kind: "slash-command",
          position: 0,
          restored: true,
        },
      ],
    };
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn(async (method) => {
        if (method === "getCoachDecision") return { decision: null } as never;
        if (method === "hasSession") return { hasSession: true } as never;
        if (method === "getChatQueue") return queued as never;
        if (method === "removeQueuedChatMessage") throw new Error("storage unavailable");
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller, states, controls } = harness(client);
    await controller.start();

    controller.removeQueued("command-1");
    await vi.waitFor(() =>
      expect(controls.at(-1)?.queueMutationError).toBe(CHAT_QUEUE_REMOVE_FAILURE_COPY),
    );
    expect(states.at(-1)?.queued).toMatchObject([{ id: "command-1" }]);
  });

  it("shows a message queued during streaming and dispatches it exactly once after success", async () => {
    const firstRun = deferred<ChatQueueRunResult>();
    const secondRun = deferred<ChatQueueRunResult>();
    let firstOptions: CoachClientCallOptions<"chat"> | undefined;
    let secondOptions: CoachClientCallOptions<"chat"> | undefined;
    const first = {
      queuedMessageId: "queued-1",
      submissionId: "submission-1",
      text: "First",
      kind: "ordinary" as const,
      position: 0,
      restored: false,
    };
    const later = {
      queuedMessageId: "queued-2",
      submissionId: "submission-2",
      text: "Later",
      kind: "ordinary" as const,
      position: 1,
      restored: false,
    };
    let enqueueCount = 0;
    let runCount = 0;
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method, _request, options) => {
        if (method === "getCoachDecision") return Promise.resolve({ decision: null }) as never;
        if (method === "hasSession") return Promise.resolve({ hasSession: false }) as never;
        if (method === "getChatQueue")
          return Promise.resolve({ schemaVersion: 1, revision: 0, items: [] }) as never;
        if (method === "enqueueChatMessage") {
          enqueueCount += 1;
          return Promise.resolve(
            enqueueCount === 1
              ? { schemaVersion: 1, revision: 1, items: [first] }
              : { schemaVersion: 1, revision: 2, items: [first, later] },
          ) as never;
        }
        if (method === "resumeChatQueue") {
          runCount += 1;
          if (runCount === 1) {
            firstOptions = options as CoachClientCallOptions<"chat">;
            return firstRun.promise as never;
          }
          secondOptions = options as CoachClientCallOptions<"chat">;
          return secondRun.promise as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller, states } = harness(client);
    await controller.start();

    await expect(controller.submit("First")).resolves.toBe(true);
    await vi.waitFor(() => expect(firstOptions).toBeDefined());
    deliver("resumeChatQueue", firstOptions!, {
      type: "turn-start",
      turnId: "turn-1",
      chatId: "desktop",
    });

    await expect(controller.submit("Later")).resolves.toBe(true);
    expect(states.at(-1)?.queued.map((item) => item.text)).toEqual(["Later"]);
    expect(runCount).toBe(1);

    deliver("resumeChatQueue", firstOptions!, {
      type: "final-text",
      turnId: "turn-1",
      text: "First reply",
    });
    firstOptions!.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: {} });
    firstRun.resolve({
      snapshot: { schemaVersion: 1, revision: 3, items: [later] },
      response: { text: "First reply" },
    });

    await vi.waitFor(() => expect(secondOptions).toBeDefined());
    expect(runCount).toBe(2);
    deliver("resumeChatQueue", secondOptions!, {
      type: "turn-start",
      turnId: "turn-2",
      chatId: "desktop",
    });
    deliver("resumeChatQueue", secondOptions!, {
      type: "final-text",
      turnId: "turn-2",
      text: "Later reply",
    });
    secondOptions!.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 2, result: {} });
    secondRun.resolve({
      snapshot: { schemaVersion: 1, revision: 4, items: [] },
      response: { text: "Later reply" },
    });

    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("idle"));
    expect(states.at(-1)?.queued).toEqual([]);
    expect(states.at(-1)?.messages.map((message) => [message.role, message.text])).toEqual([
      ["athlete", "First"],
      ["coach", "First reply"],
      ["athlete", "Later"],
      ["coach", "Later reply"],
    ]);
    expect(
      vi.mocked(client.call).mock.calls.filter(([method]) => method === "resumeChatQueue"),
    ).toHaveLength(2);
  });

  it("keeps a claimed head hidden when enqueue acknowledges a full durable snapshot", async () => {
    const run = deferred<ChatQueueRunResult>();
    let options: CoachClientCallOptions<"chat"> | undefined;
    const head = {
      queuedMessageId: "queued-1",
      submissionId: "submission-1",
      text: "First",
      kind: "ordinary" as const,
      position: 0,
      restored: true,
    };
    const later = {
      queuedMessageId: "queued-2",
      submissionId: "submission-2",
      text: "Later",
      kind: "ordinary" as const,
      position: 1,
      restored: false,
    };
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method, _request, callOptions) => {
        if (method === "getCoachDecision") return Promise.resolve({ decision: null }) as never;
        if (method === "hasSession") return Promise.resolve({ hasSession: true }) as never;
        if (method === "getChatQueue")
          return Promise.resolve({ schemaVersion: 1, revision: 1, items: [head] }) as never;
        if (method === "resumeChatQueue") {
          options = callOptions as CoachClientCallOptions<"chat">;
          return run.promise as never;
        }
        if (method === "enqueueChatMessage")
          return Promise.resolve({
            schemaVersion: 1,
            revision: 2,
            items: [head, later],
          }) as never;
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller, states } = harness(client);
    const active = controller.resume();
    await vi.waitFor(() => expect(options).toBeDefined());
    deliver("resumeChatQueue", options!, {
      type: "turn-start",
      turnId: "turn-1",
      chatId: "desktop",
    });
    expect(states.at(-1)?.queued).toEqual([]);

    await expect(controller.submit("Later")).resolves.toBe(true);
    expect(states.at(-1)?.queued.map((item) => item.id)).toEqual(["queued-2"]);
    expect(states.at(-1)?.activeQueueClaimIds).toEqual(["queued-1"]);
    expect(states.at(-1)?.messages.filter((message) => message.role === "athlete")).toHaveLength(1);

    deliver("resumeChatQueue", options!, {
      type: "interrupted",
      turnId: "turn-1",
      chatId: "desktop",
      text: "Partial",
    });
    options!.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: {} });
    run.resolve({
      snapshot: {
        schemaVersion: 1,
        revision: 3,
        items: [head, later],
        retryRequired: {
          claimId: "claim-1",
          queuedMessageIds: ["queued-1"],
          turnId: "turn-1",
          status: "retry-required",
        },
      },
      response: { text: "Partial" },
    });
    await active;
    expect(states.at(-1)?.queued.map((item) => item.id)).toEqual(["queued-1", "queued-2"]);
    expect(states.at(-1)?.activeQueueClaimIds).toEqual([]);
    expect(states.at(-1)?.messages.filter((message) => message.role === "athlete")).toHaveLength(1);
  });

  it("keeps later messages queued when Stop creates retry-required recovery", async () => {
    const run = deferred<ChatQueueRunResult>();
    let options: CoachClientCallOptions<"chat"> | undefined;
    const items = [
      {
        queuedMessageId: "queued-1",
        submissionId: "submission-1",
        text: "First",
        kind: "ordinary" as const,
        position: 0,
        restored: false,
      },
      {
        queuedMessageId: "queued-2",
        submissionId: "submission-2",
        text: "/later",
        kind: "slash-command" as const,
        position: 1,
        restored: true,
      },
    ];
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method, _request, callOptions) => {
        if (method === "getCoachDecision") return Promise.resolve({ decision: null }) as never;
        if (method === "hasSession") return Promise.resolve({ hasSession: false }) as never;
        if (method === "getChatQueue")
          return Promise.resolve({ schemaVersion: 1, revision: 2, items }) as never;
        if (method === "resumeChatQueue") {
          options = callOptions as CoachClientCallOptions<"chat">;
          deliver("resumeChatQueue", options, {
            type: "turn-start",
            turnId: "turn-3",
            chatId: "desktop",
          });
          return run.promise as never;
        }
        if (method === "retryQueuedTurn") {
          const retryOptions = callOptions as CoachClientCallOptions<"chat">;
          deliver("retryQueuedTurn", retryOptions, {
            type: "turn-start",
            turnId: "turn-4",
            chatId: "desktop",
          });
          deliver("retryQueuedTurn", retryOptions, {
            type: "final-text",
            turnId: "turn-4",
            text: "Recovered",
          });
          retryOptions.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 4, result: {} });
          return Promise.resolve({
            snapshot: { schemaVersion: 1, revision: 6, items: [items[1]!] },
            response: { text: "Recovered" },
          }) as never;
        }
        if (method === "stopChat") {
          const interrupted = {
            type: "interrupted",
            turnId: "turn-3",
            chatId: "desktop",
            text: "Partial",
          } as const;
          deliver("resumeChatQueue", options!, interrupted);
          options!.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 3, result: {} });
          run.resolve({
            snapshot: {
              schemaVersion: 1,
              revision: 4,
              items,
              retryRequired: {
                claimId: "claim-1",
                queuedMessageIds: ["queued-1"],
                turnId: "turn-3",
                status: "retry-required",
              },
            },
            response: { text: "Partial" },
          });
          return Promise.resolve({ stopped: true }) as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller, states } = harness(client);
    const active = controller.resume();
    await vi.waitFor(() => expect(options).toBeDefined());
    controller.stop();
    await active;
    expect(states.at(-1)?.status).toBe("interrupted");
    expect(states.at(-1)?.queued.map((item) => item.text)).toEqual(["First", "/later"]);
    expect(states.at(-1)?.retryRequired).toMatchObject({ claimId: "claim-1" });
    expect(
      vi.mocked(client.call).mock.calls.filter(([method]) => method === "resumeChatQueue"),
    ).toHaveLength(1);

    await controller.retryQueuedTurn("claim-1");
    expect(states.at(-1)?.messages.filter((message) => message.role === "athlete")).toHaveLength(1);
    expect(states.at(-1)?.messages.filter((message) => message.role === "athlete")[0]?.text).toBe(
      "First",
    );
    expect(states.at(-1)?.queued.map((item) => item.text)).toEqual(["/later"]);
  });
});
