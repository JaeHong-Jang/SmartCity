#!/usr/bin/env bash
# Send one prompt to an external team member and save the answer.
# Usage: harness/scripts/ask.sh <astra|argon|sol> <prompt-file|-> [out-file]
# Opus and Sonnet run inside Claude Code (Agent tool), not through this script.
set -euo pipefail

member="${1:?member required (astra|argon|sol)}"
prompt_src="${2:?prompt file or - for stdin}"
root="$(cd "$(dirname "$0")/../.." && pwd)"

if [ "$prompt_src" = "-" ]; then prompt="$(cat)"; else prompt="$(cat "$prompt_src")"; fi
role_file="$root/harness/roles/$member.md"
[ -f "$role_file" ] && prompt="$(cat "$role_file")"$'\n\n---\n\n'"$prompt"
out="${3:-$root/harness/runs/$(date +%Y%m%d-%H%M%S)-$member.md}"
mkdir -p "$(dirname "$out")"

read -r runtime model < <(node -e '
  const m = require(process.argv[1]).members[process.argv[2]];
  if (!m) { console.error("unknown member: " + process.argv[2]); process.exit(2); }
  console.log(m.runtime, m.model);
' "$root/harness/team.json" "$member")

case "$runtime" in
  codex)
    # stdin closed: codex otherwise waits for extra input when launched from a pipe
    codex exec --skip-git-repo-check -C "$root" -s read-only -m "$model" -o "$out" "$prompt" >/dev/null </dev/null
    ;;
  antigravity)
    (cd "$root" && agy --model "$model" --print "$prompt") > "$out" </dev/null
    ;;
  *)
    echo "member '$member' runs inside Claude Code (runtime=$runtime); use the Agent tool" >&2
    exit 2
    ;;
esac
echo "$out"
