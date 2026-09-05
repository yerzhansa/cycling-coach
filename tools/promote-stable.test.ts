import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const stepSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  run: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});
const workflow = z
  .object({
    env: z.record(z.string(), z.string()),
    jobs: z.object({ promote: z.object({ steps: z.array(stepSchema) }) }),
  })
  .parse(
    parse(
      readFileSync(new URL("../.github/workflows/promote-stable.yml", import.meta.url), "utf8"),
    ),
  );
const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const headSha = "a".repeat(40);
const repository = "synthetic/enduragent";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "enduragent-promotion-"));
  directories.push(directory);
  const output = join(directory, "output");
  const stateFile = join(directory, "state.json");
  const outputs = new Map<string, string>();
  writeFileSync(join(directory, "timeout"), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o700 });
  writeFileSync(join(directory, "sleep"), "#!/bin/sh\nexit 97\n", { mode: 0o700 });
  writeFileSync(join(directory, "gh"), '#!/bin/sh\ncat "$CASE_DIR/runs.json"\n', { mode: 0o700 });
  writeFileSync(
    join(directory, "docker"),
    `#!${process.execPath}
const fs = require("node:fs");
const file = process.env.CASE_DIR + "/state.json";
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
if (args[0] !== "buildx" || args[1] !== "imagetools") process.exit(2);
if (args[2] === "inspect") {
  state.inspections.push(args[3]);
  fs.writeFileSync(file, JSON.stringify(state));
  const digest = state.tags[args[3]];
  if (digest === undefined) process.exit(1);
  process.stdout.write(JSON.stringify({ digest }));
} else if (args[2] === "create" && args[3] === "-t") {
  const source = args[5];
  const digest = source.includes("@") ? source.split("@")[1] : state.tags[source];
  if (digest === undefined) process.exit(1);
  state.promotions.push({ target: args[4], source, digest });
  state.tags[args[4]] = digest;
  fs.writeFileSync(file, JSON.stringify(state));
} else process.exit(2);
`,
    { mode: 0o700 },
  );
  const sourceTag = `main-${headSha.slice(0, 12)}`;
  const tags = {
    [`${workflow.env.IMAGE_NAME}:${sourceTag}`]: digestA,
    [`${workflow.env.ALIAS_IMAGE_NAME}:${sourceTag}`]: digestA,
  };
  writeFileSync(stateFile, JSON.stringify({ tags, inspections: [], promotions: [] }));

  function execute(name: string) {
    const step = workflow.jobs.promote.steps.find((candidate) => candidate.name === name);
    if (!step?.run) throw new Error(`Missing workflow shell step: ${name}`);
    const expressions = new Map([
      ["github.event.workflow_run.head_sha", headSha],
      ["github.repository", repository],
      ["secrets.GITHUB_TOKEN", "synthetic-test-token"],
      ...outputs,
    ]);
    const env = Object.fromEntries(
      Object.entries(step.env ?? {}).map(([key, value]) => [
        key,
        value.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_match: string, expression: string) => {
          const resolved = expressions.get(expression);
          if (resolved === undefined)
            throw new Error(`Unresolved workflow expression: ${expression}`);
          return resolved;
        }),
      ]),
    );
    writeFileSync(output, "");
    const result = spawnSync("/bin/bash", ["-c", step.run], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: `${directory}:${process.env.PATH}`,
        ...workflow.env,
        ...env,
        CASE_DIR: directory,
        GITHUB_OUTPUT: output,
      },
    });
    for (const line of readFileSync(output, "utf8").trim().split("\n")) {
      const separator = line.indexOf("=");
      if (separator > 0 && step.id) {
        outputs.set(
          `steps.${step.id}.outputs.${line.slice(0, separator)}`,
          line.slice(separator + 1),
        );
      }
    }
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error,
    };
  }

  function setTags(changes: Record<string, string>) {
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    Object.assign(state.tags, changes);
    writeFileSync(stateFile, JSON.stringify(state));
  }

  expect(execute("Derive source tag").status).toBe(0);
  return {
    execute,
    setTags,
    outputs,
    tags,
    state: () => JSON.parse(readFileSync(stateFile, "utf8")),
    runs: (runs: unknown[]) =>
      writeFileSync(join(directory, "runs.json"), JSON.stringify({ workflow_runs: runs })),
  };
}

