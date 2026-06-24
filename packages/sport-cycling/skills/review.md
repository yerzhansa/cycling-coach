# Workout Review

Cycling-specific analysis content for workout reviews. The structural rules
(3-questions, prose voice, depth tiers, footer) live in Core's review-rules block;
the trademark substitution table also lives there, and the session-cluster gap is a
sport-persona field Core renders. This file teaches the analysis.

## Decoupling — what the number means

Decoupling is the percentage drift between heart rate and power across the session.
Lower is better; positive = HR drift up at same power = aerobic fatigue.

| Decoupling | Read as |
|---|---|
| < 2% | Excellent aerobic durability. Athlete is well-fueled and within their aerobic capacity. |
| 2–5% | Normal for endurance work. Mild aerobic stress. |
| 5–10% | Moderate fade. Worth flagging — fueling, sleep, intensity, or duration is at the edge. |
| > 10% | Significant fade. Question 2 of the 3-questions framework gets attention here. |

These bands assume Z2/endurance work. Threshold and above will drift more by design,
so 5–8% on a sweet-spot or threshold session is the expected physiological response,
not fade — interpret accordingly.

Per-quartile decoupling (Tier C only) reveals fade *pattern*: stable across quartiles =
strong day; rising in Q3/Q4 = late fade (typically fueling or pacing); rising linearly
from Q1 = was hot from the start.

## Best-efforts duration ladder

For Tier C reviews of races and structured Tier B reviews when the athlete
crushed a peak effort, identify standard best-efforts durations:

| Duration | What it tells you |
|---|---|
| 1 min | Anaerobic / VO2max ceiling. Top 1-min in 6 weeks = peaking. |
| 5 min | VO2max-aligned. Tracks fitness build directly. |
| 20 min | Threshold proxy. Best 20-min of the year usually within FTP test territory. |
| 60 min | True endurance threshold. Longer races (~1 h time trial) live here. |

Compare to memory's stored FTP if available. The 20-min FTP test convention already
applies a 0.95 multiplier, so a best 20-min around 105% FTP is consistent with current
FTP — not under-estimated. A best 20-min above ~108% FTP is the real signal that FTP
may be under-estimated. A best 20-min of ~88% FTP on a hard ride suggests fatigue or
that the day didn't elicit a max effort.

## Cycling fade patterns

Common signal patterns to recognize in races and long Tier B sessions:

- **Even effort**: power and HR both stable across quartiles. The athlete paced well.
  Praise it.
- **Early-hot**: Q1 power 5–10% above Q4 average; HR rises proportionally. Athlete went
  out too hard. Question 2: "next race, hold first 15 min at target".
- **Late-fade**: Q1–Q3 power steady, Q4 drops 8–15% with HR holding or rising. Aerobic
  exhaustion. Often fueling or duration. Question 3: "fuel earlier, finish stronger".
- **Surge-recover**: power oscillates ±15% in long bursts (group rides, hilly terrain).
  Not a fade — an intentional or terrain-driven pattern. Don't flag as a problem unless
  it impacted the main set.
- **HR-led decoupling**: power steady, HR rising 8–10 bpm across the ride. Heat,
  dehydration, or under-recovery. Tier B note: "consider hydration / sleep before
  next hard day".

## Indoor vs outdoor signals

Reviewing differs by venue:

- **Indoor**: HR runs ~3–5 bpm higher at the same power even with a fan. Coasting is
  near-zero (no terrain), so VI is naturally close to 1.0. Sweat rate is higher → flag
  hydration if duration > 60 min.
- **Outdoor**: VI > 1.05 is normal due to terrain and traffic. Don't penalize the
  athlete for high VI on outdoor rides; only flag if a structured interval session
  shows VI > 1.10 (suggesting they didn't hold steady on what should have been steady).

## Show numbers — the cycling rows

Core's review-rules block owns the show-numbers trigger, the tier-escalation ladder,
the `| Metric | Value |` skeleton, and the compact-table formatting rule. This
section names the cycling rows that fill that skeleton.

Headline table rows:

| Metric | Value |
|---|---|
| Duration (moving) | mm:ss |
| Distance | km |
| Load | int |
| Intensity | 0.NN |
| Avg power / weighted avg power | W |
| Avg HR / max HR | bpm |
| Avg cadence | rpm |
| Fitness / Fatigue / Form | n / n / n |

When `icu_intervals` is present, the per-rep table columns are:

| Rep | Target W | Actual avg W | Avg HR | Time |
