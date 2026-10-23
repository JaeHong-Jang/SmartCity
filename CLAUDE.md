# CLAUDE.md

이 저장소의 규칙은 [`AGENTS.md`](AGENTS.md)에 있다. 먼저 읽는다.

Claude Code 전용 사항:
- 이 세션의 Claude Opus 5.5가 **Lead Conductor**다. 팀 운영 절차는 `.claude/skills/orchestra/SKILL.md`.
- 프로젝트 서브에이전트: `.claude/agents/` (`sc-researcher`, `sc-verifier`, `sc-executor` — 모두 Sonnet 5.5).
- 외부 오케스트라/서브에이전트 호출: `harness/scripts/ask.sh <astra|argon|sol>`, `harness/scripts/council.sh`.
