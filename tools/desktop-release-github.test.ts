import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DESKTOP_FEED_URL,
  DESKTOP_PROVISIONAL_RELEASE_BODY,
  GithubClient,
  activateDesktopRelease,
  compensateDesktopRelease,
  observeDesktopLatest,
  prepareDesktopBaseline,
  promoteDesktopLatest,
  publishDesktopRelease,
  releaseFileNames,
  sealDesktopRelease,
  stageDesktopRelease,
  type DesktopReleaseManifest,
  type DesktopReleaseMode,
} from "./desktop-release-transaction.js";

const candidateVersion = "0.1.7";
const candidateTag = `enduragent-desktop@${candidateVersion}`;
const candidateCommit = "a".repeat(40);
const realSetImmediate = setImmediate;

interface FakeAsset {
  id: number;
  name: string;
  size: number;
  state: "starter" | "uploaded";
  url: string;
  browser_download_url: string;
}

interface FakeRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: FakeAsset[];
  upload_url: string;
  body: string;
}

function digest(bytes: Uint8Array, algorithm: "sha256" | "sha512", encoding: "hex" | "base64") {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function writeEnvelope(directory: string, version: string): void {
  const [dmgName, zipName, blockmapName] = releaseFileNames(version);
  const dmg = Buffer.from(`dmg-${version}`);
  const zip = Buffer.from(`zip-${version}`);
  writeFileSync(join(directory, dmgName), dmg);
  writeFileSync(join(directory, zipName), zip);
  writeFileSync(join(directory, blockmapName), `blockmap-${version}`);
  writeFileSync(
    join(directory, "latest-mac.yml"),
    stringify({
      version,
      files: [
        { url: zipName, sha512: digest(zip, "sha512", "base64"), size: zip.length },
        { url: dmgName, sha512: digest(dmg, "sha512", "base64"), size: dmg.length },
      ],
      path: zipName,
      sha512: digest(zip, "sha512", "base64"),
      releaseDate: "1998-08-07T00:00:00.000Z",
    }),
  );
}

async function sealed(
  version: string,
  draftId: string,
  mode: DesktopReleaseMode,
  baseline?: { release: FakeRelease; manifest: DesktopReleaseManifest },
): Promise<{ directory: string; manifest: DesktopReleaseManifest }> {
  const directory = mkdtempSync(join(tmpdir(), "desktop-release-github-"));
  directories.push(directory);
  writeEnvelope(directory, version);
  const baselineZip = baseline?.manifest.files.find((file) => file.name.endsWith("-arm64.zip"));
  const manifest = await sealDesktopRelease(directory, {
    tag: `enduragent-desktop@${version}`,
    desktopVersion: version,
    commit: version === candidateVersion ? candidateCommit : "b".repeat(40),
    draftId,
    mode,
    workflowRunId: "456",
    workflowRunAttempt: "1",
    draftBodySha256: digest(Buffer.from("release body"), "sha256", "hex"),
    signingIdentity: "Developer ID Application: Example (FA494ACVTF)",
    candidateCdHash: "d".repeat(40),
    candidateCodeDirectorySha256: "e".repeat(64),
    baselineTag: baseline?.release.tag_name ?? "none",
    baselineReleaseId: baseline ? String(baseline.release.id) : "none",
    baselineCommit: baseline?.manifest.commit ?? "none",
    baselineZipSha256: baselineZip?.sha256 ?? "none",
    baselineSigningIdentity: baseline?.manifest.signingIdentity ?? "none",
    baselineCdHash: baseline?.manifest.candidateCdHash ?? "none",
  });
  return { directory, manifest };
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

class FakeGithub {
  readonly calls: Array<{ method: string; url: string; authorization: string | null }> = [];
  readonly bytes = new Map<string, Buffer>();
  readonly commits = new Map<string, string>();
  pages: FakeRelease[][] = [[]];
  candidate: FakeRelease;
  latest: FakeRelease | null = null;
  nextAssetId = 1000;
  failNextUploadWithStarter = false;
  anonymousDownloadFailures = 0;
  private resolveAnonymousDownloadFailure!: () => void;
  readonly anonymousDownloadFailureObserved = new Promise<void>((resolveFailure) => {
    this.resolveAnonymousDownloadFailure = resolveFailure;
  });

  constructor(tag = candidateTag, commit = candidateCommit) {
    this.candidate = this.release(123, tag, true);
    this.commits.set(tag, commit);
  }

  release(id: number, tag: string, draft: boolean): FakeRelease {
    return {
      id,
      tag_name: tag,
      draft,
      prerelease: false,
      assets: [],
      upload_url: `https://uploads.github.com/repos/yerzhansa/enduragent/releases/${id}/assets{?name,label}`,
      body: "release body",
    };
  }

  addEnvelope(release: FakeRelease, directory: string, version: string): void {
    for (const name of releaseFileNames(version)) {
      this.addAsset(release, name, readFileSync(join(directory, name)));
    }
  }

  addAsset(
    release: FakeRelease,
    name: string,
    bytes: Buffer,
    state: "starter" | "uploaded" = "uploaded",
  ): FakeAsset {
    const asset = {
      id: this.nextAssetId++,
      name,
      size: bytes.length,
      state,
      url: `https://api.github.com/repos/yerzhansa/enduragent/releases/assets/${this.nextAssetId - 1}`,
      browser_download_url: `https://github.com/yerzhansa/enduragent/releases/download/${release.tag_name}/${name}`,
    };
    release.assets.push(asset);
    this.bytes.set(asset.url, bytes);
    this.bytes.set(asset.browser_download_url, bytes);
    return asset;
  }

  findRelease(id: number): FakeRelease | undefined {
    return [this.candidate, ...this.pages.flat()].find((release) => release.id === id);
  }

  client(): GithubClient {
    return new GithubClient("yerzhansa/enduragent", "token", this.fetch);
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    this.calls.push({ method, url, authorization: headers.get("Authorization") });
    const json = (value: unknown, status = 200) => Response.json(value, { status });
    const binary = (bytes: Buffer | undefined, status = 200) =>
      new Response(
        bytes
          ? (bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer)
          : null,
        { status },
      );
    const releaseMatch = /\/releases\/([1-9]\d*)$/u.exec(new URL(url).pathname);
    if (releaseMatch && method === "GET") {
      const release = this.findRelease(Number(releaseMatch[1]));
      return release ? json(release) : json({}, 404);
    }
    if (url.includes("/git/ref/tags/")) {
      const tag = decodeURIComponent(url.split("/git/ref/tags/")[1]);
      const commit = this.commits.get(tag);
      return commit ? json({ object: { type: "commit", sha: commit } }) : json({}, 404);
    }
    if (url.includes("/releases?per_page=100&page=")) {
      const page = Number(new URL(url).searchParams.get("page"));
      return json(this.pages[page - 1] ?? []);
    }
    if (url.endsWith("/releases/latest")) return this.latest ? json(this.latest) : json({}, 404);
    if (url.startsWith("https://uploads.github.com/") && method === "POST") {
      const name = new URL(url).searchParams.get("name")!;
      const bytes = Buffer.from((init.body as ArrayBuffer) ?? new ArrayBuffer(0));
      if (this.failNextUploadWithStarter) {
        this.failNextUploadWithStarter = false;
        this.addAsset(this.candidate, name, Buffer.alloc(0), "starter");
        return json({}, 502);
      }
      return json(this.addAsset(this.candidate, name, bytes));
    }
    if (url.includes("/releases/assets/") && method === "DELETE") {
      const id = Number(url.split("/releases/assets/")[1]);
      const index = this.candidate.assets.findIndex((asset) => asset.id === id);
      if (index === -1) return json({}, 404);
      const [asset] = this.candidate.assets.splice(index, 1);
      this.bytes.delete(asset.url);
      this.bytes.delete(asset.browser_download_url);
      return new Response(null, { status: 204 });
    }
    if (releaseMatch && method === "PATCH") {
      const release = this.findRelease(Number(releaseMatch[1]));
      if (!release) return json({}, 404);
      const update = JSON.parse(String(init.body)) as {
        body?: string;
        draft?: boolean;
        make_latest?: string;
      };
      if (update.body !== undefined) release.body = update.body;
      if (update.draft !== undefined) release.draft = update.draft;
      if (update.make_latest === "true") this.latest = release;
      if (release.draft && this.latest?.id === release.id) this.latest = null;
      return json(release);
    }
    if (url === `${DESKTOP_FEED_URL}latest-mac.yml`) {
      const asset = this.latest?.assets.find((candidate) => candidate.name === "latest-mac.yml");
      return asset ? binary(this.bytes.get(asset.url)) : binary(undefined, 404);
    }
    if (url.includes("/releases/download/") && this.anonymousDownloadFailures > 0) {
      this.anonymousDownloadFailures -= 1;
      this.resolveAnonymousDownloadFailure();
      return binary(undefined, 404);
    }
    const bytes = this.bytes.get(url);
    if (bytes) return binary(bytes);
    const release = [...this.pages.flat(), this.candidate].find((candidate) =>
      candidate.assets.some((asset) => asset.url === url || asset.browser_download_url === url),
    );
    if (release) return binary(this.bytes.get(url));
    return json({}, 404);
  };
}

async function genesisCandidate(fake: FakeGithub) {
  const result = await sealed(candidateVersion, "123", "genesis");
  fake.pages = [[]];
  return result;
}

async function steadyCandidate(fake: FakeGithub) {
  const genesis = await sealed("0.1.6", "122", "genesis");
  const baseline = fake.release(122, "enduragent-desktop@0.1.6", false);
  fake.commits.set(baseline.tag_name, genesis.manifest.commit);
  fake.addEnvelope(baseline, genesis.directory, "0.1.6");
  fake.latest = baseline;
  fake.pages = [[baseline]];
  const candidate = await sealed(candidateVersion, "123", "steady", {
    release: baseline,
    manifest: genesis.manifest,
  });
  return { ...candidate, baseline, baselineDirectory: genesis.directory };
}

describe("GitHub desktop release transaction", () => {
  it("stages audit manifest, payload, then metadata and leaves genesis private", async () => {
    const fake = new FakeGithub();
    const { directory } = await genesisCandidate(fake);
    await stageDesktopRelease(directory, fake.client());
    expect(
      fake.calls
        .filter((call) => call.method === "POST")
        .map((call) => new URL(call.url).searchParams.get("name")),
    ).toEqual(releaseFileNames(candidateVersion));
    expect(fake.candidate.draft).toBe(true);
    expect(fake.calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("resumes exact bytes, rejects conflicts, and performs no mutation on conflict", async () => {
    const fake = new FakeGithub();
    const { directory } = await genesisCandidate(fake);
    await stageDesktopRelease(directory, fake.client());
    const posts = fake.calls.filter((call) => call.method === "POST").length;
    fake.pages = [[fake.candidate]];
    await stageDesktopRelease(directory, fake.client());
    expect(fake.calls.filter((call) => call.method === "POST")).toHaveLength(posts);
    const dmg = fake.candidate.assets.find((asset) => asset.name.endsWith(".dmg"))!;
    fake.bytes.set(dmg.url, Buffer.from("conflict"));
    await expect(stageDesktopRelease(directory, fake.client())).rejects.toThrow("conflicting");
    expect(fake.calls.filter((call) => call.method === "POST")).toHaveLength(posts);
  });

  it("checks tag-to-commit binding before uploading", async () => {
    const fake = new FakeGithub(undefined, "f".repeat(40));
    const { directory } = await genesisCandidate(fake);
    await expect(stageDesktopRelease(directory, fake.client())).rejects.toThrow("commit binding");
    expect(fake.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("checks the draft body before any release mutation", async () => {
    const fake = new FakeGithub();
    const { directory } = await genesisCandidate(fake);
    fake.candidate.body = "operator changed the body";
    await expect(stageDesktopRelease(directory, fake.client())).rejects.toThrow("body binding");
    expect(fake.calls.some((call) => call.method === "POST" || call.method === "PATCH")).toBe(
      false,
    );
  });

  it("rejects a prerelease draft before any release mutation", async () => {
    const fake = new FakeGithub();
    const { directory } = await genesisCandidate(fake);
    fake.candidate.prerelease = true;
    await expect(stageDesktopRelease(directory, fake.client())).rejects.toThrow("draft binding");
    expect(fake.calls.some((call) => call.method === "POST" || call.method === "PATCH")).toBe(
      false,
    );
  });

  it("deletes only a same-name starter asset after a full preflight", async () => {
    const fake = new FakeGithub();
    const { directory } = await genesisCandidate(fake);
    const name = releaseFileNames(candidateVersion)[0];
    fake.addAsset(fake.candidate, name, Buffer.alloc(0), "starter");
    await stageDesktopRelease(directory, fake.client());
    expect(fake.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(fake.candidate.assets).toHaveLength(4);
    expect(fake.candidate.assets.every((asset) => asset.state === "uploaded")).toBe(true);
  });

  it("recovers a 502-created starter with bounded delete and retry", async () => {
    const fake = new FakeGithub();
    const { directory } = await genesisCandidate(fake);
    fake.failNextUploadWithStarter = true;
    await stageDesktopRelease(directory, fake.client());
    expect(fake.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.method === "POST")).toHaveLength(5);
    expect(fake.candidate.assets).toHaveLength(4);
  });

  it("preflights every existing asset before deleting starters or uploading", async () => {
    const fake = new FakeGithub();
    const { directory } = await genesisCandidate(fake);
    const [starterName, conflictName] = releaseFileNames(candidateVersion);
    fake.addAsset(fake.candidate, starterName, Buffer.alloc(0), "starter");
    fake.addAsset(fake.candidate, conflictName, Buffer.from("conflict"));
    await expect(stageDesktopRelease(directory, fake.client())).rejects.toThrow("conflicting");
    expect(fake.calls.some((call) => call.method === "DELETE" || call.method === "POST")).toBe(
      false,
    );
  });

  it("never sends the bearer token to unbound asset or upload origins", async () => {
    const fake = new FakeGithub();
    const { directory } = await genesisCandidate(fake);
    fake.candidate.upload_url = "https://example.invalid/assets{?name,label}";
    await expect(stageDesktopRelease(directory, fake.client())).rejects.toThrow("upload URL");
    expect(fake.calls.some((call) => call.url.includes("example.invalid"))).toBe(false);

    const second = new FakeGithub();
    const candidate = await genesisCandidate(second);
    const asset = second.addAsset(
      second.candidate,
      releaseFileNames(candidateVersion)[0],
      readFileSync(join(candidate.directory, releaseFileNames(candidateVersion)[0])),
    );
    asset.url = "https://example.invalid/asset";
    await expect(stageDesktopRelease(candidate.directory, second.client())).rejects.toThrow(
      "asset API URL",
    );
    expect(second.calls.some((call) => call.url.includes("example.invalid"))).toBe(false);
  });

  it("strips authorization from validated cross-origin asset redirects", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const client = new GithubClient("yerzhansa/enduragent", "token", async (input, init = {}) => {
      const url = String(input);
      const authorization = new Headers(init.headers).get("Authorization");
      calls.push({ url, authorization });
      if (url.startsWith("https://api.github.com/")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://release-assets.githubusercontent.com/signed-object" },
        });
      }
      return new Response(Buffer.from("asset"));
    });
    await expect(
      client.bytes("https://api.github.com/repos/yerzhansa/enduragent/releases/assets/123"),
    ).resolves.toEqual(Buffer.from("asset"));
    expect(calls.map((call) => call.authorization)).toEqual(["Bearer token", null]);
    await expect(
      client.anonymousBytes(
        "https://github.com/other/repository/releases/download/tag/latest-mac.yml",
      ),
    ).rejects.toThrow("outside the bound repository");
  });

  it("publishes steady assets provisionally and verifies tag downloads anonymously", async () => {
    const fake = new FakeGithub();
    const { directory } = await steadyCandidate(fake);
    await stageDesktopRelease(directory, fake.client());
    const observed = await observeDesktopLatest(directory, fake.client());
    await publishDesktopRelease(directory, fake.client(), observed);
    expect(fake.candidate.draft).toBe(false);
    expect(fake.latest?.id).toBe(122);
    expect(fake.candidate.body).toBe(DESKTOP_PROVISIONAL_RELEASE_BODY);
    const anonymousDownloads = fake.calls.filter((call) =>
      call.url.includes("/releases/download/"),
    );
    expect(anonymousDownloads).toHaveLength(4);
    expect(anonymousDownloads.every((call) => call.authorization === null)).toBe(true);
    const uploads = fake.calls
      .filter((call) => call.method === "POST")
      .map((call) => new URL(call.url).searchParams.get("name"));
    expect(uploads.at(-1)).toBe("latest-mac.yml");
  });

  it("waits for transient tag-specific asset propagation", async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeGithub();
      const { directory } = await steadyCandidate(fake);
      await stageDesktopRelease(directory, fake.client());
      const observed = await observeDesktopLatest(directory, fake.client());
      fake.anonymousDownloadFailures = 1;
      const publication = publishDesktopRelease(directory, fake.client(), observed);
      await fake.anonymousDownloadFailureObserved;
      await new Promise<void>((resolveTurn) => realSetImmediate(resolveTurn));
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(2_000);
      await publication;
      expect(fake.candidate.body).toBe(DESKTOP_PROVISIONAL_RELEASE_BODY);
      expect(fake.anonymousDownloadFailures).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("activates only after promotion and restores the observed latest on compensation", async () => {
    const successful = new FakeGithub();
    const accepted = await steadyCandidate(successful);
    accepted.baseline.draft = false;
    successful.latest = accepted.baseline;
    await stageDesktopRelease(accepted.directory, successful.client());
    const observed = await observeDesktopLatest(accepted.directory, successful.client());
    await publishDesktopRelease(accepted.directory, successful.client(), observed);
    await promoteDesktopLatest(accepted.directory, successful.client(), observed);
    const bodyDirectory = mkdtempSync(join(tmpdir(), "desktop-release-body-"));
    directories.push(bodyDirectory);
    const bodyPath = join(bodyDirectory, "body.md");
    writeFileSync(bodyPath, "release body");
    await activateDesktopRelease(accepted.directory, bodyPath, successful.client());
    expect(successful.latest?.id).toBe(successful.candidate.id);
    expect(successful.candidate.body).toBe("release body");

    const failed = new FakeGithub();
    const compensating = await steadyCandidate(failed);
    compensating.baseline.draft = false;
    failed.latest = compensating.baseline;
    await stageDesktopRelease(compensating.directory, failed.client());
    const prior = await observeDesktopLatest(compensating.directory, failed.client());
    await publishDesktopRelease(compensating.directory, failed.client(), prior);
    await promoteDesktopLatest(compensating.directory, failed.client(), prior);
    await compensateDesktopRelease(compensating.directory, bodyPath, failed.client(), prior);
    expect(failed.latest?.id).toBe(compensating.baseline.id);
    expect(failed.candidate.draft).toBe(true);
    expect(failed.candidate.body).toBe("release body");
  });

  it("discovers a complete retained baseline on a later page", async () => {
    const fake = new FakeGithub();
    const { baseline } = await steadyCandidate(fake);
    fake.pages = [
      Array.from({ length: 100 }, (_, index) =>
        fake.release(2000 + index, `other@${index}`, false),
      ),
      [baseline],
    ];
    const output = join(mkdtempSync(join(tmpdir(), "desktop-baseline-output-")), "output");
    directories.push(output.slice(0, output.lastIndexOf("/")));
    writeFileSync(output, "");
    const target = mkdtempSync(join(tmpdir(), "desktop-baseline-target-"));
    directories.push(target);
    await prepareDesktopBaseline(
      target,
      fake.client(),
      "steady",
      candidateTag,
      candidateVersion,
      baseline.tag_name,
      output,
    );
    expect(readFileSync(output, "utf8")).toContain("baseline_release_id=122");
    expect(readFileSync(output, "utf8")).toContain("baseline_version=0.1.6");
    expect(readdirSync(target).sort()).toEqual([...releaseFileNames("0.1.6")].sort());
    expect(fake.calls.some((call) => call.url.includes("page=2"))).toBe(true);
  });

  it("accepts only the exact legacy first-signed desktop baseline", async () => {
    const fake = new FakeGithub();
    const legacyEnvelope = await sealed("0.1.0", "121", "genesis");
    const legacy = fake.release(121, "cycling-coach@2026.8.8", false);
    fake.commits.set(legacy.tag_name, legacyEnvelope.manifest.commit);
    fake.addEnvelope(legacy, legacyEnvelope.directory, "0.1.0");
    fake.latest = legacy;
    fake.pages = [[legacy]];
    const outputDirectory = mkdtempSync(join(tmpdir(), "desktop-baseline-output-"));
    const target = mkdtempSync(join(tmpdir(), "desktop-baseline-target-"));
    directories.push(outputDirectory, target);
    const output = join(outputDirectory, "output");
    writeFileSync(output, "");

    await prepareDesktopBaseline(
      target,
      fake.client(),
      "steady",
      "enduragent-desktop@0.1.1",
      "0.1.1",
      legacy.tag_name,
      output,
    );

    expect(readFileSync(output, "utf8")).toContain("baseline_tag=cycling-coach@2026.8.8");
    expect(readFileSync(output, "utf8")).toContain("baseline_version=0.1.0");
    expect(readdirSync(target).sort()).toEqual([...releaseFileNames("0.1.0")].sort());
  });

  it.each([
    ["cycling-coach@2026.8.9", "0.1.0"],
    ["cycling-coach@2026.8.8", "0.1.1"],
    ["enduragent-desktop@0.1.1", "0.1.0"],
  ])("rejects a noncanonical desktop baseline %s carrying %s assets", async (tag, version) => {
    const fake = new FakeGithub();
    const envelope = await sealed(version, "121", "genesis");
    const release = fake.release(121, tag, false);
    fake.commits.set(release.tag_name, envelope.manifest.commit);
    fake.addEnvelope(release, envelope.directory, version);
    fake.latest = release;
    fake.pages = [[release]];
    const outputDirectory = mkdtempSync(join(tmpdir(), "desktop-baseline-output-"));
    const target = mkdtempSync(join(tmpdir(), "desktop-baseline-target-"));
    directories.push(outputDirectory, target);
    const output = join(outputDirectory, "output");
    writeFileSync(output, "");

    await expect(
      prepareDesktopBaseline(
        target,
        fake.client(),
        "steady",
        candidateTag,
        candidateVersion,
        tag,
        output,
      ),
    ).rejects.toThrow("desktop baseline");
    expect(readdirSync(target)).toEqual([]);
  });

  it("requires the candidate desktop tag to equal the candidate app version", async () => {
    const fake = new FakeGithub();
    const outputDirectory = mkdtempSync(join(tmpdir(), "desktop-baseline-output-"));
    const target = mkdtempSync(join(tmpdir(), "desktop-baseline-target-"));
    directories.push(outputDirectory, target);
    const output = join(outputDirectory, "output");
    writeFileSync(output, "");

    await expect(
      prepareDesktopBaseline(
        target,
        fake.client(),
        "genesis",
        "enduragent-desktop@0.1.8",
        candidateVersion,
        "none",
        output,
      ),
    ).rejects.toThrow("tag and version do not match");
    expect(fake.calls).toEqual([]);
  });

  it("uses the requested retained baseline instead of a newer failed draft", async () => {
    const fake = new FakeGithub();
    const { baseline } = await steadyCandidate(fake);
    const failed = await sealed("0.1.8", "124", "genesis");
    const failedRelease = fake.release(124, "enduragent-desktop@0.1.8", true);
    fake.commits.set(failedRelease.tag_name, failed.manifest.commit);
    fake.addEnvelope(failedRelease, failed.directory, "0.1.8");
    fake.pages = [[failedRelease, baseline]];
    const outputDirectory = mkdtempSync(join(tmpdir(), "desktop-baseline-output-"));
    const target = mkdtempSync(join(tmpdir(), "desktop-baseline-target-"));
    directories.push(outputDirectory, target);
    const output = join(outputDirectory, "output");
    writeFileSync(output, "");

    await prepareDesktopBaseline(
      target,
      fake.client(),
      "steady",
      "enduragent-desktop@0.1.9",
      "0.1.9",
      baseline.tag_name,
      output,
    );

    expect(readFileSync(output, "utf8")).toContain("baseline_release_id=122");
    expect(readFileSync(output, "utf8")).not.toContain("baseline_release_id=124");
  });

  it("requires N+1 latest instead of reusing N as the N+2 baseline", async () => {
    const fake = new FakeGithub();
    const { baseline } = await steadyCandidate(fake);
    const accepted = await sealed("0.1.7", "124", "genesis");
    const latest = fake.release(124, "enduragent-desktop@0.1.7", false);
    fake.commits.set(latest.tag_name, accepted.manifest.commit);
    fake.addEnvelope(latest, accepted.directory, "0.1.7");
    fake.latest = latest;
    fake.pages = [[latest, baseline]];
    const outputDirectory = mkdtempSync(join(tmpdir(), "desktop-baseline-output-"));
    const target = mkdtempSync(join(tmpdir(), "desktop-baseline-target-"));
    directories.push(outputDirectory, target);
    const output = join(outputDirectory, "output");
    writeFileSync(output, "");
    await expect(
      prepareDesktopBaseline(
        target,
        fake.client(),
        "steady",
        "enduragent-desktop@0.1.8",
        "0.1.8",
        baseline.tag_name,
        output,
      ),
    ).rejects.toThrow("must match the accepted desktop latest release");
  });

  it("refuses latest metadata CAS drift before mutation", async () => {
    const fake = new FakeGithub();
    const { directory, baseline } = await steadyCandidate(fake);
    fake.candidate.draft = false;
    fake.addEnvelope(fake.candidate, directory, candidateVersion);
    baseline.draft = false;
    fake.latest = baseline;
    const metadata = baseline.assets.find((asset) => asset.name === "latest-mac.yml")!;
    const observed = {
      id: baseline.id,
      tag: baseline.tag_name,
      metadataSha256: digest(fake.bytes.get(metadata.url)!, "sha256", "hex"),
    };
    fake.bytes.set(metadata.url, Buffer.from("changed"));
    await expect(promoteDesktopLatest(directory, fake.client(), observed)).rejects.toThrow();
    expect(
      fake.calls.some((call) => call.method === "PATCH" && call.url.endsWith("/releases/123")),
    ).toBe(false);
  });
});
