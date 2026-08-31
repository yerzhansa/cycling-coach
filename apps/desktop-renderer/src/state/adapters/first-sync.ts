import type { FirstSyncState } from "../../first-sync";

export interface FirstSyncViewAdapter {
  render(state: FirstSyncState): void;
}

export function createFirstSyncViewAdapter(input: {
  readonly publish: (next: FirstSyncState) => void;
}): FirstSyncViewAdapter {
  return {
    render(state) {
      input.publish(state);
    },
  };
}
