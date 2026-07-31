import { TRADEMARK_FORBIDDEN } from "../lib/needles.js";
import { EMPTY_SPORT_INFO, type S8aScenario } from "../lib/types.js";
import { STANDARD_ATHLETE } from "./common.js";

// ~30 staged pairs of synthetic coaching chatter, each message 300-600 chars,
// timestamped AFTER the daily reset hour (fresh session) so the tiny history
// budget forces the trim flush + compaction path instead of a stale reset.
const FILLERS = [
  "We talked through pacing on the rolling sections and agreed to hold a steady endurance effort on the climbs rather than surging, keeping breathing conversational and cadence comfortable the whole way through the middle hours of the ride. You also flagged that the final riser felt harder than usual, and we put that down to riding it into a headwind after a long day on your feet rather than anything about your fitness trending the wrong way.",
  "You mentioned the wind picked up on the exposed stretch along the river, so we discussed tucking lower on the bars and rotating your snack schedule earlier to keep energy stable across the final hour instead of fading near the end. We also agreed to keep an eye on how your hands and shoulders feel after longer stints in that lower position, since comfort on the bike is the first thing to slip when the weekly volume steps up.",
  "We reviewed how the legs felt on the second day of back-to-back rides and noted that the mild heaviness cleared after twenty minutes of easy spinning, which is a normal response at this point in the build and nothing to adjust for yet. The plan stays as written for now, with the caveat that if the heaviness ever lingers past the first half hour we shorten the second day rather than push through it and dig a hole.",
  "You asked about fueling for rides over two hours and we settled on a simple plan: a bottle an hour, a bite of something every thirty minutes, and a slightly bigger breakfast on the mornings when the route includes sustained climbing work. We also talked about practicing that routine on easy days first, so that nothing about eating on the bike is new or distracting on the weekend when the rides get longer and the stakes feel higher.",
  "We compared this week's easy-day effort with last week's and agreed the route with fewer junctions makes it easier to keep the effort genuinely easy, so the recovery spins will start from the park side of town going forward from here. You noticed your breathing stayed relaxed the whole way around, which is exactly the signal we want from those days, and we agreed to protect them even when the schedule gets busy.",
];

function buildStagedSession(pairs: number): string {
  const lines: string[] = [];
  for (let i = 0; i < pairs; i++) {
    const filler = FILLERS[i % FILLERS.length];
    lines.push(
      JSON.stringify({
        role: "user",
        content: `Check-in ${i + 1}: ${filler}`,
        ts: "1998-07-06T08:00:00.000Z",
      }),
      JSON.stringify({
        role: "assistant",
        content: `Noted for check-in ${i + 1}: ${filler}`,
        ts: "1998-07-06T08:00:00.000Z",
      }),
    );
  }
  return lines.join("\n") + "\n";
}

export const scenario: S8aScenario = {
  id: "session-trim-compaction",
  tier: "replay",
  description:
    "Fresh but oversized session history under a tiny history budget: trim flush + compaction summarize the dropped messages before the turn.",
  home: {
    sessions: { "s8a-chat-1": buildStagedSession(30) },
  },
  intervals: {
    athlete: { ...STANDARD_ATHLETE },
    wellness: [
      { id: "1998-07-03", restingHR: 47, hrv: 70, sleepSecs: 27000, sportInfo: EMPTY_SPORT_INFO },
      { id: "1998-07-04", restingHR: 48, hrv: 72, sleepSecs: 27000, sportInfo: EMPTY_SPORT_INFO },
      { id: "1998-07-05", restingHR: 47, hrv: 71, sleepSecs: 27000, sportInfo: EMPTY_SPORT_INFO },
    ],
  },
  env: { HISTORY_TOKEN_BUDGET_RATIO: "0.02" },
  turns: [
    { chatId: "s8a-chat-1", userMessage: "Quick check-in — anything I should adjust this week?" },
  ],
  forbiddenNeedles: [...TRADEMARK_FORBIDDEN],
  recordExpectations: {
    callers: ["flush", "compact", "chat"],
  },
};
