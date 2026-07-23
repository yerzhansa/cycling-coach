import { describe, expect, it, vi } from "vitest";

import {
  fetchLatestReleaseNotes,
  parseRepoFromUrl,
  parseUserFacing,
  type ReleaseNotesFetch,
} from "../src/release-notes.js";

const REPO = { owner: "yerzhansa", name: "cycling-coach" };
const RELEASES_URL = "https://github.com/yerzhansa/cycling-coach/releases";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("parseRepoFromUrl", () => {
  it("parses git+https URL with .git suffix", () => {
    expect(parseRepoFromUrl("git+https://github.com/foo/bar.git")).toEqual({
      owner: "foo",
      name: "bar",
    });
  });

  it("parses ssh URL", () => {
    expect(parseRepoFromUrl("git@github.com:foo/bar.git")).toEqual({ owner: "foo", name: "bar" });
  });

  it("parses bare https URL without .git", () => {
    expect(parseRepoFromUrl("https://github.com/foo/bar")).toEqual({ owner: "foo", name: "bar" });
  });

  it("ignores trailing #readme fragment", () => {
    expect(parseRepoFromUrl("https://github.com/foo/bar#readme")).toEqual({
      owner: "foo",
      name: "bar",
    });
  });

  it("returns null for non-GitHub host", () => {
    expect(parseRepoFromUrl("https://gitlab.com/foo/bar.git")).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(parseRepoFromUrl("not-a-url")).toBeNull();
  });
});

describe("parseUserFacing", () => {
  it("extracts a single user-facing line and drops the changeset hash prefix", () => {
    const body = "- abc1234: User-facing: Added /review command.\n\n  Engineering: stuff.";
    expect(parseUserFacing(body)).toEqual(["Added /review command."]);
  });

  it("extracts multiple user-facing lines", () => {
    const body = [
      "- abc1234: User-facing: First change.",
      "- def5678: User-facing: Second change.",
    ].join("\n");
    expect(parseUserFacing(body)).toEqual(["First change.", "Second change."]);
  });

  it("returns empty when no user-facing lines exist", () => {
    expect(parseUserFacing("- abc: Pure infra change.\n\n  Engineering details only.")).toEqual([]);
  });

  it("is case-insensitive", () => {
    const body = "user-facing: lowercase works.\nUSER-FACING: caps works.";
    expect(parseUserFacing(body)).toEqual(["lowercase works.", "caps works."]);
  });

  it("trims surrounding whitespace from the captured text", () => {
    expect(parseUserFacing("User-facing:    padded value   ")).toEqual(["padded value"]);
  });

  it("matches when the line is indented inside a sub-bullet", () => {
    const body = "  - User-facing: Indented entry.";
    expect(parseUserFacing(body)).toEqual(["Indented entry."]);
  });

  it("ignores mid-line phantom markers", () => {
    const body = "Engineering prose mentions User-facing: but this is not a release-note marker.";
    expect(parseUserFacing(body)).toEqual([]);
  });

  it("accepts only a changelog bullet and hexadecimal hash before the marker", () => {
    expect(parseUserFacing("- af3186e: User-facing: Published entry.")).toEqual([
      "Published entry.",
    ]);
    expect(parseUserFacing("- abc123: User-facing: Too-short hash.")).toEqual([]);
    expect(parseUserFacing("- not-a-hash: User-facing: Phantom entry.")).toEqual([]);
  });

  it("ignores empty captures", () => {
    expect(parseUserFacing("User-facing:\nUser-facing: real one.")).toEqual(["real one."]);
  });
});

