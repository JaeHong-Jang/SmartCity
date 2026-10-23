# ADR 0006: Phase 1 교통은 클라이언트별 미리보기, Phase 3에서 서버 권위
- 상태: Accepted · 날짜: 2026-10-23

## 결정
- Phase 1: 도시 문서만 협업 동기화. 차량은 각 클라이언트 워커에서 같은 sim 코드로 돌며 참여자마다 다를 수 있다(UI에 명시).
- 지금 고정하는 실행 계약: `Simulation.step()`(고정 dt), 시드 RNG, id 정렬 순회, 동률 규칙(도착 틱 → 차량 id, A* 동률 → 엣지 index), 스냅샷 버전(`graphRevision`).
- Phase 3 계약(예정): 서버가 `(seq, effectiveTick)`으로 명령 적용 틱 확정, 체크포인트(차량·RNG 상태 직렬화)로 늦은 접속 복원, 클라이언트는 `WebSocketSimStream` 보간.

## council 의견 요약
Astra Q3·#4(실행 계약을 지금 정의) 부분 반영 — 체크포인트 직렬화는 Phase 3.
