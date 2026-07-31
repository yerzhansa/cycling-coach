import { TRADEMARK_FORBIDDEN } from "../lib/needles.js";
import { EMPTY_SPORT_INFO, type S8aScenario } from "../lib/types.js";
import { STANDARD_ATHLETE } from "./common.js";

export const scenario: S8aScenario = {
  id: "multi-turn-memory",
  tier: "replay",
  description: "Three-turn conversation carrying a new FTP figure across turns.",
  intervals: {
    athlete: { ...STANDARD_ATHLETE },
    wellness: [{ id: "1998-07-05", restingHR: 47, hrv: 71, sleepSecs: 27000, sportInfo: EMPTY_SPORT_INFO }],
    activities: [
      {
        id: 90110,
        start_date_local: "1998-07-04T09:00:00",
        type: "Ride",
        name: "Endurance spin",
        moving_time: 5400,
        icu_training_load: 55,
      },
    ],
  },
  turns: [
    { chatId: "s8a-chat-1", userMessage: "My FTP test came back at 260 watts last night." },
    { chatId: "s8a-chat-1", userMessage: "Given that, how should Thursday's intervals change?" },
    { chatId: "s8a-chat-1", userMessage: "And remind me what my current weekly Load target is." },
  ],
  forbiddenNeedles: [...TRADEMARK_FORBIDDEN],
  recordExpectations: {
    callers: ["chat"],
  },
};
