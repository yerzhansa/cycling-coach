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
import { createClaudeCliStatus, readClaudeCliSettings } from "./claude-cli-status.js";
import { installDesktopConnectionIpc } from "./connection-ipc.js";
import { installDesktopExternalLinkIpc } from "./external-link-ipc.js";
import { DESKTOP_LIFECYCLE_CHANNEL, DESKTOP_RENDERER_URL, DESKTOP_SCHEME } from "./constants.js";
import {
  createConnectionRuntimeAuthority,
  createCredentialRuntimeApplication,
  intervalsAthleteIdForOwnership,
  readSelectedLlmProvider,
  type CredentialRuntimeApplication,
  type RuntimeConfigurationAuthority,
} from "./credential-runtime.js";
import {
  CREDENTIAL_DIRECTORY_NAME,
  createCredentialVault,
  DESKTOP_CREDENTIAL_SLOTS,
  markUnselectedModelCredentialsInactive,
  replaceCredentialRuntimeStates,
  type CredentialRuntimeState,
  type CredentialSlotStatus,
  type DesktopCredentialSlot,
} from "./credential-vault.js";
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
import {
  runtimeConfigurationForExistingSelection,
  type OnboardingLlmSelection,
} from "./llm-selection.js";
import { registerOnboardingIpc, runtimeConfigurationForCredential } from "./onboarding-ipc.js";
import { installDesktopReleaseNotesIpc } from "./release-notes-ipc.js";
import { createDesktopResidency, type DesktopResidency } from "./residency.js";
import {
  createDesktopRendererConsoleCapture,
  desktopWindowOptions,
  hardenDesktopWindow,
  installDesktopProtocol,
  isTrustedConnectionRequest,
  registerDesktopScheme,
  rendererOutputRoot,
  resolveDesktopRendererSource,
} from "./security.js";
import { DesktopDaemonSupervisor, isUtilityTerminalFrame } from "./supervisor.js";
import { createDesktopQuitCoordinator } from "./quit-coordinator.js";
import { createDesktopUpdateController } from "./update-controller.js";
import { isDesktopUpdateReleaseEligible } from "./update-eligibility.js";
import { installDesktopUpdateIpc } from "./update-ipc.js";
import {
  createConnectionTranscriptReader,
  installDesktopTranscriptIpc,
  type DesktopTranscriptReader,
} from "./transcript-ipc.js";

registerDesktopScheme();

