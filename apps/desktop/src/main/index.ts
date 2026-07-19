import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectCoachClient } from "@enduragent/coach-client";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  session,
  utilityProcess,
} from "electron";
import { DESKTOP_CONNECTION_CHANNEL, DESKTOP_RENDERER_URL, DESKTOP_SCHEME } from "./constants.js";
import { CREDENTIAL_DIRECTORY_NAME, createCredentialVault } from "./credential-vault.js";
import { registerOnboardingIpc, runtimeConfigurationForCredential } from "./onboarding-ipc.js";
import {
  desktopWindowOptions,
  hardenDesktopWindow,
  installDesktopProtocol,
  isTrustedConnectionRequest,
  registerDesktopScheme,
  rendererOutputRoot,
} from "./security.js";
import { DesktopDaemonSupervisor, isUtilityTerminalFrame } from "./supervisor.js";

registerDesktopScheme();

const mainDirectory = dirname(fileURLToPath(import.meta.url));
const utilityEntry = resolve(mainDirectory, "daemon-utility.js");
const preloadEntry = resolve(mainDirectory, "../preload/index.cjs");

async function runRuntimeSmoke(): Promise<void> {
  await app.whenReady();
  const child = utilityProcess.fork(utilityEntry, ["--desktop-runtime-smoke"], {
    serviceName: "enduragent desktop runtime",
    stdio: "pipe",
  });
  child.stdout?.pipe(process.stdout);
  child.stderr?.resume();
  child.on("message", (message) => {
    if (isUtilityTerminalFrame(message)) child.postMessage({ type: "terminal-ack" });
  });
  const exitCode = await new Promise<number>((resolveExit) => {
    child.once("exit", (code) => resolveExit(Number.isInteger(code) ? code : 1));
  });
  app.exit(exitCode);
}

