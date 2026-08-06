import { app } from "electron";
import { consumeAcceptanceStartupMarker } from "./startup-mode.js";

consumeAcceptanceStartupMarker(process.env, app);
await import("../../../src/main/index.js");
