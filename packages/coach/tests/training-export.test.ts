import { mkdtemp, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrustedActivitySourceResolver } from "@enduragent/kernel/store";
import {
  createBoundedTrainingExportFetch,
  createDurableTrainingExportWriter,
  createTrainingExportService,
  type TrainingExportClientFactory,
  type TrainingExportWriter,
} from "../src/training-export.js";

const roots: string[] = [];
const canonicalActivityId = "a".repeat(64);
const validFitBytes = [14, 16, 0, 0, 0, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54, 0, 0];
const validGpxBytes = [...new TextEncoder().encode('<?xml version="1.0"?><gpx version="1.1"/>')];
const validZipBytes = [0x50, 0x4b, 0x05, 0x06];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function availableSource(providerActivityId = "i123"): TrustedActivitySourceResolver {
  return {
    resolve: vi.fn(async () => ({
      kind: "resolved" as const,
      providerActivityId: providerActivityId as never,
      sourceRevision: "b".repeat(64),
    })),
  };
}

function credentials(
  apiKey = "secret",
  athleteId = "athlete",
): {
  read(): Promise<{ readonly apiKey: string; readonly athleteId: string }>;
} {
  return { read: vi.fn(async () => ({ apiKey, athleteId })) };
}

function binary(
  bytes: readonly number[],
  metadata?: { readonly filename?: string | null; readonly contentType?: string | null },
) {
  return {
    ok: true as const,
    value: {
      bytes: Uint8Array.from(bytes).buffer as ArrayBuffer,
      filename: metadata?.filename ?? "ride.fit",
      contentType: metadata?.contentType ?? "application/octet-stream",
      contentLength: bytes.length,
      contentEncoding: null,
    },
  };
}

function clientFactory(input: {
  readonly downloadFitFile?: ReturnType<typeof vi.fn>;
  readonly downloadGpxFile?: ReturnType<typeof vi.fn>;
  readonly downloadZip?: ReturnType<typeof vi.fn>;
}): TrainingExportClientFactory {
  return vi.fn(
    () =>
      ({
        activities: {
          downloadFitFile: input.downloadFitFile ?? vi.fn(),
          downloadGpxFile: input.downloadGpxFile ?? vi.fn(),
        },
        workouts: { downloadZip: input.downloadZip ?? vi.fn() },
      }) as never,
  );
}

