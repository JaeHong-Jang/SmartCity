# Workflow: Review (병합 전)

1. `sc-verifier`: `npm test && npm run typecheck && npm run build` + UI 변경 시 Playwright 스크린샷/콘솔.
2. `ask.sh sol`: `git diff` 를 프롬프트에 포함해 교차 리뷰. 재현 시나리오가 있는 지적만 수용 후보.
3. Opus: 각 지적을 확인(재현)하고 수정 또는 기각 사유 기록. 수정 후 1번 재실행.
4. 증거(명령·출력 요약)를 커밋 메시지 또는 PR 본문에 남긴다.
