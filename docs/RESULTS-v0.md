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
| P8 | tick p99 < 5 ms, no missed ticks with all slots generating | 2 LLM slots generating: p99 1.17 ms, 0 missed. All 32 CPU cores busy: p99 76-88 ms, 0 missed, 0 overruns | **pass**; CPU saturation stretches ticks 80× |
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
  60 s (about 2 MB/day). The WAL is capped near 4 MB. Retention: full resolution 7 days,
  1 Hz to 90 days, then deleted; events older than 90 days and thought prompts older than 7 days are pruned.
- This host's uptime and monotonic clocks run about 4.4% slower than its wall clock (30.0 s vs 31.4 s measured).
- Background event rate on the live body: about 43 logged events/min and 1.6-1.9 thought wakes/min under bench load.

## Limits
- The reporting model is small (4B). Report-level numbers mix detection with reading ability; event-level numbers
  isolate the core.
- T1-T3 run in accelerated time on recorded body data. Real-time runs cover T9 and live restarts only.
- B1 is a minimal heartbeat. It got raw snapshots without noise statistics; a smarter wrapper would do better.
- The detector was tuned on seeds 1-2 after run 1 exposed faults (SPEC 8.7). Held-out seeds were run once.
