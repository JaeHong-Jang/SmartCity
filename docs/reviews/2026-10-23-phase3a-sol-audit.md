# Research: Phase 3a 리팩토링·성능 감사

> 결정하려는 것: 결정성·안전·관측 가능한 동작을 유지하면서 tick p95 ≤ 4ms와 편집 지연 감소를 달성할 우선순위  
> 작성: Sol · 2026-10-23 · 보고 대상: Lead Conductor  
> 범위: sim·shared·server 비테스트 코드. ADR 0003~0008과 모듈 계약 대조. 파일 수정 없음.

## 판정: 개선 계획에 조건부 동의

우선 적용할 후보는 **차량별 횡단보도 Map 중복 생성 제거**, **스냅샷 좌표 계산의 정적 정보 재사용**, **컴파일 결과의 부분 캐시**다. 재경로·재투영 자체를 생략하는 증분화는 현재 동작을 바꾸므로 별도 설계 검토가 필요하다.

### 측정값과 원출력

환경: Node **v22.22.1**, Vitest **v5.0.5**. 같은 머신에서도 실행 방식·JIT·GC에 따라 편차가 있다. 아래 수치는 개선 후 성능 예측이 아니다.

| 측정 | 명령·방법 | 결과 |
|---|---|---|
| 요청한 벤치 | `npx vitest run --configLoader runner packages/sim/src/bench.test.ts` | 2/2 통과, 19.45s. 기본 reporter에서는 벤치 로그가 표시되지 않음 |
| 로그 포함 재실행 | 위 명령 + `--reporter=verbose --silent=false` | 차량 ≥2960, 보행자 ≥4999. tick 평균 **7.72ms**, p95 **11.96ms**. 재컴파일 step **446.0ms** |
| 별도 계측 | `TSX_DISABLE_CACHE=1 node --import tsx --input-type=module` heredoc. 벤치와 같은 문서·seed·초기화·400틱 | step 평균 **2.85ms**, p95 **5.25ms**. tick 평균 **4.99ms**, p95 **9.14ms** |
| CPU 프로파일 | 같은 heredoc에서 `node:inspector`의 `Profiler.start/stop`, sampling interval 100µs. 결과는 메모리에서 집계 | 아래 self time 표. `.cpuprofile` 파일 생성 안 함 |
| 단계별 재컴파일 | `node --input-type=module` heredoc + esbuild `write:false`. 메모리에서 함수 wrapper를 주입해 시간·호출 수 집계 | 3000대·5000명에서 step **529.81ms**. 계측 오버헤드 포함 |

벤치 원출력:

```text
[sim bench] segments=420 lanes=1680 connectors=4712 compile=102.1ms vehicles>=2959 step=1.68ms snapshot=1.22ms

[sim bench peds] vehicles>=2960 pedestrians>=4999 pedGraph nodes=1680 edges=2512 crossings=833 holding crossings=788 step mean=4.74ms p95=7.69ms snapshot=1.83ms tick(step+snapshot) mean=7.72ms p95=11.96ms recompile step=446.0ms

Test Files  1 passed (1)
     Tests  2 passed (2)
```

**통과가 4ms 목표 달성을 뜻하지 않는다.** 첫 테스트는 평균 step <25ms만 검사하고, 혼합 부하는 성능 목표를 assertion으로 검사하지 않는다. 또한 별도 `snapshot=1.83ms`는 정지된 상태에서 반복한 평균이므로 tick p95에서 빼서 해석하면 안 된다.

CPU 프로파일 상위 함수 — 400틱, snapshot 포함:

| 함수 | Self time | 전체 샘플 시간 비율 |
|---|---:|---:|
| `Simulation.snapshot` | 545.1ms | 19.3% |
| `writePose` | 389.8ms | 13.8% |
| `computeAccelerations` | 322.4ms | 11.4% |
| `processRequests` | 289.8ms | 10.3% |
| 차량 `Router.find` | 190.3ms | 6.7% |
| `movePeds` | 174.5ms | 6.2% |
| `pedRequests` | 173.1ms | 6.1% |
| `tailOverhang` | 147.1ms | 5.2% |
| `advance` | 115.8ms | 4.1% |
| GC | 33.1ms | 1.2% |

