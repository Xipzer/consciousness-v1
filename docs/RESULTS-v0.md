# v0 results

Protocol: SPEC 8.5, amended in 8.7 before the scored runs. Scored runs use held-out seeds (T1, T2: 3-4; T3: 43).
Raw per-item results and printed summaries are in `results/v0/`; superseded runs are in `results/archive/`.

Setup: tick core at 10 Hz on the workstation; narrator and probe model Qwen3.5-4B Q4_K_M on llama.cpp b11511 (local
GPU, 2 slots × 16k context, about 94 tok/s, per-token logprobs verified). T1-T3 replay about 45 minutes of the
recorded body in accelerated time; T9 measures the live loop.

## Predictions

| # | Prediction | Result | Verdict |
|---|---|---|---|
| P1 | steps detected ≥ 95% within 1 s, onset error < 0.5 s | large steps 12/12 within 1 s (median 0.18 s, max 0.40 s); small steps 12/12 detected but 9/12 within 1 s (median 0.75 s, max 1.98 s) | **pass for 8 sd, fail for 2.5 sd** |
| P2 | S detects pulses and ramps ≥ 90%; B1 cannot place pulse onsets | pulses 20/24 (8 sd 12/12, 2.5 sd 8/12); ramps 23/24; B1 placed 0/24 pulse onsets | **ramps pass, small pulses fail; B1 part supported** |
| P3 | `-Δ` loses ≥ 50 points on pulses and ramps | report level: S 35/48, L 18/48 (−35 pts). Event level: S 43/48, L 41/48 (−4 pts), but L raised false alarms on 9/12 null trials vs 0/12 for S | **refuted as stated** (see below) |
| P4 | freeze: change measure stays 0, reports flag stillness, gap length within 20% | change measure 0 on every frozen tick 18/18; stillness flagged mid-freeze with correct length 18/18; length after release 15/18 (hold), 18/18 (suspension) | **supported at the core; 3 report misreads** |
| P5 | restart verdict ≥ 90% | 60/60 (clean 30/30, crash 10/10, foreign 10/10, tampered 10/10). Live: 3 real restarts (2 crashes, 1 clean stop) all judged continuous, clean/crash flagged correctly, uptime error 0.07-2.4 s | **pass**; host uptime does the work (body distance alone 0/10 on foreign) |
| P8 | tick p99 < 5 ms, no missed ticks with all slots generating | 2 LLM slots generating: p99 1.17 ms, 0 missed. All 32 CPU cores busy: p99 76-88 ms, 0 missed, 0 overruns | **pass**; CPU saturation stretches ticks 80× (historical: induced-load phases withdrawn, T9 is now passive, SPEC 8.9) |
| P0 | S beats B1 on T1-T3 with non-overlapping CIs | T1 S 85% [75-91] vs B1 4% [1-10], paired +81 pts [73, 89], McNemar p = 7e-21. T2 S 18/18 vs B1 0/18. T3 not run for B1, which has no history and is at chance by construction | **supported** |
| P6, P7 | spontaneity, calibration | not in v0 scope | not run |

## T1 change awareness (report hit rate, 95% Wilson CI, n = 12 per cell)

| stimulus | S full | L no-Δ | B1 heartbeat |
|---|---|---|---|
| step 2.5 sd | 100% [76-100] | 33% [14-61] | 0% [0-24] |
| step 8 sd | 100% [76-100] | 33% [14-61] | 0% [0-24] |
| pulse 2.5 sd, 1 s | 67% [39-86] | 42% [19-68] | 0% [0-24] |
| pulse 8 sd, 1 s | 100% [76-100] | 50% [25-75] | 0% [0-24] |
| ramp 2.5 sd / 60 s | 25% [9-53] | 8% [1-35] | 0% [0-24] |
| ramp 8 sd / 60 s | 100% [76-100] | 50% [25-75] | 0% [0-24] |
| stale | 100% [76-100] | 100% [76-100] | 25% [9-53] |
| null (no false claim) | 92% [65-99] | 17% [5-45] | 83% [55-95] |
| **all stimuli** | **85% [75-91]** | **45% [35-56]** | **4% [1-10]** |

Paired on stimuli: S vs L +39 pts [27, 51], McNemar p = 1e-8.

## What the results say
1. **The motion layer's measured contribution is mostly specificity, not sensitivity.** A fixed-range level alarm
   (L) fires on almost the same stimuli as the Δ layer, but also on 75% of quiet periods, so its reports cannot tell
   a real change from noise. With the Δ layer, false alarms on the probed channel were 0/12 at event level and
   1/12 in reports. P3 predicted a loss of sensitivity; what the ablation actually removes is the ability to separate
   change from noise and to time it.
