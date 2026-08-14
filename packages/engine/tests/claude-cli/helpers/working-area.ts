import { isAbsolute } from "node:path";

import type { ClaudeWorkingAreaPort } from "../../../src/agent/claude-cli/working-area.js";

export function fixedClaudeWorkingArea(cwd: string): ClaudeWorkingAreaPort {
  if (!isAbsolute(cwd)) throw new TypeError("Claude working area must be absolute");
  return Object.freeze({
    cacheKey: cwd,
    async prepareForLaunch() {
      return Object.freeze({ cwd, assertCurrent() {} });
    },
  });
}
