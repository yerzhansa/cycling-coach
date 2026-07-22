import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectCoachClient } from "@enduragent/coach-client";
import { checkIntervalsStoreOwnerAtPath } from "@enduragent/coach/backfill";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  session,
  shell,
  utilityProcess,
} from "electron";
import { createChatGptAuth, hasChatGptProfile } from "./chatgpt-auth.js";
import { installDesktopConnectionIpc } from "./connection-ipc.js";
import { DESKTOP_LIFECYCLE_CHANNEL, DESKTOP_RENDERER_URL, DESKTOP_SCHEME } from "./constants.js";
import {
  createConnectionRuntimeAuthority,
  createCredentialRuntimeApplication,
  intervalsAthleteIdForOwnership,
  readSelectedLlmProvider,
  type CredentialRuntimeApplication,
  type RuntimeConfigurationAuthority,
} from "./credential-runtime.js";
import { CREDENTIAL_DIRECTORY_NAME, createCredentialVault } from "./credential-vault.js";
import {
  DesktopDaemonLifecycle,
  type DesktopDaemonConnection,
  type DesktopDaemonLifecycleState,
} from "./daemon-lifecycle.js";
import { resolveDesktopAthleteHome, seedFirstRunConfig } from "./first-run-config.js";
import {
  lifecycleErrorCopy,
  startupRefusalCopy,
  unexpectedStartupCopy,
} from "./lifecycle-messages.js";
import { registerOnboardingIpc, runtimeConfigurationForCredential } from "./onboarding-ipc.js";
import { createDesktopResidency, type DesktopResidency } from "./residency.js";
import {
  desktopWindowOptions,
  hardenDesktopWindow,
  installDesktopProtocol,
  isTrustedConnectionRequest,
  registerDesktopScheme,
  rendererOutputRoot,
  resolveDesktopRendererSource,
} from "./security.js";
import { DesktopDaemonSupervisor, isUtilityTerminalFrame } from "./supervisor.js";

registerDesktopScheme();

