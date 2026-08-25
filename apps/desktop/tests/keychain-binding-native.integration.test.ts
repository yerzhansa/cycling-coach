import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildKeychainBinding,
  KEYCHAIN_BINDING_CREATION_ROLLBACK_SOURCE,
  KEYCHAIN_BINDING_MINIMUM_MACOS,
  keychainBindingBuildPath,
  keychainBindingCompilerAvailable,
} from "../scripts/build-keychain-binding.mjs";
import {
  KEYCHAIN_CREDENTIAL_SERVICE_DEV,
  createKeychainBindingTransport,
} from "../src/main/keychain-binding.js";

const COMPILE_TIMEOUT_MS = 300_000;
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalPartitionDescription =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
  '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">' +
  '<plist version="1.0"><dict><key>Partitions</key><array>' +
  "<string>teamid:FA494ACVTF</string></array></dict></plist>";
const alternatePartitionDescription = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Partitions</key>
    <array>
      <string>teamid:FA494ACVTF</string>
    </array>
  </dict>
</plist>`;
const wrongTeamPartitionDescription = alternatePartitionDescription.replace(
  "teamid:FA494ACVTF",
  "teamid:OTHER",
);
let root = "";
let parserHarness = "";
let creationRollbackHarness = "";

function plistDictionary(contents: string) {
  return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${contents}</dict></plist>`;
}

function hexDescription(description: string) {
  return Buffer.from(description, "utf8").toString("hex");
}

function harnessStatus(...arguments_: string[]) {
  const result = spawnSync(parserHarness, arguments_, {
    encoding: "utf8",
    timeout: COMPILE_TIMEOUT_MS,
  });
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) {
    throw new Error(`partition description harness stopped with ${result.signal}`);
  }
  return result.status;
}

function partitionDescriptionStatus(...descriptions: string[]) {
  return harnessStatus("descriptions", ...descriptions);
}

function partitionAclStatus(
  authorization: "exact" | "wrong" | "extra",
  applications: "null" | "empty" | "populated",
  prompt: "zero" | "nonzero",
) {
  return harnessStatus("acl", authorization, applications, prompt, canonicalPartitionDescription);
}

function accessAclStatus(
  ownerAuthorization: "exact" | "extra",
  ownerApplications: "null" | "empty" | "populated",
  ownerCount: "missing" | "single" | "duplicate",
  partitionCount: "missing" | "single" | "duplicate",
  unrelated: "none" | "default" | "any" | "change-owner",
) {
  return harnessStatus(
    "access",
    ownerAuthorization,
    ownerApplications,
    ownerCount,
    partitionCount,
    unrelated,
    canonicalPartitionDescription,
  );
}

