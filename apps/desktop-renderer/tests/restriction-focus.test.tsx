import { afterEach, describe, expect, it } from "vitest";
import {
  clearTrainingRestrictionFocusRequest,
  focusTrainingRestrictionIfPresent,
  requestTrainingRestrictionFocus,
  takeTrainingRestrictionFocusRequest,
} from "../src/ui/settings/restriction-focus";

afterEach(() => {
  clearTrainingRestrictionFocusRequest();
});

describe("training restriction focus", () => {
  it("focuses a present destination and consumes the request", () => {
    const card = document.createElement("div");
    card.tabIndex = -1;
    document.body.append(card);

    requestTrainingRestrictionFocus();
    focusTrainingRestrictionIfPresent(card);

    expect(card).toHaveFocus();
    expect(takeTrainingRestrictionFocusRequest()).toBe(false);
    card.remove();
  });

  it("leaves an absent destination pending for the coordinator", () => {
    requestTrainingRestrictionFocus();
    focusTrainingRestrictionIfPresent(null);

    expect(takeTrainingRestrictionFocusRequest()).toBe(true);
    expect(takeTrainingRestrictionFocusRequest()).toBe(false);
  });
});
