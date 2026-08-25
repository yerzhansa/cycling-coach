import { lstatSync, readFileSync } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const canonicalInventoryPath = resolve(scriptDirectory, "../build/windows-pe-inventory.json");
const portableExecutableHeaderBytes = 4096;
const inventoryFailureMessage = "Windows PE inventory is invalid";

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !isAbsolute(value) &&
    !value.includes("\\") &&
    !value.split("/").includes("..")
  );
}

function freezeInventory(value) {
  return Object.freeze({
    schema: value.schema,
    signing: Object.freeze({ ...value.signing }),
    required: Object.freeze(value.required.map((entry) => Object.freeze({ ...entry }))),
    thirdPartyExceptions: Object.freeze(
      value.thirdPartyExceptions.map((entry) => Object.freeze({ ...entry })),
    ),
  });
}

function parseInventory(source) {
  let inventory;
  try {
    inventory = JSON.parse(source);
  } catch {
    throw new TypeError(inventoryFailureMessage);
  }
  const signingValid =
    exactObject(inventory?.signing) &&
    hasExactKeys(inventory.signing, ["tool", "version", "option"]) &&
    inventory.signing.tool === "electron-builder" &&
    inventory.signing.version === "26.15.3" &&
    inventory.signing.option === "win.signExts";
  const requiredValid =
    Array.isArray(inventory?.required) &&
    inventory.required.length > 0 &&
    inventory.required.every((entry) => {
      if (!exactObject(entry) || !validRelativePath(entry.path)) return false;
      const keys = Object.hasOwn(entry, "location")
        ? ["path", "kind", "location"]
        : ["path", "kind"];
      if (!hasExactKeys(entry, keys)) return false;
      if (![
        "application",
        "runtime-library",
        "uninstaller",
        "installer",
      ].includes(entry.kind)) return false;
      return (
        !Object.hasOwn(entry, "location") ||
        entry.location === "installer-payload" ||
        entry.location === "artifact"
      );
    });
  const exceptionsValid =
    Array.isArray(inventory?.thirdPartyExceptions) &&
    inventory.thirdPartyExceptions.every(
      (entry) =>
        exactObject(entry) &&
        hasExactKeys(entry, ["path", "sha256", "upstreamSigner", "rationale"]) &&
        validRelativePath(entry.path) &&
        /^[0-9a-f]{64}$/u.test(entry.sha256) &&
        [entry.upstreamSigner, entry.rationale].every(
          (field) => typeof field === "string" && field.length > 0 && field === field.trim(),
        ),
    );
  const paths = [
    ...(Array.isArray(inventory?.required) ? inventory.required.map((entry) => entry?.path) : []),
    ...(Array.isArray(inventory?.thirdPartyExceptions)
      ? inventory.thirdPartyExceptions.map((entry) => entry?.path)
      : []),
  ];
  if (
    !exactObject(inventory) ||
    !hasExactKeys(inventory, ["schema", "signing", "required", "thirdPartyExceptions"]) ||
    inventory.schema !== "windows-pe-inventory/1" ||
    !signingValid ||
    !requiredValid ||
    !exceptionsValid ||
    new Set(paths).size !== paths.length
  ) {
    throw new TypeError(inventoryFailureMessage);
  }
  return freezeInventory(inventory);
}

export function readWindowsPeInventory(path = canonicalInventoryPath) {
  if (typeof path !== "string" || path.length === 0) throw new TypeError(inventoryFailureMessage);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new TypeError();
    return parseInventory(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof TypeError && error.message === inventoryFailureMessage) throw error;
    throw new TypeError(inventoryFailureMessage);
  }
}

export function isPortableExecutable(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 64) return false;
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const peOffset = view.getUint32(60, true);
  return (
    peOffset <= bytes.byteLength - 4 &&
    bytes[peOffset] === 0x50 &&
    bytes[peOffset + 1] === 0x45 &&
    bytes[peOffset + 2] === 0 &&
    bytes[peOffset + 3] === 0
  );
}

function portablePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

async function enumerateTree(unpackedRoot) {
  const rootStat = await lstat(unpackedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new TypeError("Windows unpacked root is invalid");
  }
  const portableExecutables = [];
  const symlinks = [];
  async function visit(directory) {
    const names = await readdir(directory);
    for (const name of names) {
      const path = join(directory, name);
      const stat = await lstat(path);
      const relativePath = portablePath(unpackedRoot, path);
      if (stat.isSymbolicLink()) {
        symlinks.push(relativePath);
      } else if (stat.isDirectory()) {
        await visit(path);
      } else if (stat.isFile()) {
        const handle = await open(path, "r");
        try {
          const bytes = Buffer.alloc(portableExecutableHeaderBytes);
          const { bytesRead } = await handle.read(bytes, 0, portableExecutableHeaderBytes, 0);
          if (isPortableExecutable(bytes.subarray(0, bytesRead))) {
            portableExecutables.push(relativePath);
          }
        } finally {
          await handle.close();
        }
      }
    }
  }
  await visit(unpackedRoot);
  return {
    portableExecutables: portableExecutables.sort(),
    symlinks: symlinks.sort(),
  };
}

export async function enumeratePortableExecutables(unpackedRoot) {
  return Object.freeze((await enumerateTree(unpackedRoot)).portableExecutables);
}

function applyVersion(path, version) {
  return path.replaceAll("${version}", version);
}

export async function diffWindowsPeInventory({ unpackedRoot, inventory, version }) {
  if (
    typeof version !== "string" ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)
  ) {
    throw new TypeError("Windows PE inventory version is invalid");
  }
  const inspected = await enumerateTree(unpackedRoot);
  const expected = inventory.required
    .filter((entry) => entry.location === undefined)
    .map((entry) => applyVersion(entry.path, version))
    .sort();
  const declared = new Set([
    ...expected,
    ...inventory.thirdPartyExceptions.map((entry) => applyVersion(entry.path, version)),
  ]);
  const actual = inspected.portableExecutables;
  const missing = expected.filter((path) => !actual.includes(path));
  const undeclared = actual.filter((path) => !declared.has(path));
  const notInspected = inventory.required
    .filter((entry) => entry.location !== undefined)
    .map((entry) => applyVersion(entry.path, version))
    .sort();
  return Object.freeze({
    ok: missing.length === 0 && undeclared.length === 0 && inspected.symlinks.length === 0,
    missing: Object.freeze(missing),
    undeclared: Object.freeze(undeclared),
    symlinks: Object.freeze(inspected.symlinks),
    expected: Object.freeze(expected),
    actual: Object.freeze(actual),
    notInspected: Object.freeze(notInspected),
  });
}

function parseArguments(arguments_) {
  let unpackedRoot;
  let inventoryPath;
  let version;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith("--") && unpackedRoot === undefined) {
      unpackedRoot = argument;
      continue;
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) throw new TypeError("Invalid arguments");
    index += 1;
    if (argument === "--inventory" && inventoryPath === undefined) inventoryPath = value;
    else if (argument === "--version" && version === undefined) version = value;
    else throw new TypeError("Invalid arguments");
  }
  if (unpackedRoot === undefined) throw new TypeError("Invalid arguments");
  return { unpackedRoot: resolve(unpackedRoot), inventoryPath, version: version ?? "0.0.0" };
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const inventory = readWindowsPeInventory(arguments_.inventoryPath);
  const result = await diffWindowsPeInventory({
    unpackedRoot: arguments_.unpackedRoot,
    inventory,
    version: arguments_.version,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof TypeError ? error.message : "Windows PE inventory failed"}\n`);
    process.exitCode = 2;
  }
}
