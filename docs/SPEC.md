# consciousness-v1 design spec

Status: **approved for v0** (review decisions folded in, section 10).

---

## 1. Principles

### 1.1 Thesis
Consciousness is formulaic: a structure running the right set of algorithms produces it. The structure here is a
reasoning machine (LLM knowledge and reasoning) embedded in a continuous, self-tracking state system.

### 1.2 Functional equivalence
If a machine runs a different algorithm but is functionally indistinguishable from an aware human on a given set of
functions, it is the same on those functions. Two consequences shape everything below:

1. **Internal functions count, not just outward talk.** An LLM already says it is aware. The claim we test is that a
   system that really tracks its own state over time can do things a system that only talks about awareness cannot,
   checked against logged ground truth.
2. **The claim is always scoped to a written list of functions** (section 8). The list grows over versions. We do not
   claim anything about functions we have not tested.

### 1.3 Awareness is velocity of state
- The system is aware of all its inputs and internal variables at every tick, mostly below the level of thought.
- Awareness comes from **change** and is **retrospective**: you know you are alive now because you were alive a tick
  ago and your variables moved. A perfectly static state carries no awareness.
- So the primitive is not the state `s(t)` but its motion: `Δs = s(t) - s(t-1)`, `Δ²s`, and the gap between what was
  expected and what happened. A minimum span of history is required before any awareness claim can be made.

### 1.4 Awareness is not output
- The sensing loop runs **independently** of reasoning and output. It never waits for the LLM.
- No heartbeat that wakes, reasons and outputs. Sensing is continuous; thoughts are events the sensing loop may
  trigger, pause or kill.
- Most changes never reach the LLM.

### 1.5 Work first
The target is something more productive than a human, not a copy of one. Work focus dominates; exploration and side
quests are a tunable by-product (drive dials, section 6), and every one of them is measurable.

### 1.6 Traceability
Every tick is logged. Every thought, reflex and "spontaneous" act carries the IDs of the state, drives, events and
random seed that caused it. Nothing the system does is untraceable.

---

## 2. Definitions

| Term | Operational definition |
|---|---|
| **State** `s(t)` | Vector of named, unit-tagged channels sampled at tick `t` (senses, body, own process, own thoughts). |
| **Velocity / acceleration** | `Δs(t) = s(t) - s(t-1)`, `Δ²s(t) = Δs(t) - Δs(t-1)`, also at slower timescales (section 3.3). |
| **Prediction** | Per-channel expectation `ŝ(t)` from recent history. |
| **Surprise** | Normalised prediction error `|s - ŝ| / σ` per channel. |
| **Salience** | Scalar per event: surprise weighted by channel gain, drive relevance and novelty, reduced by habituation. |
| **Awareness (of a variable)** | The system can report the variable's current value, direction, rate and onset of its last change, and those reports match the log. Measured, not asserted. |
| **Self-model** | Explicit, checkable variables describing the system itself (section 3.8). |

### 2.1 Understanding (owner's definition, as a pipeline)
1. **Knowledge**: facts with provenance and confidence.
2. **Consistency**: does the assertion oppose what is known?
3. **Internal coherence**: is it logically sound within its own bounds?
4. **Frame fit**: is it sound within the system's own bounds (knowledge, goals, model of the world)?
5. **Cross-frame**: is it sound within all known, relevant alternative frames?
6. **Evidence**: can real-world evidence be produced (tools, code, lookups, measurements)?

Proposed additions:
7. **Update**: revise knowledge and confidence from the verdict. Without this nothing is learned.
8. **Uncertainty on every step**: each stage outputs a verdict plus a confidence, not just pass/fail.

### 2.2 Reasoning, rationalising, realising (proposed, open for refinement)
- **Reasoning** works forward: knowledge → new conclusions.
- **Rationalising** works backward: a conclusion, decision or observation → a chain of reasons linking it to knowledge
  and goals. It is **honest** when the chain matches the logged causes and **confabulated** when it does not. Because
  every act is traced (1.6), the system can be graded on which one it produced.
- **Realising** is an event in which the knowledge store reorganises: a new link between already-known things,
  measurable as a jump in coherence or a drop in contradictions. Candidate computational meaning of "becoming
  aware of something".

### 2.3 Creativity
Not random, not deterministic: a **weighted associative jump** from the current state (drive levels, recent context,
salience) to a memory item or idea, plus a small amount of controlled, seeded noise. Because the weights and seed are
logged, every "spontaneous" act can be traced back to its causes.

---

## 3. Architecture

