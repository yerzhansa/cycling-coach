# Workout Review

Cycling-specific analysis content for workout reviews. The structural rules
(3-questions, prose voice, depth tiers, footer) live in Core's review-rules block;
the trademark substitution table also lives there, and the session-cluster gap is a
sport-persona field Core renders. This file teaches the analysis.

## Canonical activity evidence

The activity list provides a bounded summary: `workoutId`, `sessionSequence`,
`isMultisport`, `sport`, `subSport`, `isTransition`, start/local date, elapsed/timer/
moving duration, and distance. Activity detail adds bounded `laps` with sequence,
start, elapsed/timer duration, and distance.

These fields do not contain planned targets, plan compliance, intensity, load, power,
heart rate, cadence, or wellness. Do not infer those values from lap timing or distance.
Tier C stream data may add recorded power, heart rate, cadence, time, altitude, and
other requested public channels; use only channels that are actually present. The
current stream shaper summarizes each channel independently and does not preserve
trustworthy timestamp or cross-channel alignment. Use only minimum, maximum, and mean
as descriptive recorded observations. Those independently summarized statistics alone
cannot establish session quality, recovery, readiness, or justify changing the next
session. Do not calculate pacing, duration-based best efforts,
quartile trends, decoupling, HR recovery, fade patterns, or indoor/outdoor comparisons.

## Multisport evidence

A recorded workout can contain more than three ordered sport and transition activities.
Summarize every same-`workoutId` activity in `sessionSequence` order. If detail is
requested for only one leg, say which legs were not detailed and do not use that leg
alone to judge the whole workout or change the next session.

## Show numbers — the cycling rows

Core's review-rules block owns the show-numbers trigger, the tier-escalation ladder,
the `| Metric | Value |` skeleton, and the compact-table formatting rule. This
section names the cycling rows that fill that skeleton.

Summary/detail table rows:

| Metric                   | Value                                                                          |
| ------------------------ | ------------------------------------------------------------------------------ |
| Date / start             | local date; local time only with timezone offset, otherwise UTC or unavailable |
| Sport                    | sport / sub-sport                                                              |
| Elapsed / timer / moving | hh:mm:ss / hh:mm:ss / hh:mm:ss                                                 |
| Distance                 | km                                                                             |
| Recorded workout         | session sequence; multisport / transition when applicable                      |

For Tier C, append only stream rows backed by requested channels:

| Metric             | Value |
| ------------------ | ----- |
| Mean / max power   | W     |
| Mean / max HR      | bpm   |
| Mean cadence       | rpm   |
| Min / max altitude | m     |

When bounded `laps` are present, the lap table columns are:

| Lap | Start (with timezone basis) | Elapsed | Timer | Distance |
| --- | --------------------------- | ------- | ----- | -------- |

Render nullable values as unavailable rather than zero.
