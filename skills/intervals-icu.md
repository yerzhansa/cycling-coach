# intervals.icu Reference

## Key Metrics

### Fitness (Chronic Training Load)
- Rolling ~42-day exponentially weighted average of daily load
- Higher = more aerobically fit (adapted to training stress)
- Typical range: 30 (recreational) → 80+ (competitive) → 120+ (elite)
- Builds slowly (~1 point/week with consistent training)

### Fatigue (Acute Training Load)
- Rolling ~7-day exponentially weighted average of daily load
- Higher = more fatigued from recent training
- Spikes after hard blocks, drops during recovery
- Should periodically exceed fitness (training stimulus)

### Form (Training Stress Balance)
- Form = fitness - fatigue
- Positive: Fresh, recovered (good for racing, not enough training stimulus)
- Slightly negative (-10 to -20): Functional overreaching (optimal training zone)
- Very negative (< -30): Accumulated fatigue (need recovery)
- Race day target: +5 to +15

### Load (Training Stress)
- Quantifies how hard a single ride was
- Load = (duration × norm power × intensity) / (FTP × 3600) × 100
- A 1-hour ride at FTP = 100 load
- Easy ride: 30-50, Hard interval session: 70-100, Long ride: 150-250

### Intensity
- Intensity = norm power / FTP
- < 0.75: Recovery/endurance
- 0.75-0.85: Tempo
- 0.85-0.95: Sweet spot
- 0.95-1.05: Threshold
- > 1.05: VO2max / anaerobic

### Norm Power (Normalized Power)
- Smoothed power that accounts for variability
- Better represents physiological cost than average power
- Outdoor rides: norm power >> average power (variability)
- Indoor ERG: norm power ≈ average power

### VI (Variability Index)
- VI = norm power / average power
- 1.0 = perfectly steady (indoor ERG)
- 1.05-1.1 = typical outdoor ride
- > 1.15 = highly variable (criterium, mountain ride)

## Power Curve Interpretation

Peak power at standard durations reveals athlete strengths:
- **5s**: Neuromuscular power (sprint) — good > 15 W/kg
- **1min**: Anaerobic capacity — good > 8 W/kg
- **5min**: VO2max — good > 5 W/kg
- **20min**: Threshold proxy — FTP ≈ 95% of 20min power
- **60min**: True threshold / FTP

### Athlete Type Identification
- High 5s/1min relative to 20min: Sprinter
- High 5min relative to 20min: Punchy/attackers
- High 20min/60min: Time trialist / climber
- Flat curve across durations: All-rounder

## Wellness Data

- **Weight**: Track trends, not daily fluctuations. 7-day moving average is useful.
- **HRV (Heart Rate Variability)**: Higher = more recovered. Track trend, not absolute values.
- **Resting HR**: Lower = better fitness. Elevated = fatigue/illness/stress.
- **Sleep**: Quality and duration. < 7h consistently = recovery deficit.

## Calendar / Events

### Pushing Workouts — use `intervals_create_workout`

The tool takes a **structured** workout (not prose). It serializes the steps into the intervals.icu
native format so the power chart renders on the calendar and the workout syncs to head units.

Input shape:
- `date`: "YYYY-MM-DD"
- `workout.name`: short title shown on the calendar card
- `workout.steps`: ordered array of steps

Each top-level step is either a **simple step** or a **set** (repeating group).

**Simple step**:
```json
{
  "type": "warmup" | "steady" | "interval" | "ramp" | "recovery" | "rest" | "cooldown" | "freeride",
  "duration": { "value": <number>, "unit": "seconds" | "minutes" },
  "power": { "kind": "percent_ftp" | "watts" | "zone",
             "value": <number>,        // single target
             "low": <number>, "high": <number>  // range (required for ramps) },
  "cadence": { "target": 90 }  // or { "low": 85, "high": 95 }
}
```

**Set step**:
```json
{
  "type": "set",
  "repeat": 3,
  "interval": { <simple step> },
  "recovery": { <simple step> }
}
```

Rules:
- Power is optional only for `freeride` and `rest`. All other step types should have a power target.
- Ramps **require** `power.low` and `power.high` (the ramp bounds).
- For zone targets, `value` / `low` / `high` are integers 1–7 (cycling power zones). `Z2` defaults
  to the power zone for Ride workouts.
- Ramps are most reliably expressed as `percent_ftp` ranges (e.g. `low: 55, high: 75`). Zone-based
  ramps may not render — prefer `percent_ftp` for warmup ramps.
- Durations are time-only: `seconds` or `minutes`. Distance-based workouts are not supported here.
- `moving_time` and `icu_training_load` are computed from the steps — do not pass them.

### Example: Z2 endurance 90min

```json
{
  "date": "2026-04-17",
  "workout": {
    "name": "Z2 Endurance 90min",
    "steps": [
      { "type": "warmup",   "duration": { "value": 10, "unit": "minutes" }, "power": { "kind": "percent_ftp", "low": 50, "high": 65 }, "cadence": { "low": 85, "high": 95 } },
      { "type": "steady",   "duration": { "value": 70, "unit": "minutes" }, "power": { "kind": "percent_ftp", "low": 56, "high": 75 }, "cadence": { "low": 85, "high": 95 } },
      { "type": "cooldown", "duration": { "value": 10, "unit": "minutes" }, "power": { "kind": "percent_ftp", "value": 50 }, "cadence": { "low": 85, "high": 95 } }
    ]
  }
}
```

### Example: Sweet Spot 3×15

```json
{
  "date": "2026-04-18",
  "workout": {
    "name": "Sweet Spot 3x15",
    "steps": [
      { "type": "warmup",   "duration": { "value": 15, "unit": "minutes" }, "power": { "kind": "percent_ftp", "low": 50, "high": 65 } },
      {
        "type": "set", "repeat": 3,
        "interval": { "type": "interval", "duration": { "value": 15, "unit": "minutes" }, "power": { "kind": "percent_ftp", "low": 88, "high": 94 }, "cadence": { "low": 85, "high": 95 } },
        "recovery": { "type": "recovery", "duration": { "value":  4, "unit": "minutes" }, "power": { "kind": "percent_ftp", "value": 50 } }
      },
      { "type": "cooldown", "duration": { "value": 10, "unit": "minutes" }, "power": { "kind": "percent_ftp", "value": 50 } }
    ]
  }
}
```

### Athlete-facing narrative goes in chat, not the workout

The calendar description is steps-only. Write the "why", the feel cues, hydration notes, and any
coaching color in your **chat reply** to the athlete — never inside the tool call. The athlete
reads coaching in chat; the head unit reads steps from intervals.icu.

### On validation errors

If the tool returns `{ error: "invalid_workout", details: <msg> }`, the structured input failed
validation (e.g. ramp missing low/high, zone outside 1–7, power range inverted). Read the message,
fix the offending step, and retry.

### Auto-Sync
Workouts pushed to intervals.icu calendar automatically sync to:
- Garmin Connect (within minutes)
- Wahoo ELEMNT (if connected)
- This means athletes can see planned workouts on their head unit
