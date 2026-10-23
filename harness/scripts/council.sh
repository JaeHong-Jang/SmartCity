#!/usr/bin/env bash
# Ask the two external orchestrators (Astra, Argon) the same question in parallel.
# The lead (Opus) then reads both answers and records the decision in docs/adr.
# Usage: harness/scripts/council.sh <prompt-file> [run-name]
set -euo pipefail

prompt_file="${1:?prompt file required}"
name="${2:-council}"
here="$(cd "$(dirname "$0")" && pwd)"
dir="$here/../runs/$(date +%Y%m%d-%H%M%S)-$name"
mkdir -p "$dir"
cp "$prompt_file" "$dir/prompt.md"

"$here/ask.sh" astra "$prompt_file" "$dir/astra.md" & a=$!
"$here/ask.sh" argon "$prompt_file" "$dir/argon.md" & g=$!
status=0
wait $a || { echo "astra failed" >&2; status=1; }
wait $g || { echo "argon failed" >&2; status=1; }

echo "$dir"
exit $status
