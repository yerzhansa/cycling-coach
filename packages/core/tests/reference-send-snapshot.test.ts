import { afterEach, describe, expect, it, vi } from "vitest";
import { GrammyError } from "grammy";
import { sendSnapshotOutput } from "../src/reference/sync/send-snapshot.js";
import type { SnapshotOutput } from "../src/reference/sync/snapshot-debug.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const chunkedOutput = (count: number): SnapshotOutput => ({
  kind: "chunks",
  chunks: Array.from({ length: count }, (_, i) => `chunk-${i}`),
});

const documentOutput = (): SnapshotOutput => ({
  kind: "document",
  buffer: Buffer.from('{"big":"dump"}', "utf8"),
  filename: "snapshot-test.json",
  chunks: ["chunk-fallback-1", "chunk-fallback-2"],
});

const makeGrammyRateLimitError = (retryAfterSec: number): unknown => {
  // GrammyError's constructor is internal; spoof a duck-typed object the
  // helper inspects via instanceof + property access.
  const err = Object.create(GrammyError.prototype) as GrammyError;
  Object.assign(err, {
    error_code: 429,
    description: "Too Many Requests",
    parameters: { retry_after: retryAfterSec },
    method: "sendMessage",
    payload: {},
    message: "Too Many Requests",
  });
  return err;
};

describe("sendSnapshotOutput", () => {
  it("sends every chunk in order when no failures occur", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const r = await sendSnapshotOutput(chunkedOutput(3), { reply, sleep });

    expect(reply).toHaveBeenCalledTimes(3);
    expect(reply).toHaveBeenNthCalledWith(1, "chunk-0");
    expect(reply).toHaveBeenNthCalledWith(2, "chunk-1");
    expect(reply).toHaveBeenNthCalledWith(3, "chunk-2");
    expect(r).toEqual({ sent: 3, total: 3, interrupted: false });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a failing chunk once after sleeping retry_after seconds (Telegram 429)", async () => {
    const reply = vi
      .fn()
      .mockResolvedValueOnce(undefined) // chunk 0
      .mockRejectedValueOnce(makeGrammyRateLimitError(2)) // chunk 1 fails first time
      .mockResolvedValueOnce(undefined) // chunk 1 retry succeeds
      .mockResolvedValueOnce(undefined); // chunk 2
    const sleep = vi.fn().mockResolvedValue(undefined);

    const r = await sendSnapshotOutput(chunkedOutput(3), { reply, sleep });

    expect(reply).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(r).toEqual({ sent: 3, total: 3, interrupted: false });
  });

  it("falls back to a 1s sleep on non-429 transient errors", async () => {
    const reply = vi
      .fn()
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const r = await sendSnapshotOutput(chunkedOutput(1), { reply, sleep });

    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(r).toEqual({ sent: 1, total: 1, interrupted: false });
  });

  it("abandons after a second consecutive failure and sends the 'interrupted at K of N' guidance", async () => {
    const reply = vi
      .fn()
      .mockResolvedValueOnce(undefined) // chunk 0 ok
      .mockResolvedValueOnce(undefined) // chunk 1 ok
      .mockRejectedValueOnce(new Error("network")) // chunk 2 fails
      .mockRejectedValueOnce(new Error("network again")) // retry also fails
      .mockResolvedValueOnce(undefined); // interrupted-message reply
    const sleep = vi.fn().mockResolvedValue(undefined);

    const r = await sendSnapshotOutput(chunkedOutput(5), { reply, sleep });

    expect(r).toEqual({ sent: 2, total: 5, interrupted: true });
    expect(reply).toHaveBeenCalledTimes(5);
    const lastCall = reply.mock.calls.at(-1)![0] as string;
    expect(lastCall).toContain("interrupted at chunk 3 of 5");
    expect(lastCall).toContain("/snapshot raw");
  });

  it("uploads the document via sendDocument when output.kind is document", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendDocument = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const r = await sendSnapshotOutput(documentOutput(), {
      reply,
      sendDocument,
      sleep,
    });

    expect(sendDocument).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
    expect(r).toEqual({ sent: 1, total: 1, interrupted: false });
  });

  it("falls through to chunked-with-retry when sendDocument throws (architect-final F5)", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendDocument = vi.fn().mockRejectedValue(new Error("upload denied"));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const r = await sendSnapshotOutput(documentOutput(), {
      reply,
      sendDocument,
      sleep,
    });

    expect(sendDocument).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledTimes(2); // both fallback chunks
    expect(reply).toHaveBeenNthCalledWith(1, "chunk-fallback-1");
    expect(reply).toHaveBeenNthCalledWith(2, "chunk-fallback-2");
    expect(r).toEqual({ sent: 2, total: 2, interrupted: false });
  });

  it("falls back to default backoff when retry_after is Infinity (would otherwise park ~25 days)", async () => {
    const reply = vi
      .fn()
      .mockRejectedValueOnce(makeGrammyRateLimitError(Infinity))
      .mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const r = await sendSnapshotOutput(chunkedOutput(1), { reply, sleep });

    expect(sleep).toHaveBeenCalledWith(1_000); // default, not Infinity
    expect(r).toEqual({ sent: 1, total: 1, interrupted: false });
  });

  it("falls back to default backoff when retry_after is NaN", async () => {
    const reply = vi
      .fn()
      .mockRejectedValueOnce(makeGrammyRateLimitError(NaN))
      .mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await sendSnapshotOutput(chunkedOutput(1), { reply, sleep });

    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("falls back to default backoff when retry_after exceeds the 300s cap", async () => {
    const reply = vi
      .fn()
      .mockRejectedValueOnce(makeGrammyRateLimitError(999_999))
      .mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await sendSnapshotOutput(chunkedOutput(1), { reply, sleep });

    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("honors retry_after at the 300s cap boundary", async () => {
    const reply = vi
      .fn()
      .mockRejectedValueOnce(makeGrammyRateLimitError(300))
      .mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await sendSnapshotOutput(chunkedOutput(1), { reply, sleep });

    expect(sleep).toHaveBeenCalledWith(300_000);
  });
});
