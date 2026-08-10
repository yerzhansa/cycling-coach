import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface WindowsIconGeneratorModule {
  readonly APPLICATION_ICON_SIZES: readonly number[];
  readonly TRAY_ICON_SIZES: readonly number[];
  readonly createPngIco: (frames: Array<{ readonly size: number; readonly png: Buffer }>) => Buffer;
}

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorModuleUrl = new URL("../scripts/generate-windows-icons.mjs", import.meta.url).href;
const { APPLICATION_ICON_SIZES, TRAY_ICON_SIZES, createPngIco } = (await import(
  generatorModuleUrl
)) as WindowsIconGeneratorModule;
const icoSignature = Buffer.from([0, 0, 1, 0]);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngFrame(size: number): Buffer {
  const frame = Buffer.alloc(24);
  pngSignature.copy(frame);
  frame.write("IHDR", 12, "ascii");
  frame.writeUInt32BE(size, 16);
  frame.writeUInt32BE(size, 20);
  return frame;
}

describe("Windows icon generation", () => {
  it("encodes the declared PNG frames as an ICO directory and payload", () => {
    const smallFrame = pngFrame(16);
    const largeFrame = pngFrame(256);
    const ico = createPngIco([
      { size: 16, png: smallFrame },
      { size: 256, png: largeFrame },
    ]);

    expect(APPLICATION_ICON_SIZES).toEqual([16, 24, 32, 48, 64, 128, 256]);
    expect(TRAY_ICON_SIZES).toEqual([16, 20, 24, 32, 40, 48]);
    expect(ico.subarray(0, 4)).toEqual(icoSignature);
    expect(ico.readUInt16LE(4)).toBe(2);
    expect(ico.readUInt8(6)).toBe(16);
    expect(ico.readUInt8(7)).toBe(16);
    expect(ico.readUInt16LE(10)).toBe(1);
    expect(ico.readUInt16LE(12)).toBe(32);
    expect(ico.readUInt32LE(14)).toBe(smallFrame.length);
    expect(ico.readUInt32LE(18)).toBe(38);
    expect(ico.readUInt8(22)).toBe(0);
    expect(ico.readUInt8(23)).toBe(0);
    expect(ico.readUInt32LE(30)).toBe(largeFrame.length);
    expect(ico.readUInt32LE(34)).toBe(38 + smallFrame.length);
    expect(ico.subarray(38, 38 + smallFrame.length)).toEqual(smallFrame);
    expect(ico.subarray(38 + smallFrame.length)).toEqual(largeFrame);
  });

  it("keeps the Windows builder wired to the committed ICO resources", async () => {
    const builder = parse(await readFile(join(desktopRoot, "electron-builder.yml"), "utf8"));

    expect(builder.win).toEqual({
      icon: "resources/app-icon.ico",
      signExecutable: false,
      files: ["resources/tray.ico"],
      target: [{ target: "dir", arch: ["x64"] }],
    });
  });

  it.each(["app-icon.ico", "tray.ico"])(
    "commits a non-empty valid ICO header for %s",
    async (name) => {
      const bytes = await readFile(join(desktopRoot, "resources", name));

      expect(bytes.length).toBeGreaterThan(4);
      expect(bytes.subarray(0, icoSignature.length)).toEqual(icoSignature);
    },
  );
});
