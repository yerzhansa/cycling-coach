import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_CONNECTION_CHANNEL } from "../main/constants.js";

contextBridge.exposeInMainWorld(
  "enduragentAuth",
  Object.freeze({
    getDaemonConnection: () => ipcRenderer.invoke(DESKTOP_CONNECTION_CHANNEL),
  }),
);
