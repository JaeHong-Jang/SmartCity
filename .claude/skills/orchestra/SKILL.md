---
name: orchestra
description: SmartCity 오케스트라 팀 운영 절차. 기능 개발·조사·설계 결정·리뷰를 Opus(리드)·Astra·Argon(오케스트라)·Sol·Sonnet(서브에이전트)에게 배분할 때 사용.
---
# Orchestra 운영

1. 작업 유형 판별 → `harness/workflows/{feature,research,council,review}.md` 중 해당 절차를 따른다.
2. 배분 규칙 (`harness/team.json`):
   - 설계 결정 → `harness/scripts/council.sh <proposal.md> <name>` (Astra·Argon 병렬) → ADR 기록
   - 도메인/알고리즘 조사, 교차 코드 리뷰 → `harness/scripts/ask.sh sol <prompt.md> <out.md>`
   - 오픈소스/웹 조사 → Agent `sc-researcher`
   - 범위가 명확한 구현 → Agent `sc-executor` (지시서: `harness/templates/task-brief.md`)
   - 실행 검증 → Agent `sc-verifier`
3. 독립 작업은 병렬로(백그라운드) 실행한다. 외부 CLI 호출은 수 분 걸릴 수 있으므로 `run_in_background` 사용.
4. 자기 승인 금지: 작성자와 다른 모델이 검증한다. 완료 보고에는 증거를 붙인다.
