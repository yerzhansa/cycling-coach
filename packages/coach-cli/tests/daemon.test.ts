import { PassThrough, Writable } from "node:stream";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  EXIT_AGENT_ERROR,
  EXIT_DAEMON_UNAVAILABLE,
  EXIT_SUCCESS,
  EXIT_USAGE,
} from "@enduragent/coach-contract";
import {
  parseCoachCliInvocation,
  runCoachDaemonCommand,
  type CoachDaemonController,
  type DaemonServiceSnapshot,
} from "../src/index.js";

function capture(): { readonly stream: Writable; read(): string } {
  let text = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        text += String(chunk);
        callback();
      },
    }),
    read: () => text,
  };
}

function terminal() {
  const stdout = capture();
  const stderr = capture();
  return {
    stdout,
    stderr,
    value: {
      input: new PassThrough(),
      stdout: stdout.stream,
      stderr: stderr.stream,
      isTTY: false,
    },
  };
}

const registered = (running = true, pid: number | null = 42): DaemonServiceSnapshot => ({
  kind: "registered",
  label: "ai.enduragent.coach.synthetic",
  installed: true,
  loaded: true,
  running,
  pid: running ? pid : null,
});

const absent: DaemonServiceSnapshot = {
  kind: "absent",
  label: "ai.enduragent.coach.synthetic",
  installed: false,
  loaded: false,
  running: false,
  pid: null,
};

const unknown: DaemonServiceSnapshot = {
  kind: "unknown",
  label: "ai.enduragent.coach.synthetic",
  installed: null,
  loaded: null,
  running: null,
  pid: null,
};

function controller(snapshot: DaemonServiceSnapshot): CoachDaemonController {
  return {
    supported: true,
    install: vi.fn(async () => snapshot),
    status: vi.fn(async () => snapshot),
    restart: vi.fn(async () => snapshot),
  };
}

describe("daemon command", () => {
  it("parses only the three exact additive forms", () => {
    for (const action of ["install", "status", "restart"] as const) {
      expect(parseCoachCliInvocation(["daemon", action])).toEqual({ kind: "daemon", action });
    }
    for (const argv of [["daemon"], ["daemon", "stop"], ["daemon", "status", "extra"]]) {
      expect(parseCoachCliInvocation(argv)).toEqual({
        kind: "usage",
        message: "Usage: enduragent [version|serve|self-test]",
      });
    }
  });

  it.each([
    [
      "install",
      registered(),
      "Enduragent service installed (ai.enduragent.coach.synthetic).\n",
      "",
      EXIT_SUCCESS,
    ],
    [
      "restart",
      registered(),
      "Enduragent service restarted (ai.enduragent.coach.synthetic).\n",
      "",
      EXIT_SUCCESS,
    ],
    [
      "status",
      registered(),
      "Enduragent service is running (ai.enduragent.coach.synthetic, pid 42).\n",
      "",
      EXIT_SUCCESS,
    ],
    [
      "status",
      registered(true, null),
      "Enduragent service is running (ai.enduragent.coach.synthetic, pid unknown).\n",
      "",
      EXIT_SUCCESS,
    ],
    [
      "status",
      registered(false),
      "Enduragent service is registered but stopped (ai.enduragent.coach.synthetic).\n",
      "",
      EXIT_DAEMON_UNAVAILABLE,
    ],
    [
      "status",
      absent,
      "Enduragent service is not installed (ai.enduragent.coach.synthetic).\n",
      "",
      EXIT_DAEMON_UNAVAILABLE,
    ],
    ["status", unknown, "", "Enduragent service status is unavailable.\n", EXIT_DAEMON_UNAVAILABLE],
  ] as const)(
    "renders %s without cross-stream output",
    async (action, snapshot, stdout, stderr, exit) => {
      const io = terminal();
      await expect(
        runCoachDaemonCommand({ action, controller: controller(snapshot), terminal: io.value }),
      ).resolves.toBe(exit);
      expect(io.stdout.read()).toBe(stdout);
      expect(io.stderr.read()).toBe(stderr);
    },
  );

  it("short-circuits unsupported platforms without a controller call", async () => {
    const io = terminal();
    const service = controller(registered());
    Object.defineProperty(service, "supported", { value: false });
    await expect(
      runCoachDaemonCommand({ action: "install", controller: service, terminal: io.value }),
    ).resolves.toBe(EXIT_USAGE);
    expect(service.install).not.toHaveBeenCalled();
    expect(io.stdout.read()).toBe("");
    expect(io.stderr.read()).toBe("Enduragent service management is available only on macOS.\n");
  });

  it("redacts rejections and rejects absent mutation results", async () => {
    for (const service of [
      {
        ...controller(absent),
        install: async () => {
          throw new Error("sensitive detail");
        },
      },
      controller(absent),
    ]) {
      const io = terminal();
      await expect(
        runCoachDaemonCommand({ action: "install", controller: service, terminal: io.value }),
      ).resolves.toBe(EXIT_AGENT_ERROR);
      expect(io.stdout.read()).toBe("");
      expect(io.stderr.read()).toBe("Enduragent service command failed.\n");
    }
  });

  it("keeps the R6 source boundary free of host packages", async () => {
    const source = await readFile(new URL("../src/verbs/daemon.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/@enduragent\/(?:kernel-node|coach|engine|kernel)(?:\/|["'])/);
  });
});
