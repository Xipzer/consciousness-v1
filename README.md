# consciousness-v1

An engineering test of a functionalist theory of machine awareness: awareness as continuous self-tracking of state
change, built as a non-blocking sensing loop with LLM thought threads on top.

Design and pre-registered predictions: [docs/SPEC.md](docs/SPEC.md).

## Setup

```sh
bun install                 # also installs the leak-guard git hooks
cp .env.example .env        # point CV1_LLM_URL at a llama.cpp server (per-token logprobs required)
```

The pre-commit and commit-msg hooks run `scripts/leak-guard.sh`, which blocks private terms, private IP ranges and
secrets. It fails closed when its local term list is absent.

## Run

```sh
bun start                   # the loop: 10 Hz tick worker, body sensors, state history, narrator thread
bun test                    # unit tests for the core, continuity chain and storage
bun bench/t1.ts             # change awareness: S vs heartbeat (B1) vs no-delta ablation (L)
bun bench/t2.ts             # freeze and suspension
bun bench/t3.ts             # continuity across restarts
bun bench/t9.ts             # tick timing under load (needs the loop running)
```

Data lives in `data/` (tick log segments, SQLite). Full-resolution segments are compressed after their hour, kept
7 days, then downsampled to 1 Hz and deleted after 90 days.
