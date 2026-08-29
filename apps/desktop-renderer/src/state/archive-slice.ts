import type { StateCreator } from "zustand";
import { EMPTY_ARCHIVE_SURFACE, type ArchiveViewState } from "../archive/controller.js";
import type { EnduragentState } from "./store.js";

export interface ArchiveActions {
  refresh(): void;
  open(boundaryRef: string): void;
  close(): void;
  loadEarlier(): void;
  retry(): void;
  requestDeletion(boundaryRef: string): void;
  cancelDeletion(): void;
  confirmDeletion(): void;
}

export interface ArchiveSlice {
  readonly archive: ArchiveViewState;
  readonly archiveActions: ArchiveActions | null;
  setArchive: (next: ArchiveViewState) => void;
  bindArchiveActions: (actions: ArchiveActions | null) => void;
}

export const createArchiveSlice: StateCreator<EnduragentState, [], [], ArchiveSlice> = (set) => ({
  archive: EMPTY_ARCHIVE_SURFACE,
  archiveActions: null,
  setArchive(next) {
    set({ archive: next });
  },
  bindArchiveActions(actions) {
    set({ archiveActions: actions });
  },
});
