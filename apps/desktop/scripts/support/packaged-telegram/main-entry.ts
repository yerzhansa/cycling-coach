import { app } from "electron";
import { runTelegramAcceptanceBootstrap } from "./process-safety.js";
import { consumeAcceptanceStartupMarker } from "./startup-mode.js";

await runTelegramAcceptanceBootstrap({
  input: process.stdin,
  beforeImport: () => consumeAcceptanceStartupMarker(process.env, app),
  importProduction: () => import("../../../src/main/index.js"),
  quit: () => app.quit(),
  report: (diagnostic) => process.stderr.write(`${diagnostic}\n`),
  exit: (code) => {
    process.exitCode = code;
    app.exit(code);
  },
});
