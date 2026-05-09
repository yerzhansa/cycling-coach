import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { getCoachHome } from "../src/coach-home.js";

let tempHome: string;
let origHome: string | undefined;
let origCyclingHome: string | undefined;
let origRunningHome: string | undefined;
let origDuathlonHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "coach-home-"));
  origHome = process.env.HOME;
  origCyclingHome = process.env.CYCLING_COACH_HOME;
  origRunningHome = process.env.RUNNING_COACH_HOME;
  origDuathlonHome = process.env.DUATHLON_COACH_HOME;
  process.env.HOME = tempHome;
  delete process.env.CYCLING_COACH_HOME;
  delete process.env.RUNNING_COACH_HOME;
  delete process.env.DUATHLON_COACH_HOME;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origCyclingHome === undefined) delete process.env.CYCLING_COACH_HOME;
  else process.env.CYCLING_COACH_HOME = origCyclingHome;
  if (origRunningHome === undefined) delete process.env.RUNNING_COACH_HOME;
  else process.env.RUNNING_COACH_HOME = origRunningHome;
  if (origDuathlonHome === undefined) delete process.env.DUATHLON_COACH_HOME;
  else process.env.DUATHLON_COACH_HOME = origDuathlonHome;
  rmSync(tempHome, { recursive: true, force: true });
});

describe("getCoachHome — env-var override (tier 1)", () => {
  it("returns the absolute path from <BINARY>_HOME when set", () => {
    process.env.CYCLING_COACH_HOME = "/data";
    expect(getCoachHome("cycling-coach")).toBe("/data");
  });

  it("expands `~` to the user's home directory", () => {
    process.env.CYCLING_COACH_HOME = "~";
    expect(getCoachHome("cycling-coach")).toBe(homedir());
  });

  it("expands `~/...` to <homedir>/...", () => {
    process.env.CYCLING_COACH_HOME = "~/cycling-data";
    expect(getCoachHome("cycling-coach")).toBe(join(homedir(), "cycling-data"));
  });

  it("derives env-var name per binary (running-coach → RUNNING_COACH_HOME)", () => {
    process.env.RUNNING_COACH_HOME = "/srv/run";
    expect(getCoachHome("running-coach")).toBe("/srv/run");
  });

  it("derives env-var name per binary (duathlon-coach → DUATHLON_COACH_HOME)", () => {
    process.env.DUATHLON_COACH_HOME = "/srv/duathlon";
    expect(getCoachHome("duathlon-coach")).toBe("/srv/duathlon");
  });

  it("ignores empty-string override (treats it as unset)", () => {
    process.env.CYCLING_COACH_HOME = "";
    // Falls through to tier 2 or 3; with HOME=tempHome and no legacy dir,
    // tier 3 picks ~/.enduragent/cycling.
    expect(getCoachHome("cycling-coach")).toBe(join(tempHome, ".enduragent", "cycling"));
  });
});

describe("getCoachHome — legacy ~/.cycling-coach/ (tier 2)", () => {
  it("returns ~/.cycling-coach/ for cycling-coach when the directory exists", () => {
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });
    expect(getCoachHome("cycling-coach")).toBe(join(tempHome, ".cycling-coach"));
  });

  it("skips tier 2 for non-cycling-coach binaries even when ~/.cycling-coach/ exists", () => {
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });
    expect(getCoachHome("running-coach")).toBe(join(tempHome, ".enduragent", "running"));
    expect(getCoachHome("duathlon-coach")).toBe(join(tempHome, ".enduragent", "duathlon"));
  });
});

describe("getCoachHome — fresh-install ~/.enduragent/<dataSubdir>/ (tier 3)", () => {
  it("returns ~/.enduragent/cycling for cycling-coach when legacy is absent", () => {
    expect(getCoachHome("cycling-coach")).toBe(join(tempHome, ".enduragent", "cycling"));
  });

  it("strips the -coach suffix to derive the data subdir", () => {
    expect(getCoachHome("running-coach")).toBe(join(tempHome, ".enduragent", "running"));
    expect(getCoachHome("duathlon-coach")).toBe(join(tempHome, ".enduragent", "duathlon"));
  });
});
