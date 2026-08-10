import { createHealthzRequestHandler } from "../../src/daemon/healthz-server.js";
import { classifyPeerReadOnly } from "../../src/daemon/handshake.js";
import {
  acquireUpgradeFence,
  admitStartupThroughUpgradeFence,
} from "../../src/daemon/upgrade-fence.js";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { acquireWriteLock } from "@enduragent/kernel-node/lock";

interface StartMessage {
  readonly type: "start";
  readonly home: AthleteHome;
  readonly mode?: "healthy" | "bound" | "foreign";
  readonly handoffCapability?: string;
  readonly platform?: NodeJS.Platform;
}

function send(value: unknown): void {
  process.send?.(value);
}

async function runWriter(message: StartMessage): Promise<void> {
  const lock = await acquireWriteLock({
    configDir: message.home.configDir,
    athleteHome: message.home.root,
    version: "0.1.0-synthetic",
  });
  if (lock.status !== "acquired") {
    send({ type: "peer", peer: lock });
    return;
  }
  let binding: Awaited<ReturnType<typeof lock.listener.bind>> | undefined;
  if (message.mode !== "bound") {
    binding = await lock.listener.bind({
      request: message.mode === "healthy"
        ? createHealthzRequestHandler({ appVersion: "0.1.0-synthetic" })
        : (_request, response) => response.end("foreign\n"),
      upgrade: (_request, socket) => socket.destroy(),
    });
  }
  send({
    type: "ready",
    pid: process.pid,
    rawPort: lock.port,
    protocolPort: binding?.port,
    rw: "open",
  });
  await new Promise<void>((resolve) => {
    process.on("message", (value) => {
      if ((value as { readonly type?: unknown }).type === "stop") resolve();
    });
  });
  await binding?.close();
  await lock.release();
  send({ type: "stopped", rw: "closed" });
}

async function main(): Promise<void> {
  const role = process.argv[2];
  const message = await new Promise<StartMessage>((resolve) => {
    process.once("message", (value) => resolve(value as StartMessage));
  });
  if (role === "writer") {
    await runWriter(message);
    return;
  }
  if (role === "classify") {
    send({ type: "classification", result: await classifyPeerReadOnly(message.home) });
    return;
  }
  if (role === "fence-holder") {
    const acquired = await acquireUpgradeFence({
      configDir: message.home.configDir,
      ...(message.platform === undefined ? {} : { platform: message.platform }),
    });
    if (acquired.status !== "acquired") {
      send({ type: "fence", result: acquired });
      return;
    }
    send({
      type: "fence",
      result: {
        status: "acquired",
        socketPath: acquired.handle.socketPath,
        handoffCapability: acquired.handle.handoffCapability,
      },
    });
    await new Promise<void>((resolve) => {
      process.on("message", (value) => {
        if ((value as { readonly type?: unknown }).type === "stop") resolve();
      });
    });
    await acquired.handle.release();
    return;
  }
  if (role === "fence-admit") {
    send({
      type: "admission",
      result: await admitStartupThroughUpgradeFence({
        configDir: message.home.configDir,
        ...(message.platform === undefined ? {} : { platform: message.platform }),
        ...(message.handoffCapability === undefined
          ? {}
          : { handoffCapability: message.handoffCapability }),
      }),
    });
    return;
  }
  throw new Error("unknown daemon fixture role");
}

try {
  await main();
  process.disconnect?.();
} catch {
  send({ type: "error" });
  process.exitCode = 70;
  process.disconnect?.();
}
