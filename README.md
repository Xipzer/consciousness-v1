# consciousness-v1

An engineering test of a functionalist theory of machine awareness: awareness as continuous self-tracking of state
change, built as a non-blocking sensing loop with LLM thought threads on top.

Design: [docs/SPEC.md](docs/SPEC.md) (in review).

## Setup

```sh
./scripts/install-hooks.sh
```

The pre-commit and commit-msg hooks run `scripts/leak-guard.sh`, which blocks private terms, private IP ranges and
secrets. It fails closed when its local term list is absent.
