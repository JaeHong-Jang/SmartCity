# Workflow: Feature

1. **Brief** (Opus) — `templates/task-brief.md`로 목표·범위·수용 기준·건드릴 파일을 적는다.
2. **Contract** (Opus) — 필요한 `packages/shared` 타입/Command를 먼저 추가한다. 계약이 바뀌면 영향받는 패키지를 나열한다.
3. **Design check** (선택) — 되돌리기 어려운 결정이면 `council.md` 실행.
4. **Implement** (Opus 또는 `sc-executor`) — 패키지 경계별로 병렬 가능. 테스트를 함께 작성한다.
5. **Verify** (`sc-verifier`) — test/typecheck/build, UI 변경이면 실브라우저 스크린샷·콘솔 확인.
6. **Cross review** (`ask.sh sol`) — diff를 작성자와 다른 모델이 리뷰.
7. **Integrate** (Opus) — 지적 반영 → 재검증 → 커밋. 설계 변경이 있었으면 ADR 갱신.
