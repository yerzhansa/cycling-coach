import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FAKE_CLAUDE_SCRIPTS_DIR = join(HERE, "frame-scripts");

export const HANG_VERSION = "__hang__";
export const FAIL_VERSION = "__fail__";

export interface FakeClaudeOptions {
  version?: string;
  script?: string;
}

export interface FakeClaude {
  dir: string;
  binaryPath: string;
  setVersion(version: string): Promise<void>;
  setScript(script: string): Promise<void>;
  readArgv(): Promise<string[]>;
  readEnv(): Promise<Record<string, string>>;
  readCwds(): Promise<string[]>;
  readFramesIn(): Promise<string[]>;
  cleanup(): Promise<void>;
}

function stubSource(dir: string, scriptsDir: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const STUB_DIR = ${JSON.stringify(dir)};
const SCRIPTS_DIR = ${JSON.stringify(scriptsDir)};
const argv = process.argv.slice(2);

fs.writeFileSync(path.join(STUB_DIR, "argv"), argv.map((a) => a + "\\n").join(""));
fs.writeFileSync(path.join(STUB_DIR, "env.json"), JSON.stringify(process.env, null, 2));
fs.appendFileSync(path.join(STUB_DIR, "cwd-log"), process.cwd() + "\\n");

function readPointer(name, fallback) {
  try {
    return fs.readFileSync(path.join(STUB_DIR, name), "utf8").trim();
  } catch {
    return fallback;
  }
}

function hangForever() {
  setInterval(() => {}, 60000);
}

if (argv.includes("--version")) {
  const version = readPointer("version", "0.0.0");
  if (version === ${JSON.stringify(HANG_VERSION)}) {
    hangForever();
  } else if (version === ${JSON.stringify(FAIL_VERSION)}) {
    process.stderr.write(
      "claude: fatal: startup failed (env keys: " + Object.keys(process.env).sort().join(",") + ")\\n",
    );
    process.exit(3);
  } else {
    process.stdout.write(version + " (Claude Code)\\n");
    process.exit(0);
  }
} else {
  const scriptName = process.env.FAKE_CLAUDE_SCRIPT || readPointer("script", "happy-turn");
  const scriptPath = path.join(SCRIPTS_DIR, scriptName + ".ndjson");
  const chunks = [];
  let stdinEnded = false;
  const flushStdin = () => {
    fs.writeFileSync(path.join(STUB_DIR, "frames-in.ndjson"), Buffer.concat(chunks));
  };
  flushStdin();
  process.stdin.on("data", (chunk) => {
    chunks.push(chunk);
    flushStdin();
  });
  process.stdin.on("end", () => {
    stdinEnded = true;
    flushStdin();
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const settleStdin = async () => {
    for (let waited = 0; waited < 500 && !stdinEnded; waited += 25) await sleep(25);
    flushStdin();
  };
  (async () => {
    let raw;
    try {
      raw = fs.readFileSync(scriptPath, "utf8");
    } catch {
      process.stderr.write("fake-claude: unknown script " + scriptName + "\\n");
      process.exit(66);
      return;
    }
    const lines = raw.split("\\n").filter((line) => line.trim().length > 0);
    for (const line of lines) {
      let control = null;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object" && parsed.__control) control = parsed;
      } catch {
        control = null;
      }
      if (control === null) {
        process.stdout.write(line + "\\n");
        continue;
      }
      if (control.__control === "sleep") {
        await sleep(control.ms || 0);
        continue;
      }
      if (control.__control === "exit") {
        process.exit(control.code || 0);
      }
      if (control.__control === "hang") {
        hangForever();
        return;
      }
    }
    await settleStdin();
    process.exit(0);
  })();
}
`;
}

export async function createFakeClaude(options: FakeClaudeOptions = {}): Promise<FakeClaude> {
  const dir = await mkdtemp(join(tmpdir(), "fake-claude-"));
  const binaryPath = join(dir, "fake-claude");
  await writeFile(binaryPath, stubSource(dir, FAKE_CLAUDE_SCRIPTS_DIR), { mode: 0o755 });
  await writeFile(join(dir, "version"), options.version ?? "2.1.220");
  await writeFile(join(dir, "script"), options.script ?? "happy-turn");

  return {
    dir,
    binaryPath,
    setVersion: async (version: string) => {
      await writeFile(join(dir, "version"), version);
    },
    setScript: async (script: string) => {
      await writeFile(join(dir, "script"), script);
    },
    readArgv: async () => {
      const raw = await readFile(join(dir, "argv"), "utf8");
      return raw.split("\n").slice(0, -1);
    },
    readEnv: async () => {
      const raw = await readFile(join(dir, "env.json"), "utf8");
      return JSON.parse(raw) as Record<string, string>;
    },
    readCwds: async () => {
      const raw = await readFile(join(dir, "cwd-log"), "utf8");
      return raw.split("\n").filter((line) => line.length > 0);
    },
    readFramesIn: async () => {
      const raw = await readFile(join(dir, "frames-in.ndjson"), "utf8");
      return raw.split("\n").filter((line) => line.trim().length > 0);
    },
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
