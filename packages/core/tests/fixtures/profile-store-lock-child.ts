import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  compareAndSaveStoredProfile,
  loadStoredProfileSnapshot,
  recoverAndSaveStoredProfile,
  saveStoredProfile,
} from "../../src/auth/profile-store.js";
import { atomicWriteFileSync } from "../../src/io/atomic-write-file-sync.js";
import { withInterprocessFileLockSync } from "../../src/io/interprocess-file-lock-sync.js";

const mode = process.argv[2];
const profilesPath = process.argv[3];
const readyPath = process.argv[4];
const releasePath = process.argv[5];
const profileName = process.argv[6];
const access = process.argv[7];

if (
  (mode !== "barrier-recovery" &&
    mode !== "barrier-writer" &&
    mode !== "cas" &&
    mode !== "holder" &&
    mode !== "writer") ||
  profilesPath === undefined ||
  readyPath === undefined ||
  releasePath === undefined ||
  profileName === undefined ||
  access === undefined
) {
  throw new Error("Invalid synthetic profile-store child arguments");
}

if (mode === "holder") {
  withInterprocessFileLockSync(join(dirname(profilesPath), ".auth-profiles.lock"), () => {
    writeFileSync(readyPath, "ready\n", { mode: 0o600 });
    while (!existsSync(releasePath)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    atomicWriteFileSync(
      profilesPath,
      JSON.stringify(
        {
          alpha: { type: "oauth", access: "alpha-access", refresh: "alpha-refresh", expires: 1 },
        },
        null,
        2,
      ),
    );
  });
} else if (mode === "writer" || mode === "barrier-writer") {
  writeFileSync(readyPath, "attempted\n", { mode: 0o600 });
  if (mode === "barrier-writer") {
    while (!existsSync(releasePath)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  saveStoredProfile(profilesPath, profileName, {
    type: "oauth",
    access,
    refresh: `${access}-refresh`,
    expires: 2,
  });
} else if (mode === "cas") {
  const expected = loadStoredProfileSnapshot(profilesPath, profileName);
  if (expected === null) throw new Error("Expected synthetic profile snapshot");
  writeFileSync(readyPath, "ready\n", { mode: 0o600 });
  while (!existsSync(releasePath)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  const result = await compareAndSaveStoredProfile(profilesPath, profileName, expected, {
    type: "oauth",
    access,
    refresh: `${access}-refresh`,
    expires: 3,
  });
  writeFileSync(`${readyPath}.result`, JSON.stringify(result), { mode: 0o600 });
} else {
  writeFileSync(readyPath, "attempted\n", { mode: 0o600 });
  while (!existsSync(releasePath)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  recoverAndSaveStoredProfile(profilesPath, profileName, {
    type: "oauth",
    access,
    refresh: `${access}-refresh`,
    expires: 4,
  });
}