프로파일은 벤치 측정 구간 이후 추가 400틱을 대상으로 했다. `topUp`도 포함하며 프로파일 오버헤드가 있으므로 함수 순위의 근거로 사용한다.

재컴파일 단계 계측:

| 단계 | 시간 | 호출 수·해석 |
|---|---:|---|
| `compileNetwork` | 76.43ms | 1 |
| `buildNet` | 9.56ms | 1 |
| `buildZones` | 17.51ms | 1 |
| `restoreZones` 합계 | **154.33ms** | **3000** |
| `recompileWorld` 전체 | **282.65ms** | 위 네 항목 포함 |
| `buildPedGraph` | 19.98ms | 1 |
| `reprojectPeds` | 60.90ms | 1 |
| `routeCrossers` | 65.30ms | 1, 횡단 중 보행자 즉시 경로 복구 |
| `buildSignals` | 5.42ms | 1 |
| `buildDemand` | 0.21ms | 1, 건물 없는 벤치 |
| `processPedQueue` | 19.79ms | 재컴파일 뒤 같은 step의 경로 처리 |
| step 전체 | **529.81ms** | 재구축 이후 정상 tick 작업도 포함 |

원출력 발췌:

```text
EXACT_BENCH_LOAD 3000 5000
APPLY_RESULT { ok: true }
"stepMs":529.8064510000004
"restoreZones":{"ms":154.32825200000207,"calls":3000}
"recompileWorld":{"ms":282.6464079999996,"calls":1}
```

`applyCommand()`는 dirty 표시를 하고 실제 재컴파일은 다음 `step()`의 `flush()`에서 실행된다. 따라서 벤치의 `recompile step`은 순수 컴파일 시간이 아니다. 경로 캐시 폐기는 `newPedWorld()`의 새 Map 생성으로 일어나며, 큰 비용은 기존 캐시 순회보다 **이후 재탐색**에 있다. 캐시 폐기 자체의 독립 시간은 미측정이다.

## 우선순위 목록

### [P1] 차량마다 동일한 횡단보도 Map 생성 — `packages/sim/src/traffic/recompile.ts:73`

- **근거:** `restoreZones()`가 차량마다 `new Map(w.graph.crossings.map(...))`를 실행한다. 3000대 × 약833개로 재컴파일마다 약 **250만 개의 Map 입력 쌍**을 만든다. 단계 계측에서 함수 합계 154.33ms, 별도 재컴파일 CPU 프로파일에서도 self time 1위였다.
- **제안:** 새 crossing ID → index Map을 재컴파일당 한 번 만들고 전달한다. 이전 edge → 새 edge 대응표도 한 번 생성해 `mapEdge()`의 반복 문자열 조회를 줄인다.
- **기대 효과:** Map 구축을 O(차량 수 × 횡단보도 수)에서 O(횡단보도 수)로 축소한다. 실제 절감 시간은 구현 후 측정해야 한다.
- **위험:** **낮음.** 기존 차량 처리 순서와 예약 병합·odometer 조건은 그대로 유지한다.

### [P1] 스냅샷의 정적 좌표 정보 반복 계산 — `packages/sim/src/network/net.ts:41`, `packages/sim/src/simulation.ts:171`

- **근거:** 프로파일에서 `snapshot` self 19.3%, `writePose` self 13.8%. 매 차량·보행자마다 폴리라인 구간 탐색 후 `hypot`, 정규화, heading 계산을 수행한다.
- **제안:** 폴리라인 조각별 방향·길이·heading을 컴파일 시 계산해 재사용한다. 먼저 `writePose`만 개선하고 동일 snapshot 바이트를 비교한다. laneFlow와 stats의 별도 차량 순회 통합도 후속 후보다.
- **위험:** **중간.** 누적길이 경계에서 선택하는 조각, 역방향 heading, 퇴화 선분 처리, 부동소수점 연산 순서가 달라질 수 있다. snapshot 버퍼 소유권도 유지해야 한다.

### [P1] 시설 편집도 전체 컴파일·재배치를 유발 — `packages/sim/src/simulation.ts:52`, `packages/sim/src/simulation.ts:450`

