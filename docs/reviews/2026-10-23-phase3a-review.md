# Review: Phase 3a — 동작 불변 리팩토링·성능

> 리뷰어: Sol · 관점: `harness/roles/sol.md`  
> 범위: `git diff HEAD` 및 신규 파일. 파일 수정 없음.

## 판정: reject

검증을 통과하는 곡선 도로 입력에서 **첫 tick부터 HEAD와 스냅샷이 달라지는 반례**를 확인했다. 기존 골든 2개는 모두 통과하므로, 골든 통과만으로 이번 bbox 최적화를 승인할 수 없다.

## 지적 사항

| # | 심각도 | 위치 | 문제 | 재현/근거 | 제안 |
|---|---|---|---|---|---|
| 1 | **P1** | `packages/sim/src/network/crossings.ts:152` | 퇴화한 횡단 다각형에서 bbox 사전 제외가 기존 충돌 구역을 제거한다. 차량의 횡단 구역 예약과 스냅샷이 달라진다. | 아래 입력은 `applyCommand` 성공. `c\|a` 구역의 커넥터 passage가 **HEAD 6개 → 현재 0개**. 차량 생성 후 첫 tick의 구역 예약은 **HEAD 1 → 현재 0**. | 퇴화한 다각형에는 bbox 제외를 적용하지 않고 기존 `polylineInside` 경로를 유지한다. 해당 입력의 구역·예약·스냅샷 회귀 테스트를 추가한다. 접선 계산 자체의 변경은 별도 동작 변경으로 다룬다. |
| 2 | P2 | `packages/sim/src/network/pedGraph.ts`, `packages/sim/src/citizens/peds.ts` | 분할하면서 기존 export 경로를 제거했다. 계약의 “순수 이동(export 경로 유지)”에 어긋난다. | 기존 `pedGraph`의 `nearestEdge`, `nearestNode`, `PedRouter` export가 사라졌다. `peds`의 `reprojectPeds`, `routeCrossers`, `walkerGoal`, `retargetWalkers`, `REPROJECT_RADIUS`도 런타임 조회 결과 `undefined`. 기존 테스트 import도 새 경로로 변경됐다. | 이전 모듈에서 호환 re-export를 제공하거나, 경로 변경을 계약 변경으로 명시해 승인받는다. |

### #1 재현 입력과 결과

빈 문서에 다음 노드와 도로를 **한 batch Command**로 추가한다.

| 종류 | ID | 입력 |
|---|---|---|
| 노드 | `c` | `(0, 0)` |
| 노드 | `a` | `(75, 0)` |
| 노드 | `p` | `(0, 100)` |
| 노드 | `q` | `(0, -100)` |
| 도로 | `a` | `c → a`, `road-2`, control `(-36.513157894736835, 0)` |
| 도로 | `p` | `c → p`, `road-2` |
| 도로 | `q` | `c → q`, `road-2` |

실행 결과:

```text
apply { ok: true }
HEAD vs current byZone c|a: 6 0
spawn 1 1
first snapshot difference at tick 1
zone vehicle reservations HEAD/current 1 0
```

원인은 다음과 같다.

- 되접힌 곡선의 횡단 위치 `s = 9`에서 `tangentAtLength`가 `{x: 0, z: 0}`을 반환한다.
- 충돌 다각형 네 꼭짓점이 약 `(-9, 0)`의 같은 점으로 퇴화한다.
- 기존 `polylineInside`는 이 입력에서 커넥터 전체 구간을 반환한다.
- 새 bbox 검사는 커넥터를 제외해 그 결과를 바꾼다. `1e-6` 여유만으로는 이 차이를 막지 못한다.

HEAD의 `crossings.ts`를 `git show`로 읽어 메모리에서 번들링한 뒤 직접 비교했다. 예약 영향은 동일한 Simulation 두 개 중 하나의 `zones`만 HEAD 함수 결과로 교체해 분리 검증했다. `demand:false`, `citizens:false`로 생성하고, car를 `p|b|0`의 `length − 10`에서 `q|f|0`으로 보내면 첫 tick부터 스냅샷이 달라진다.

### 실행 근거

| 검증 | 결과 |
|---|---|
| `npx vitest run --configLoader runner --reporter=verbose --silent=false` | **46파일·311테스트 통과**, 서버 2파일·19테스트 실패. 실패 원인은 `/tmp` 생성의 **EROFS**이며 코드 결함으로 판정하지 않음 |
| 골든·compile·dirty·BusRouter·ghostBuilding·시설 규칙 집중 실행 | **6파일·18테스트 통과**, 골든 해시 유지 |
| `npm run typecheck` | 전체 통과 |
| Vite `build({root:'apps/web', configLoader:'runner', build:{write:false}})` | **142모듈**, 메모리 프로덕션 빌드 통과 |
| HEAD ↔ 현재 기하 비교 | 명령으로 생성한 직선·곡선 교차로 **160개**, 컴파일 비교 **320회**, 최근접 질의 **9,600쌍** 일치. 위 퇴화 입력에서 별도로 불일치 발견 |
| Simulation 교차 실행 | 현재 인스턴스 2개와 HEAD 인스턴스를 **500틱** 비교해 스냅샷 일치 |
| 웹 실행 검증 | 원격 batch의 일방통행 변경 → 정류장 연쇄 삭제 → 선택 해제 통과. 전체 무효화 및 도로 타입 교체 후 청크 재생성 통과 |
| 영속화 메모리 FS 장애 주입 | 부분 append 롤백, checkpoint/reload, 로그 초기화 실패, 부분 tail 복구 통과 |
| `git diff HEAD --check` | 통과 |

추가 확인 사항:

- 충돌 캐시는 커넥터 ID **순서**와 `Object.is` 좌표 비교를 사용한다. 위 실행 범위에서는 잘못된 재사용을 발견하지 못했다.
- `Req` 풀은 정상적인 인스턴스 교차 실행에서 간섭하지 않았다. 다만 예외 시 `finish()`를 보장하는 `finally`는 없으므로 차량 참조 잔류 가능성이 있다. 예외 후 GC 영향은 **미검증**이다.
- `policy.enforce`의 설정·복원은 기존 모듈 플래그와 같은 동기 실행 구조다. 이번 분할로 새롭게 생긴 누출은 발견하지 못했다.
- 실제 디스크 장애·서버 재시작·룸 언로드 통합 검증과 e2e 5개는 **미검증**이다. 메모리 FS 검증으로 대체 승인하지 않는다.

### 성능 측정

`TSX_DISABLE_CACHE=1 node --import tsx harness/runs/3a/prof.ts …` 실행 결과다.

| 항목 | 현재 측정 |
|---|---|
| 차량 3,000대·보행자 5,000명, tick 재측정 | 평균 **5.94ms**, p50 **5.45ms**, p95 **11.91ms**, p99 **15.57ms** |
| 재컴파일+step 6회 | **564 / 330 / 379 / 260 / 244 / 235ms** |

tick p95 ≤4ms와 재컴파일 ≤150ms 목표에 미달한다. 읽기 전용 환경에서 기준 worktree를 만들 수 없어 전후 성능 비교는 수행하지 않았다. 따라서 **성능 회귀 여부는 미검증**이다.

## 동의하는 점 (짧게)

재컴파일 Map 재사용, 예약 복구 유지, 커넥터 순서를 포함한 캐시 비교, 명령 분류표의 타입 검사, 도로 타입 객체 교체에 기반한 WeakMap 사용은 타당하다. 다만 **#1을 수정하고 퇴화 기하 회귀 테스트를 통과하기 전에는 승인할 수 없다.**