describe("training export service", () => {
  it("resolves a canonical ride privately and writes a bounded FIT export with metadata", async () => {
    const downloadFitFile = vi.fn(async () =>
      binary(validFitBytes, {
        filename: "Morning Ride.fit",
        contentType: "application/vnd.ant.fit",
      }),
    );
    const retained: Uint8Array[] = [];
    const copies: Uint8Array[] = [];
    const writer: TrainingExportWriter = {
      write: vi.fn(async ({ bytes }) => {
        retained.push(bytes);
        copies.push(Uint8Array.from(bytes));
        return "committed" as const;
      }),
    };
    const sources = availableSource("provider-42");
    const service = createTrainingExportService({
      credentials: credentials(),
      sources,
      writer,
      createClient: clientFactory({ downloadFitFile }),
    });

    await expect(
      service.export({
        kind: "activity",
        canonicalActivityId,
        format: "fit",
        destinationPath: "/tmp/ride.fit",
      }),
    ).resolves.toEqual({
      status: "exported",
      byteLength: validFitBytes.length,
      suggestedFilename: "Morning Ride.fit",
      contentType: "application/vnd.ant.fit",
    });
    expect(sources.resolve).toHaveBeenCalledWith({ canonicalActivityId });
    expect(downloadFitFile).toHaveBeenCalledWith("provider-42", {
      includeMetadata: true,
      power: true,
      hr: true,
    });
    expect(copies[0]).toEqual(Uint8Array.from(validFitBytes));
    expect(retained[0]).toEqual(Uint8Array.from(validFitBytes, () => 0));
  });

  it("routes GPX and workout ZIP formats through their typed metadata methods", async () => {
    const downloadGpxFile = vi.fn(async () =>
      binary(validGpxBytes, { filename: "ride.gpx", contentType: "application/gpx+xml" }),
    );
    const downloadZip = vi.fn(async () =>
      binary(validZipBytes, { filename: "workouts.zip", contentType: "application/zip" }),
    );
    const writer: TrainingExportWriter = { write: vi.fn(async () => "committed" as const) };
    const sources = availableSource();
    const createClient = clientFactory({ downloadGpxFile, downloadZip });
    const service = createTrainingExportService({
      credentials: credentials(),
      sources,
      writer,
      createClient,
    });

    await service.export({
      kind: "activity",
      canonicalActivityId,
      format: "gpx",
      destinationPath: "/tmp/ride.gpx",
    });
    await expect(
      service.export({
        kind: "workout-archive",
        oldest: "1998-07-20",
        newest: "1998-07-26",
        format: "zwo",
        destinationPath: "/tmp/workouts.zip",
      }),
    ).resolves.toMatchObject({ status: "exported", byteLength: validZipBytes.length });
    expect(downloadGpxFile).toHaveBeenCalledWith("i123", {
      includeMetadata: true,
      power: true,
      hr: true,
    });
    expect(downloadZip).toHaveBeenCalledWith({
      format: "zwo",
      oldest: "1998-07-20",
      newest: "1998-07-26",
      includeMetadata: true,
    });
    expect(sources.resolve).toHaveBeenCalledTimes(1);
  });

  it("refuses missing or ambiguous ride authority before reading credentials", async () => {
    const read = vi.fn(async () => ({ apiKey: "secret", athleteId: "athlete" }));
    for (const reason of ["not_found", "ambiguous"] as const) {
      const service = createTrainingExportService({
        credentials: { read },
        sources: { resolve: vi.fn(async () => ({ kind: "unavailable" as const, reason })) },
        writer: { write: vi.fn(async () => "committed" as const) },
        createClient: clientFactory({}),
      });
      await expect(
        service.export({
          kind: "activity",
          canonicalActivityId,
          format: "fit",
          destinationPath: "/tmp/ride.fit",
        }),
      ).resolves.toEqual({
        status: "refused",
        reason: reason === "ambiguous" ? "ambiguous-source" : "source-not-found",
      });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("requires configured credentials and maps provider and writer failures", async () => {
    const request = {
      kind: "workout-archive" as const,
      oldest: "1998-07-20",
      newest: "1998-07-26",
      format: "fit" as const,
      destinationPath: "/tmp/workouts.zip",
    };
    const missing = createTrainingExportService({
      credentials: credentials("", ""),
      sources: availableSource(),
      writer: { write: vi.fn(async () => "committed" as const) },
      createClient: clientFactory({}),
    });
    await expect(missing.export(request)).resolves.toEqual({
      status: "refused",
      reason: "not-configured",
    });

    const rateLimited = createTrainingExportService({
      credentials: credentials(),
      sources: availableSource(),
      writer: { write: vi.fn(async () => "committed" as const) },
      createClient: clientFactory({
        downloadZip: vi.fn(async () => ({
          ok: false,
          error: { kind: "RateLimit", status: 429, retryAfterMs: 1_000, body: null },
        })),
      }),
    });
    await expect(rateLimited.export(request)).resolves.toEqual({
      status: "refused",
      reason: "rate-limited",
    });

    for (const [outcome, reason] of [
      ["failed", "write-failed"],
      ["uncertain", "commit-uncertain"],
    ] as const) {
      const service = createTrainingExportService({
        credentials: credentials(),
        sources: availableSource(),
        writer: { write: vi.fn(async () => outcome) },
        createClient: clientFactory({ downloadZip: vi.fn(async () => binary(validZipBytes)) }),
      });
      await expect(service.export(request)).resolves.toEqual({ status: "refused", reason });
    }

    const thrownProvider = createTrainingExportService({
      credentials: credentials(),
      sources: availableSource(),
      writer: { write: vi.fn(async () => "committed" as const) },
      createClient: clientFactory({
        downloadZip: vi.fn(async () => {
          throw new Error("private provider failure");
        }),
      }),
    });
    await expect(thrownProvider.export(request)).resolves.toEqual({
      status: "refused",
      reason: "provider-unavailable",
    });

    const thrownWriter = createTrainingExportService({
      credentials: credentials(),
      sources: availableSource(),
      writer: {
        write: vi.fn(async () => {
          throw new Error("private filesystem failure");
        }),
      },
      createClient: clientFactory({ downloadZip: vi.fn(async () => binary(validZipBytes)) }),
    });
    await expect(thrownWriter.export(request)).resolves.toEqual({
      status: "refused",
      reason: "write-failed",
    });
  });

  it("reports a file committed while the caller disconnects instead of inviting a retry", async () => {
    const controller = new AbortController();
    const service = createTrainingExportService({
      credentials: credentials(),
      sources: availableSource(),
      writer: {
        write: vi.fn(async () => {
          controller.abort(new Error("caller detached"));
          return "committed" as const;
        }),
      },
      createClient: clientFactory({ downloadZip: vi.fn(async () => binary(validZipBytes)) }),
    });
    await expect(
      service.export(
        {
          kind: "workout-archive",
          oldest: "1998-07-20",
          newest: "1998-07-26",
          format: "zwo",
          destinationPath: "/tmp/workouts.zip",
        },
        controller.signal,
      ),
    ).resolves.toMatchObject({ status: "exported", byteLength: validZipBytes.length });
  });

  it("rejects empty, oversized, or unexpected content without exposing metadata", async () => {
    const request = {
      kind: "workout-archive" as const,
      oldest: "1998-07-20",
      newest: "1998-07-26",
      format: "erg" as const,
      destinationPath: "/tmp/workouts.zip",
    };
    const empty = createTrainingExportService({
      credentials: credentials(),
      sources: availableSource(),
      writer: { write: vi.fn(async () => "committed" as const) },
      createClient: clientFactory({ downloadZip: vi.fn(async () => binary([])) }),
    });
    await expect(empty.export(request)).resolves.toEqual({
      status: "refused",
      reason: "invalid-response",
    });

    const oversized = createTrainingExportService({
      credentials: credentials(),
      sources: availableSource(),
      maximumWorkoutArchiveBytes: 1,
      writer: { write: vi.fn(async () => "committed" as const) },
      createClient: clientFactory({ downloadZip: vi.fn(async () => binary(validZipBytes)) }),
    });
    await expect(oversized.export(request)).resolves.toEqual({
      status: "refused",
      reason: "response-too-large",
    });

    const sanitized = createTrainingExportService({
      credentials: credentials(),
      sources: availableSource(),
      writer: { write: vi.fn(async () => "committed" as const) },
      createClient: clientFactory({
        downloadZip: vi.fn(async () =>
          binary(validZipBytes, { filename: "../secret.zip", contentType: "application/zip" }),
        ),
      }),
    });
    await expect(sanitized.export(request)).resolves.toMatchObject({
      status: "exported",
      suggestedFilename: null,
      contentType: "application/zip",
    });

    const unexpectedWriter = { write: vi.fn(async () => "committed" as const) };
    const unexpectedContent = createTrainingExportService({
      credentials: credentials(),
      sources: availableSource(),
      writer: unexpectedWriter,
      createClient: clientFactory({
        downloadZip: vi.fn(async () =>
          binary([1], { filename: "private.html", contentType: "text/html; charset=utf-8" }),
        ),
      }),
    });
    await expect(unexpectedContent.export(request)).resolves.toEqual({
      status: "refused",
      reason: "invalid-response",
    });
    expect(unexpectedWriter.write).not.toHaveBeenCalled();

    const invalidSignatureWriter = { write: vi.fn(async () => "committed" as const) };
    const invalidSignature = createTrainingExportService({
      credentials: credentials(),
      sources: availableSource(),
      writer: invalidSignatureWriter,
      createClient: clientFactory({ downloadZip: vi.fn(async () => binary([1, 2, 3, 4])) }),
    });
    await expect(invalidSignature.export(request)).resolves.toEqual({
      status: "refused",
      reason: "invalid-response",
    });
    expect(invalidSignatureWriter.write).not.toHaveBeenCalled();
  });
});

describe("bounded training export fetch", () => {
  it("stops declared and streamed responses above the private byte limit", async () => {
    const declared = vi.fn(
      async () => new Response(Uint8Array.from([1]), { headers: { "content-length": "3" } }),
    );
    const noteDeclared = vi.fn();
    await expect(
      createBoundedTrainingExportFetch({
        baseFetch: declared,
        maximumBytes: 2,
        noteLimitExceeded: noteDeclared,
      })("https://example.test"),
    ).rejects.toThrow("private byte limit");
    expect(noteDeclared).toHaveBeenCalledOnce();

    const streamed = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Uint8Array.from([1, 2]));
              controller.enqueue(Uint8Array.from([3]));
              controller.close();
            },
          }),
        ),
    );
    const noteStreamed = vi.fn();
    await expect(
      createBoundedTrainingExportFetch({
        baseFetch: streamed,
        maximumBytes: 2,
        noteLimitExceeded: noteStreamed,
      })("https://example.test"),
    ).rejects.toThrow("private byte limit");
    expect(noteStreamed).toHaveBeenCalledOnce();
  });
});