function disableChromiumMediaSessionIntegration(): void {
  const alreadyDisabled = app.commandLine.getSwitchValue("disable-features");
  app.commandLine.appendSwitch(
    "disable-features",
    [alreadyDisabled, "MediaSessionService", "HardwareMediaKeyHandling"]
      .filter((feature) => feature.length > 0)
      .join(","),
  );
}

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
  const securitySmokeMode = process.argv.includes("--desktop-security-smoke");
  const rendererConsoleCapture = createDesktopRendererConsoleCapture(securitySmokeMode);
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
  let quitRequested = false;
  let protocolInstalled = false;
  let disposeConnectionIpc: (() => void) | undefined;
  let disposeTranscriptIpc: (() => void) | undefined;
  let disposeExternalLinkIpc: (() => void) | undefined;
  let disposeReleaseNotesIpc: (() => void) | undefined;
  let disposeUpdateIpc: (() => void) | undefined;
  let disposeOnboarding: (() => void) | undefined;
  let daemonLifecycle: DesktopDaemonLifecycle | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const updateController = createDesktopUpdateController({
    releaseEligible: isDesktopUpdateReleaseEligible({
      isPackaged: app.isPackaged,
      platform: process.platform,
      securitySmokeMode,
      appPath: app.getAppPath(),
      currentVersion: app.getVersion(),
    }),
    currentVersion: app.getVersion(),
    loadUpdater: async () => {
      const { autoUpdater } = await import("electron-updater");
      return autoUpdater;
    },
    requestQuit: () => app.quit(),
  });
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      controller.abort();
      disposeConnectionIpc?.();
      disposeConnectionIpc = undefined;
      disposeTranscriptIpc?.();
      disposeTranscriptIpc = undefined;
      disposeExternalLinkIpc?.();
      disposeExternalLinkIpc = undefined;
      disposeReleaseNotesIpc?.();
      disposeReleaseNotesIpc = undefined;
      disposeUpdateIpc?.();
      disposeUpdateIpc = undefined;
      updateController.close();
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
  const quitCoordinator = createDesktopQuitCoordinator({
    drain: shutdown,
    updateController,
    exit: (code) => app.exit(code),
  });
  app.on("before-quit", (event) => {
    desktopIsClosing = true;
    residency?.close();
    if (quitCoordinator.beforeQuit(event) === "draining") quitRequested = true;
  });
  try {
    const resolution = await supervisor.resolve();
    if (resolution.status === "refused") {
      if (!controller.signal.aborted && resolution.cause !== "cancelled") {
        const copy = startupRefusalCopy(resolution.cause);
        dialog.showErrorBox(copy.title, copy.content);
      }
      await shutdown();
      if (!quitRequested) app.exit(resolution.exitCode);
      return;
    }
    let window: BrowserWindow | null = null;
    let windowCreation: Promise<BrowserWindow> | undefined;
    const currentWindow = (): BrowserWindow | null =>
      window !== null && !window.isDestroyed() ? window : null;
    type RuntimeBinding = {
      readonly authority: RuntimeConfigurationAuthority;
      readonly credentials: CredentialRuntimeApplication;
      readonly transcript: DesktopTranscriptReader;
    };
    let activeRuntimeBinding: RuntimeBinding | undefined;
    const preparedRuntimeBindings = new Map<
      number,
      {
        readonly binding: RuntimeBinding;
        readonly statuses: readonly CredentialSlotStatus[];
        readonly revisions: ReadonlyMap<DesktopCredentialSlot, number>;
      }
    >();
    const credentialRuntimeState = new Map<DesktopCredentialSlot, CredentialRuntimeState>();
    const credentialRuntimeRevisions = new Map<DesktopCredentialSlot, number>();
    const markCredentialRuntimeChange = (slot: DesktopCredentialSlot): void => {
      credentialRuntimeRevisions.set(slot, (credentialRuntimeRevisions.get(slot) ?? 0) + 1);
    };
    const failModelCredentialRuntimeStates = (): void => {
      for (const slot of DESKTOP_CREDENTIAL_SLOTS) {
        if (slot === "intervals-icu") continue;
        credentialRuntimeState.set(slot, "failed");
        markCredentialRuntimeChange(slot);
      }
    };
    let recoveringCredentialRuntime:
      | {
          readonly states: ReadonlyMap<DesktopCredentialSlot, CredentialRuntimeState>;
          readonly revisions: ReadonlyMap<DesktopCredentialSlot, number>;
        }
      | undefined;
    let reapplyCredentials = async (
      _connection: DesktopDaemonConnection,
      _signal: AbortSignal,
    ): Promise<void> => {};
    const publishLifecycle = (state: DesktopDaemonLifecycleState): void => {
      if (state.status === "recovering" && recoveringCredentialRuntime === undefined) {
        recoveringCredentialRuntime = {
          states: new Map(credentialRuntimeState),
          revisions: new Map(credentialRuntimeRevisions),
        };
        for (const slot of credentialRuntimeState.keys()) {
          credentialRuntimeState.set(slot, "failed");
        }
      }
      if (state.status === "ready" && recoveringCredentialRuntime !== undefined) {
        for (const [slot, runtimeState] of recoveringCredentialRuntime.states) {
          if (
            (credentialRuntimeRevisions.get(slot) ?? 0) ===
            (recoveringCredentialRuntime.revisions.get(slot) ?? 0)
          ) {
            credentialRuntimeState.set(slot, runtimeState);
          }
        }
        recoveringCredentialRuntime = undefined;
      }
      if (state.status === "closing" || state.status === "terminal") {
        for (const slot of credentialRuntimeState.keys()) {
          credentialRuntimeState.set(slot, "failed");
        }
        recoveringCredentialRuntime = undefined;
        preparedRuntimeBindings.clear();
      }
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
          activeRuntimeBinding = prepared.binding;
          replaceCredentialRuntimeStates(
            credentialRuntimeState,
            prepared.statuses,
            (slot) =>
              (credentialRuntimeRevisions.get(slot) ?? 0) === (prepared.revisions.get(slot) ?? 0),
          );
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
        transcript: createConnectionTranscriptReader(connection),
        credentials: createCredentialRuntimeApplication({
          configureRuntime: authority.configureRuntime,
          clearRuntimeCredential: authority.clearCredential,
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
    const readActiveRuntimeConfig = async () => {
      const binding = activeRuntimeBinding;
      const lifecycleState = daemonLifecycle?.snapshot();
      if (binding === undefined || lifecycleState?.status !== "ready") throw new TypeError();
      const snapshot = await binding.authority.getRuntimeConfig();
      const currentLifecycleState = daemonLifecycle?.snapshot();
      if (
        activeRuntimeBinding !== binding ||
        currentLifecycleState?.status !== "ready" ||
        currentLifecycleState.generation !== lifecycleState.generation
      ) {
        throw new TypeError();
      }
      return snapshot;
    };
    const readActiveTranscript = async <T>(
      read: (reader: DesktopTranscriptReader) => Promise<T>,
    ): Promise<T> => {
      const binding = activeRuntimeBinding;
      const lifecycleState = daemonLifecycle?.snapshot();
      if (binding === undefined || lifecycleState?.status !== "ready") throw new TypeError();
      const page = await read(binding.transcript);
      const currentLifecycleState = daemonLifecycle?.snapshot();
      if (
        activeRuntimeBinding !== binding ||
        currentLifecycleState?.status !== "ready" ||
        currentLifecycleState.generation !== lifecycleState.generation
      ) {
        throw new TypeError();
      }
      return page;
    };
    const credentialRoot = join(app.getPath("userData"), CREDENTIAL_DIRECTORY_NAME);
    const vault = createCredentialVault({
      root: credentialRoot,
      encryption: safeStorage,
      runtimeState: credentialRuntimeState,
      onRuntimeStateChange: markCredentialRuntimeChange,
      createRuntimePublicationGuard(slot) {
        const binding = activeRuntimeBinding;
        const lifecycleState = daemonLifecycle?.snapshot();
        return () => {
          const currentLifecycleState = daemonLifecycle?.snapshot();
          const canPublish =
            binding !== undefined &&
            activeRuntimeBinding === binding &&
            lifecycleState?.status === "ready" &&
            currentLifecycleState?.status === "ready" &&
            lifecycleState.generation === currentLifecycleState.generation;
          if (!canPublish && slot !== "intervals-icu") failModelCredentialRuntimeStates();
          return canPublish;
        };
      },
      async applyCredential(slot, value, selection) {
        const binding = activeRuntimeBinding!;
        const lifecycleState = daemonLifecycle?.snapshot();
        if (lifecycleState?.status !== "ready") throw new TypeError();
        await binding.credentials.applyExplicit(
          runtimeConfigurationForCredential(slot, value, selection),
        );
        const currentLifecycleState = daemonLifecycle?.snapshot();
        if (
          activeRuntimeBinding !== binding ||
          currentLifecycleState?.status !== "ready" ||
          currentLifecycleState.generation !== lifecycleState.generation
        ) {
          if (slot !== "intervals-icu") failModelCredentialRuntimeStates();
          throw new TypeError();
        }
      },
      async reapplyCredential(slot, value, storedCredentialSlots) {
        const binding = activeRuntimeBinding!;
        const lifecycleState = daemonLifecycle?.snapshot();
        if (lifecycleState?.status !== "ready") throw new TypeError();
        const status = await binding.credentials.reapplyStoredCredential(
          slot,
          value,
          storedCredentialSlots,
        );
        const currentLifecycleState = daemonLifecycle?.snapshot();
        if (
          activeRuntimeBinding !== binding ||
          currentLifecycleState?.status !== "ready" ||
          currentLifecycleState.generation !== lifecycleState.generation
        ) {
          if (slot !== "intervals-icu") failModelCredentialRuntimeStates();
          throw new TypeError();
        }
        return status;
      },
      async clearCredential(slot) {
        const binding = activeRuntimeBinding!;
        const lifecycleState = daemonLifecycle?.snapshot();
        if (lifecycleState?.status !== "ready") throw new TypeError();
        const result = await binding.credentials.clearCredential(slot);
        const currentLifecycleState = daemonLifecycle?.snapshot();
        if (
          activeRuntimeBinding !== binding ||
          currentLifecycleState?.status !== "ready" ||
          currentLifecycleState.generation !== lifecycleState.generation
        ) {
          if (slot !== "intervals-icu") failModelCredentialRuntimeStates();
          throw new TypeError();
        }
        return result;
      },
    });
    reapplyCredentials = async (connection, signal) => {
      if (signal.aborted) return;
      const revisions = new Map(credentialRuntimeRevisions);
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
      const successorStatuses = await successorVault.credentialStatuses();
      const lifecycleState = daemonLifecycle?.snapshot();
      if (
        signal.aborted ||
        lifecycleState?.status !== "recovering" ||
        lifecycleState.generation + 1 !== connection.generation
      ) {
        return;
      }
      preparedRuntimeBindings.set(connection.generation, {
        binding: successor,
        statuses: successorStatuses,
        revisions,
      });
    };
    const chatGptAuth = createChatGptAuth({
      configDir,
      async applyRuntimeConfig(request) {
        const binding = activeRuntimeBinding!;
        const lifecycleState = daemonLifecycle?.snapshot();
        if (lifecycleState?.status !== "ready") throw new TypeError();
        await binding.credentials.applyExplicit(request);
        const currentLifecycleState = daemonLifecycle?.snapshot();
        if (
          activeRuntimeBinding !== binding ||
          currentLifecycleState?.status !== "ready" ||
          currentLifecycleState.generation !== lifecycleState.generation
        ) {
          failModelCredentialRuntimeStates();
          throw new TypeError();
        }
        markUnselectedModelCredentialsInactive(
          credentialRuntimeState,
          undefined,
          markCredentialRuntimeChange,
        );
      },
      async clearRuntimeCredential() {
        const binding = activeRuntimeBinding!;
        const lifecycleState = daemonLifecycle?.snapshot();
        if (lifecycleState?.status !== "ready") throw new TypeError();
        const result = await binding.credentials.clearCredential("openai-codex");
        const currentLifecycleState = daemonLifecycle?.snapshot();
        if (
          activeRuntimeBinding !== binding ||
          currentLifecycleState?.status !== "ready" ||
          currentLifecycleState.generation !== lifecycleState.generation
        ) {
          failModelCredentialRuntimeStates();
          throw new TypeError();
        }
        if (result === "cleared") {
          markUnselectedModelCredentialsInactive(
            credentialRuntimeState,
            undefined,
            markCredentialRuntimeChange,
          );
        }
        return result;
      },
      getRuntimeConfig: readActiveRuntimeConfig,
      openExternal: (url) => shell.openExternal(url),
      signal: controller.signal,
    });
    const claudeCli = createClaudeCliStatus({
      settings: () => readClaudeCliSettings({ configPath: join(configDir, "config.yaml") }),
      environment: () => process.env,
      async applyRuntimeConfig(request) {
        const binding = activeRuntimeBinding!;
        const lifecycleState = daemonLifecycle?.snapshot();
        if (lifecycleState?.status !== "ready") throw new TypeError();
        await binding.credentials.applyExplicit(request);
        const currentLifecycleState = daemonLifecycle?.snapshot();
        if (
          activeRuntimeBinding !== binding ||
          currentLifecycleState?.status !== "ready" ||
          currentLifecycleState.generation !== lifecycleState.generation
        ) {
          failModelCredentialRuntimeStates();
          throw new TypeError();
        }
        markUnselectedModelCredentialsInactive(
          credentialRuntimeState,
          undefined,
          markCredentialRuntimeChange,
        );
      },
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
          rendererConsoleCapture.attach(created.webContents);
          hardenDesktopWindow(created);
          disposeOnboarding?.();
          disposeOnboarding = registerOnboardingIpc({
            ipcMain,
            dialog,
            window: created,
            vault,
            chatGptAuth,
            claudeCli,
            getRuntimeConfig: readActiveRuntimeConfig,
            applyExistingLlmSelection: async (selection: OnboardingLlmSelection) => {
              const binding = activeRuntimeBinding;
              const lifecycleState = daemonLifecycle?.snapshot();
              if (binding === undefined || lifecycleState?.status !== "ready") {
                throw new TypeError();
              }
              const applied = await binding.credentials.applyExistingLlmSelection(
                selection.provider,
                runtimeConfigurationForExistingSelection(selection),
              );
              const currentLifecycleState = daemonLifecycle?.snapshot();
              if (
                activeRuntimeBinding !== binding ||
                currentLifecycleState?.status !== "ready" ||
                currentLifecycleState.generation !== lifecycleState.generation
              ) {
                throw new TypeError();
              }
              return applied;
            },
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
    disposeTranscriptIpc = installDesktopTranscriptIpc({
      ipcMain,
      currentWindow: () => mainWindow.current() ?? undefined,
      readPage: (request) =>
        readActiveTranscript((reader) => reader.getTranscriptPage(request)),
      readArchivedConversations: (request) =>
        readActiveTranscript((reader) => reader.listArchivedConversations(request)),
      readArchivedPage: (request) =>
        readActiveTranscript((reader) => reader.getArchivedTranscriptPage(request)),
    });
    disposeExternalLinkIpc = installDesktopExternalLinkIpc({
      ipcMain,
      currentWindow: () => mainWindow.current() ?? undefined,
      openExternal: (url) => shell.openExternal(url),
    });
    disposeReleaseNotesIpc = installDesktopReleaseNotesIpc({
      ipcMain,
      currentWindow: () => mainWindow.current() ?? undefined,
    });
    disposeUpdateIpc = installDesktopUpdateIpc({
      ipcMain,
      currentWindow: () => mainWindow.current() ?? undefined,
      isTrusted: (event) => isTrustedConnectionRequest(event, mainWindow.current() ?? undefined),
      controller: updateController,
    });
    residency = createDesktopResidency({
      app,
      mainWindow,
      trayIconPath: resolve(mainDirectory, "../../resources/trayTemplate.png"),
      trayPopoverUrl: rendererSource.trayPopoverUrl,
      reportFailure(operation) {
        process.stderr.write(`desktop-residency-failure ${operation}\n`);
      },
    });
    const initialWindow = await mainWindow.show();
    await residency.start();
    void updateController.start();

    if (securitySmokeMode) {
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
        syncChipPresent: document.querySelector("button.sync-chip") !== null,
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
        syncChipPresent: rendererResult.syncChipPresent,
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
          !rendererConsoleCapture.hasMessageContaining(daemonLifecycle.connection().token) &&
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
  disableChromiumMediaSessionIntegration();
  const runPrimaryDesktop = process.argv.includes("--desktop-runtime-smoke")
    ? runRuntimeSmoke
    : runDesktop;
  void runPrimaryDesktop().catch((error: unknown) => {
    console.error("desktop startup failed", error);
    if (!desktopIsClosing) {
      dialog.showErrorBox(unexpectedStartupCopy.title, unexpectedStartupCopy.content);
    }
    app.exit(1);
  });
}
