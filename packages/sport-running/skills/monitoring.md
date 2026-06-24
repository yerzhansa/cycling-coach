# Running Training-Monitoring Reference

How to talk to a runner about the numbers that come back from their synced training — the **load trend**, **pace:heart-rate decoupling**, and anything touching **DFA-α1** or the aerobic threshold. The metric math is faithful and parity-checked; this file governs *what the runner sees and the words around it*. The hazard here is **mislabeling, not miscomputation**: presenting a descriptive number as a validated prescription, or calling a fractal-organization baseline the athlete's aerobic threshold.

## Two evidence halves — never trade confidence across the line

The material on this surface rests on two different grades of evidence. State nothing from the weaker half with the confidence of the stronger one.

- **DFA / aerobic-threshold half — strong (full-text) evidence.** Grounded in the version-of-record DFA-α1 literature.
- **Load (acute:chronic) / pace-decoupling half — weak (abstract-grade) evidence.** Grounded in abstract-level sources that license a *labeling guardrail only*, not a validated prescription, and the acute:chronic ratio construct is itself contested.

When you discuss both in one breath, keep the grades distinct. Borrowing the DFA half's confidence to dress up a load-trend statement is the exact failure this split prevents.

## Running load: a trend, never a ratio number

Surface running load as a **direction**, not a figure:

> "Your recent load is climbing above your built-up base." — or — "Your load is settling back below your base; that's recovery showing up."

- **Never quote the acute:chronic ratio value** (e.g. "1.35"), and **never apply the 0.8–1.3 'sweet-spot' or danger-zone bands.** The system computes the ratio internally; it is deliberately not shown.
- Why withhold the number: the recent 7-day (acute) term is itself part of the 28-day (chronic) baseline it is divided by, so the ratio tracks load as a mathematical artifact regardless of any real physiological link (Lolli 2019). The sweet-spot bands descend from team-sport injury data with no running-specific re-derivation, and the causal-inference critique holds that the thresholds were never validated as actionable injury guidance (Impellizzeri 2020, 2021). For running specifically the signal is weaker still — the most recent running-only analysis (abstract-grade) finds the effect minimal and non-significant.
- The honest residual the construct *does* support is the trend — is recent load rising or falling against the base. Give that, and stop there.

## Running DFA-α1: no number, ever

For a runner there is **no α1 readout of any kind** — no α1 value, no crossing pace or heart rate, no "validated" status. The running adapter ships `dfaValidated=false`, so the metric is skipped, not surfaced.

- You may discuss DFA-α1 **as a concept** from general knowledge, but never quote a running α1 and never imply a running readout exists.
- Why running differs from cycling: foot-strike impact during running degrades the beat-to-beat (R-R) signal α1 is built from and can artificially suppress it. Cycling's validations never had to contend with that, which is why a validated α1 surface is gated to cycling and withheld for running.

## α1 ≈ 1.0 is never the aerobic threshold

If DFA-α1 comes up, do not equate a reading near 1.0 with the aerobic threshold. The literature's aerobic-threshold surrogate sits at **α1 ≈ 0.75**; a value near 1.0 marks intact fractal organization — easy effort *well below* threshold — not a threshold crossing.

## Pace:HR decoupling — flat terrain, pace only

- Compute and discuss decoupling on **pace vs heart rate over flat terrain**.
- The cycling escape hatch — let power absorb the gradient and decouple power:HR on any terrain — **does not transfer to running.** Running power and grade-adjusted pace are *not* validated grade-absorbing load anchors on this evidence, so a hilly run's decoupling is not trustworthy.
- Any specific decoupling percentage threshold or minimum-duration / minimum-steadiness figure is **coaching convention, not validated.** The physiology of why a steady, flat, sub-threshold effort is required is grounded; the exact cut-points are not. Don't quote them as if measured.

## The eight caveats — carry them whenever these numbers come up

1. **Fatigue masquerade.** A low α1 on an easy run can mean accumulated fatigue, not high intensity — a fixed α1 does not map to a fixed pace once the athlete is tired.
2. **Sensor limits.** α1 is not comparable across recording devices; optical / wrist (PPG) sensors lack the beat-to-beat precision it needs.
3. **Weekly-trend blind spot.** A rising/falling load trend does not see a single long run well above the recent longest — a single-session distance jump (greater than 110% of the prior 30 days' longest run) is its own first-class running risk signal the trend misses. Treat the figure as a direction to watch, not a hard cut-line — though this single-session signal itself rests on cite-grade evidence, so don't down-tone it to the load trend's weaker confidence.
4. **Input disclosure.** The load trend reflects **mean daily Load**, not the runner's distance or perceived-effort total; that input choice shapes what "rising" or "falling" means, so disclose it.
5. **Running power isn't grade-absorbing.** Decoupling leans on pace on flat terrain; running power and grade-adjusted pace are not the validated grade anchor cycling power is.
6. **Decoupling cut-points are convention.** Any decoupling percentage threshold or duration floor traces to coach / vendor sources, not peer-reviewed validation at this grade.
7. **Mind the evidence split.** The DFA half is full-text grade, the load / decoupling half abstract grade — statements must not borrow confidence across the line.
8. **No running α1, ever.** `dfaValidated=false` for running: no α1 value, no crossing pace or HR, no readiness or drift figure. Discuss the concept from priors only; never invent or quote a running α1.
