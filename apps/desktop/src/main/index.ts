import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, session, utilityProcess } from "electron";
import { DESKTOP_CONNECTION_CHANNEL, DESKTOP_RENDERER_URL, DESKTOP_SCHEME } from "./constants.js";
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
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      controller.abort();
      if (connectionHandlerInstalled) {
        ipcMain.removeHandler(DESKTOP_CONNECTION_CHANNEL);
        connectionHandlerInstalled = false;
      }
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
      return {
        url: location.href,
        bridgeKeys: Object.keys(window.enduragentAuth ?? {}),
        noNodeGlobals: ["process", "require", "Buffer", "global", "module"].every((key) => typeof window[key] === "undefined"),
        rpcConnected: document.documentElement.dataset.rpc === "connected",
        blockedOffPort: blocked,
        drawerPresent: document.querySelector('.drawer[aria-label="Training context"]') !== null,
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
