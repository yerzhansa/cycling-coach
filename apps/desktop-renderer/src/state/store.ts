import { create } from "zustand";
import type { StoredViewId } from "../app/views.js";
import {
  applyPalette,
  resolveTheme,
  type Appearance,
  type ResolvedTheme,
} from "../theme/applyPalette.js";
import { publishNativeAppearance } from "../theme/nativeAppearance.js";
import { paletteById } from "../theme/palettes.js";
import {
  readStoredAppearance,
  readStoredPaletteId,
  writeStoredAppearance,
  writeStoredPaletteId,
} from "../theme/preferences.js";
import { createArchiveSlice, type ArchiveSlice } from "./archive-slice.js";
import {
  createActivityAnalysisSlice,
  type ActivityAnalysisSlice,
} from "./activity-analysis-slice.js";
import { createChatSlice, type ChatSlice } from "./chat-slice.js";
import { createOnboardingSlice, type OnboardingSlice } from "./onboarding-slice.js";
import { createPlanSlice, type PlanSlice } from "./plan-slice.js";
import { createRideImportSlice, type RideImportSlice } from "./ride-import-slice.js";
import {
  createSettingsSlice,
  settingsMutationActive,
  type SettingsSlice,
} from "./settings-slice.js";
import { createSyncSlice, type SyncSlice } from "./sync-slice.js";
import { createTrainingSlice, type TrainingSlice } from "./training-slice.js";
import { createTrainingExportSlice, type TrainingExportSlice } from "./training-export-slice.js";

export interface EnduragentState
  extends
    ChatSlice,
    ArchiveSlice,
    SettingsSlice,
    TrainingSlice,
    PlanSlice,
    TrainingExportSlice,
    ActivityAnalysisSlice,
    SyncSlice,
    RideImportSlice,
    OnboardingSlice {
  readonly activeView: StoredViewId;
  readonly paletteId: string;
  readonly appearance: Appearance;
  readonly theme: ResolvedTheme;
  readonly runtimeReady: boolean;
  setActiveView: (view: StoredViewId) => void;
  setPaletteId: (paletteId: string) => void;
  setAppearance: (appearance: Appearance) => void;
  refreshTheme: () => void;
  markRuntimeReady: () => void;
}

function stamp(paletteId: string, appearance: Appearance): ResolvedTheme {
  if (typeof document === "undefined") return resolveTheme(appearance);
  return applyPalette({
    root: document.documentElement,
    palette: paletteById(paletteId),
    appearance,
  });
}

export const useEnduragentStore = create<EnduragentState>((set, get, api) => ({
  ...createChatSlice(set, get, api),
  ...createArchiveSlice(set, get, api),
  ...createSettingsSlice(set, get, api),
  ...createTrainingSlice(set, get, api),
  ...createPlanSlice(set, get, api),
  ...createTrainingExportSlice(set, get, api),
  ...createActivityAnalysisSlice(set, get, api),
  ...createSyncSlice(set, get, api),
  ...createRideImportSlice(set, get, api),
  ...createOnboardingSlice(set, get, api),
  activeView: "chat",
  paletteId: readStoredPaletteId(),
  appearance: readStoredAppearance(),
  theme: resolveTheme(readStoredAppearance()),
  runtimeReady: false,
  setActiveView(view) {
    const current = get();
    if (current.activeView === "settings" && settingsMutationActive(current.settings)) return;
    set({ activeView: view });
  },
  setPaletteId(paletteId) {
    writeStoredPaletteId(paletteId);
    set({ paletteId, theme: stamp(paletteId, get().appearance) });
  },
  setAppearance(appearance) {
    writeStoredAppearance(appearance);
    publishNativeAppearance(appearance);
    set({ appearance, theme: stamp(get().paletteId, appearance) });
  },
  refreshTheme() {
    const { paletteId, appearance } = get();
    set({ theme: stamp(paletteId, appearance) });
  },
  markRuntimeReady() {
    set({ runtimeReady: true });
  },
}));

export function bootTheme(): ResolvedTheme {
  const { paletteId, appearance } = useEnduragentStore.getState();
  publishNativeAppearance(appearance);
  const theme = stamp(paletteId, appearance);
  useEnduragentStore.setState({ theme });
  return theme;
}
