import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keychainHelperBuildPath } from "./build-keychain-helper.mjs";
import { KEYCHAIN_HELPER_RESOURCE_PATH, machoExecutableIdentity } from "./package-inventory.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDirectory, "..");
const outputRoot = join(desktopRoot, "dist");
const sourceMatrixRoot = join(outputRoot, "self-test-asar/resources/self-test");
const sourceRunnerRoot = join(outputRoot, "self-test-runner");
const targetRoot = join(outputRoot, "extra-resources");
const temporaryRoot = join(outputRoot, `.extra-resources-${process.pid}`);
const declared = ["matrix.json", "matrix.sha256", "self-test-runner.cjs"];

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

await rm(temporaryRoot, { recursive: true, force: true });
await mkdir(join(temporaryRoot, "self-test"), { recursive: true });
for (const name of declared) {
  const source =
    name === "self-test-runner.cjs" ? join(sourceRunnerRoot, name) : join(sourceMatrixRoot, name);
  const stat = await lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid staged source");
  await copyFile(source, join(temporaryRoot, "self-test", name));
}
for (const name of declared) {
  const target = join(temporaryRoot, "self-test", name);
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid staged resource");
  const bytes = await readFile(target);
  const text = bytes.toString("utf8");
  if (
    /vitest|dev-fixtures|\.env|secret|process\.exit|process\.exitCode|console\./iu.test(text) ||
    /(?:^|["'\s])\/(?:Users|private|tmp|home|var)\//u.test(text)
  ) {
    throw new Error("forbidden staged content");
  }
}
const canonicalMatrix = await readFile(join(sourceMatrixRoot, "matrix.json"));
const stagedMatrix = await readFile(join(temporaryRoot, "self-test/matrix.json"));
const canonicalChecksum = await readFile(join(sourceMatrixRoot, "matrix.sha256"));
const stagedChecksum = await readFile(join(temporaryRoot, "self-test/matrix.sha256"));
if (
  !canonicalMatrix.equals(stagedMatrix) ||
  !canonicalChecksum.equals(stagedChecksum) ||
  canonicalChecksum.toString("utf8") !== `${digest(canonicalMatrix)}  matrix.json\n`
) {
  throw new Error("staged resource mismatch");
}
if (process.platform === "darwin") {
  const source = keychainHelperBuildPath(desktopRoot);
  const sourceStat = await lstat(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error("invalid staged source");
  const target = join(temporaryRoot, KEYCHAIN_HELPER_RESOURCE_PATH);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  await chmod(target, 0o755);
  const staged = await lstat(target);
  if (!staged.isFile() || staged.isSymbolicLink()) throw new Error("invalid staged resource");
  machoExecutableIdentity(await readFile(target), KEYCHAIN_HELPER_RESOURCE_PATH);
}
await rm(targetRoot, { recursive: true, force: true });
await rename(temporaryRoot, targetRoot);
