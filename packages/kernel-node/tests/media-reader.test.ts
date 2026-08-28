import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { PDFDocument, rgb } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import {
  createManagedMediaReader,
  ManagedMediaReaderError,
  type ManagedImageExtension,
  type ManagedMediaReaderLimits,
} from "@enduragent/kernel-node/chat-attachments";

const LIMITS: ManagedMediaReaderLimits = {
  imageBytes: 20_971_520,
  imageDimension: 8_192,
  imagePixels: 40_000_000,
  documentBytes: 26_214_400,
  pdfPages: 100,
  pdfVisualPages: 10,
  pdfVisualPixels: 16_000_000,
  pdfPageDimension: 4_096,
  parserMs: 30_000,
  parserOldGenerationMiB: 256,
};

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6ggZFCsjqVJGJwAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wOC0yNVQyMDo0MzozNSswMDowML+eSE4AAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDgtMjVUMjA6NDM6MzUrMDA6MDDOw/DyAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA4LTI1VDIwOjQzOjM1KzAwOjAwmdbRLQAAAApJREFUCNdjYAAAAAIAAeIhvDMAAAAASUVORK5CYII=",
  "base64",
);
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=",
  "base64",
);
const WEBP = Buffer.from(
  "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAgA0JaACdLoB+AADsAD+8MQL/yC5YXXI1/8gP+QH/ID/+PIAAAA=",
  "base64",
);

function source(bytes: Uint8Array, extension: ManagedImageExtension) {
  return {
    objectId: `object-${extension}`,
    relativePath: `chat-attachments/${"a".repeat(64)}/object-${extension}`,
    byteSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    extension,
  } as const;
}

function reader(bytes: Uint8Array, limits: ManagedMediaReaderLimits = LIMITS, workerUrl?: URL) {
  return createManagedMediaReader({
    objects: { readObjectBytes: vi.fn(async () => Uint8Array.from(bytes)) },
    limits,
    workerUrl:
      workerUrl ?? new URL("../dist/chat-attachments/media-reader-worker.js", import.meta.url),
  });
}

async function makeVisualPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  page.drawRectangle({ x: 40, y: 80, width: 532, height: 640, color: rgb(0.8, 0.85, 0.9) });
  return Buffer.from(await pdf.save());
}

describe("managed visual media reader", () => {
  it.each([
    ["png", PNG, "image/png"],
    ["jpg", JPEG, "image/jpeg"],
    ["webp", WEBP, "image/webp"],
  ] as const)(
    "validates %s dimensions and returns transient native bytes",
    async (extension, bytes, mediaType) => {
      await expect(reader(bytes).readImage(source(bytes, extension))).resolves.toMatchObject({
        projection: { kind: "managed-image", mediaType, width: 1, height: 1, pixels: 1 },
        payload: { mediaType, width: 1, height: 1 },
      });
    },
  );

  it("rejects excessive dimensions and managed-object integrity failures", async () => {
    await expect(
      reader(PNG, { ...LIMITS, imageDimension: 1 }).readImage({
        ...source(PNG, "png"),
        byteSize: PNG.byteLength + 1,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ManagedMediaReaderError>>({ reason: "integrity_mismatch" }),
    );

    const oversizedHeader = Buffer.from(PNG);
    oversizedHeader.writeUInt32BE(9_000, 16);
    oversizedHeader.writeUInt32BE(crc32(oversizedHeader.subarray(12, 29)) >>> 0, 29);
    const oversizedSource = source(oversizedHeader, "png");
    await expect(reader(oversizedHeader).readImage(oversizedSource)).rejects.toEqual(
      expect.objectContaining<Partial<ManagedMediaReaderError>>({ reason: "limit_exceeded" }),
    );

    const excessivePixels = Buffer.from(PNG);
    excessivePixels.writeUInt32BE(7_000, 16);
    excessivePixels.writeUInt32BE(7_000, 20);
    excessivePixels.writeUInt32BE(crc32(excessivePixels.subarray(12, 29)) >>> 0, 29);
    await expect(reader(excessivePixels).readImage(source(excessivePixels, "png"))).rejects.toEqual(
      expect.objectContaining<Partial<ManagedMediaReaderError>>({ reason: "limit_exceeded" }),
    );

    const corrupted = Buffer.from(PNG);
    corrupted[corrupted.length - 13] ^= 0x01;
    await expect(reader(corrupted).readImage(source(corrupted, "png"))).rejects.toEqual(
      expect.objectContaining<Partial<ManagedMediaReaderError>>({ reason: "validation_failed" }),
    );
  });

  it("renders selected visual-only PDF pages to bounded transient PNGs", async () => {
    const bytes = await makeVisualPdf();
    const payloads = await reader(bytes).renderPdfPages({
      ...source(bytes, "png"),
      extension: "pdf",
      pageNumbers: [1],
    });
    expect(payloads).toMatchObject([
      { mediaType: "image/png", pageNumber: 1, width: 816, height: 1056 },
    ]);
    expect(payloads[0]?.bytes.subarray(0, 8)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it("contains a stalled worker and ships the built worker entry", async () => {
    const stalled = new URL("data:text/javascript,setInterval(() => {}, 1000)");
    await expect(
      reader(PNG, { ...LIMITS, parserMs: 20 }, stalled).readImage(source(PNG, "png")),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ManagedMediaReaderError>>({ reason: "parser_timeout" }),
    );
    await expect(
      stat(new URL("../dist/chat-attachments/media-reader-worker.js", import.meta.url)),
    ).resolves.toMatchObject({ size: expect.any(Number) });
  });
});