- **근거:** `feature.upsert/remove`, 보호구역, 폐쇄, 신호 명령이 모두 같은 `netDirty` 경로를 탄다. 횡단보도 한 개 추가로 446ms step을 재현했다.
- **제안:** 먼저 **순수 파생 결과만 캐시**한다.

| 변경 | 재사용 가능한 단위 | 다시 계산할 부분 |
|---|---|---|
| 방지턱 | 차선·커넥터 기하, 충돌표, 보행 기하 | 해당 구간 방지턱 표 |
| 구간 횡단보도 | 차량 차선·커넥터 기하 | 해당 구간 zone, 보도 분할·crossing, 관련 신호 |
| 폐쇄 | 기하·충돌표·보행 기하 | 차량 진입 플래그, 수요 접속, 경로 비용 관련 상태 |
| 보호구역 | 위치 기하·충돌표 | 속도·비용·정지 규칙, 관련 커넥터 속도 |
| 세그먼트 기하·타입 | 영향 없는 기하 조각 | 양 끝 노드의 모든 다리·커넥터·충돌표, 영향받은 보도·출입구 |

- **위험:** **높음.** 세그먼트 하나의 변경도 노드 setback을 통해 인접 세그먼트 끝에 전파된다. 전역 정렬 index 변경도 재매핑해야 한다. 기존 재경로·정지 상태 초기화·재투영을 생략하면 동작 불변이 아니다.

### [P2] 교차로 요청 배열·객체 생성과 매 tick 정렬 — `packages/sim/src/traffic/intersections.ts:46`

- **근거:** 매 tick `Req[]`와 요청 객체를 만들고 `sort()`한다. CPU self 10.3%. 복잡도는 요청 수 R에 대해 O(R log R)이며 도시 전체 차량 쌍 비교는 아니다.
- **제안:** World별 scratch 배열·요청 레코드를 재사용한다. 필요하면 노드별 bucket 안에서 기존 comparator로 정렬한다.
- **위험:** **중간.** `(node, pri, order, vehicleId)` 순서와 `blockedMark` 공정성 처리를 보존해야 한다.

### [P2] 경로 재탐색과 큐 처리 — `packages/sim/src/network/route.ts:112`, `packages/sim/src/citizens/peds.ts:279`

- **근거:** 차량 A* self 6.7%에 heap 비용이 추가된다. 차량 경로 캐시는 없고, 보행은 이미 숫자 OD 키 캐시가 있다. 재구축하면 보행 캐시가 사라지고 횡단 중 보행자는 예산 밖에서 즉시 재탐색한다.
- **제안:** 차량은 동일 graph·출발 상태·목적지 집합·차종·대기열 비용 상태에 한정한 중복 제거부터 검토한다. 보행 그래프가 완전히 동일하면 index와 캐시를 함께 재사용한다. 차량·보행 큐의 `splice(0, k)`는 head index로 대체할 수 있다.
- **위험:** **중간~높음.** 차량 비용에는 현재 정지 차량 수 ×2s가 들어간다. **OD만 키로 삼은 캐시는 동작을 바꾼다.** 보행 캐시 hit는 현재 예산을 소모하지 않으므로 예산 계산도 유지해야 한다.

### [P2] 건물 수에 따른 전수 탐색 — `packages/sim/src/network/pedGraph.ts:218`, `packages/sim/src/traffic/demand.ts:44`

- **근거:** PedGraph는 건물마다 모든 sidewalk run을 검사하고, 출입구 후보의 도로 횡단 검사도 모든 segment box를 순회한다. demand는 건물마다 모든 열린 세그먼트를 검사한다. 각각 건물×도로 규모로 증가한다.
- **제안:** 도로·보도 AABB 공간 인덱스로 후보를 줄이고, 기존 거리 계산과 동률 순서를 그대로 적용한다. `buildDemand()`의 누적길이도 세그먼트당 재사용한다.
- **위험:** **중간.** 최근접 후보 동률·상위 8개 후보 순서가 출입구 선택을 바꿀 수 있다. **현재 벤치에는 건물이 없어 비용은 미검증**이다.