async function runDesktop(): Promise<void> {
  await app.whenReady();
  const controller = new AbortController();
  const supervisor = new DesktopDaemonSupervisor(
    {
      env: { ...process.env },
      executablePath: process.execPath,
      appVersion: app.getVersion(),
      signal: controller.signal,
    },
    utilityEntry,
  );
  let quitting = false;
  let protocolInstalled = false;
  let connectionHandlerInstalled = false;
  let disposeOnboarding: (() => void) | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      controller.abort();
      if (connectionHandlerInstalled) {
        ipcMain.removeHandler(DESKTOP_CONNECTION_CHANNEL);
        connectionHandlerInstalled = false;
      }
      disposeOnboarding?.();
      disposeOnboarding = undefined;
      if (protocolInstalled) {
        session.defaultSession.protocol.unhandle(DESKTOP_SCHEME);
        protocolInstalled = false;
      }
      await supervisor.close();
    })();
    return shutdownPromise;
  };
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void shutdown().then(
      () => app.exit(0),
      () => app.exit(1),
    );
  });
  try {
    const resolution = await supervisor.resolve();
    if (resolution.status === "refused") {
      await shutdown();
      app.exit(resolution.exitCode);
      return;
    }
    const daemonPort = Number(new URL(resolution.url).port);
    const vault = createCredentialVault({
      root: join(app.getPath("userData"), CREDENTIAL_DIRECTORY_NAME),
      encryption: safeStorage,
      async applyCredential(slot, value) {
        const client = await connectCoachClient({ url: resolution.url, token: resolution.token });
        try {
          const request = runtimeConfigurationForCredential(slot, value);
          const result = await client.call("configureRuntime", request);
          if (
            (request.llm !== undefined && !result.applied.llm) ||
            (request.intervals !== undefined && !result.applied.intervals)
          ) {
            throw new TypeError();
          }
        } finally {
          await client.close();
        }
      },
    });
    await vault.reapplyConfigured();
    await installDesktopProtocol({
      session: session.defaultSession,
      daemonPort,
      rendererRoot: rendererOutputRoot(),
      ...(process.env.ELECTRON_RENDERER_URL === undefined
        ? {}
        : { developmentUrl: process.env.ELECTRON_RENDERER_URL }),
    });
    protocolInstalled = true;
    let window: BrowserWindow | undefined = new BrowserWindow(desktopWindowOptions(preloadEntry));
    const consoleMessages: string[] = [];
    window.webContents.on("console-message", (_event, _level, consoleMessage) => {
      consoleMessages.push(consoleMessage);
    });
    hardenDesktopWindow(window);
    ipcMain.handle(DESKTOP_CONNECTION_CHANNEL, (event) => {
      if (!isTrustedConnectionRequest(event, window)) {
        throw new Error("untrusted desktop connection request");
      }
      return { url: resolution.url, token: resolution.token };
    });
    connectionHandlerInstalled = true;
    disposeOnboarding = registerOnboardingIpc({
      ipcMain,
      dialog,
      window,
      vault,
      isTrusted: (event) => isTrustedConnectionRequest(event, window),
    });
    window.once("ready-to-show", () => window?.show());
    window.once("closed", () => {
      window = undefined;
    });
    await window.loadURL(DESKTOP_RENDERER_URL);

    if (process.argv.includes("--desktop-security-smoke")) {
      const rendererResult = await window.webContents.executeJavaScript(`(async () => {
      const blockedPort = ${daemonPort === 65_535 ? daemonPort - 1 : daemonPort + 1};
      const blocked = await new Promise((resolve) => {
        let violation = false;
        const onViolation = (event) => {
          if (event.effectiveDirective === "connect-src") violation = true;
        };
        document.addEventListener("securitypolicyviolation", onViolation, { once: true });
        const socket = new WebSocket("ws://127.0.0.1:" + blockedPort + "/rpc");
        const finish = () => { socket.close(); resolve(violation); };
        socket.addEventListener("error", () => setTimeout(finish, 0), { once: true });
        setTimeout(finish, 1000);
      });
      const deadline = Date.now() + 5000;
      while (document.documentElement.dataset.rpc === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const credentialStatuses = await window.enduragentAuth.credentialStatuses();
      return {
        url: location.href,
        bridgeKeys: Object.keys(window.enduragentAuth ?? {}).sort(),
        credentialStatuses,
        noNodeGlobals: ["process", "require", "Buffer", "global", "module"].every((key) => typeof window[key] === "undefined"),
        rpcConnected: document.documentElement.dataset.rpc === "connected",
        blockedOffPort: blocked,
        drawerPresent: document.querySelector('.drawer[aria-label="Training data"]') !== null,
        rendererSurfaces: {
          dom: document.documentElement.outerHTML,
          localStorage: Object.entries(localStorage),
          sessionStorage: Object.entries(sessionStorage)
        }
      };
    })()`);
      const screenshot = (await window.webContents.capturePage()).toPNG();
      const outputArgument = process.argv.find((value) =>
        value.startsWith("--desktop-security-output="),
      );
      if (outputArgument !== undefined) {
        await writeFile(outputArgument.slice("--desktop-security-output=".length), screenshot);
      }
      const result = {
        url: rendererResult.url,
        rpcUrl: resolution.url,
        bridgeKeys: rendererResult.bridgeKeys,
        noNodeGlobals: rendererResult.noNodeGlobals,
        rpcConnected: rendererResult.rpcConnected,
        blockedOffPort: rendererResult.blockedOffPort,
        drawerPresent: rendererResult.drawerPresent,
        credentialStatuses: rendererResult.credentialStatuses,
        credentialStatusesMetadataOnly:
          Array.isArray(rendererResult.credentialStatuses) &&
          rendererResult.credentialStatuses.every((entry: Record<string, unknown>) => {
            const keys = Object.keys(entry).sort();
            return JSON.stringify(keys) === JSON.stringify(["runtimeReady", "slot", "state"]);
          }) &&
          !JSON.stringify(rendererResult.credentialStatuses).includes(resolution.token),
        tokenAbsentInRendererSurfaces:
          !JSON.stringify(rendererResult.rendererSurfaces).includes(resolution.token) &&
          !consoleMessages.some((entry) => entry.includes(resolution.token)) &&
          !screenshot.includes(resolution.token),
      };
      process.stdout.write(`DESKTOP_SECURITY_READY ${JSON.stringify(result)}\n`);
      await new Promise<void>((resolveRelease) => {
        process.stdin.once("data", () => resolveRelease());
        process.stdin.resume();
      });
      await shutdown();
      app.exit(0);
    }
  } catch (error) {
    await shutdown();
    throw error;
  }
}

if (process.argv.includes("--desktop-runtime-smoke")) {
  void runRuntimeSmoke().catch(() => app.exit(1));
} else {
  void runDesktop().catch(() => app.exit(1));
}