describe("stable promotion digest binding", () => {
  it.each([false, true])("promotes the checked digest when source tags change: %s", (race) => {
    const run = fixture();
    expect(run.execute("Check source image digests").status).toBe(0);
    expect(run.outputs.get("steps.images.outputs.digest")).toBe(digestA);
    if (race) run.setTags(Object.fromEntries(Object.keys(run.tags).map((tag) => [tag, digestB])));
    expect(run.execute("Promote checked image digest").status).toBe(0);
    expect(run.execute("Verify stable image digests").status).toBe(0);
    expect(run.state().promotions).toEqual([
      {
        target: `${workflow.env.IMAGE_NAME}:stable`,
        source: `${workflow.env.IMAGE_NAME}@${digestA}`,
        digest: digestA,
      },
      {
        target: `${workflow.env.ALIAS_IMAGE_NAME}:stable`,
        source: `${workflow.env.ALIAS_IMAGE_NAME}@${digestA}`,
        digest: digestA,
      },
    ]);
    expect(run.state().inspections).toEqual([
      ...Object.keys(run.tags),
      `${workflow.env.IMAGE_NAME}:stable`,
      `${workflow.env.ALIAS_IMAGE_NAME}:stable`,
    ]);
  });

  it.each([digestB, "", "sha256:not-a-digest", `sha256:${"b".repeat(64)}\navailable=true`])(
    "rejects mismatched or malformed source digest %s before enabling writes",
    (digest) => {
      const run = fixture();
      run.setTags({ [`${workflow.env.ALIAS_IMAGE_NAME}:main-${headSha.slice(0, 12)}`]: digest });
      expect(run.execute("Check source image digests").status).not.toBe(0);
      expect(run.outputs.has("steps.images.outputs.available")).toBe(false);
      expect(run.state().promotions).toEqual([]);
    },
  );

  it.each([workflow.env.IMAGE_NAME, workflow.env.ALIAS_IMAGE_NAME])(
    "detects a changed stable digest for %s",
    (image) => {
      const run = fixture();
      expect(run.execute("Check source image digests").status).toBe(0);
      expect(run.execute("Promote checked image digest").status).toBe(0);
      run.setTags({ [`${image}:stable`]: digestB });
      expect(run.execute("Verify stable image digests").status).not.toBe(0);
    },
  );
});

const trustedRun = {
  id: 101,
  run_number: 1,
  created_at: "1998-01-01T00:00:00Z",
  head_sha: headSha,
  head_branch: "main",
  event: "push",
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  status: "completed",
  conclusion: "success",
};

describe("stable promotion image-run provenance", () => {
  it("accepts a successful same-repository main push", () => {
    const run = fixture();
    run.runs([trustedRun]);
    expect(run.execute("Wait for matching image publication").status).toBe(0);
    expect(run.outputs.get("steps.publish.outputs.ready")).toBe("true");
  });

  it.each([
    { event: "workflow_dispatch" },
    { event: "pull_request" },
    { head_branch: "feature/other" },
    { head_sha: "b".repeat(40) },
    { repository: { full_name: "other/enduragent" } },
    { head_repository: { full_name: "other/enduragent" } },
    { head_repository: null },
  ])("ignores mismatched provenance %j", (changed) => {
    const run = fixture();
    run.runs([{ ...trustedRun, ...changed }]);
    expect(run.execute("Wait for matching image publication").status).toBe(0);
    expect(run.outputs.get("steps.publish.outputs.ready")).toBe("false");
  });

  it("does not let a newer manual run replace the successful push", () => {
    const run = fixture();
    run.runs([
      trustedRun,
      { ...trustedRun, event: "workflow_dispatch", run_number: 2, conclusion: "failure" },
    ]);
    expect(run.execute("Wait for matching image publication").status).toBe(0);
    expect(run.outputs.get("steps.publish.outputs.ready")).toBe("true");
  });

  it("preserves path-filter skips when no image run exists", () => {
    const run = fixture();
    run.runs([]);
    expect(run.execute("Wait for matching image publication").status).toBe(0);
    expect(run.outputs.get("steps.publish.outputs.ready")).toBe("false");
  });

  it("refuses a failed matching run", () => {
    const run = fixture();
    run.runs([{ ...trustedRun, conclusion: "failure" }]);
    expect(run.execute("Wait for matching image publication").status).not.toBe(0);
    expect(run.outputs.has("steps.publish.outputs.ready")).toBe(false);
  });
});
