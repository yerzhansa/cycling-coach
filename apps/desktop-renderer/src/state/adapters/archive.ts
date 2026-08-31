import type { ArchiveView, ArchiveViewState } from "../../archive/controller";

export interface ArchiveViewAdapter {
  readonly view: ArchiveView;
}

export function createArchiveViewAdapter(input: {
  readonly publish: (next: ArchiveViewState) => void;
}): ArchiveViewAdapter {
  return {
    view: {
      render(state) {
        input.publish(state);
      },
    },
  };
}
