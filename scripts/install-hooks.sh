#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
chmod +x "$root"/.githooks/* "$root"/scripts/*.sh
git -C "$root" config core.hooksPath .githooks
echo "hooks installed (core.hooksPath=.githooks)"
[[ -s "$root/.private/leak-terms" ]] || echo "warning: .private/leak-terms is missing; every commit will be blocked until it exists" >&2