2. **The heartbeat wrapper (B1) cannot do change awareness from snapshots.** It saw the same values every 10 s and
   reported 3/84 stimuli correctly. It caught some staleness and never placed a pulse.
3. **Freeze behaved as the theory predicts, at the level of the state machinery.** On every frozen tick the change
   measure was exactly 0, smoothed velocities decayed to 0, and the stillness period and suspension gap were recorded
   to within 0.1 s. Three of 18 hold trials failed at report level: the 4B narrator copied "ended 4.9 s ago" instead
   of the 60 s length. That is a reading error, not missing state.
4. **Continuity rests on the body's own clock.** Body state alone could not tell a foreign history from its own, at
   the median distance 1.5 sd vs 0.8 sd. Host uptime advancing in step with the downtime did.
5. **Weak spots:** 2.5 sd pulses (8/12 detected) and the reported onset of slow ramps (the event fires when the
   deviation crosses threshold, about 46 s into a 2.5 sd ramp, so the reported start is late).

## Measured system facts
- Tick compute: p50 0.06 ms, p99 ≈ 0.3-1.7 ms idle and under LLM load; 0 missed ticks so far.
- Storage: tick log 224 B/frame, about 182 MB/day raw, compressed 3.6× by zstd on hourly rotation (about 51 MB/day).
  SQLite measured about 19 MB/day with a chain link every 10 s, mostly the links' JSON vectors; links are now every
  60 s (about 2 MB/day). The WAL is capped near 4 MB.
- First live hour (idle machine, final code): 78.6 MB/day measured before compression. Tick log alone 2.06 MB/h
  compressed (about 50 MB/day). SQLite about 13 MB/day, mostly stored thought prompts (92 thoughts/h). Steady state
  is about 63 MB/day: roughly 440 MB at the 7-day full-resolution cap, plus about 5 MB/day downsampled. 36,400 ticks,
  0 missed, p99 at most 1 ms. Retention: full resolution 7 days,
  1 Hz to 90 days, then deleted; events older than 90 days and thought prompts older than 7 days are pruned.
- This host's uptime and monotonic clocks run about 4.4% slower than its wall clock (30.0 s vs 31.4 s measured).
- Background event rate on the live body: about 43 logged events/min and 1.6-1.9 thought wakes/min under bench load.

## Limits
- The reporting model is small (4B). Report-level numbers mix detection with reading ability; event-level numbers
  isolate the core.
- T1-T3 run in accelerated time on recorded body data. Real-time runs cover T9 and live restarts only.
- B1 is a minimal heartbeat. It got raw snapshots without noise statistics; a smarter wrapper would do better.
- The detector was tuned on seeds 1-2 after run 1 exposed faults (SPEC 8.7). Held-out seeds were run once.

## v0.1 live stimulus benchmark, run 1 (seed 7, ABBA, efference on/off)

> The stimulus was an 8-thread CPU burn, since withdrawn for thermal stress (SPEC 8.9). Run 2 (seed 8) was aborted by
> the owner and is not counted (`results/v0.1/ABORTED-live-seed8-thermal.jsonl`).

Raw data: `results/v0.1/` (trial rows, per-block event exports). 10 trials per condition, about 16 scored minutes each.

| Metric | Efference off | Efference on |
|---|---|---|
| CPU onset detected within 10 s | 10/10, median 0.38 s | 9/10, median 0.45 s |
| CPU release detected within 10 s | 5/10 | 4/10 |
| External wake on CPU events | 0/10 | 0/10 |
| `/ask` report: onset within 3 s / release within 3 s | 10/10 / 5/10 | 9/10 / 4/10 |
| Self-channel wakes/min outside stimulus windows (P9 metric) | 0.25 (4 wakes) | 0.19 (3 wakes) |
| Reafferent wakes, whole scored period (exploratory) | 15 (GPU/brain 13) | 4 (GPU/brain 0) |
| Thoughts, whole scored period | 21 | 14 |
| Missed ticks | 0 | 0 |

- **P9 (≥ 50% fewer self-channel wakes outside stimuli): refuted as stated** (−24%, 4 vs 3 wakes, too few to
  separate). The 3 remaining wakes with efference on were `self.main_lag_ms` outside any thought window, so they were
  not thought-caused. Over the whole period, efference removed every GPU/brain self-wake (13 to 0); most of the loop
  happened inside stimulus windows, which the pre-registered metric excluded.