let desktopIsClosing = false;

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
  let residency: DesktopResidency | undefined;
  app.on("second-instance", () => {
    void residency?.showMainWindow();
  });
  app.on("activate", () => {
    void residency?.showMainWindow();
  });
  app.on("window-all-closed", () => {});
  await app.whenReady();
  const controller = new AbortController();
  const environment = { ...process.env };
  const rendererSource = resolveDesktopRendererSource(
    app.isPackaged,
    environment.ELECTRON_RENDERER_URL,
  );
  try {
    await seedFirstRunConfig({ env: environment });
  } catch {
    process.stderr.write("desktop-first-run-config-failure seed\n");
  }
  const supervisor = new DesktopDaemonSupervisor(
    {
      env: environment,
      executablePath: process.execPath,
      appVersion: app.getVersion(),
      signal: controller.signal,
    },
    utilityEntry,
  );
  let quitting = false;
  let protocolInstalled = false;
  let disposeConnectionIpc: (() => void) | undefined;
  let disposeOnboarding: (() => void) | undefined;
  let daemonLifecycle: DesktopDaemonLifecycle | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      controller.abort();
      disposeConnectionIpc?.();
      disposeConnectionIpc = undefined;
      disposeOnboarding?.();
      disposeOnboarding = undefined;
      if (protocolInstalled) {
        session.defaultSession.protocol.unhandle(DESKTOP_SCHEME);
        protocolInstalled = false;
      }
      await (daemonLifecycle?.close() ?? supervisor.close());
    })();
    return shutdownPromise;
  };
  app.on("before-quit", (event) => {
    desktopIsClosing = true;
    residency?.close();
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
      if (!controller.signal.aborted && resolution.cause !== "cancelled") {
        const copy = startupRefusalCopy(resolution.cause);
        dialog.showErrorBox(copy.title, copy.content);
      }
      await shutdown();
      if (!quitting) app.exit(resolution.exitCode);
      return;
    }
    let window: BrowserWindow | null = null;
    let windowCreation: Promise<BrowserWindow> | undefined;
    const currentWindow = (): BrowserWindow | null =>
      window !== null && !window.isDestroyed() ? window : null;
    type RuntimeBinding = {
      readonly authority: RuntimeConfigurationAuthority;
      readonly credentials: CredentialRuntimeApplication;
    };
    let activeRuntimeBinding: RuntimeBinding | undefined;
    const preparedRuntimeBindings = new Map<number, RuntimeBinding>();
    let reapplyCredentials = async (
      _connection: DesktopDaemonConnection,
      _signal: AbortSignal,
    ): Promise<void> => {};
    const publishLifecycle = (state: DesktopDaemonLifecycleState): void => {
      const visibleWindow = currentWindow();
      if (visibleWindow !== null && state.status !== "starting") {
        visibleWindow.webContents.send(DESKTOP_LIFECYCLE_CHANNEL, {
          status: state.status,
          generation: state.generation,
        });
      }
      const copy =
        controller.signal.aborted || desktopIsClosing ? undefined : lifecycleErrorCopy(state);
      if (copy !== undefined) dialog.showErrorBox(copy.title, copy.content);
    };
    daemonLifecycle = new DesktopDaemonLifecycle(supervisor, resolution, {
      prepareReady: ({ connection, signal }) => reapplyCredentials(connection, signal),
      onTransition: publishLifecycle,
      onReady({ previous, current }) {
        const prepared = preparedRuntimeBindings.get(current.generation);
        if (prepared !== undefined) {
          activeRuntimeBinding = prepared;
          preparedRuntimeBindings.delete(current.generation);
        }
        if (new URL(previous.url).port === new URL(current.url).port) return;
        const visibleWindow = currentWindow();
        if (visibleWindow === null) return;
        visibleWindow.webContents.reload();
      },
    });
    const configDir = join(resolveDesktopAthleteHome(environment), "config");
    const createRuntimeBinding = (
      connection: Pick<DesktopDaemonConnection, "url" | "token">,
    ): RuntimeBinding => {
      const authority = createConnectionRuntimeAuthority(connection, connectCoachClient);
      return {
        authority,
        credentials: createCredentialRuntimeApplication({
          configureRuntime: authority.configureRuntime,
          selectedLlmProvider: async (storedCredentialSlots) =>
            readSelectedLlmProvider(await authority.getRuntimeConfig(), {
              chatGptProfilePresent: await hasChatGptProfile(configDir),
              storedCredentialSlots,
            }),
        }),
      };
    };
    activeRuntimeBinding = createRuntimeBinding({
      url: resolution.url,
      token: resolution.token,
    });
    const credentialRoot = join(app.getPath("userData"), CREDENTIAL_DIRECTORY_NAME);
    const vault = createCredentialVault({
      root: credentialRoot,
      encryption: safeStorage,
      async applyCredential(slot, value) {
        await activeRuntimeBinding!.credentials.applyExplicit(
          runtimeConfigurationForCredential(slot, value),
        );
      },
      reapplyCredential: (slot, value, storedCredentialSlots) =>
        activeRuntimeBinding!.credentials.reapplyStoredCredential(
          slot,
          value,
          storedCredentialSlots,
        ),
    });
    reapplyCredentials = async (connection, signal) => {
      if (signal.aborted) return;
      const successor = createRuntimeBinding(connection);
      const successorVault = createCredentialVault({
        root: credentialRoot,
        encryption: safeStorage,
        async applyCredential(slot, value) {
          await successor.credentials.applyExplicit(runtimeConfigurationForCredential(slot, value));
        },
        reapplyCredential: successor.credentials.reapplyStoredCredential,
      });
      await successorVault.reapplyConfigured();
      if (!signal.aborted) preparedRuntimeBindings.set(connection.generation, successor);
    };
    const chatGptAuth = createChatGptAuth({
      configDir,
      applyRuntimeConfig: (request) => activeRuntimeBinding!.credentials.applyExplicit(request),
      getRuntimeConfig: () => activeRuntimeBinding!.authority.getRuntimeConfig(),
      openExternal: (url) => shell.openExternal(url),
      signal: controller.signal,
    });
    daemonLifecycle.start();
    await vault.reapplyConfigured();
    await installDesktopProtocol({
      session: session.defaultSession,
      currentDaemonPort: () => daemonLifecycle!.currentPort(),
      rendererRoot: rendererOutputRoot(),
      rendererSource,
    });
    protocolInstalled = true;
    const consoleMessages: string[] = [];
    const mainWindow = {
      current: currentWindow,
      show: (): Promise<BrowserWindow> => {
        if (windowCreation !== undefined) return windowCreation;
        const current = mainWindow.current();
        if (current !== null) {
          if (current.isMinimized()) current.restore();
          current.show();
          current.focus();
          return Promise.resolve(current);
        }
        windowCreation = (async () => {
          const created = new BrowserWindow(desktopWindowOptions(preloadEntry));
          window = created;
          created.webContents.on("console-message", (_event, _level, consoleMessage) => {
            consoleMessages.push(consoleMessage);
          });
          hardenDesktopWindow(created);
          disposeOnboarding?.();
          disposeOnboarding = registerOnboardingIpc({
            ipcMain,
            dialog,
            window: created,
            vault,
            chatGptAuth,
            checkIntervalsCredentialOwner: async (value) => {
              const snapshot = await activeRuntimeBinding!.authority.getRuntimeConfig();
              return checkIntervalsStoreOwnerAtPath(
                join(resolveDesktopAthleteHome(environment), "store", "store.db"),
                {
                  apiKey: value,
                  athleteId: intervalsAthleteIdForOwnership(snapshot),
                  historyNewestDate: "1970-01-01",
                  clock: { now: () => Date.now(), monotonicNow: () => performance.now() },
                  signal: controller.signal,
                },
              );
            },
            isTrusted: (event) =>
              isTrustedConnectionRequest(event, mainWindow.current() ?? undefined),
          });
          created.once("ready-to-show", () => {
            if (!created.isDestroyed()) created.show();
          });
          created.once("closed", () => {
            if (window === created) {
              window = null;
              disposeOnboarding?.();
              disposeOnboarding = undefined;
            }
          });
          await created.loadURL(DESKTOP_RENDERER_URL);
          if (created.isMinimized()) created.restore();
          created.show();
          created.focus();
          return created;
        })().finally(() => {
          windowCreation = undefined;
        });
        return windowCreation;
      },
    };
    disposeConnectionIpc = installDesktopConnectionIpc({
      ipcMain,
      currentWindow: () => mainWindow.current() ?? undefined,
      runtime: daemonLifecycle,
    });
    residency = createDesktopResidency({
      app,
      mainWindow,
      trayIconPath: join(app.getAppPath(), "resources", "trayTemplate.png"),
      trayPopoverUrl: rendererSource.trayPopoverUrl,
      reportFailure(operation) {
        process.stderr.write(`desktop-residency-failure ${operation}\n`);
      },
    });
    const initialWindow = await mainWindow.show();
    await residency.start();

    if (process.argv.includes("--desktop-security-smoke")) {
      const daemonPort = daemonLifecycle.currentPort();
      const rendererResult = await initialWindow.webContents.executeJavaScript(`(async () => {
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
      const screenshot = (await initialWindow.webContents.capturePage()).toPNG();
      const outputArgument = process.argv.find((value) =>
        value.startsWith("--desktop-security-output="),
      );
      if (outputArgument !== undefined) {
        await writeFile(outputArgument.slice("--desktop-security-output=".length), screenshot);
      }
      const result = {
        url: rendererResult.url,
        rpcUrl: daemonLifecycle.connection().url,
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
            return JSON.stringify(keys) === JSON.stringify(["runtimeState", "slot", "state"]);
          }) &&
          !JSON.stringify(rendererResult.credentialStatuses).includes(
            daemonLifecycle.connection().token,
          ),
        tokenAbsentInRendererSurfaces:
          !JSON.stringify(rendererResult.rendererSurfaces).includes(
            daemonLifecycle.connection().token,
          ) &&
          !consoleMessages.some((entry) => entry.includes(daemonLifecycle!.connection().token)) &&
          !screenshot.includes(daemonLifecycle.connection().token),
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

const primaryInstance = app.requestSingleInstanceLock();

if (!primaryInstance) {
  app.exit(0);
} else {
  const runPrimaryDesktop = process.argv.includes("--desktop-runtime-smoke")
    ? runRuntimeSmoke
    : runDesktop;
  void runPrimaryDesktop().catch(() => {
    if (!desktopIsClosing) {
      dialog.showErrorBox(unexpectedStartupCopy.title, unexpectedStartupCopy.content);
    }
    app.exit(1);
  });
}
