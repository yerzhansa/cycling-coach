import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const canonicalManifestDirectory = resolve(scriptDirectory, "../tests/fixtures/windows-parity");
const manifestNamePattern = /^[a-z][a-z0-9-]*\.scenarios\.json$/u;
const scenarioIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const surfacePattern = /^[a-z][a-z0-9-]*$/u;

export const WINDOWS_PARITY_SCENARIO_MANIFEST_MAX_BYTES = 1_048_576;
export const DEFAULT_WINDOWS_PARITY_SCENARIO_MANIFESTS = Object.freeze([
  "chat-settings.scenarios.json",
  "training.scenarios.json",
  "telegram.scenarios.json",
  "shell-lifecycle.scenarios.json",
]);

export class WindowsParityScenarioManifestError extends Error {
  constructor(stage) {
    super(`windows-parity scenario manifest rejected at ${stage}`);
    this.name = "WindowsParityScenarioManifestError";
    this.stage = stage;
  }
}

function reject(stage) {
  throw new WindowsParityScenarioManifestError(stage);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function boundedText(value) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function boundedTests(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(boundedText) &&
    new Set(value).size === value.length
  );
}

function configuredManifestNames(value) {
  if (!Array.isArray(value) || value.length === 0) reject("configuration");
  const names = value.map((name) => {
    if (typeof name !== "string" || !manifestNamePattern.test(name)) reject("configuration");
    return name;
  });
  if (new Set(names).size !== names.length) reject("configuration");
  return names;
}

function parseScenario(value) {
  if (!record(value) || typeof value.automation !== "string") reject("schema");
  const hasTest = Object.hasOwn(value, "test");
  const hasTests = Object.hasOwn(value, "tests");
  if (value.automation === "deterministic" && hasTest === hasTests) reject("schema");
  const expectedKeys =
    value.automation === "deterministic"
      ? ["automation", "expected", "id", "surface", hasTest ? "test" : "tests"]
      : value.automation === "vm-only"
        ? ["automation", "expected", "id", "surface"]
        : reject("schema");
  if (!exactKeys(value, expectedKeys)) reject("schema");
  if (
    !boundedText(value.id) ||
    !scenarioIdPattern.test(value.id) ||
    !boundedText(value.surface) ||
    !surfacePattern.test(value.surface) ||
    !boundedText(value.expected)
  ) {
    reject("schema");
  }
  if (
    value.automation === "deterministic" &&
    ((hasTest && !boundedText(value.test)) || (hasTests && !boundedTests(value.tests)))
  ) {
    reject("schema");
  }
  return Object.freeze(
    value.automation === "deterministic"
      ? hasTest
        ? {
            id: value.id,
            surface: value.surface,
            expected: value.expected,
            automation: value.automation,
            test: value.test,
          }
        : {
            id: value.id,
            surface: value.surface,
            expected: value.expected,
            automation: value.automation,
            tests: Object.freeze([...value.tests]),
          }
      : {
          id: value.id,
          surface: value.surface,
          expected: value.expected,
          automation: value.automation,
        },
  );
}

function parseManifest(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    reject("parse");
  }
  if (
    !record(value) ||
    !exactKeys(value, ["schemaVersion", "scenarios"]) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.scenarios) ||
    value.scenarios.length === 0
  ) {
    reject("schema");
  }
  return value.scenarios.map(parseScenario);
}

export async function loadWindowsParityScenarios(input = {}, dependencies = {}) {
  const directory = input.directory ?? canonicalManifestDirectory;
  if (!isAbsolute(directory)) reject("configuration");
  const manifestNames = configuredManifestNames(
    input.manifestNames ?? DEFAULT_WINDOWS_PARITY_SCENARIO_MANIFESTS,
  );
  const read = dependencies.readFile ?? readFile;
  const scenarios = [];
  const ids = new Set();
  for (const manifestName of manifestNames) {
    let source;
    try {
      source = await read(join(directory, manifestName), "utf8");
    } catch {
      reject("read");
    }
    if (
      typeof source !== "string" ||
      Buffer.byteLength(source, "utf8") > WINDOWS_PARITY_SCENARIO_MANIFEST_MAX_BYTES
    ) {
      reject("size");
    }
    for (const scenario of parseManifest(source)) {
      if (ids.has(scenario.id)) reject("duplicate-id");
      ids.add(scenario.id);
      scenarios.push(scenario);
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    manifests: Object.freeze([...manifestNames]),
    scenarios: Object.freeze(scenarios),
  });
}