describe("durable training export writer", () => {
  it("writes mode-0600 bytes atomically in the selected directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "enduragent-export-"));
    roots.push(root);
    const destinationPath = join(root, "ride.fit");
    const writer = createDurableTrainingExportWriter({ createTemporaryId: () => "fixed" });

    await expect(
      writer.write({ destinationPath, bytes: Uint8Array.from([1, 2, 3]) }),
    ).resolves.toBe("committed");
    expect(await readFile(destinationPath)).toEqual(Buffer.from([1, 2, 3]));
    expect((await stat(destinationPath)).mode & 0o777).toBe(0o600);
    expect(await readdir(root)).toEqual(["ride.fit"]);
  });

  it("distinguishes pre-commit failure from post-rename commit uncertainty", async () => {
    const root = await mkdtemp(join(tmpdir(), "enduragent-export-state-"));
    roots.push(root);
    const destinationPath = join(root, "workouts.zip");
    const failed = createDurableTrainingExportWriter({
      createTemporaryId: () => "failed",
      openFile: vi.fn(async () => {
        throw new Error("open failed");
      }) as never,
    });
    await expect(failed.write({ destinationPath, bytes: Uint8Array.from([1]) })).resolves.toBe(
      "failed",
    );

    const uncertain = createDurableTrainingExportWriter({
      createTemporaryId: () => "uncertain",
      renameFile: rename,
      syncDirectory: vi.fn(async () => {
        throw new Error("directory sync failed");
      }),
    });
    await expect(uncertain.write({ destinationPath, bytes: Uint8Array.from([2]) })).resolves.toBe(
      "uncertain",
    );
    expect(await readFile(destinationPath)).toEqual(Buffer.from([2]));
  });
});
