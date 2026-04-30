# Workout Design

## Workout Types

### Endurance (Z2)
- Duration: 45min-3h
- Structure: Steady state at 56-75% FTP
- Cadence: 85-95 RPM
- When: Base phase, recovery weeks, long rides
- Indoor: Lower RPM fine (80-90), use ERG mode

### Tempo (Z3)
- Duration: 45-90min main set
- Structure: 2x20min or 3x15min at 76-90% FTP
- Cadence: 85-95 RPM
- When: Build phase, group ride simulation

### Sweet Spot (Z4)
- Duration: 45-75min main set
- Standard formats: 2x20min, 3x15min, 4x10min at 88-94% FTP
- Cadence: 85-95 RPM
- When: Primary training zone for time-crunched athletes
- Most time-efficient intensity for FTP development

### Threshold (Z5)
- Duration: 30-60min main set
- Standard formats: 2x20min, 3x10min, 2x15min at 95-105% FTP
- Cadence: 90-100 RPM
- When: Build/peak phase, race-specific prep

### VO2max (Z6)
- Duration: 15-25min main set
- Standard formats: 5x4min, 4x5min, 6x3min at 106-120% FTP
- Recovery: Equal time or 50% of interval duration
- Cadence: 95-105 RPM
- When: Peak phase, developing top-end power
- Limit: 2x per week maximum

### Sprint/Neuromuscular
- Duration: 5-10min total work
- Structure: 6-10x 15-30s all-out efforts
- Recovery: 3-5min between efforts
- When: Race prep, criterium training

### Recovery (Z1)
- Duration: 30-45min
- Structure: Easy spinning < 55% FTP
- Cadence: 90+ RPM (light gear)
- When: Day after hard effort, between hard blocks

## Workout Structure Template

Every workout follows: Warmup → Main Set → Cooldown

1. **Warmup** (10-15min): Progressive from Z1 to Z2, include 2-3 openers (30s at target intensity)
2. **Main Set**: The prescribed intervals
3. **Cooldown** (5-10min): Easy spinning in Z1

## Progressive Overload Patterns

- **Duration**: Add 2-5min per interval every 1-2 weeks (e.g., 2x15 → 2x18 → 2x20)
- **Sets**: Add a set every 2-3 weeks (e.g., 3x10 → 4x10)
- **Intensity**: Raise target 2-3% FTP per phase
- **Recovery reduction**: Shorten rest intervals (e.g., 5min → 4min → 3min)

## Indoor vs Outdoor

- Indoor: Better for structured intervals (ERG mode), controlled environment
- Outdoor: Better for long rides, group rides, race simulation
- Prescribe indoor for: weekday intervals, time-crunched sessions
- Prescribe outdoor for: weekend long rides, endurance rides

## Mapping to `intervals_create_workout`

When pushing a workout to the calendar, pass the structured shape (never prose — see
`intervals-icu.md`). Step types map to what's actually happening:

| Step                          | Use                                                      |
| ----------------------------- | -------------------------------------------------------- |
| `warmup`                      | Pre-set progressive build-up                             |
| `ramp`                        | Transition with `low`+`high` power bounds                |
| `steady`                      | Single block at one intensity (e.g. Z2 endurance)        |
| `interval`                    | Work effort inside a set (sweet spot, threshold, VO2max) |
| `recovery`                    | Easy spin between intervals inside a set                 |
| `rest`                        | Off-bike-style complete rest (rare in cycling)           |
| `cooldown`                    | Post-set easy spin                                       |
| `freeride`                    | No power target (Zwift freeride / outdoor easy)          |
| `set { repeat, interval, recovery }` | Group repeated intervals (e.g. 3×15 sweet spot)  |

### Sweet Spot 3×15 → tool input

```json
{
  "name": "Sweet Spot 3x15",
  "steps": [
    { "type": "warmup",   "duration": { "value": 15, "unit": "minutes" }, "power": { "kind": "percent_ftp", "low": 50, "high": 65 } },
    { "type": "set", "repeat": 3,
      "interval": { "type": "interval", "duration": { "value": 15, "unit": "minutes" }, "power": { "kind": "percent_ftp", "low": 88, "high": 94 }, "cadence": { "low": 85, "high": 95 } },
      "recovery": { "type": "recovery", "duration": { "value":  4, "unit": "minutes" }, "power": { "kind": "percent_ftp", "value": 50 } } },
    { "type": "cooldown", "duration": { "value": 10, "unit": "minutes" }, "power": { "kind": "percent_ftp", "value": 50 } }
  ]
}
```

### Z2 Endurance 90min → tool input

```json
{
  "name": "Z2 Endurance 90min",
  "steps": [
    { "type": "warmup",   "duration": { "value": 10, "unit": "minutes" }, "power": { "kind": "percent_ftp", "low": 50, "high": 65 }, "cadence": { "low": 85, "high": 95 } },
    { "type": "steady",   "duration": { "value": 70, "unit": "minutes" }, "power": { "kind": "percent_ftp", "low": 56, "high": 75 }, "cadence": { "low": 85, "high": 95 } },
    { "type": "cooldown", "duration": { "value": 10, "unit": "minutes" }, "power": { "kind": "percent_ftp", "value": 50 } }
  ]
}
```

### VO2max 5×4 → tool input

```json
{
  "name": "VO2max 5x4",
  "steps": [
    { "type": "warmup",   "duration": { "value": 15, "unit": "minutes" }, "power": { "kind": "percent_ftp", "low": 50, "high": 70 } },
    { "type": "set", "repeat": 5,
      "interval": { "type": "interval", "duration": { "value": 4, "unit": "minutes" }, "power": { "kind": "percent_ftp", "low": 106, "high": 120 }, "cadence": { "low": 95, "high": 105 } },
      "recovery": { "type": "recovery", "duration": { "value": 4, "unit": "minutes" }, "power": { "kind": "percent_ftp", "value": 50 } } },
    { "type": "cooldown", "duration": { "value": 10, "unit": "minutes" }, "power": { "kind": "percent_ftp", "value": 50 } }
  ]
}
```

Narrative (feel, hydration, coaching cues) goes in your chat reply — not inside the tool call.
