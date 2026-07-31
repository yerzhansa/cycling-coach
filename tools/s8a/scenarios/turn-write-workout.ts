import { TRADEMARK_FORBIDDEN } from "../lib/needles.js";
import { EMPTY_SPORT_INFO, type S8aScenario } from "../lib/types.js";
import { STANDARD_ATHLETE } from "./common.js";

export const scenario: S8aScenario = {
  id: "turn-write-workout",
  tier: "replay",
  description: "Write-tool turn: schedule a structured endurance ride on the calendar.",
  intervals: {
    athlete: { ...STANDARD_ATHLETE },
    wellness: [
      { id: "1998-07-03", restingHR: 47, hrv: 70, sleepSecs: 27000, sportInfo: EMPTY_SPORT_INFO },
      { id: "1998-07-04", restingHR: 48, hrv: 72, sleepSecs: 27000, sportInfo: EMPTY_SPORT_INFO },
      { id: "1998-07-05", restingHR: 47, hrv: 71, sleepSecs: 27000, sportInfo: EMPTY_SPORT_INFO },
    ],
    activities: [
      {
        id: 90104,
        start_date_local: "1998-07-04T09:00:00",
        type: "Ride",
        name: "Endurance spin",
        moving_time: 5400,
        icu_training_load: 55,
      },
    ],
  },
  turns: [
    {
      chatId: "s8a-chat-1",
      userMessage:
        "Schedule me a 90-minute endurance ride for tomorrow morning, zone 2, and put it on my calendar.",
    },
  ],
  forbiddenNeedles: [...TRADEMARK_FORBIDDEN],
  recordExpectations: {
    tools: ["intervals_create_workout"],
    callers: ["chat"],
  },
};