### [P2] shared 검증의 반복 기하 계산 — `packages/shared/src/apply.ts:269`, `packages/shared/src/apply.ts:336`

- **근거:** 건물 파츠 쌍마다 `partOutline()`을 다시 계산한다. 48파츠는 최대1128쌍이다. `checkNoNewCrossings()`는 영향 세그먼트마다 전체 도로를 다시 샘플링한다. `checkCapacity()`도 추가 시마다 `Object.keys()`로 개수를 센다.
- **제안:** 검증 호출 안에서 파츠 outline·높이 범위, 도로 샘플·bounds를 캐시한다. 서버의 반복 편집 병목이 확인되면 트랜잭션과 함께 갱신되는 공간 인덱스를 검토한다.
- **위험:** 호출 내 캐시는 **낮음**, 지속 인덱스는 **중간**. batch 중간 상태와 rollback 후 인덱스 일치를 보장해야 한다. 최악 건물 입력 시간은 이번 감사에서 미측정이다.

### [P2] 서버의 동기 영속화가 전체 이벤트 루프를 점유 — `apps/server/src/persistence.ts:89`, `apps/server/src/persistence.ts:106`

- **근거:** 매 명령 `mkdirSync → existsSync/statSync → appendFileSync`를 수행한다. 200명령 또는 dirty 상태 30초마다 전체 문서를 `JSON.stringify`하고 동기 체크포인트를 쓴다.
- **제안:** 디렉터리 준비·로그 파일 상태 관리를 룸 수명에 묶는 개선부터 검토한다. 비동기화는 룸별 직렬 큐와 체크포인트 seq 경계 설계 후 진행한다.
- **위험:** **중간~높음.** append 실패 시 rollback, 부분 로그 복구, checkpoint rename 후 로그 절단 순서를 보존해야 한다. 디스크 지연·처리량은 미측정이다.
- **확인 결과:** **매 명령 전체 문서 직렬화는 없다.** `Room.command()`는 Command를 한 번 직렬화해 로그와 broadcast 문자열에 재사용한다(`room.ts:105`, `room.ts:135`). 이미 적용된 최적화를 다시 계획할 필요가 없다.

### [P3] 배열 이동·작은 할당 개선 — `packages/sim/src/citizens/peds.ts:373`, `packages/sim/src/traffic/world.ts:162`

- **근거:** 보행 band의 `shift()`·`splice()`, 차량 edge 목록의 선형 삽입·검색은 혼잡한 단일 edge에서 반복 이동 비용을 만든다. snapshot도 ID 배열 `slice()`와 결과·stats 객체를 매번 생성한다.
- **제안:** 밀집 band에서 비용이 확인되면 head index를 검토한다. snapshot 내부 임시 객체와 반복 scan을 줄이되 외부에 넘기는 배열 복사는 유지한다.
- **위험:** **중간.** 보행은 band 순서와 순차 전이가 결과를 결정한다. swap-remove나 비정렬 순회로 바꾸면 안 된다. 일반 tick에 전역 O(n²) 차량 비교가 있다는 근거는 없다.

## 동작 불변 리팩토링 후보

| 위치 | 자연스러운 분할·중복 제거 | 위험 | 기대 효과 |
|---|---|---|---|
| `shared/src/apply.ts:147`, 912줄 | 검증 함수, Tx, 명령 dispatch, 도로 분할·삭제 분리 | 중간 | 정책·구조 검증과 cascade 변경의 리뷰 범위 축소 |
| `shared/src/apply.ts:748`, `:773` | 시설 끝 거리·간격 판정 공통화 | 낮음 | `validateFeature`와 `pruneFeatures`의 1e-6 허용오차 일치 |
| `sim/src/network/compile.ts:352`, 447줄 | 충돌 기하·충돌표 계산 분리 | 낮음 | 컴파일 캐시 단위와 테스트 경계 확보 |
| `sim/src/network/pedGraph.ts:118`, 573줄 | 그래프 빌더 / 근접 탐색 / PedRouter 분리 | 낮음 | 정적 생성과 실행 질의의 책임 분리 |
| `sim/src/citizens/peds.ts:28`, 688줄 | Pool·band 저장 / 이동·허가 / 재투영 분리 | 중간 | 안전 복구 코드의 독립 검토 |
| `sim/src/citizens/citizens.ts:144`, 694줄 | 이벤트 heap·일정 / 인구 조정 / 통행 상태 전이 분리 | 중간 | RNG·이벤트 순서 추적 용이 |
| `sim/src/simulation.ts:171`, 528줄 | snapshot writer와 차량·보행 재구축 조정 분리 | 중간 | 성능 계측과 회귀 검증 용이 |
| `shared/src/geometry.ts:108`, 477줄 | polyline·polygon 연산 모듈 분리 | 낮음 | sim/shared 간 기하 재사용 경계 명확화 |

