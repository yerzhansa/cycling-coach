import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { parseGpxCourse, type CourseRouteParseResult } from "@enduragent/kernel/ingest";
import { createRaceCourseSnapshot, type RaceCourseSnapshot } from "@enduragent/kernel/planning";
import { parseFitCourse } from "@enduragent/kernel-node/ingest";
import { interpretCyclingRaceCourse } from "@enduragent/sport-cycling";

export type PlanRaceCourseParseResult =
  | { readonly ok: true; readonly course: RaceCourseSnapshot }
  | { readonly ok: false; readonly fileName: string; readonly detail: string };

export interface PlanRaceCourseAdapter {
  parse(filePath: string): Promise<PlanRaceCourseParseResult>;
}

function failure(fileName: string, detail: string): PlanRaceCourseParseResult {
  return Object.freeze({ ok: false, fileName, detail });
}

export function createNodePlanRaceCourseAdapter(): PlanRaceCourseAdapter {
  return Object.freeze({
    async parse(filePath: string) {
      const fileName = basename(filePath);
      try {
        const extension = extname(filePath).toLowerCase();
        const bytes = new Uint8Array(await readFile(filePath));
        let parsed: CourseRouteParseResult;
        if (extension === ".gpx") {
          parsed = parseGpxCourse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } else if (extension === ".fit") {
          parsed = await parseFitCourse(bytes);
        } else {
          return failure(fileName, "Choose a GPX or FIT file.");
        }
        if (!parsed.ok) return failure(fileName, parsed.detail);
        const preview = interpretCyclingRaceCourse(parsed.route);
        return Object.freeze({
          ok: true,
          course: createRaceCourseSnapshot({
            fileName,
            route: parsed.route,
            preview,
          }),
        });
      } catch {
        return failure(fileName, "This file could not be read as a Race Course.");
      }
    },
  });
}
