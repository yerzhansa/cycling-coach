import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { extractFile } from "@electron/asar";
import { parse } from "yaml";
import {
  createTelegramAcceptanceBuilderConfiguration,
  TELEGRAM_ACCEPTANCE_APP_ID,
  TELEGRAM_ACCEPTANCE_PRODUCT_NAME,
  verifyTelegramAcceptanceDesignatedRequirement,
  verifyTelegramAcceptanceEntitlements,
  verifyTelegramAcceptanceInfoPlist,
  verifyTelegramAcceptanceManifest,
  verifyTelegramAcceptanceSignature,
} from "../tests/fixtures/packaged-telegram/package-acceptance.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = "dist/telegram-acceptance-package";
const execute = promisify(execFile);

async function verifySigningPayload(application) {
  const scratch = await mkdtemp(join(tmpdir(), "enduragent-telegram-signature-"));
  const entitlementsDer = join(scratch, "entitlements.der");
  const entitlementsXml = join(scratch, "entitlements.plist");
  const requirements = join(scratch, "requirements.txt");
  try {
    await execute("/usr/bin/codesign", [
      "--display",
      "--entitlements",
      entitlementsDer,
      "--der",
      application,
    ]);
    await execute("/usr/bin/derq", [
      "query",
      "--xml",
      "-i",
      entitlementsDer,
      "-o",
      entitlementsXml,
    ]);
    const entitlementJson = await execute("/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      entitlementsXml,
    ]);
    verifyTelegramAcceptanceEntitlements(JSON.parse(entitlementJson.stdout));
    await execute("/usr/bin/codesign", ["--display", "--requirements", requirements, application]);
    verifyTelegramAcceptanceDesignatedRequirement(await readFile(requirements, "utf8"));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
const { build } = await import("electron-builder");
await rm(join(desktopRoot, outputDirectory), { recursive: true, force: true });
const sourceManifest = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
if (typeof sourceManifest.version !== "string" || sourceManifest.version.length === 0) {
  throw new TypeError("Desktop package version is invalid");
}
const canonical = parse(await readFile(join(desktopRoot, "electron-builder.yml"), "utf8"));
const artifacts = await build({
  projectDir: desktopRoot,
  publish: "never",
  config: createTelegramAcceptanceBuilderConfiguration(canonical),
});
const application = join(
  desktopRoot,
  outputDirectory,
  `mac-arm64/${TELEGRAM_ACCEPTANCE_PRODUCT_NAME}.app`,
);
await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", application]);
const signature = await execute("/usr/bin/codesign", ["-d", "--verbose=4", application]);
const signatureDescription = `${signature.stdout}\n${signature.stderr}`;
verifyTelegramAcceptanceSignature(signatureDescription);
await verifySigningPayload(application);
const infoPlist = await execute("/usr/bin/plutil", [
  "-convert",
  "json",
  "-o",
  "-",
  join(application, "Contents/Info.plist"),
]);
verifyTelegramAcceptanceInfoPlist(JSON.parse(infoPlist.stdout));
const packagedManifest = JSON.parse(
  extractFile(join(application, "Contents/Resources/app.asar"), "package.json").toString("utf8"),
);
verifyTelegramAcceptanceManifest(packagedManifest, sourceManifest.version);
process.stdout.write(
  `${JSON.stringify({
    application,
    appId: TELEGRAM_ACCEPTANCE_APP_ID,
    signature: "ad-hoc",
    artifacts: artifacts.map((path) => resolve(path)),
  })}\n`,
);