추가 주의사항:

- `compile.ts:373`의 `pointSegDist`와 shared `geometry.ts:306`의 `pointSegmentDistance`는 의미가 유사하다. 다만 기존 compile 구현은 할당 없는 스칼라 계산이다. 단순 교체는 성능·반올림 차이를 만들 수 있다.
- compile·crossings·pedGraph에 중심선 접선·법선·누적길이 계산이 반복된다. 공통 샘플 캐시는 후보지만 **보도 offset, 차선 trim, 차량 폭으로 확장한 충돌 영역을 하나의 기하로 통합해서는 안 된다.**
- `Req`, `Passage`, `ZoneHold`는 요청·통과 구간·차량별 예약 수명이 다르다. 필드가 비슷하다는 이유로 타입을 합칠 근거는 없다.
- **죽은 코드·미사용 export는 확정하지 않았다.** 공개 barrel과 디버그 API의 외부 사용 가능성이 있어 삭제 후보로 승인할 수 없다.
- 파일 분할 자체의 실행시간 개선은 입증되지 않았다.

## 하지 말아야 할 것

1. **재컴파일 시 예약 복구 생략:** `recompile.ts:65`의 기존 미해제 예약 ∪ 실제 차체 ∪ 현재 커넥터 잔여 구역을 유지한다. 후미 기준 해제와 `noGrantTick`도 보존한다.
2. **횡단 보행자 경로 복구를 일반 예산 큐로 미루기:** `routeCrossers()`는 비용이 크더라도 건너편 band 예약 복구에 필요한 안전 경로다.
3. **변경 없는 구간의 차량·보행 상태를 무조건 유지하기:** 현재는 재경로·정지 카운터 초기화·재투영이 실행된다. 이를 생략하는 것은 캐시 최적화를 넘어선 동작 변경이다.
4. **index 정렬·동률 규칙 변경:** 부분 컴파일 후에도 기존 전역 index, 충돌 목록, A* 동률, 차량 요청 순서와 보행 slot/band 처리 순서를 맞춰야 한다.
5. **차량 OD 캐시의 장기 재사용:** 대기열 비용·폐쇄·차종·목적 s가 다르면 같은 OD도 같은 질의가 아니다.
6. **보행 그래프의 무조건 지연 빌드:** 시민·보행자뿐 아니라 snapshot 건물 정보와 출입구 조회도 소비자다. 기존 API 결과를 유지하는 조건부터 정의해야 한다.
7. **로그 기록 전 성공 broadcast:** 서버 seq 권위, 실패 rollback, 복구 가능한 체크포인트 경계를 유지한다.
8. **snapshot에 내부 mutable 배열 노출:** 버퍼 반환·transfer 계약을 보존한다. `buildingIds`·타입 ID 배열 복사를 없애려면 소유권 검토가 선행돼야 한다.
9. **벽시계 기반 경로 예산·병렬 상태 갱신 도입:** 작업 수 예산과 기존 RNG 소비·상태 갱신 순서를 유지한다.

후속 구현 검증은 같은 seed·Command 열에 대해 **매 tick snapshot 바이트·stats·예약 상태를 비교**하고, 재컴파일 직후 충돌 구역·후미·보행 간격 불변식을 검사해야 한다. 이번 실행은 벤치 2개 통과까지이며, 전체 기능 테스트·타입체크·빌드와 개선 후 4ms 달성은 미검증이다.