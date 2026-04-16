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

### Pushing Workouts
When creating events on the intervals.icu calendar:
- `start_date_local`: ISO date string for the workout day
- `category`: "WORKOUT" for planned sessions
- `type`: "Ride" for cycling workouts
- `name`: Descriptive name (e.g., "Sweet Spot 2x20")
- `moving_time`: Duration in seconds
- `icu_training_load`: Planned load
- `description`: Workout details, interval structure, coaching notes

### Auto-Sync
Workouts pushed to intervals.icu calendar automatically sync to:
- Garmin Connect (within minutes)
- Wahoo ELEMNT (if connected)
- This means athletes can see planned workouts on their head unit