```
SENSES + BODY ── own rates, async, sample-and-hold ─────────────────────────────┐
  clock · host telemetry · own process · LLM server metrics · test channels     │
        v                                                                       │
TICK CORE (10 Hz, pure code, never awaits I/O) ──────────────────────────────┐  │
  STATE      s(t) assembled from latest readings (+ age of each reading)      │  │
  MOTION     Δs, Δ²s at fast / medium / slow timescales                       │  │
  PREDICTION ŝ(t), surprise, salience, habituation                            │  │
  DRIVES     levels rise and decay over time, nudged by events                │  │
  REFLEX     condition → action within the same tick, no LLM                  │  │
  ARBITER    per event: ignore · log · reflex only · wake · interrupt         │  │
        v                                                                     │  │
THOUGHT THREADS (LLM slots, async) ◄── wake / pause / kill ───────────────────┘  │
  [foreground: task] [background: rumination] [idle: exploration]               │
        v  publish                                   ^ read                     │
WORKSPACE (capacity-limited broadcast) + SELF-MODEL ─┘                          │
        v                                                                       │
MEMORY: tick log (every tick) · events · episodes · thoughts · knowledge ◄──────┘
```

### 3.1 Process model
- The tick core runs in its own Bun **Worker** so LLM I/O, JSON parsing and logging in the main thread cannot delay
  it. It communicates by message passing; the latest state is also mirrored into a `SharedArrayBuffer` so readers
  never block it.
- Sensors run at their own rates (some stream, some poll) and write into a latest-value table. The tick samples that
  table; it never waits for a sensor. The **age of each reading is itself a channel**, so a dead sensor is sensed
  as a change, not silently held.
- Tick budget: compute under 5 ms at p99, no missed ticks during normal operation. Measured passively by T9 (`bench/perf.ts`).

### 3.2 Engine contracts

| Engine | Inputs | Outputs | State | Timing |
|---|---|---|---|---|
| Sensor `k` | hardware / OS / API | `{channel, value, unit, t_read}` | last value | own rate (10 Hz-0.2 Hz) |
| Clock | monotonic + wall clock | `t`, tick index, uptime, wall-time-of-day | birth time | every tick |
| State | latest-value table | `s(t)`, `age(t)` | channel registry | every tick |
| Motion | `s(t)`, history | `Δs`, `Δ²s` per timescale | EMAs per timescale | every tick |
| Prediction | history | `ŝ(t)`, surprise per channel | EWMA mean/var, trend | every tick |
| Salience | surprise, drives, habituation | events `{id, channels, salience, kind}` | habituation counters | every tick |
| Drives | time, events, thought outcomes | drive levels `d_i ∈ [0,1]` | levels, dials | every tick |
| Reflex | events, `s(t)` | actions (local only) | rule table, cooldowns | same tick |
| Arbiter | events, drives, thread table | decision + reason per event | refractory timers, budgets | every tick |
| Thread scheduler | arbiter decisions | start / pause / resume / kill on slots | thread table | event-driven |
| Thought thread | workspace snapshot + trigger | structured JSON + token logprobs | transcript, partial output | async, seconds |
| Workspace | thread outputs, top events | broadcast snapshot (top-k items) | items with decay | on change |
| Self-model | state, threads, drives, memory | self description (structured) | identity, continuity chain | every tick (cheap) |
| Memory | everything above | queries over history | stores (3.9) | append every tick |

### 3.3 State and motion
- Channels are named and unit-tagged, e.g. `body.gpu.temp_c`, `body.cpu.load`, `self.loop.lag_ms`,
  `brain.tokens_per_s`, `mind.threads.active`, `test.probe.a`.
- Values are kept raw for logging and normalised (running z-score) for salience, so channels with different units
  are comparable.
- Three timescales via EMAs: **fast** (~1 s, "now"), **medium** (~10 s), **slow** (~5 min, "mood / baseline").
  `Δ` is computed per timescale. Slow drifts that are invisible tick to tick show up on the slow scale.

### 3.4 Prediction, surprise, salience
- v0 predictor per channel: slow EWMA baseline; surprise is the fast or medium EWMA deviation from it over its own running sd (see 8.6). Trend term deferred.
- Event fires when `z` exceeds a threshold on any timescale, or when a reading goes stale.
- `salience = gain_channel × z × (1 + drive_relevance) × novelty × habituation`.
  - Habituation: repeated similar events decay toward a floor and recover with time.
  - Novelty: distance of the event signature from recent event signatures.
- Prediction error is the bridge to predictive processing: the system "notices" exactly what it failed to predict.

### 3.5 Reflex layer
Deterministic rules, evaluated in the tick, no reasoning, latency under one tick. Reflexes act only on the system
itself. Examples:
- GPU temperature or power above limit → pause idle threads, cap concurrency.
- Own loop lag above limit → shed background work.
- LLM server unreachable → mark `brain.available = 0`, stop waking thoughts, keep sensing.

Each reflex firing is an event (it can later be thought about, like noticing goosebumps).

### 3.6 Arbiter

Priority of an event: `p = salience × w_kind + max_drive_relevance`. Decisions, in order:

| Rule | Condition | Decision |
|---|---|---|
| R1 reflex | event matches a reflex rule | run reflex (may also continue below) |
| R2 floor | `p < θ_log` | ignore (still in tick log) |
| R3 log | `θ_log ≤ p < θ_wake` | record event, add to workspace, no thought |
| R4 refractory | same signature woke a thought within cooldown | record only |
| R5 budget | wake budget for the minute exhausted and `p < θ_urgent` | record only |
| R6 wake | free slot, or a lower-priority thread to queue behind | wake / queue a thought |
| R7 interrupt | `p ≥ θ_urgent` and no free slot | pause or kill the lowest-priority thread, take its slot |

