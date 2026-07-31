import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  expandTilde,
  resolveAthleteHome,
} from "../src/home/resolve-athlete-home.js";

describe("resolveAthleteHome", () => {
  it("default (no env) → ~/.enduragent with store/archive/config children", () => {
    const home = resolveAthleteHome({});
    expect(basename(home.root)).toBe(".enduragent");
    expect(dirname(home.root)).toBe(homedir());
    expect(home.storeDir).toBe(join(home.root, "store"));
    expect(home.archiveDir).toBe(join(home.root, "archive"));
    expect(home.configDir).toBe(join(home.root, "config"));
  });

  it("absolute override", () => {
    const home = resolveAthleteHome({ ENDURAGENT_HOME: "/tmp/custom-home" });
    expect(home.root).toBe("/tmp/custom-home");
    expect(home.storeDir).toBe(join("/tmp/custom-home", "store"));
    expect(home.archiveDir).toBe(join("/tmp/custom-home", "archive"));
    expect(home.configDir).toBe(join("/tmp/custom-home", "config"));
  });

  it("tilde override", () => {
    const home = resolveAthleteHome({ ENDURAGENT_HOME: "~/myhome" });
    expect(home.root).toBe(join(homedir(), "myhome"));
  });

  it("empty-string override ignored → default root", () => {
    const home = resolveAthleteHome({ ENDURAGENT_HOME: "" });
    expect(home.root).toBe(join(homedir(), ".enduragent"));
  });

  it("no per-binary subdir / not binary-keyed", () => {
    expect(resolveAthleteHome.length).toBe(0);
    const home = resolveAthleteHome({});
    expect(home.root).not.toBe(join(homedir(), ".enduragent", "cycling"));
    expect(dirname(home.storeDir)).toBe(home.root);
    expect(dirname(home.archiveDir)).toBe(home.root);
    expect(dirname(home.configDir)).toBe(home.root);
  });

  it("pure, no mkdir — resolver creates nothing", () => {
    const base = mkdtempSync(join(tmpdir(), "athlete-home-"));
    const absent = join(base, "definitely-absent");
    const home = resolveAthleteHome({ ENDURAGENT_HOME: absent });
    expect(home.root).toBe(absent);
    expect(existsSync(home.storeDir)).toBe(false);
    expect(existsSync(home.archiveDir)).toBe(false);
    expect(existsSync(home.configDir)).toBe(false);
  });

  it("expandTilde units", () => {
    expect(expandTilde("~")).toBe(homedir());
    expect(expandTilde("~/x")).toBe(join(homedir(), "x"));
    expect(expandTilde("/abs")).toBe("/abs");
  });
});
