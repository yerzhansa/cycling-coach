import { TRADEMARK_FORBIDDEN } from "../lib/needles.js";
import { EMPTY_SPORT_INFO, type S8aScenario } from "../lib/types.js";
import { STANDARD_ATHLETE } from "./common.js";

export const scenario: S8aScenario = {
  id: "turn-basic-wellness",
  tier: "replay",
  description: "Single grounded coaching turn: wellness + athlete profile reads, recovery trend answer.",
  intervals: {
    athlete: { ...STANDARD_ATHLETE },
    wellness: [
      { id: "1998-06-29", restingHR: 47, hrv: 70, sleepSecs: 26400, sportInfo: EMPTY_SPORT_INFO },
      { id: "1998-06-30", restingHR: 46, hrv: 72, sleepSecs: 27000, sportInfo: EMPTY_SPORT_INFO },
      { id: "1998-07-01", restingHR: 48, hrv: 69, sleepSecs: 25200, sportInfo: EMPTY_SPORT_INFO },
      { id: "1998-07-02", restingHR: 47, hrv: 71, sleepSecs: 27600, sportInfo: EMPTY_SPORT_INFO },
      { id: "1998-07-03", restingHR: 49, hrv: 68, sleepSecs: 25800, sportInfo: EMPTY_SPORT_INFO },
      { id: "1998-07-04", restingHR: 47, hrv: 73, sleepSecs: 28200, sportInfo: EMPTY_SPORT_INFO },
      { id: "1998-07-05", restingHR: 46, hrv: 75, sleepSecs: 28800, sportInfo: EMPTY_SPORT_INFO },
    ],
  },
  turns: [
    {
      chatId: "s8a-chat-1",
      userMessage:
        "Good morning coach. Before you answer anything else, fetch my wellness for the last 7 days and my athlete profile, then tell me how my recovery is trending.",
    },
  ],
  forbiddenNeedles: [...TRADEMARK_FORBIDDEN],
  recordExpectations: {
    tools: ["intervals_fetch_wellness", "intervals_fetch_athlete"],
    callers: ["chat"],
  },
};