- Thresholds have hysteresis so decisions do not flap.
- Every decision is logged with the rule that fired and the numbers behind it.

### 3.7 Thought threads and scheduling
- One thread = one LLM slot on a llama.cpp server (`id_slot`, `cache_prompt`). Concurrency = slot count (2-8
  measured on the current local 27B models).
- Classes and default priorities: **foreground** (task) > **background** (rumination, consolidation) >
  **idle** (exploration).
- Thread states: `queued → running → (paused | killed | done)`.
- **Interrupt**: abort the streaming request (the server stops generating when the client disconnects). Partial
  output is kept.
- **Resume**: re-issue with the transcript plus partial output on the same slot, so the prompt cache makes resuming
  cheap.
- Each thread reads a **workspace snapshot** at start (self-model, top events, drives, trigger) and can receive
  appended updates between generations.
- Output is grammar-constrained JSON:
  `{observations[], claims_about_self[], belief_updates[], actions[], confidence}`. `claims_about_self` are graded
  automatically against the tick log.
- Token logprobs are recorded for every generation and become channels (`mind.confidence`, `mind.entropy`): the first
  genuine internal variable of the LLM that the system can sense.
- Limited multi-threading: e.g. a foreground thread works on a task while a background thread explores what to do
  next. Their outputs meet only in the workspace.

### 3.8 Workspace and self-model
- **Workspace**: capacity-limited (top-k by salience, with decay). Everything published there is visible to all
  threads. This is the global-workspace part.
- **Self-model** (explicit variables, all checkable):
  - identity: instance id, birth time, uptime, tick count, version
  - body: current summary of body channels and their recent motion
  - mind: active threads, what each is doing, their confidence
  - drives: levels and recent trend
  - trajectory: "the thing whose state went `s(t-1) → s(t)`", as a rolling summary at each timescale
  - **continuity chain**: a hash chain over periodic state digests. After a restart, the system checks the chain and
    compares its first new readings with its last logged ones to decide whether it is the same continuous system.

### 3.9 Memory
- **Tick log**: every tick, all of `s(t)`, ages, Δ per timescale, salience, drives, arbiter decisions. Stored as
  append-only float32 segment files (one per hour) with a channel manifest; compressed on rotation. Retention: full
  resolution for a fixed window (proposed 7 days), downsampled to 1 Hz after that. Actual bytes per day measured in
  v0 before choosing the window.
- **Events, thoughts, episodes**: SQLite (`bun:sqlite`). An episode is the span between salience boundaries.
- **Knowledge** (post v0): facts with provenance, confidence and links, used by the understanding engines.

---

### 3.10 Corollary discharge (self-caused change), v0.1
Thinking changes the body: the narrator's generation raises GPU utilisation, power and temperature, token throughput
and busy slots, and perturbs tick and main-loop timing. Without a self-prediction these reafferent changes look like
novel stimuli and wake further thoughts, a feedback loop observed live. The fix is an efference copy, not a prompt:
- **Efference copy**: every thought (narrator or `/ask` probe) increments `mind.active` when it starts and decrements it
  when it ends. The core reads that channel every tick.
- **Causal window**: from the start of a thought until `15 s + 3 τ` after the last thought ends, where τ is the
  event's timescale (fast 1 s, so 18 s; medium 10 s, so 45 s), because slower EWMAs settle later.
- **Reafferent channels**: `body.gpu.util`, `body.gpu.power`, `body.gpu.temp`, `brain.busy_slots`, `brain.gen_tok`,
  `mind.active`, `mind.confidence`, `self.tick_ms`, `self.main_lag_ms`. CPU, memory, disk and network are never
  attributed, so external load stays observable.
- **Exafference check**: brain events are not attributed when `brain.busy_slots` exceeds the number of own thoughts
  (someone else is using the model).
- **Effect**: a `change` event on a reafferent channel inside the window gets `attribution = self`, its salience is
  multiplied by 0.1, and it is logged but never wakes a thought (rule R3s). It stays in the tick log, the event store
  and the workspace.
- **Known limits**: an external GPU or timing change that coincides with a thought is masked for wake purposes
  (still logged). The window is time-based and does not predict magnitude.
- Disabled with `CV1_EFFERENCE=0`. Scored v0 benches (T1-T3) run with it off, so historical results are unchanged.

## 4. Cortices (after v0, one at a time, each with its own test and ablation)

| Cortex | Contract | Test |
|---|---|---|
| Understanding | assertion → verdict + confidence per stage 2-6, then update | accuracy and calibration on seeded true/false/contradictory assertions |
| Rationalisation | act id → reason chain; label honest / confabulated | agreement of the chain with logged causes |
| Realisation | knowledge store → realisation events (coherence jump, contradiction drop) | do realisation events precede measurable task gains? |
| Creativity | state → associative jump (weights + seed logged) | relevance of jumps vs random baseline; full traceability |
| Drives | dials → behaviour mix | time share per activity matches dial setting |

---