describe("fetchLatestReleaseNotes", () => {
  it("looks up npm latest and then the exact GitHub release tag", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: ReleaseNotesFetch = vi.fn(async (url, init) => {
      requests.push({ url, init });
      if (requests.length === 1) return jsonResponse({ version: "2026.7.23" });
      return jsonResponse({
        body: [
          "- af3186e: User-facing: Added desktop release notes.",
          "Engineering detail.",
          "  User-facing: Improved update guidance.",
        ].join("\n"),
        html_url: "https://attacker.invalid/not-used",
      });
    });

    await expect(
      fetchLatestReleaseNotes("cycling-coach", REPO, { fetch: fetchImpl }),
    ).resolves.toEqual({
      status: "available",
      version: "2026.7.23",
      notes: ["Added desktop release notes.", "Improved update guidance."],
      releaseUrl: `${RELEASES_URL}/tag/cycling-coach@2026.7.23`,
    });
    expect(requests.map(({ url }) => url)).toEqual([
      "https://registry.npmjs.org/cycling-coach/latest",
      "https://api.github.com/repos/yerzhansa/cycling-coach/releases/tags/cycling-coach@2026.7.23",
    ]);
    expect(requests[1].init?.headers).toEqual({ Accept: "application/vnd.github+json" });
    expect(requests.every(({ init }) => init?.redirect === "error")).toBe(true);
  });

  it("returns available with an empty notes list", async () => {
    const fetchImpl: ReleaseNotesFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ version: "2026.7.23" }))
      .mockResolvedValueOnce(jsonResponse({ body: "Engineering details only." }));

    await expect(
      fetchLatestReleaseNotes("cycling-coach", REPO, { fetch: fetchImpl }),
    ).resolves.toEqual({
      status: "available",
      version: "2026.7.23",
      notes: [],
      releaseUrl: `${RELEASES_URL}/tag/cycling-coach@2026.7.23`,
    });
  });

  it("fails closed when npm is unavailable", async () => {
    const fetchImpl: ReleaseNotesFetch = vi.fn(async () => jsonResponse({}, 503));
    await expect(
      fetchLatestReleaseNotes("cycling-coach", REPO, { fetch: fetchImpl }),
    ).resolves.toEqual({
      status: "unavailable",
      version: null,
      releaseUrl: RELEASES_URL,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a registry redirect without attempting GitHub", async () => {
    let streamCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        streamCancelled = true;
      },
    });
    const fetchImpl: ReleaseNotesFetch = vi.fn(
      async () =>
        new Response(stream, {
          status: 302,
          headers: { Location: "https://attacker.invalid/latest" },
        }),
    );
    await expect(
      fetchLatestReleaseNotes("cycling-coach", REPO, { fetch: fetchImpl }),
    ).resolves.toEqual({
      status: "unavailable",
      version: null,
      releaseUrl: RELEASES_URL,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(streamCancelled).toBe(true);
  });

  it("preserves the known version and local tag URL when GitHub fails", async () => {
    const fetchImpl: ReleaseNotesFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ version: "2026.7.23" }))
      .mockRejectedValueOnce(new Error("remote details must not escape"));

    await expect(
      fetchLatestReleaseNotes("cycling-coach", REPO, { fetch: fetchImpl }),
    ).resolves.toEqual({
      status: "unavailable",
      version: "2026.7.23",
      releaseUrl: `${RELEASES_URL}/tag/cycling-coach@2026.7.23`,
    });
  });

  it("aborts a timed-out request and never throws", async () => {
    let observedAbort = false;
    const fetchImpl: ReleaseNotesFetch = vi.fn(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    );

    await expect(
      fetchLatestReleaseNotes("cycling-coach", REPO, { fetch: fetchImpl, timeoutMs: 1 }),
    ).resolves.toEqual({
      status: "unavailable",
      version: null,
      releaseUrl: RELEASES_URL,
    });
    expect(observedAbort).toBe(true);
  });

  it("times out after response headers when the streamed body never finishes", async () => {
    let streamCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"version":"2026.7.23"'));
      },
      cancel() {
        streamCancelled = true;
      },
    });
    const fetchImpl: ReleaseNotesFetch = vi.fn(async () => new Response(stream));

    await expect(
      fetchLatestReleaseNotes("cycling-coach", REPO, { fetch: fetchImpl, timeoutMs: 1 }),
    ).resolves.toEqual({
      status: "unavailable",
      version: null,
      releaseUrl: RELEASES_URL,
    });
    expect(streamCancelled).toBe(true);
  });

  it("caps an excessive supplied timeout at 30 seconds", async () => {
    vi.useFakeTimers();
    let observedAbort = false;
    const fetchImpl: ReleaseNotesFetch = vi.fn(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    );

    try {
      const result = fetchLatestReleaseNotes("cycling-coach", REPO, {
        fetch: fetchImpl,
        timeoutMs: Number.MAX_SAFE_INTEGER,
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(observedAbort).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({ status: "unavailable", version: null });
      expect(observedAbort).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors an already-aborted caller signal without making a request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl: ReleaseNotesFetch = vi.fn();

    await expect(
      fetchLatestReleaseNotes("cycling-coach", REPO, {
        fetch: fetchImpl,
        signal: controller.signal,
      }),
    ).resolves.toEqual({
      status: "unavailable",
      version: null,
      releaseUrl: RELEASES_URL,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", {}],
    ["wrong type", { version: 20260723 }],
    ["malformed", { version: "not-a-version" }],
    ["oversize", { version: `1.0.0-${"a".repeat(65)}` }],
    ["unsafe", { version: "1.0.0/../../latest" }],
  ])("rejects a %s npm version", async (_label, registryBody) => {
    const fetchImpl: ReleaseNotesFetch = vi.fn(async () => jsonResponse(registryBody));
    await expect(
      fetchLatestReleaseNotes("cycling-coach", REPO, { fetch: fetchImpl }),
    ).resolves.toEqual({
      status: "unavailable",
      version: null,
      releaseUrl: RELEASES_URL,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a registry response over 64 KiB", async () => {
    const fetchImpl: ReleaseNotesFetch = vi.fn(async () =>
      jsonResponse({ version: "2026.7.23", padding: "x".repeat(64 * 1024) }),
    );
    await expect(
      fetchLatestReleaseNotes("cycling-coach", REPO, { fetch: fetchImpl }),
    ).resolves.toMatchObject({ status: "unavailable", version: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cancels a registry body rejected from its oversized content-length header", async () => {
    let streamCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        streamCancelled = true;
      },
    });
    const fetchImpl: ReleaseNotesFetch = vi.fn(
      async () =>
        new Response(stream, {
          headers: { "Content-Length": String(64 * 1024 + 1) },
        }),
    );

    await expect(
      fetchLatestReleaseNotes("cycling-coach", REPO, { fetch: fetchImpl }),
    ).resolves.toMatchObject({ status: "unavailable", version: null });
    expect(streamCancelled).toBe(true);
  });

  it("rejects a GitHub response over 256 KiB without parsing it unbounded", async () => {
    const fetchImpl: ReleaseNotesFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ version: "2026.7.23" }))
      .mockResolvedValueOnce(jsonResponse({ body: "x".repeat(256 * 1024) }));

    await expect(
      fetchLatestReleaseNotes("cycling-coach", REPO, { fetch: fetchImpl }),
    ).resolves.toMatchObject({ status: "unavailable", version: "2026.7.23" });
  });

  it("rejects more than 100 user-facing notes rather than truncating", async () => {
    const body = Array.from({ length: 101 }, (_, i) => `User-facing: Note ${i}.`).join("\n");
    const fetchImpl: ReleaseNotesFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ version: "2026.7.23" }))
      .mockResolvedValueOnce(jsonResponse({ body }));

    await expect(
      fetchLatestReleaseNotes("cycling-coach", REPO, { fetch: fetchImpl }),
    ).resolves.toMatchObject({ status: "unavailable", version: "2026.7.23" });
  });

  it("rejects a note longer than 2,000 UTF-16 units rather than truncating", async () => {
    const fetchImpl: ReleaseNotesFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ version: "2026.7.23" }))
      .mockResolvedValueOnce(jsonResponse({ body: `User-facing: ${"x".repeat(2001)}` }));

    await expect(
      fetchLatestReleaseNotes("cycling-coach", REPO, { fetch: fetchImpl }),
    ).resolves.toMatchObject({ status: "unavailable", version: "2026.7.23" });
  });

  it("rejects more than 64 KiB of total note text rather than truncating", async () => {
    const body = Array.from(
      { length: 33 },
      (_, i) => `User-facing: ${String(i).padStart(2, "0")}${"x".repeat(1998)}`,
    ).join("\n");
    const fetchImpl: ReleaseNotesFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ version: "2026.7.23" }))
      .mockResolvedValueOnce(jsonResponse({ body }));

    await expect(
      fetchLatestReleaseNotes("cycling-coach", REPO, { fetch: fetchImpl }),
    ).resolves.toMatchObject({ status: "unavailable", version: "2026.7.23" });
  });

  it("keeps every returned release URL locally constructed and under 2,048 characters", async () => {
    const fetchImpl: ReleaseNotesFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ version: "2026.7.23" }))
      .mockResolvedValueOnce(
        jsonResponse({
          body: "User-facing: Safe local URL.",
          html_url: `https://attacker.invalid/${"x".repeat(3000)}`,
        }),
      );
    const result = await fetchLatestReleaseNotes("cycling-coach", REPO, { fetch: fetchImpl });

    expect(result.releaseUrl).toBe(`${RELEASES_URL}/tag/cycling-coach@2026.7.23`);
    expect(result.releaseUrl.length).toBeLessThanOrEqual(2048);
  });
});
