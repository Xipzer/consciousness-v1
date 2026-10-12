#!/usr/bin/env bash
# Blocks commits that would publish private names, infrastructure details or secrets.
# Private terms live in .private/leak-terms (gitignored) so the list itself is never published.
# Fails closed: no terms file, no commit.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
terms="$root/.private/leak-terms"

patterns=(
  '\b192\.168\.[0-9]{1,3}\.[0-9]{1,3}'
  '\b10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b'
  '\b172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}'
  '\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}'
  '(^|[^a-z0-9])ssh[[:space:]]'
  'gh[pousr]_[A-Za-z0-9]{30,}'
  'github_pat_[A-Za-z0-9_]{30,}'
  'sk-(ant-)?[A-Za-z0-9_-]{20,}'
  'AKIA[0-9A-Z]{16}'
  'AIza[0-9A-Za-z_-]{35}'
  'xox[abprs]-[A-Za-z0-9-]{10,}'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  '[MN][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}'
  '(api[_-]?key|secret|token|passw(or)?d)["'"'"' ]*[:=][ "'"'"']*[A-Za-z0-9/+_-]{16,}'
)

[[ -s "$terms" ]] || { echo "leak-guard: $terms missing or empty; refusing to commit (fail closed)" >&2; exit 1; }

scan() {
  local label="$1" text="$2" hit=0
  if grep -qiF -f "$terms" <<<"$text"; then
    echo "leak-guard: private term in $label: $(grep -oiF -f "$terms" <<<"$text" | sort -u | tr '\n' ' ')" >&2
    hit=1
  fi
  for p in "${patterns[@]}"; do
    if grep -qiE -e "$p" <<<"$text"; then
      echo "leak-guard: pattern /$p/ in $label" >&2
      hit=1
    fi
  done
  if [[ ! "$label" =~ ^(\.gitignore|scripts/leak-guard\.sh|scripts/install-hooks\.sh)$ ]] && grep -qF '.private/' <<<"$text"; then
    echo "leak-guard: reference to .private/ in $label" >&2
    hit=1
  fi
  return $hit
}

failed=0

if [[ "${1:-}" == "--message" ]]; then
  scan "commit message" "$(grep -v '^#' "$2")" || failed=1
  exit $failed
fi

while IFS= read -r -d '' path; do
  [[ "$path" == .private/* ]] && { echo "leak-guard: staged file under .private/: $path" >&2; failed=1; continue; }
  scan "path $path" "$path" || failed=1
  added="$(git diff --cached --no-color --no-ext-diff -U0 -- "$path" | grep '^+' | grep -v '^+++' || true)"
  [[ -z "$added" ]] && continue
  scan "$path" "$added" || failed=1
done < <(git diff --cached --name-only -z --diff-filter=ACMR)

(( failed )) && echo "leak-guard: commit blocked" >&2
exit $failed