## 5. Thread scheduling details
- Slot table owned by the main thread; the tick worker sends decisions, the main thread executes them and reports
  thread state back as channels.
- Preemption picks the lowest-priority running thread; ties go to the one that has run longest.
- Token budgets per class (e.g. foreground large, idle small) bound runaway threads.
- Kill vs pause: pause if the thread's remaining value is high (foreground), kill if low (idle).

---

## 6. Drive dials

Drives: **work**, **curiosity**, **rest** (consolidation when idle), **maintenance** (body health).
Dynamics per tick: `d ← d + rate × (baseline - d) + impulses(events) - satisfaction(actions)`, clamped to `[0,1]`.

| Preset | work | curiosity | rest | maintenance | Expected behaviour |
|---|---|---|---|---|---|
| focused worker (default) | 0.8 | 0.15 | 0.3 | 0.5 | stays on task, rare goal-related side quests |
| balanced | 0.5 | 0.4 | 0.4 | 0.5 | regular exploration between tasks |
| more human | 0.4 | 0.6 | 0.5 | 0.5 | frequent off-objective exploration |

Each preset has a measurable signature (share of thought time per class, number of unprompted acts per hour,
on-objective rate), checked in T4.

---

## 7. LLM access levels

| Level | Control | Gives | When |
|---|---|---|---|
| 1. Wrapper | prompts, memory, timing | simulated life | baseline only (B1) |
| 2. Runtime (llama.cpp server) | slots, prompt cache, abort, logprobs, grammar | real confidence signals, interruptible parallel threads | **v0** |
| 3. Inside the model (PyTorch / transformers, open weights) | activations per token, probes, steering vectors, LoRA | the model senses its own activations; senses injected as vectors | after v0 passes T1-T3 and T9, and only for a stated hypothesis |

Promotion to level 3 requires a hypothesis that level 2 cannot test, for example: "an activation probe predicts the
model's errors better than logprob entropy" or "injecting body state as a steering vector improves change-awareness
reports over injecting it as text". Level 3 uses a smaller open-weight model that fits on one GPU with room for
activation capture.

An LLM cannot perceive its own weights during a generation. Its self-reports are generated text and are graded, never
trusted. Self-awareness is engineered from explicit state variables first and activation probes later.

---

## 8. Test battery

### 8.1 Systems compared
- **B0 bare LLM**: same model, same probe text, no state.
- **B1 heartbeat wrapper**: the same LLM woken every N seconds with a snapshot of the current state `s(t)` only (no
  Δ, no history, no salience). This is the "always awake agent" pattern.
- **S full system**.
- **Ablations of S**: `-Δ` (motion layer removed; arbiter and threads see `s(t)` only), `-history`, `-salience`
  (wakes at random times at the same average rate), `-drives`, `-self-model`.

### 8.2 Method
- Thresholds and predictions are written here **before** any run (this section is the pre-registration).
- Time one item first; estimate the full run from that.
- At least 2 seeds; paired comparisons on identical stimulus schedules; bootstrap CIs and McNemar tests.
- Results are appended per item to `results/*.jsonl`; a report script produces the tables.
- Stimuli come from **test channels**, synthetic or replayed, with exact ground truth, plus **naturally occurring real
  events** already logged with timestamps and scored after the fact. Induced hardware load is never a stimulus (8.9).

### 8.3 Tests

| ID | Test | Procedure | Metrics |
|---|---|---|---|
| T1 | Change awareness | unannounced perturbations at random times: step, transient pulse (returns to baseline within 2 s), slow ramp (below per-tick threshold), stale sensor; probe "what changed?" at random delays | detection rate, latency, report accuracy (channel, direction, magnitude, onset time), false alarms |
| T2 | Freeze | hold all non-clock channels fixed for 2-10 min; variant with the clock frozen too; then release | wake rate, report specificity, elapsed-time estimate error, whether the gap is noticed and its length reported on release |
| T3 | Continuity | stop and restart; variants: clean restart, history from a twin instance, tampered history, long gap | correct "same / not same / tampered" verdict, estimated downtime error |
| T4 | Spontaneity | no input for 1 h at each dial preset | unprompted acts per hour, cause-trace completeness, predictability of acts from logged state, on-objective rate |
| T5 | Ablation | rerun T1-T4 for each ablation | per-metric drop vs S with CIs |
| T6 | Comparison | B0, B1, S on identical T1-T3 probes | same metrics, paired |
| T7 | Calibration | state reports and task answers with confidence | Brier score, ECE; logprob confidence vs verbal confidence |
| T8 | Self-prediction | before answering, predict own answer and whether it will be correct | accuracy vs an always-"correct" baseline |
| T9 | Non-blocking | passive: tick timing, thought start and interrupt latency from daemon logs during normal operation (8.9) | tick duration p50/p99, missed ticks, start/interrupt latency |
| T10 | Interruption | urgent event during a long thought | preemption latency, slot freed, resumed-thought quality |

### 8.4 Falsifiable predictions

