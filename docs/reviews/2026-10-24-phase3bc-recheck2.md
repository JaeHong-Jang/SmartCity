# Review: Phase 3b·3c — Sol #10 재검토 2
> 리뷰어: Sol · 관점: 조사·분석·검증  
> 대상: HEAD `d875685` + 현재 작업 변경분 · 파일 수정 없음

## 판정: approve

#10의 취소·연결 해제 후 영구 점유 반례는 해결됐습니다. 확인한 경합에서도 최종 메시지 중복·누락이나 다른 작업의 슬롯을 해제하는 현상은 재현되지 않았습니다.

## 지적 사항

| # | 심각도 | 위치 | 문제 | 재현/근거 | 제안 |
|---|---|---|---|---|---|
| — | — | — | 이번 재검토 범위에서 신규 결함 없음 | 아래 실행 결과 | — |

## 검증 결과

표준입력 스크립트로 **56개 시나리오를 실행해 모두 통과**했습니다.

| 검사 | 결과 |
|---|---|
| settle되지 않는 모델에서 `cancel`·`drop` | 즉시 `jobs=0`, 실행 슬롯 해제. 후속 요청 수락. 취소된 요청의 오류 전송 없음 |
| 취소·연결 해제·deadline 후 이전 응답이 늦게 성공 또는 실패하는 6개 경우 | 같은 클라이언트·룸의 새 작업 유지. 이전 작업의 `.finally(finish)`가 새 작업을 삭제하거나 슬롯을 해제하지 않음 |
| 새 작업 실행 중 제3의 요청 | 다른 룸은 동시 실행 제한으로, 같은 룸은 룸 점유 제한으로 정상 거절 |
| 응답·취소 지연을 각각 0·5·10·15ms로 조합한 48개 경합 | 미취소 요청은 최종 메시지 정확히 1개. 취소가 먼저 완료된 요청은 최종 메시지 없음. 종료 후 작업·슬롯·룸 점유 모두 0 |

멱등성은 `gate.ts:39–46`의 요청별 `released` 가드가 보장합니다. `service.ts:67`의 abort 객체 비교는 이전 작업의 정리가 새 작업을 삭제하지 못하게 합니다.

## 회귀 및 실행 증거

- 지정된 `'Sol 3b recheck #10'` 테스트 포함, 선택한 7개 파일에서 **66개 통과·6개 실패**.
- 기존 #1~#9 관련 회귀: `phase3b`, AI, transit, dirty 테스트 통과. shared 성장 및 sim 골든 테스트도 통과.
- 실패 6개는 모두 서버 성장 테스트의 `mkdtemp '/tmp/growth-XXXXXX'`가 읽기 전용 환경에서 `EROFS`로 실패한 경우입니다. 후처리의 `dispose` 오류도 이에 따른 것입니다.
- `npm run typecheck`: **전체 통과**.

실행 명령:

```text
npm test -- --no-cache --configLoader runner --maxWorkers 4 --testTimeout 15000 \
  apps/server/src/ai/agent.test.ts packages/shared/src/phase3b.test.ts \
  packages/sim/src/citizens/transit.test.ts apps/web/src/render/dirty.test.ts \
  packages/shared/src/growth.test.ts apps/server/src/growth.test.ts \
  packages/sim/src/golden.test.ts
```

전체 테스트·빌드·실제 소켓/API 통합은 이번 재검토에서 **미검증**입니다. 수정 전 코드에서 회귀 테스트가 실패한다는 점은 독립적으로 재확인하지 않았습니다.

## 동의하는 점 (짧게)

- 취소·연결 해제에서도 모델의 settle 여부와 무관하게 자원을 즉시 정리합니다.
- deadline의 정리와 오류 전송 조건을 분리한 수정이 기존 누수 경로를 해소합니다.