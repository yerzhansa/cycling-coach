import { describe, expect, it } from "vitest";
import { cn } from "../src/lib/utils";

describe("Tailwind class merging", () => {
  it("lets later utilities override app theme tokens", () => {
    expect(cn("h-ctl", "h-auto")).toBe("h-auto");
    expect(cn("px-ctl-px", "p-0")).toBe("p-0");
    expect(cn("rounded-ctl", "rounded-none")).toBe("rounded-none");
    expect(cn("shadow-elev-1", "shadow-none")).toBe("shadow-none");
  });

  it("keeps the last app token from each theme group", () => {
    expect(cn("gap-inset", "gap-row")).toBe("gap-row");
    expect(cn("rounded-chip", "rounded-card")).toBe("rounded-card");
    expect(cn("shadow-elev-1", "shadow-elev-4")).toBe("shadow-elev-4");
  });
});