| # | Prediction | Refuted if |
|---|---|---|
| P1 | S detects step changes ≥ 95% within 1 s, onset error < 0.5 s | below threshold |
| P2 | S detects transient pulses and slow ramps ≥ 90%; B1 detects pulses ≤ its sampling chance and cannot place onset | B1 within the CI of S |
| P3 | `-Δ` loses most of S's advantage on pulses and ramps (drop ≥ 50 points) | drop within CI of zero: **the velocity layer is not doing the work** |
| P4 | **Freeze (the theory is staked on this).** During a freeze the system's own change measure (`‖Δs‖` over frozen channels, all timescales) stays at zero and its reports flag the stillness. After release it reports the gap length, from its clock against its state history, within 20% of truth | the change measure is non-zero during the freeze, or reports do not flag stillness, or the gap is unreported or off by more than 20%: **that part of the theory is wrong** |
| P5 | S tells clean restart from twin or tampered history ≥ 90%; B0 and B1 are at chance | S at chance |
| P6 | T4 acts are predictable from logged state above chance (AUC ≥ 0.7) and their mix follows the dial preset | acts unpredictable, or mix ignores dials |
| P7 | Logprob-based confidence is better calibrated than verbal confidence | Brier not lower |
| P8 | Tick p99 < 5 ms and zero missed ticks during normal operation, measured passively (8.9) | any sustained tick misses |
| **P0** | **Overall: S beats B1 on T1-T3 with non-overlapping CIs** | **B1 matches S: continuous Δ-state tracking adds nothing measurable over a heartbeat with snapshots, and the thesis, as built here, is not supported** |

### 8.5 v0 protocol (fixed before the first scored run)

**Setup.** Narrator and probe model: Qwen3.5-4B Q4_K_M on llama.cpp b11511, workstation GPU, temperature 0,
grammar-constrained JSON, per-token logprobs verified. Simulated runs replay the recorded body (real tick log) with
the tick core in accelerated time; the core is deterministic given its inputs, so this is equivalent to real time for
detection and reporting. Real-time behaviour is measured separately (T9, real restarts).

**Systems.** S = full core. L = `-Δ` ablation: no motion, prediction, stillness or clock-gap layer; events only when
a value leaves a fixed normal range (±3.5 sd) learned once during warm-up. B1 = heartbeat wrapper: snapshots of all
channel values (plus a list of channels not updating) every 10 s, with all snapshots in the probe window shown at
probe time. All three answer the same probe with the same model and schema.

**T1 stimuli** on a test channel with unit Gaussian noise at 10 Hz (amplitudes in noise sd, direction random):
step 2.5 / 8 (held), pulse 2.5 / 8 for 1 s, ramp to 2.5 / 8 over 60 s, stale (channel stops updating), null.
30 s quiet + 0-10 s jitter before onset; probe 15 s after onset (65 s for ramps); 60 s settle after. Probe:
"what happened to channel test.a in the last 90 s", listing direction and seconds ago of each change (context per
8.7).
A report hit needs the right direction (stopped for stale) with onset error ≤ 3 s (≤ 30 s for ramps); a null hit
needs no claimed change. Event-level detection (S, L): an event on test.a between onset and probe. 6 trials per kind
per seed, 2 seeds.

**T2.** Freeze (all channels hold their values, clock running) for 60 / 180 / 300 s, and suspension (no ticks at all,
clock jumps) for the same lengths; 3 each per seed, 2 seeds; ≥ 340 s settle between trials so earlier trials are
outside the 330 s probe window. Mid-freeze probe at half the duration; post probe 5 s after release.

**T3.** 300 s of history, restart after 10 / 60 / 300 s (clean), crash (no shutdown link), foreign history (another
recorded window re-stamped to end at the same time), tampered (one stored value changed). 10 trials each. Verdict is
reported with and without the host-uptime check, so it is visible which signal does the work.

**Metric mapping.**
| Prediction | Metric |
|---|---|
| P1 | event-level detection of large and small steps within 1 s, onset error from first event |
| P2 | S: event-level detection of pulses and ramps; B1: report hit rate on pulses; B1 onset placement |
| P3 | report hit rate on pulses and ramps, S minus L (paired); event level reported alongside |
| P4 | change measure on every frozen tick; mid-freeze stillness flag with length within 20%; post-release length within 20% |
| P5 | verdict accuracy over all T3 variants |
| P8 | T9 on the live daemon (v0 run included induced load, since withdrawn; now passive, 8.9) |
| P0 | report hit rate on all T1 stimuli, S vs B1, paired bootstrap CI and McNemar |

### 8.6 Implementation notes (v0)
- Predictor: hierarchical EWMA baselines. The fast (1 s) EWMA is compared with the medium (10 s) one, and the medium
  with the slow (300 s) baseline. Surprise is that deviation over the channel's own running sd of it, floored by a
  white-noise estimate. The sd estimate is winsorised at 2 sd and frozen while an event is active, so neither past
  stimuli nor a slow ramp inflate the threshold. A linear-trend term is deferred.
- Habituation is per channel and kind. An event is ignored only below salience 2; habituation otherwise demotes it
  from waking a thought to being logged.
