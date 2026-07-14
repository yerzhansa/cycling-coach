import { describe, it, expect } from "vitest";
import { createMemorySnapshot } from "../src/memory/snapshot.js";
import type { MemoryStore } from "../src/memory.js";

const EMPTY = { garmin: false, nonGarmin: false, unknown: false };

function stubStore(
  readMemory: () => string,
  provenanceForSection: MemoryStore["provenanceForSection"] = () => EMPTY,
): MemoryStore {
  return { readMemory, provenanceForSection } as unknown as MemoryStore;
}

describe("createMemorySnapshot", () => {
  it("reads a section body and reports presence", () => {
    const snap = createMemorySnapshot(
      stubStore(() => "## Athlete Profile\nFTP 247W, 72kg\n## Health\nknee ok"),
    );
    expect(snap.read("Athlete Profile")).toBe("FTP 247W, 72kg");
    expect(snap.has("Athlete Profile")).toBe(true);
    expect(snap.read("Missing")).toBeNull();
    expect(snap.has("Missing")).toBe(false);
  });

  it("keeps an h3 line and an inline marker inside the body (only column-0 splits)", () => {
    const snap = createMemorySnapshot(
      stubStore(
        () =>
          "## Profile\nFTP 250W\n### sub heading stays\nsee a ## marker inline stays\n## Health\nknee ok",
      ),
    );
    expect(snap.listSections()).toEqual(["Profile", "Health"]);
    expect(snap.read("Profile")).toBe(
      "FTP 250W\n### sub heading stays\nsee a ## marker inline stays",
    );
    expect(snap.read("sub heading stays")).toBeNull();
  });

  it("reads an empty body as null with has false", () => {
    const snap = createMemorySnapshot(stubStore(() => "## Empty\n\n## Real\ndata"));
    expect(snap.read("Empty")).toBeNull();
    expect(snap.has("Empty")).toBe(false);
    expect(snap.read("Real")).toBe("data");
    expect(snap.has("Real")).toBe(true);
    expect(snap.listSections()).toEqual(["Empty", "Real"]);
  });

  it("yields no sections for an empty source", () => {
    const snap = createMemorySnapshot(stubStore(() => ""));
    expect(snap.listSections()).toEqual([]);
    expect(snap.read("anything")).toBeNull();
    expect(snap.has("anything")).toBe(false);
  });

  it("freezes the snapshot at call time and stays stable across repeated reads", () => {
    let calls = 0;
    const snap = createMemorySnapshot(
      stubStore(() => {
        calls += 1;
        return calls === 1 ? "## A\nfirst" : "## A\nMUTATED\n## B\nnew";
      }),
    );
    expect(snap.read("A")).toBe("first");
    expect(snap.read("A")).toBe("first");
    expect(snap.has("B")).toBe(false);
    expect(snap.listSections()).toEqual(["A"]);
  });

  it("freezes section provenance with the section contents", () => {
    const garmin = { garmin: true, nonGarmin: false, unknown: false };
    let current = garmin;
    const snap = createMemorySnapshot(
      stubStore(
        () => "## Profile\nFTP 247W",
        () => current,
      ),
    );
    current = EMPTY;

    expect(snap.provenanceOf("Profile")).toEqual(garmin);
    expect(snap.provenanceOf("Missing")).toEqual(EMPTY);
  });
});
