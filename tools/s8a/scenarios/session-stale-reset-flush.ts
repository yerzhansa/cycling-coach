import { TRADEMARK_FORBIDDEN } from "../lib/needles.js";
import { EMPTY_SPORT_INFO, type S8aScenario } from "../lib/types.js";
import { STANDARD_ATHLETE } from "./common.js";

const STAGED_SESSION = [
  '{"role":"user","content":"Last week I did three rides and the Saturday long ride went really well.","ts":"1998-07-05T17:40:00.000Z"}',
  '{"role":"assistant","content":"Great to hear — a strong long ride like that is exactly the aerobic base work we want.","ts":"1998-07-05T17:42:00.000Z"}',
  '{"role":"user","content":"My knee felt a bit sore after the hill repeats on Wednesday, though.","ts":"1998-07-05T17:50:00.000Z"}',
  '{"role":"assistant","content":"Noted. Mild soreness after hill work is worth watching — keep the next few rides flat and easy and tell me if it lingers.","ts":"1998-07-05T17:52:00.000Z"}',
  '{"role":"user","content":"Also, I want to target a century ride at the end of August.","ts":"1998-07-05T17:58:00.000Z"}',
  '{"role":"assistant","content":"A late-August century is a solid goal. We have eight weeks — plenty of time to build your long-ride distance progressively.","ts":"1998-07-05T18:00:00.000Z"}',
].join("\n") + "\n";

export const scenario: S8aScenario = {
  id: "session-stale-reset-flush",
  tier: "replay",
  description:
    "Stale session (last message before the daily reset hour) triggers the pre-reset memory flush and archive, then a fresh turn.",
  home: {
    memoryMd: "# Athlete profile\n\n- FTP: 250 W\n- Rides 4x per week, mostly mornings\n",
    sessions: { "s8a-chat-1": STAGED_SESSION },
  },
  intervals: {
    athlete: { ...STANDARD_ATHLETE },
    wellness: [
      { id: "1998-07-03", restingHR: 47, hrv: 70, sleepSecs: 27000, sportInfo: EMPTY_SPORT_INFO },
      { id: "1998-07-04", restingHR: 48, hrv: 72, sleepSecs: 27000, sportInfo: EMPTY_SPORT_INFO },
      { id: "1998-07-05", restingHR: 47, hrv: 71, sleepSecs: 27000, sportInfo: EMPTY_SPORT_INFO },
    ],
  },
  turns: [{ chatId: "s8a-chat-1", userMessage: "Morning! What should today look like?" }],
  forbiddenNeedles: [...TRADEMARK_FORBIDDEN],
  recordExpectations: {
    tools: ["memory_write"],
    callers: ["flush", "chat"],
  },
};