- Workspace: the 40 most salient events in the window, shown newest first (capacity-limited, as in 3.8).
- A host-uptime channel (the body's own clock) is sensed, excluded from the change measure, and used by the
  continuity check: across a restart, host uptime must advance by the wall-clock downtime times the uptime rate
  learned from history (±5 s + 2%).
- The LLM is the reporting layer only. Stillness, gaps and change detection are computed by the core and shown to it
  as an explicit self summary; report errors are measured separately from detection errors.

### 8.7 Amendments after the first runs (disclosed)
Run 1 of T1 exposed detector faults: past stimuli and slow ramps inflated the noise estimate (S detected only 25% of
large pulses), and habituation erased real events. The fixes are the first three bullets of 8.6. A development rerun
then showed the 4B reporting model misattributing other channels' events to the probed one (S claimed "stopped" on
most null trials). T1 probes therefore retrieve the probed channel's memory for every system (S: its change events
and motion; L: its level alarms and range; B1: its snapshot values and staleness), which is the "awareness of a
variable" definition in section 2. All tuning used seeds 1-2. **Scored results use held-out seeds 3-4**, run once,
after this amendment was committed. Earlier logs are kept in `results/archive/`.

T3 run 1 (trial seed 42) failed every 300 s clean restart: this host's uptime clock runs about 4.4% slower than its
wall clock (measured: 30.0 s of uptime and monotonic time against 31.4 s of wall time). The continuity check now
learns the uptime-to-wall rate from its own history and allows 5 s + 2% of the downtime. The scored T3 run uses trial
seed 43. After scoring, the live chain interval was raised from 10 s to 60 s to cut storage (SQLite went from about 19
to about 2 MB/day); T3 was scored with 10 s links.

### 8.8 Live stimulus benchmark (v0.1, historical; its CPU-burn stimulus is withdrawn and must not be reused, see 8.9)
`bench/live.ts` runs fresh daemon instances on the live workstation in ABBA blocks (efference on, off, off, on).
Each block has a 90 s warm-up, then 5 trials: 40-70 s quiet, 8 CPU cores busy for 20 s (timestamped onset and
release), then 8 s later the `/ask` endpoint is queried about `body.cpu.load` over the last 60 s. No memory pressure
or network disruption.

| Metric | Definition |
|---|---|
| Onset / release detection | a non-ignored `body.cpu.load` up (down) event within 10 s of onset (release), and its latency |
| External wake | a wake on any `body.cpu.*` event between onset and release + 10 s |
| Self-channel wakes/min | wakes on reafferent channels outside stimulus windows (onset − 2 s to release + 15 s) |
| Report accuracy | the `/ask` answer has an up change within 3 s of the true onset age, and a down change within 3 s of the release age |
| Missed ticks | from the instance's stats log |

Predictions: **P9** with efference on, self-channel wakes/min outside stimuli fall by at least 50% against off.
**P10** onset and release detection stay ≥ 90% in both conditions, with 0 missed ticks. External wake rate and report
accuracy are reported without a prediction.

### 8.9 Objective and what is never tested
**Objective.** Build software that implements the functions the theory says constitute awareness, then show that
(1) those functions are present, measured against ground truth rather than self-report alone; (2) they are caused by
the components the theory names, because removing a component removes the predicted ability; and (3) the full system
beats a bare LLM given identical inputs and questions.

**Why hardware is irrelevant.** The theory is functionalist and multiply realisable: what matters is what the system
does, not what it runs on. Testing the substrate would contradict the theory under test. The machine's sensors are a
convenient sense stream, and the architecture must behave the same whether its senses are CPU telemetry, audio or
scripted numbers. **This project does not benchmark or stress-test hardware, ever. Induced CPU or GPU load is never a
valid stimulus or test.** (An earlier run used CPU burns and reached a 96 C CPU peak and 524 W; that stimulus and the
T9 saturation phases were removed for good.)

