# Review: Phase 2b R1·R2 및 추가 수정 재검증
> 리뷰어: Sol · 관점: Research · Analysis · Verification  
> 대상: 현재 작업 트리. 파일 수정 없음.

## 판정: approve

R1·R2의 원래 반례가 해결됐다. 추가 수정에서 신규 blocker/major는 발견하지 못했다. 아래 Minor 1건은 승인 차단 사항이 아니다.

## 지적 사항

| # | 심각도 | 위치 | 문제 | 재현/근거 | 제안 |
|---|---|---|---|---|---|
| 1 | Minor / P3 | `citizens.ts:373`, `schedule():175` | 같은 일정 재계획도 이벤트를 추가해 무효 이벤트가 누적된다. | `cityDoc()`, `demand:false`에서 시간 진행 없이 `reconcileCitizens()` 100회 → 유효 이벤트는 **400개로 동일**, 전체 heap은 **574→17,974개**. 유효 출발 시각은 모두 유지된다. | 기존 유효 이벤트의 시각·목적이 같으면 추가를 생략하거나 무효 이벤트를 주기적으로 정리한다. |

## 재검증 결과

| 대상 | 결과 |
|---|---|
| **R1** | **통과.** 150m·156m 횡단 배치에서 첫 보행자 횡단 중 `segment.setSchoolZone` 적용 → 횡단 점유와 출구 예약 유지. 이후 12명을 같은 출구로 보내도 첫 보행자가 9초 안에 보도로 빠져나가고 횡단 점유가 해제된다. |
| **R2** | **통과.** 300m 도로에서 40틱 후 동일 ID 횡단보도를 `t=0.5→0.7` 이동 → 기존 60m 순간이동이 재현되지 않는다. 이동한 횡단보도에 남지 않고 최종 이동도 종료한다. |
| **직장 후설치** | **통과.** 지정 회귀 테스트 통과. 별도 실행에서도 직장 배정 시민 **208명**의 출발 tick이 `hash(id, day)` 기반 계산과 일치한다. |
| **기존 일정·결정성** | **통과.** 반복 재계획 100회에서 유효 일정 유지. 직장 후설치와 도로 편집 30회를 포함한 두 실행의 11시 상태·스냅샷이 일치한다. 기존 시민 포함 결정성 테스트도 통과한다. |
| **Studio UX** | 코드 검토상 문제 없음. 덩어리 칠하기 기본값, 템플릿 로드의 `leave()` 확인, 신규 설계의 수동 이름 입력 전 자동 갱신, 저장 성공 후 `panel='buildings'`, 정면 범례를 확인했다. |
| **Phase 2b E2E** | 추가 테스트의 도로 시설·직장 후설치·보행 출현·Studio 저장 검사를 확인했다. UX 추가 항목 전부를 직접 검사하는 테스트는 아니다. **이번 리뷰에서 실브라우저 재실행은 미검증**이다. |

## 실행 근거

```text
npx vitest run --configLoader runner \
  packages/sim/src/citizens/peds.test.ts \
  packages/sim/src/citizens/citizens.test.ts \
  packages/sim/src/invariants.test.ts \
  apps/web/src/studio --reporter verbose

Test Files  5 passed
     Tests  52 passed
```

```text
npx vitest run --configLoader runner \
  packages/sim/src/simulation.test.ts --reporter verbose

Test Files  1 passed
     Tests  13 passed
```

- `npm run typecheck`: 전체 워크스페이스 **exit 0**.
- `git diff --check`: **exit 0**.
- 추가 일정·결정성 검사는 esbuild `write:false` 메모리 번들로 실행했다.
- 빌드와 Playwright 재실행은 파일 생성이 필요한 관계로 읽기 전용·파일 수정 금지 조건에서 수행하지 않았다. 전달받은 브라우저 통과 결과와 이번 직접 검증을 구분한다.

## 동의하는 점 (짧게)

- `routeCrossers()`가 일반 경로 큐 처리 전에 횡단자의 출구 예약을 복구한다.
- 동일 ID 횡단보도도 최종 `pedPose`로 20m 제한을 검사한다.
- 시민 재계획은 해시 기반 출발 시각과 seq 기반 이전 이벤트 무효화를 유지한다.