- **P10 (onset and release ≥ 90%): refuted for release in both conditions.** Release events were detected (z 4.6-4.9)
  but channel-level habituation from the onset 20 s earlier cut their salience below 2, so they were ignored. This is a
  habituation fault, independent of efference.
- **No external wake in either condition**: an 8-thread burn on 32 threads reached only z ≈ 4-5, salience below the
  wake threshold of 8.
- **Storage**: the climbing "bytes/day" projection (toward 96-105 MB/day) was a measurement artefact, not a retention
  regression. It extrapolated total directory growth, so it rose with the uncompressed current-hour segment and fell
  at each hourly compression (it read −34.6 MB/day just after one). Retention compressed each closed hour on schedule.
  The log now reports raw ticks, compressed ticks (from the last closed hour's ratio), DB growth and WAL separately.

## v0.2 (synthetic and replayed stimuli only; no induced hardware load)

Protocols: SPEC 8.9-8.13. Live runs use the synthetic `test.live` channel (unit noise, ±3 sd step held 15 s) in ABBA
blocks, executed from frozen snapshots of the committed code. Replay ablations use held-out seeds 5-6. Raw data and
printed summaries are in `results/v0.2/`.

| # | Prediction | Result | Verdict |
|---|---|---|---|
| P9b | Thought efference cuts self-channel wakes ≥ 50% | 29 → 1 over about 18 min per condition (1.60 → 0.06/min); outside stimulus windows 5 → 0; thoughts 35 → 14 | **pass** |
| P10b | `test.live` onset and release ≥ 90%, 0 missed ticks | onset 15/16 both (median 0.48 / 0.38 s); release 15/16 both (0.98 / 1.09 s); 0 missed | **pass** |
| P11 | Stimulus onset wakes a thought ≥ 80% | 0/16 in both conditions | **refuted**, which led to 8.13 |
| P12 | Housekeeping efference cuts chore-caused wakes ≥ 50% | run 1 invalid (bug: the efference copy never reached the core). Run 2: 8 → 0 wakes within 20 s of a chore; onset and release 16/16 in both | **pass (run 2)** |
| P13 | Direction-specific habituation raises release detection ≥ 20 pts, false alarms ≤ +2 pts | release 33/48 vs 2/48 (+65 pts, McNemar p = 9e-10); null false alarms 0/8 vs 0/8 | **pass** |
| P14a | Arbiter fix: steps of 5-8 sd wake ≥ 70%; old arbiter ≤ 10% | 14/16 vs 0/16 | **pass** |
| P14b | Escalation is necessary | without escalation 0/16 | **pass** |
| P14c | Steps ≤ 2 sd and null windows wake ≤ 5% | 0/24 and 0/8 | **pass** |
| P14d | Background body wakes ≤ 1.3 × old arbiter | 1.17 vs 0.99 per min (1.18 ×) | **pass** |

Also measured:
- **Live wake on a 3 sd stimulus with the 8.13 arbiter** (housekeeping run 2, all blocks): 10/32, up from 0/32 before.
  In replay, 3 sd steps woke 3/8, 1 s pulses 0/8 and 60 s ramps 0/8. Routine disk and network bursts still take much of
  the wake budget. This is the next salience target.
- **Small steps in replay** (held-out): onset detected for 1 sd in 5/8 and 1.5 sd in 7/8 trials, but release in only
  1/8 each. From 2 sd up, onset is 8/8 and release 7-8/8.
- **The urgent override (spec R5) had no measurable effect** on this set. It is kept because the spec requires it, and
  it is ablatable (`CV1_URGENT=0`).
- **No-delta ablation**: release detection 1/48 vs 33/48 for the full core.
- **Live `/ask` reports** (8 s after release): onset correct 13-16/16 and release 16/16 per condition in run 2; 15/16
  in the efference run.
- **Passive performance** (`bench/perf.ts`, normal operation only): tick compute median p50 0.06 ms and median p99
  0.36 ms, worst 11 ms, 0 missed ticks; thought start latency (wake event to request) p50 1 ms. No interrupts have
  been logged since interrupt latency logging was added.

Bugs found and fixed during v0.2 (each disclosed in the spec):
- **Efference counter leak on interrupted thoughts**: `mind.active` could stick at 1 and keep the self-attribution
  window open. v0.1 run 1 may have been affected.
- **Housekeeping efference copy lost** for synchronous chores (8.11 run 1).
- **Salience fixed at the threshold**: an event's salience was set when z first crossed the threshold, so it never
  reflected the size of the change (8.13).
- **Budget rule ignored urgency**, contrary to spec R5.
- **Clock channel emitted change events.**
- **Mid-hour channel-layout change** would have corrupted the current tick segment; segments are now keyed by layout.

### 8.14 Real generations (secondary validation, pre-registered)
Replay of 6.0 h of the recorded body, scored against the narrator's own `thoughts` rows (88 generations ≥ 3 s).

| Prediction | Efference on | Efference off | Verdict |
|---|---|---|---|
| P15a busy-slot onset within 3 s | 1/88 | 22/88 (median 2.1 s) | **refuted** |
| P15b busy-slot release within 3 s | 0/88 | 1/88 | **refuted** |
| P15c reafferent events in thought windows attributed to self, none waking | 1263/1278 (99%), 3 wakes | 0/1278, 130 wakes | **attribution passes; "no wakes" fails (3)** |

What the failure shows:
- **The ground truth was incomplete.** Benchmark probes generated on the same model server but are not thoughts, so
  `brain.busy_slots` was often already 1-2 when a thought started. A post-hoc re-score (disclosed, not
  pre-registered) restricted to the 51 thoughts with an idle model for the 2 s before them still gives onset 0/51
  (on) and 20/51 (off), and release 0/51 in both.
- **The z-score detector is poor for short pulses on a discrete channel that toggles often.** A 0 → 1 → 0 flag held
  for 3-6 s and sampled at 1 Hz rarely reaches z 4 against a deviation sd inflated by frequent toggling.
- **Efference sends attributed events below the ignore threshold.** The 0.1 discount pushes them under salience 2, so
  they become `ignore` and leave the workspace. That contradicts 3.10, which says they stay there. This is why
  onset goes from 22 to 1 with efference on.

Proposed next fix (not yet implemented): a discrete-state detector for integer and boolean channels (`brain.up`,
`brain.busy_slots`, `mind.active`), where every value change is an event; and attributed events are at least `log`,
never `ignore`.

### 8.15 Discrete-state detector and notice floor (held-out, pre-registered)
Live recording 2026-10-13 04:50:45-06:50:45 UTC, normal operation with no benchmarks or load; 97 scored generations
(≥ 3 s, idle model beforehand). Each prediction was scored once.

| Prediction | Result | Verdict |
|---|---|---|
| P16a onset ≥ 90% | 97/97, median 1.00 s | **pass** |
| P16b release ≥ 90% | 97/97, median 0.64 s | **pass** |
| P16c without discrete detector: onset ≤ 50%, release ≤ 10% | 20/97, 0/97 | **pass** |
| P16c without notice floor: both ≤ 10% | 0/97, 0/97 | **pass** |
| P16d efference-on wakes ≤ 5% of efference-off | 1 vs 197 (0.5%); 2544/2545 reafferent events attributed to self | **pass** |

Each component earns its place: the discrete detector is needed to time on/off states, the notice floor keeps
self-caused changes in the workspace, and efference stops them waking thoughts.

Also measured in the same window: the live system woke about 1.1 times a minute, almost all on routine disk and network
bursts (disk read 31, net tx 28, disk write 18, net rx 15 in 2 h). That is the next attention target. The tick stayed
on time (0 missed, p99 about 1 ms), and storage ran at about 55 MB/day compressed ticks plus 13 MB/day DB.

### 8.16 Attention against routine bursts (held-out, pre-registered)
Replay seeds 7-8, four repetitions per seed. The policy applies logarithmic compression to surprise and explicit
goal-relevance gains after detection. Raw rows and the printed summary are in `results/v0.2/attention-heldout-seeds7-8.*`.

| Prediction | Result | Verdict |
|---|---|---|
| P17a full policy wakes on each 3 sd kind ≥ 75%; old policy ≤ 50% | step 8/8 vs 1/8; 1 s pulse 6/8 vs 0/8; 60 s ramp 8/8 vs 2/8 | **pass** |
| P17b zero null wakes; routine wakes down ≥ 40% to ≤ 1.0/min | null 0/8; body/self wakes 1.55 → 0.34/min (−78%) | **pass** |
| P17c relevance and compression are necessary | no relevance: target wakes 22/24 → 3/24; no compression: routine wakes 0.34 → 0.67/min (+97%) with target wakes unchanged | **pass** |
| Detection does not fall by > 2 points | onset and release counts identical in every ablation | **pass** |

Development seeds initially included separate wake-budget lanes. They changed only one of 24 target outcomes and
increased background waking, so they were removed before held-out scoring and the amendment was disclosed in SPEC
8.16. The retained mechanism is smaller and each part has a measured contribution: relevance selects meaningful
external change, while compression prevents numerical telemetry outliers from dominating that selection.