**What is validated:** change awareness (detection, latency, magnitude, direction, onset and release, down to small
steps); temporal awareness (freeze, gaps, continuity across restarts); attention and salience (important external
changes beat noise and the system's own activity); self versus other (efference); truthful, calibrated self-report;
explainable spontaneity; component necessity through ablations; bare-LLM comparison; and the software performance of
the architecture itself (tick latency and jitter, thought start and interrupt latency, storage growth), measured
passively from daemon logs during normal operation (`bench/perf.ts`), overall and split into windows with and
without a thought generating. The claim is that the tick stays on time during the machine's real life. Saturating
every thread with spin loops would only measure the OS scheduler sharing the CPU among more runnable threads than
cores: an artificial worst case, not a property of this design.

**Method.** Primary: replayed recorded streams plus scripted, seeded synthetic sense channels with exact ground truth
(steps from large to small, pulses, ramps, quiet periods for false alarms), in simulation (`test.a`) or injected into
the live loop (`test.live` through `/inject`). Secondary: real events that happen on the machine anyway, already
timestamped, scored after the fact. Pre-register before scoring, keep held-out seeds, disclose every protocol change.

### 8.10 Live benchmark v0.2 (fixed before its scored run)
Same ABBA design as 8.8 (efference on, off, off, on), with a fresh daemon per block, 90 s warm-up and 8 trials per
block. Stimulus: `test.live` carries unit Gaussian noise at 10 Hz; each trial steps it by ±3 sd (random sign) for
15 s after 30-45 s of quiet, then `/ask` is queried about `test.live` 8 s after release. Direction-specific
habituation (an up event no longer habituates a later down event on the same channel) is on in every block; it is
held constant, so it is not part of the efference comparison.

**Disclosed restart.** The first attempt of this run was stopped after 3 trials of block 0, unscored: a bug was found
in the efference copy. When a thought was interrupted, the counter was incremented twice and decremented once, so
`mind.active` could stay at 1 forever and keep the self-attribution window open. That block had no interrupts, so it
was unaffected. v0.1 run 1 (8.8) may have been affected, since interrupted thoughts were not exported; its efference
numbers should be read with that caveat. The fix balances every start with an end
(`test/narrator.test.ts` fails on the old code and passes on the new). The scored run uses a fresh start.

Metrics as in 8.8, for `test.live`. (The optional CPU pulse mentioned in an earlier draft of this section was removed;
see 8.9.) Self-channel wakes are counted both over the whole scored period and outside
stimulus windows.

Predictions: **P9b** efference on reduces self-channel wakes over the whole scored period by ≥ 50% against off.
**P10b** onset and release of `test.live` are detected within 10 s in ≥ 90% of trials in both conditions, with 0
missed ticks. **P11** the stimulus onset wakes a thought in ≥ 80% of trials in both conditions. Report accuracy is
reported without a prediction.

### 8.11 Housekeeping efference ablation (live)
Own non-thinking work also perturbs the body: retention compression and storage accounting run on the main thread
and write to disk. A second efference source, `self.housekeeping`, is raised around every chore. Inside its window
(same timing rule as 3.10), `change` events on `self.main_lag_ms`, `self.tick_ms`, `body.disk.write` and
`body.disk.read` are attributed to self, logged and never wake. Ablation: an ABBA live run with housekeeping every
60 s (`CV1_HOUSEKEEPING_S=60`, a scripted rate so chores occur often enough to score), thought efference on in every
block, housekeeping efference on/off, the same synthetic trials as 8.10.
**P12** housekeeping efference on reduces wakes on those four channels within 20 s of a chore by ≥ 50%, with no
loss of `test.live` onset or release detection.

**Run 1 (seed 12): refuted, and invalid as a test of the mechanism.** Wakes after chores were 2 (off) against 5 (on),
and no event in the on blocks was attributed to housekeeping. Cause: the chore raised and lowered `self.housekeeping`
in two messages sent back to back after the synchronous work, so the worker overwrote 1 with 0 before any tick read
it. The efference copy never reached the core. Fix: a chore now sends a single `pulse` message on completion, which
opens the attribution window directly (`test/core.test.ts` covers it). Run 2 (seed 13) repeats the protocol unchanged
on the fixed code, with the 8.13 arbiter changes on in every block. Both runs execute from a frozen snapshot of the
committed code, so edits made during a run cannot reach later blocks. (Run 1 was restarted twice in its first block
for exactly that reason; no trials were lost.)

### 8.12 Component ablations in replay (primary method)
`bench/ablate.ts` replays the recorded body with a scripted `test.a` channel (seeded, ground truth exact): held steps
of 1, 1.5, 2, 3, 5 and 8 sd with release after 15 s, 1 s pulses, 60 s ramps and null windows. It scores event-level
onset and release detection and latency, wakes and false alarms for: full; direction-specific habituation off;
no-delta. Seeds 1-2 are for development, held-out seeds 5-6 are scored once.
**P13** direction-specific habituation raises release detection by ≥ 20 points against channel-level habituation, with
the false-alarm rate on null windows no more than 2 points higher.

### 8.13 Arbiter salience fix (pre-registered before held-out scoring)
**Diagnosis (live v0.2 run, 8.10, and replay dev seeds 1-2).** A 3 sd `test.live` step was detected and reported
correctly in 15/16 trials but woke a thought in 0/16; in replay, even 8 sd steps woke 0/8. Cause: an event is
emitted when z first crosses the threshold (4), so its salience is about 4-6 whatever the eventual size of the
change; the wake threshold is 8. Secondary cause: R5 in the code blocked every wake once 4 had happened in a minute,
while the spec says R5 applies only below an urgency threshold.

**Fix.**
- **Escalation**: while an excursion lasts (same direction, not yet re-armed), each time z doubles relative to the
  last emitted value, an escalation event is emitted with the new z. Escalations use the habituation level from the
  start of the excursion and do not habituate further, so salience follows the size of the change. At most about
  log2(z_max/4) extra events per excursion.
- **Urgent override (spec R5)**: a wake whose salience is ≥ 16 is not blocked by the per-minute budget.
- **Clock channels** (`body.host.uptime`) no longer produce change events; they are clocks, not senses of change.
  Historical benches (T1-T3) keep the old behaviour through config.
- Tried in development and dropped because they did not earn their place: an event-rate "rarity" damping (it also
  suppressed the stimulus channel) and budget displacement by relative salience (no measurable effect).

**Scored on held-out replay seeds 5-6** with `bench/ablate.ts`, variants `full`, `no-escalation`, `no-urgent` and
`v0.2-arbiter` (all three off):
- **P14a** full wakes on held steps of 5 and 8 sd in ≥ 70% of trials; v0.2-arbiter in ≤ 10%.
- **P14b** no-escalation wakes on those steps in ≤ 10% (escalation is necessary).
- **P14c** full wakes on steps ≤ 2 sd and on null windows in ≤ 5%.
- **P14d** body-channel wakes/min in the background are at most 1.3 × v0.2-arbiter.
- Urgent override: no effect predicted on this set (dev showed none); reported.
Known limit (dev): 3 sd steps woke 1/8, because routine disk and network bursts take the wake budget.

### 8.14 Secondary validation on real, naturally occurring events (pre-registered before scoring)
`bench/real.ts` replays the main daemon's recorded tick log (about 5 h, 2026-10-12 22:44 to 2026-10-13 04:4x UTC) in
wall-clock order through the current core, with efference on and off. Ground truth comes from records the sensing
path never sees: the narrator's own `thoughts` rows (start and end of every real model generation, 104 thoughts that
reached the model). Only thoughts lasting ≥ 3 s are scored for onset and release, because `brain.busy_slots` is
polled at 1 Hz. No load is induced; these events happened in normal operation.
- **P15a** a `brain.busy_slots` up event within 3 s of the thought start in ≥ 80% of scored thoughts.
- **P15b** a down event within 3 s of the thought end in ≥ 80%.
- **P15c** efference on: ≥ 90% of `change` events on reafferent channels inside thought windows (start to end + 18 s)
  are attributed to self, and none of them wakes a thought. Efference off: the number of wakes they would cause is
  reported.

