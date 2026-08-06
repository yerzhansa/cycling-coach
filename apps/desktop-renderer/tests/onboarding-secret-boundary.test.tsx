import { waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CredentialWriteResult,
  OnboardingCredentialWriteInput,
} from "../src/onboarding/bridge.js";
import { handoffCredential } from "../src/onboarding/credentials.js";
import {
  control,
  mountWizard,
  openApiKeyPanel,
  openTrainingPanel,
  panel,
  passwordInput,
  resetOnboardingStore,
  rowState,
  seedSecret,
  testBridge,
  type UserEvent,
} from "./onboarding-harness.js";

function panelButton(name: string, label: string): HTMLButtonElement {
  const host = panel(name);
  if (host === null) throw new Error(`panel not open: ${name}`);
  return within(host).getByRole("button", { name: label });
}

async function saveIn(user: UserEvent, name: string): Promise<void> {
  await user.click(
    panelButton(name, name === "training" ? "Save Intervals.icu API key" : "Save API key"),
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface Transient {
  readonly slot: string;
  readonly value: string;
}

function domSurfaces(extra: Record<string, unknown>): Record<string, unknown> {
  const controls = Array.from(document.querySelectorAll("input, select, textarea"));
  return {
    innerHTML: document.body.innerHTML,
    outerHTML: document.body.outerHTML,
    text: document.body.textContent ?? "",
    attributes: controls.flatMap((element) =>
      Array.from(element.attributes, (attribute) => `${attribute.name}=${attribute.value}`),
    ),
    snapshot: Object.fromEntries(
      controls.map((element, index) => [String(index), element.getAttribute("value") ?? ""]),
    ),
    location: globalThis.location.href,
    browserStorage: [
      ...Object.entries({ ...localStorage }),
      ...Object.entries({ ...sessionStorage }),
    ],
    ...extra,
  };
}

describe("onboarding renderer secret boundary", () => {
  for (const [slot, sentinel] of [
    ["anthropic", "synthetic-model-secret-sentinel"],
    ["intervals-icu", "synthetic-intervals-secret-sentinel"],
  ] as const) {
    it(`releases the ${slot} password before the pending handoff settles`, async () => {
      const input = { value: sentinel, dataset: { slot } };
      const gate = deferred();
      let transient: Transient | undefined;
      const write = async (value: OnboardingCredentialWriteInput) => {
        try {
          transient = { slot: value.slot, value: value.value };
          await gate.promise;
        } finally {
          transient = undefined;
        }
      };
      const pending = handoffCredential(input, write);
      expect(input.value).toBe("");
      expect(transient).toEqual({ slot, value: sentinel });
      gate.resolve();
      await pending;
      expect(input.value).toBe("");
      expect(transient).toBeUndefined();
      const capturedSurfaces = {
        innerHTML: "",
        outerHTML: '<input type="password">',
        text: "",
        attributes: ["type=password"],
        snapshot: { input: "" },
        location: "enduragent://app/index.html",
        console: [],
        bridgeResult: { slot, status: "configured", runtimeReady: true },
        rpc: [],
        browserStorage: [],
      };
      expect(JSON.stringify(capturedSurfaces)).not.toContain(sentinel);
    });
  }

  it("clears the live control when the privileged handoff rejects", async () => {
    const sentinel = "synthetic-refused-secret-sentinel";
    const input = { value: sentinel, dataset: { slot: "openrouter" } };
    await expect(
      handoffCredential(input, async () => {
        throw new TypeError();
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(input.value).toBe("");
    expect(JSON.stringify(input)).not.toContain(sentinel);
  });
});

describe("mounted onboarding secret boundary", () => {
  const consoleCalls: unknown[] = [];
  const consoleSpies: Array<{ restore: () => void }> = [];

  beforeEach(() => {
    consoleCalls.splice(0);
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      const spy = vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleCalls.push(args);
      });
      consoleSpies.push({ restore: () => spy.mockRestore() });
    }
  });

  afterEach(() => {
    for (const spy of consoleSpies.splice(0)) spy.restore();
    resetOnboardingStore();
  });

  it("releases the coach-keys password before the pending write settles", async () => {
    const sentinel = "synthetic-wizard-model-secret";
    const user = userEvent.setup();
    const gate = deferred();
    const rpc: unknown[] = [];
    let transient: Transient | undefined;
    let bridgeResult: CredentialWriteResult | undefined;
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ slot: "anthropic", state: "configured", runtimeState: "active" }]);
    bridge.writeCredential.mockImplementation(async (value) => {
      rpc.push({ slot: value.slot, selection: value.selection });
      try {
        transient = { slot: value.slot, value: value.value };
        await gate.promise;
      } finally {
        transient = undefined;
      }
      bridgeResult = { slot: value.slot, status: "configured", runtimeReady: true };
      return bridgeResult;
    });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);

    await user.type(passwordInput("anthropic"), sentinel);
    expect(passwordInput("anthropic").value).toBe(sentinel);
    await saveIn(user, "api-key");

    await waitFor(() => {
      expect(transient).toEqual({ slot: "anthropic", value: sentinel });
    });
    expect(passwordInput("anthropic").value).toBe("");
    expect(JSON.stringify(domSurfaces({ console: consoleCalls, rpc }))).not.toContain(sentinel);

    gate.resolve();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expect(transient).toBeUndefined();
    expect(JSON.stringify(domSurfaces({ console: consoleCalls, rpc, bridgeResult }))).not.toContain(
      sentinel,
    );
    wizard.controller.dispose();
  });

  it("releases the training-data password before the pending write settles", async () => {
    const sentinel = "synthetic-wizard-intervals-secret";
    const user = userEvent.setup();
    const gate = deferred();
    const rpc: unknown[] = [];
    let transient: Transient | undefined;
    let bridgeResult: CredentialWriteResult | undefined;
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses
      .mockResolvedValueOnce([{ slot: "anthropic", state: "configured", runtimeState: "active" }])
      .mockResolvedValue([
        { slot: "anthropic", state: "configured", runtimeState: "active" },
        { slot: "intervals-icu", state: "configured", runtimeState: "active" },
      ]);
    bridge.writeCredential.mockImplementation(async (value) => {
      rpc.push({ slot: value.slot, selection: value.selection });
      try {
        transient = { slot: value.slot, value: value.value };
        await gate.promise;
      } finally {
        transient = undefined;
      }
      bridgeResult = { slot: value.slot, status: "configured", runtimeReady: true };
      return bridgeResult;
    });
    const wizard = mountWizard({ bridge });
    await wizard.open();

    await openTrainingPanel(user);
    await user.type(passwordInput("intervals-icu"), sentinel);
    await saveIn(user, "training");

    await waitFor(() => {
      expect(transient).toEqual({ slot: "intervals-icu", value: sentinel });
    });
    expect(passwordInput("intervals-icu").value).toBe("");
    expect(JSON.stringify(domSurfaces({ console: consoleCalls, rpc }))).not.toContain(sentinel);

    gate.resolve();
    await waitFor(() => {
      expect(rowState("training")).toBe("ready");
    });
    expect(transient).toBeUndefined();
    expect(JSON.stringify(domSurfaces({ console: consoleCalls, rpc, bridgeResult }))).not.toContain(
      sentinel,
    );
    wizard.controller.dispose();
  });

  it("clears the live control when the privileged write rejects", async () => {
    const sentinel = "synthetic-wizard-refused-secret";
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.writeCredential.mockRejectedValue(new TypeError());
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);
    await user.selectOptions(control<HTMLSelectElement>("onboarding-llm-provider"), "openrouter");

    await user.type(passwordInput("openrouter"), sentinel);
    await saveIn(user, "api-key");

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("credential-save-failed");
    });
    expect(passwordInput("openrouter").value).toBe("");
    expect(JSON.stringify(domSurfaces({ console: consoleCalls }))).not.toContain(sentinel);
    wizard.controller.dispose();
  });

  it("never lets a typed secret reach a value attribute or the wizard store", async () => {
    const sentinel = "synthetic-wizard-attribute-secret";
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);

    await user.type(passwordInput("anthropic"), sentinel);
    await user.selectOptions(control<HTMLSelectElement>("onboarding-llm-provider"), "openrouter");

    expect(document.querySelector('input[data-slot="anthropic"]')).toBeNull();
    expect(passwordInput("openrouter").getAttribute("value")).toBeNull();
    expect(JSON.stringify(domSurfaces({}))).not.toContain(sentinel);
    expect(JSON.stringify(wizard.controller.state())).not.toContain(sentinel);
    wizard.controller.dispose();
  });

  it("writes only the selected provider's slot when the model key is saved", async () => {
    const user = userEvent.setup();
    const modelSecret = "synthetic-scoped-model-secret";
    const trainingSecret = "synthetic-scoped-training-secret";
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);
    await openTrainingPanel(user);
    seedSecret("anthropic", modelSecret);
    seedSecret("intervals-icu", trainingSecret);

    await saveIn(user, "api-key");

    await waitFor(() => {
      expect(bridge.writeCredential).toHaveBeenCalledOnce();
    });
    expect(bridge.writeCredential.mock.calls[0]?.[0]?.slot).toBe("anthropic");
    expect(passwordInput("intervals-icu").value).toBe(trainingSecret);
    wizard.controller.dispose();
  });

  it("writes only intervals-icu when the training key is saved", async () => {
    const user = userEvent.setup();
    const modelSecret = "synthetic-scoped-model-secret-2";
    const trainingSecret = "synthetic-scoped-training-secret-2";
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);
    await openTrainingPanel(user);
    seedSecret("anthropic", modelSecret);
    seedSecret("intervals-icu", trainingSecret);

    await saveIn(user, "training");

    await waitFor(() => {
      expect(bridge.writeCredential).toHaveBeenCalledOnce();
    });
    expect(bridge.writeCredential.mock.calls[0]?.[0]?.slot).toBe("intervals-icu");
    expect(passwordInput("anthropic").value).toBe(modelSecret);
    wizard.controller.dispose();
  });
});