describe.skipIf(process.platform !== "darwin" || !keychainBindingCompilerAvailable())(
  "keychain native binding",
  () => {
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "enduragent-keychain-binding-"));
      await cp(join(desktopRoot, "native"), join(root, "native"), { recursive: true });
      await buildKeychainBinding(root);
      parserHarness = join(root, "partition-description-harness");
      const compile = spawnSync(
        "xcrun",
        [
          "clang++",
          join(root, "native/keychain-binding/partition-description-harness.mm"),
          join(root, "native/keychain-binding/partition-description.mm"),
          "-std=c++20",
          "-O2",
          "-arch",
          "arm64",
          `-mmacosx-version-min=${KEYCHAIN_BINDING_MINIMUM_MACOS}`,
          "-framework",
          "CoreFoundation",
          "-framework",
          "Security",
          "-o",
          parserHarness,
        ],
        { encoding: "utf8", timeout: COMPILE_TIMEOUT_MS },
      );
      if (compile.error !== undefined) throw compile.error;
      if (compile.status !== 0 || compile.signal !== null) {
        throw new Error(compile.stderr || "partition description harness compilation failed");
      }
      creationRollbackHarness = join(root, "creation-rollback-harness");
      const creationRollbackCompile = spawnSync(
        "xcrun",
        [
          "clang++",
          join(root, "native/keychain-binding/creation-rollback-harness.cc"),
          join(root, KEYCHAIN_BINDING_CREATION_ROLLBACK_SOURCE),
          "-std=c++20",
          "-O2",
          "-arch",
          "arm64",
          `-mmacosx-version-min=${KEYCHAIN_BINDING_MINIMUM_MACOS}`,
          "-o",
          creationRollbackHarness,
        ],
        { encoding: "utf8", timeout: COMPILE_TIMEOUT_MS },
      );
      if (creationRollbackCompile.error !== undefined) throw creationRollbackCompile.error;
      if (creationRollbackCompile.status !== 0 || creationRollbackCompile.signal !== null) {
        throw new Error(
          creationRollbackCompile.stderr || "creation rollback harness compilation failed",
        );
      }
    }, COMPILE_TIMEOUT_MS);

    afterAll(async () => {
      if (root !== "") await rm(root, { recursive: true, force: true });
    });

    it("refuses ordinary Node before every Keychain operation", async () => {
      const transport = createKeychainBindingTransport({
        bindingPath: keychainBindingBuildPath(root),
      });
      for (const op of [
        "probe",
        "read-key",
        "create-key",
        "retry-created-key-rollback",
        "delete-key",
      ] as const) {
        await expect(
          transport.send({ op, service: KEYCHAIN_CREDENTIAL_SERVICE_DEV }),
        ).resolves.toEqual(
          op === "create-key"
            ? { ok: false, code: "not-team-signed", creationRollbackPending: false }
            : { ok: false, code: "not-team-signed" },
        );
      }
    });

    it("passes the deterministic creation rollback transaction harness", () => {
      const result = spawnSync(creationRollbackHarness, [], {
        encoding: "utf8",
        timeout: COMPILE_TIMEOUT_MS,
      });
      if (result.error !== undefined) throw result.error;
      expect(result.signal).toBeNull();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    });

    it("pins promptless validation and exact-reference creation rollback", async () => {
      const source = await readFile(
        join(desktopRoot, "native/keychain-binding/keychain-binding.mm"),
        "utf8",
      );
      const transactionSource = await readFile(
        join(desktopRoot, KEYCHAIN_BINDING_CREATION_ROLLBACK_SOURCE),
        "utf8",
      );
      const readiness = source.slice(
        source.indexOf("const char *ReadinessFailure"),
        source.indexOf("napi_value Probe"),
      );
      const statusMapping = source.slice(
        source.indexOf("const char *StatusCode"),
        source.indexOf("bool TrustedHost"),
      );
      const creation = source.slice(
        source.indexOf("napi_value CreateKey"),
        source.indexOf("napi_value RetryCreatedKeyRollback"),
      );
      const reading = source.slice(
        source.indexOf("napi_value ReadKey"),
        source.indexOf("napi_value CreateKey"),
      );
      const deletion = source.slice(
        source.indexOf("napi_value DeleteKey"),
        source.indexOf("NAPI_MODULE_INIT"),
      );
      const rollbackDeletion = source.slice(
        source.indexOf("const char *DeleteCreatedItem"),
        source.indexOf("void ReleaseCreatedRef"),
      );
      const finalizer = source.slice(
        source.indexOf("void FinalizeBindingState"),
        source.indexOf("const char *ReadinessFailure"),
      );
      const accessConstructionStart = source.indexOf("SecAccessRef MakeAccess");
      const accessConstruction = source.slice(
        accessConstructionStart,
        source.indexOf("PartitionInspection InspectAccess", accessConstructionStart),
      );
      expect(readiness.indexOf("InteractionDisabled()")).toBeLessThan(
        readiness.indexOf("TrustedHost()"),
      );
      expect(readiness).toContain("StatusCode(interactionStatus)");
      expect(readiness).not.toContain('Failure(env, "keychain-locked")');
      expect(statusMapping).toContain(
        'DefaultKeychainLocked() ? "keychain-locked" : "uninspectable-item"',
      );
      expect(statusMapping).toMatch(
        /case errSecNotAvailable:\s+case errSecNoDefaultKeychain:\s+return "uninspectable-item";/u,
      );
      expect(source).toContain("kSecMatchSearchList");
      expect(source).toContain("kSecUseKeychain");
      expect(accessConstruction).toContain("IsExpectedOwnerAcl(authorizations, applications)");
      expect(accessConstruction.indexOf("IsExpectedOwnerAcl")).toBeLessThan(
        accessConstruction.indexOf("SecACLSetContents"),
      );
      expect(accessConstruction).toContain("SecKeychainPromptSelector{}");
      expect(accessConstruction).toMatch(
        /ownerCount != 1 \|\| !ownerExact \|\| partitionCount != 0 \|\| hasUnsafe/u,
      );
      expect(accessConstruction).not.toContain("SecACLCreateWithSimpleContents");
      expect(accessConstruction).not.toContain("InspectAccess(access)");
      expect(reading.indexOf("RetryCreationRollback(")).toBeLessThan(
        reading.indexOf("CopyDefaultKeychain"),
      );
      expect(reading).not.toContain("kSecReturnData");
      expect(reading.match(/SecKeychainItemCopyContent\(/gu)).toHaveLength(1);
      const contentCleanup = reading.slice(reading.indexOf("SecKeychainItemCopyContent("));
      const eraseOffsets = [...contentCleanup.matchAll(/EraseBytes\(contentBytes/gu)].map(
        (match) => match.index,
      );
      const freeOffsets = [
        ...contentCleanup.matchAll(/SecKeychainItemFreeContent\(nullptr, contentBytes\)/gu),
      ].map((match) => match.index);
      expect(eraseOffsets).toHaveLength(3);
      expect(freeOffsets).toHaveLength(3);
      for (const [index, eraseOffset] of eraseOffsets.entries()) {
        const freeOffset = freeOffsets[index]!;
        expect(eraseOffset).toBeLessThan(freeOffset);
        if (index + 1 < eraseOffsets.length) {
          expect(freeOffset).toBeLessThan(eraseOffsets[index + 1]!);
        }
      }
      const bufferFailure = reading.slice(
        reading.indexOf("if (bufferStatus != napi_ok || freeStatus != errSecSuccess)"),
        reading.indexOf("napi_value response"),
      );
      const publicationFailure = reading.slice(
        reading.indexOf('if (response == nullptr || !Set(env, response, "key", key))'),
        reading.indexOf("return response;"),
      );
      expect(bufferFailure.match(/EraseBytes\(keyBytes/gu)).toHaveLength(1);
      expect(bufferFailure.indexOf("EraseBytes(keyBytes")).toBeLessThan(
        bufferFailure.indexOf("return bufferStatus"),
      );
      expect(publicationFailure.match(/EraseBytes\(keyBytes/gu)).toHaveLength(1);
      expect(publicationFailure.indexOf("EraseBytes(keyBytes")).toBeLessThan(
        publicationFailure.indexOf("return NapiError(env)"),
      );
      expect(creation.indexOf("RetryCreationRollback(")).toBeLessThan(
        creation.indexOf("CopyDefaultKeychain"),
      );
      expect(creation).toContain("RunCreationRollbackTransaction(");
      expect(creation).toContain("CreationFailure(env, result.code");
      expect(source).toContain('"creationRollbackPending"');
      expect(source).toContain('"retryCreatedKeyRollback"');
      expect(transactionSource.indexOf("dependencies.inspect(")).toBeLessThan(
        transactionSource.indexOf("dependencies.copyContent("),
      );
      expect(transactionSource.indexOf("dependencies.freeContent(")).toBeLessThan(
        transactionSource.indexOf("dependencies.createBuffer("),
      );
      expect(transactionSource.indexOf("dependencies.createBuffer(")).toBeLessThan(
        transactionSource.indexOf("dependencies.publishBuffer("),
      );
      expect(transactionSource).toContain("dependencies.wipeBuffer(");
      expect(transactionSource).toContain("dependencies.deleteExact(");
      expect(transactionSource).not.toContain("SecItemDelete");
      expect(transactionSource).not.toContain("SecItemCopyMatching");
      expect(rollbackDeletion).toContain("SecKeychainItemDelete(");
      expect(rollbackDeletion).not.toContain("SecItemDelete");
      expect(finalizer).toContain("ReleaseCreationRollbackDebt(");
      expect(finalizer).not.toContain("DeleteCreatedItem");
      expect(deletion).toContain("SecItemCopyMatching");
      expect(deletion).toContain("InspectPartition(item)");
      expect(deletion).toContain("SecKeychainItemDelete(item)");
      expect(deletion).not.toContain("RetryCreationRollback");
      expect(deletion.indexOf("state->creationDebt.pending")).toBeLessThan(
        deletion.indexOf("CopyDefaultKeychain"),
      );
      expect(deletion).not.toContain("SecItemDelete");
      expect(source).toContain("#define __STDC_WANT_LIB_EXT1__ 1");
      expect(source).toContain("memset_s(bytes, length, 0, length)");
      expect(source).toContain("CFDataCreateWithBytesNoCopy(");
      expect(source).toContain("kCFAllocatorNull");
      expect(source).toContain("napi_set_instance_data(");
      expect(source).toMatch(/napi_define_properties\([\s\S]*?\) != napi_ok/u);
      expect(source).not.toContain("explicit_bzero");
      expect(source).not.toContain("material.fill");
    });

    it("accepts equivalent exact partition property lists", () => {
      expect(partitionDescriptionStatus(canonicalPartitionDescription)).toBe(0);
      expect(partitionDescriptionStatus(alternatePartitionDescription)).toBe(0);
    });

    it("accepts hex-encoded pretty-printed partition property lists", () => {
      const hexadecimal = hexDescription(alternatePartitionDescription);
      expect(partitionDescriptionStatus(hexadecimal)).toBe(0);
      expect(partitionDescriptionStatus(hexadecimal.toUpperCase())).toBe(0);
    });

    it("accepts only exact persisted partition ACL fields", () => {
      expect(partitionAclStatus("exact", "null", "zero")).toBe(0);
      expect(partitionAclStatus("extra", "null", "zero")).toBe(1);
      expect(partitionAclStatus("wrong", "null", "zero")).toBe(1);
      expect(partitionAclStatus("exact", "empty", "zero")).toBe(1);
      expect(partitionAclStatus("exact", "populated", "zero")).toBe(1);
      expect(partitionAclStatus("exact", "null", "nonzero")).toBe(1);
    });

    it("accepts one protected owner with one or more exact partition ACLs", () => {
      expect(accessAclStatus("exact", "empty", "single", "single", "none")).toBe(0);
      expect(accessAclStatus("exact", "empty", "single", "single", "default")).toBe(0);
      expect(accessAclStatus("exact", "empty", "single", "duplicate", "none")).toBe(0);
    });

    it("rejects an unsafe or ambiguous owner ACL", () => {
      expect(accessAclStatus("exact", "empty", "missing", "single", "none")).toBe(1);
      expect(accessAclStatus("exact", "empty", "duplicate", "single", "none")).toBe(1);
      expect(accessAclStatus("exact", "null", "single", "single", "none")).toBe(1);
      expect(accessAclStatus("exact", "populated", "single", "single", "none")).toBe(1);
      expect(accessAclStatus("extra", "empty", "single", "single", "none")).toBe(1);
    });

    it("rejects ambiguous partitions and unrestricted mutation authority", () => {
      expect(accessAclStatus("exact", "empty", "single", "missing", "none")).toBe(1);
      expect(accessAclStatus("exact", "empty", "single", "single", "any")).toBe(1);
      expect(accessAclStatus("exact", "empty", "single", "single", "change-owner")).toBe(1);
    });

    it("rejects malformed and structurally invalid property lists", () => {
      const rejected = [
        "teamid:FA494ACVTF",
        '<?xml version="1.0"?><plist><dict>',
        '<?xml version="1.0"?><plist version="1.0"><array><string>teamid:FA494ACVTF</string></array></plist>',
        plistDictionary(""),
        plistDictionary("<key>Partitions</key><string>teamid:FA494ACVTF</string>"),
        plistDictionary("<key>Partitions</key><array></array>"),
        plistDictionary("<key>Partitions</key><array><integer>1</integer></array>"),
      ];
      for (const description of rejected) {
        expect(partitionDescriptionStatus(description)).toBe(1);
      }
    });

    it("rejects extra keys and extra, missing, or wrong partitions", () => {
      const rejected = [
        plistDictionary(
          "<key>Partitions</key><array><string>teamid:FA494ACVTF</string></array>" +
            "<key>Extra</key><string>teamid:FA494ACVTF</string>",
        ),
        plistDictionary("<key>Partitions</key><array><string>teamid:OTHER</string></array>"),
        plistDictionary(
          "<key>Partitions</key><array><string>teamid:FA494ACVTF</string>" +
            "<string>teamid:OTHER</string></array>",
        ),
      ];
      for (const description of rejected) {
        expect(partitionDescriptionStatus(description)).toBe(1);
      }
    });

    it("rejects hex-encoded wrong teams and malformed hex", () => {
      expect(partitionDescriptionStatus(hexDescription(wrongTeamPartitionDescription))).toBe(1);
      expect(partitionDescriptionStatus("abc")).toBe(1);
      expect(partitionDescriptionStatus("gg")).toBe(1);
    });

    it("rejects entities after decoding a hex description", () => {
      const withEntity =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<!DOCTYPE plist [<!ENTITY team "teamid:FA494ACVTF">]>' +
        '<plist version="1.0"><dict><key>Partitions</key><array>' +
        "<string>&team;</string></array></dict></plist>";
      expect(partitionDescriptionStatus(hexDescription(withEntity))).toBe(1);
    });

    it("rejects duplicate partition dictionary keys", () => {
      const expected = "<key>Partitions</key><array><string>teamid:FA494ACVTF</string></array>";
      const wrong = "<key>Partitions</key><array><string>teamid:OTHER</string></array>";
      expect(partitionDescriptionStatus(plistDictionary(expected + expected))).toBe(1);
      expect(partitionDescriptionStatus(plistDictionary(expected + wrong))).toBe(1);
    });

    it("accepts multiple expected descriptions and rejects zero or mixed descriptions", () => {
      expect(partitionDescriptionStatus()).toBe(1);
      expect(
        partitionDescriptionStatus(canonicalPartitionDescription, alternatePartitionDescription),
      ).toBe(0);
      expect(
        partitionDescriptionStatus(canonicalPartitionDescription, wrongTeamPartitionDescription),
      ).toBe(1);
    });
  },
);
