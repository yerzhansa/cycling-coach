import { describe, expect, it, vi } from "vitest";

const asar = vi.hoisted(() => {
  const directoryPath = "nested";
  const filePath = "nested\\runtime.bin";
  return {
    directoryPath,
    filePath,
    extractFile: vi.fn((_archivePath: string, listedPath: string) => {
      if (listedPath !== filePath) throw new Error(`unexpected ASAR extraction path: ${listedPath}`);
      return Buffer.from("runtime");
    }),
    listPackage: vi.fn(() => [`\\${directoryPath}`, `\\${filePath}`]),
    statFile: vi.fn((_archivePath: string, listedPath: string) => {
      if (listedPath === directoryPath) return { files: {}, unpacked: false };
      if (listedPath === filePath) return { size: 7, unpacked: false };
      throw new Error(`unexpected ASAR stat path: ${listedPath}`);
    }),
    uncache: vi.fn(),
  };
});

vi.mock("@electron/asar", () => ({
  extractFile: asar.extractFile,
  listPackage: asar.listPackage,
  statFile: asar.statFile,
  uncache: asar.uncache,
}));

import { collectAsar } from "../scripts/package-inventory.mjs";

describe("win32 ASAR inventory paths", () => {
  it("uses raw listed paths for ASAR reads and POSIX paths for inventory keys", () => {
    const inventory = collectAsar("synthetic.asar", {
      archiveLabel: "archive",
      entryLabelRoot: "archive-entry",
    });

    expect([...inventory.keys()]).toEqual(["nested", "nested/runtime.bin"]);
    expect(inventory.get("nested/runtime.bin")).toEqual({
      type: "file",
      unpacked: false,
      bytes: Buffer.from("runtime"),
    });
    expect(asar.statFile).toHaveBeenNthCalledWith(1, "synthetic.asar", "nested", false);
    expect(asar.statFile).toHaveBeenNthCalledWith(2, "synthetic.asar", "nested\\runtime.bin", false);
    expect(asar.extractFile).toHaveBeenCalledWith(
      "synthetic.asar",
      "nested\\runtime.bin",
      false,
    );
  });
});
