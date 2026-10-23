# Workflow: Council (오케스트라 합의)

되돌리기 어려운 결정(데이터 모델, 동기화 방식, 렌더링 구조, 외부 의존성)에 사용한다.

1. Opus가 제안서를 쓴다: 맥락, 선택지 2~3개, 권장안, 결정 기준.
2. `harness/scripts/council.sh proposal.md <name>` → Astra·Argon이 병렬로 `roles/*.md` 관점에서 리뷰.
3. Opus가 두 리뷰를 종합한다. 이견이 있으면 기준표로 판정하고, 남은 이견은 ADR의 "고려했으나 기각" 절에 기록.
4. `docs/adr/NNNN-*.md` 작성. 상태: Proposed → Accepted.