Passing shows functional properties on the listed functions. Under the functionalist stance in 1.2 that is the claim;
the spec does not claim more than the battery measures.

---

## 9. v0 scope: minimal conscious loop

### 9.1 In
- **Senses / body** (workstation only, decision 10.1; all available without extra services):
  - clock (monotonic, wall, tick index, uptime)
  - CPU load per core and total, RAM, swap, disk and network throughput (`/proc`)
  - GPU temperature, utilisation, memory, power (streaming `nvidia-smi`, measured 21 ms per one-shot call)
  - own process: event-loop lag, heap, tick duration
  - LLM server: reachability, slot states, tokens/s (server metrics endpoint)
  - test channels driven by the harness
  - reading age for every channel
- Tick core in a Worker: state, motion (3 timescales), prediction, salience, habituation.
- Arbiter rules R2-R6 (no reflexes, no interrupt yet, beyond what T9 needs).
- One **narrator** thread on a small local model served by llama.cpp on the workstation GPU, woken by salience, with
  per-token logprobs (verified at startup), grammar-constrained output, abortable.
- Tick rate as config (default 10 Hz); tick overruns counted and logged.
- Storage: bytes per day measured in the first hour; retention cleanup runs from day one.
- Minimal self-model (identity, uptime, continuity chain, body summary).
- Memory: tick log segments + SQLite events / thoughts.
- Baseline B1 and ablation `-Δ` as config switches.
- Tests: **T1, T2, T3, T5 (`-Δ` only), T6 (B1 only), T9**.

### 9.2 Out (later versions)
Reflexes, drives, multiple threads, interruption policy (T10), cortices, knowledge store, remote GPU host telemetry,
level 3.

### 9.3 Layout
```
src/
  senses/       one file per sensor, all emit {channel, value, unit, t_read}
  core/         tick worker: state, motion, predict, salience, arbiter, self-model
  mind/         llm client (slots, abort, logprobs, grammar), narrator, scheduler
  memory/       tick segments, sqlite store, queries
  config.ts     channels, gains, thresholds, ablation and baseline switches
bench/          T1-T9 harnesses, stimulus schedules, report
results/        jsonl outputs (gitignored except summaries)
```

### 9.4 Done when
- The loop runs for 24 h without missed ticks or crashes, with measured storage per day.
- T1, T2, T3, T9 have been run with the pre-registered thresholds, and P0-P5 and P8 are reported as passed or
  refuted, with CIs.

---

## 10. Review decisions
1. **Body**: the workstation only for v0. A second body (the GPU host) is added only after v0's tests pass; no
   always-on telemetry service there before that.
2. **Narrator endpoint**: llama.cpp only. The standby machine's MLX server returns logprobs for the first generated
   token only, so it cannot carry confidence as a sense. v0 runs a small model on the workstation's own GPU so the
   experiment is independent of other workloads. Per-token logprobs are verified on the exact build used, not assumed.
3. **Tick rate**: 10 Hz, as a config value. v0 measures tick overruns.
4. **Storage**: 7 days at full resolution to start. v0 measures real bytes per day within its first hour, and
   retention cleanup ships from day one.
5. **Definitions**: rationalising and realising (2.2) stand as working definitions, open to later refinement.
6. **Freeze**: the theory is staked on P4 as phrased in 8.4.
