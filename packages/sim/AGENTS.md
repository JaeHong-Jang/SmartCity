# packages/sim — 결정적 교통 시뮬레이션 코어

루트 `AGENTS.md`를 확장한다. 공개 계약은 `src/types.ts`와 아래 `Simulation` API. 변경 시 Lead 승인 필요.

## 금지
- DOM, Three.js, Node 전용 API, `Math.random`, `Date.now`, `performance.now` 사용 금지 (워커와 서버 양쪽에서 동일하게 돌아야 함).
- `Map`/`Set` 순회 순서에 의존하는 로직은 삽입 순서가 결정적일 때만 허용. 문서 컬렉션은 **id 정렬 순서**로 순회한다.

## 공개 API
```ts
compileNetwork(doc: CityDoc): RoadGraph          // 순수 함수, 렌더러도 사용

class Simulation {
  constructor(doc: CityDoc, opts?: SimOptions)   // doc은 내부에서 cloneJson
  applyCommand(cmd: Command): ApplyResult         // 내부 doc에 적용 → 네트워크 재컴파일 예약
  step(): void                                    // 1틱 (dt = 1/tickRate)
  snapshot(reuse?: SnapshotBuffers): SimSnapshot   // reuse 버퍼가 충분히 크면 재사용, 아니면 새로 할당. 내부 상태 버퍼를 절대 넘기지 않음
  stats(): SimStats
  get graph(): RoadGraph
  get doc(): Readonly<CityDoc>
  vehicles(): VehicleView[]                       // personId = 운전 중인 시민 id (자가용)
  signals(): SignalView[]
  /** 테스트/디버그: 지정 차선 위치에 차량 생성, 목적 차선까지 경로. 실패 시 null */
  spawnVehicle(typeId: string, fromLaneId: string, toLaneId: string, s?: number): number | null
}
```

## 모델 사양 (docs/architecture/overview.md D4 요약)
- **틱**: 기본 20Hz, 모든 갱신은 틱 단위. 1틱 순서: (1) 문서 변경 시 재컴파일·차량/보행자 재배치 (2) 신호·보행 신호 갱신 (3) 시민 이벤트 (4) 수요 생성·버스 (5) 경로 큐 처리(차량 100 + 보행 150 /틱) (6) 비신호 게이트 갱신 → 보행 횡단 허가 → 교차로 진입 허가 → 구간 횡단보도 통과 허가 (7) IDM 가속 계산(모든 차량, 이전 상태 기준) (8) 위치 적분·엣지 이동·구역 해제 (9) 보행 이동 (10) 도착/정체 제거 (11) 시민 상태 갱신(도착·실패·하차).
- **차선 배치**: `laneOffset()`(shared) 사용. forward = a→b. 각 노드 setback = 연결된 도로 중 최대 `roadHalfWidth` + 1m (degree 1이면 0, degree 2이고 같은 도로 타입·각도 차 < 20°면 1m). 교차로 횡단보도가 있는 끝은 그 방향 **모든 차선**을 `CROSSWALK_ZONE`=4m 더 자른다(`laneStartA/B` = setback + 4). setback·`junctionPolygon`은 불변. trim 후 차선 < 2m면 그 구간의 교차로 횡단보도를 만들지 않는다.
- **커넥터**: 진입 차선 끝 → 진출 차선 시작, 3차 베지어(접선 길이 = 거리의 0.4). 회전 판정: 진입 방향 대비 각도 |θ|<35° 직진, θ>0 우회전, θ<0 좌회전 (`angleBetween`, 양수 = 우회전). 차선 규칙: 1차선은 모든 회전, 다차선은 최우측=우회전+직진, 최좌측=좌회전+직진, 중간=직진. 직진 차선 매핑 `min(i, n_out-1)`, 우회전 → 진출 최우측, 좌회전 → 진출 최좌측. U턴은 degree 1(막다른 길)에서만. **차선 이동 커넥터**(ADR 0003): 직진 커넥터에 더해 인접 진출 차선(i±1)으로 가는 직진 커넥터도 만든다(경로 비용 +1s). 어떤 경우에도 모든 진입 차선이 최소 1개 진출 커넥터를 갖도록 보정.
- **충돌표**: 같은 노드 커넥터 쌍 중 폴리라인 최소 거리 < 2.5m(차폭 반영)이거나 같은 진출 차선으로 합류하면 충돌. 같은 진입 차선을 공유하면 충돌 아님.
- **경로**: 차선+커넥터 그래프 A*. 비용 = 길이/제한속도(+ 좌회전 4s, 우회전 2s, U턴 15s, 차선 이동 1s 페널티) + 차선 대기열(정지 차량 수 × 2s, 경로 계산 시점 값). 휴리스틱 = 직선거리/40m/s. 동률은 엣지 index 작은 쪽. 폐쇄 세그먼트 차선은 진입 불가. 버스전용 차선은 bus만.
- **IDM**: `a·[1 − (v/v0)^4 − (s*/gap)^2]`, `s* = s0 + max(0, vT + vΔv/(2√(ab)))`. car s0=2, T=1.2 / truck·bus s0=3, T=1.5. v0 = min(엣지 제한속도, 차량 maxSpeed), 커넥터는 회전 반경 기반 `min(√(2.5·R), 다음 차선 제한)`. 가속 하한 −9 m/s².
- **선행 차량 탐색**: 같은 엣지의 앞 차량 → 없으면 경로상 다음 엣지들(누적 150m까지). 진입 허가가 없으면 정지선(차선 끝)을 v=0 가상 선행차로 둔다.
- **교차로 관리자 (ADR 0004)**: 정지선까지 거리 ≤ max(12m, v²/(2b) + 5m) 인 각 차선 선두 차량이 요청. 허가 조건: (1) 신호 노드면 해당 접근로 녹색(황색·전적색 중 신규 허가 없음), (2) 충돌 커넥터에 점유·허가 차량 없음, (3) 진출 차선 빈 공간 − 이미 허가된 차량들의 몫 ≥ min(차량 길이 + 2m, 진출 차선 길이) → 허가와 동시에 그 공간을 예약. 처리 순서: 직진·우회전 요청 먼저, 좌회전·U턴 나중(비보호 좌회전 양보). 좌회전은 충돌하는 직진/우회전 요청이 대기 중이면 허가 안 함. 같은 우선순위 안에서는 도착 틱 → 차량 id. 앞선 요청이 충돌 때문에 막혔다면 그와 충돌하는 뒤 요청은 허가하지 않는다(공정성), 진출 공간 부족으로 막힌 요청은 예외. **예약 해제는 차량 후미(s − 차량 길이)가 커넥터를 벗어날 때.**
- **신호**: `intersections[nodeId]`가 없고 degree ≥ 3이면 자동 신호. 자동 위상: 접근로를 각도로 정렬해 가장 마주보는 쌍을 묶음(4지 = 2위상, 3지 = 쌍 1 + 단독 1, 5지 이상 = 접근로별). 기본 green 20s, yellow 3s, allRed 2s, `offset` 적용. 위상 목록에 없는 접근로는 단독 위상으로 추가, 사라진 세그먼트 참조는 무시. `kind: 'uncontrolled'`는 신호 없이 FCFS.
- **수요**: `demand` 옵션이 켜져 있으면 틱마다 확률적으로 통행 생성. 건물이 있으면 출발 주거 ↔ 도착 비주거(가중치 = `floorArea`), 각 건물은 가장 가까운 비폐쇄 세그먼트(최대 80m)에 접속. 건물이 없으면 임의 차선 간 통행. 생성률 ≈ `trafficDensity × min(차선 총길이/60, 2000) / 30` 대/초, 동시 차량 상한 `maxVehicles`. 차량 타입은 `spawnWeight` 가중 선택. 출발 위치에 차체 길이+5m 공간이 없으면 생성 보류.
- **버스**: 노선별 `buses`대를 정류장들에 균등 배치, 정류장 순환. 정류장 위치 = 해당 방향 최우측 차선의 `t × 길이`. 도착하면 10s 정차(state 'dwelling', 뒤 차량에게 정지 장애물), 이후 다음 정류장 경로.
- **재컴파일**: `graphRevision`++. 차선 id가 유지되고 길이 변화 < 0.5m인 차량은 유지 후 경로 재탐색(실패 시 제거), 그 외는 제거(`removed`++). 커넥터 위 차량은 같은 id 커넥터가 있으면 유지, 없으면 제거. 예약은 재구성.
- **도로 폐쇄**: 폐쇄 세그먼트로의 신규 진입·경로 금지, 이미 위에 있는 차량은 끝까지 빠져나감(배출), 폐쇄 구간을 지나던 경로는 재탐색.
- **정체 제거**: 90s 이상 연속 정지한 일반 차량은 제거하고 `removed`로 집계(조용히 삭제하지 말 것 — stats에 노출), 버스는 제외. 30s 이상 대기 중이면 1회 경로 재탐색.
- **laneFlow**: 차선별 (평균 속도 / 제한속도), 차량 없으면 −1. 스냅샷마다 계산.

### Phase 2b — 거리 교통 시설 (ADR 0008 §3)
- **횡단보도(`RoadGraph.crossings`, id 정렬)**: 교차로 = degree ≥ 3, 보도 있는 다리, `crosswalkLegs`(생략 = 전부)에 포함 → id `${nodeId}|${segmentId}`, 중심 s = setback + 2. 구간 = `RoadFeature` crosswalk, 보도 필요, `s ≥ laneStartA + 4`이고 `length − s ≥ laneStartB + 4`일 때만(아니면 무시). 지브라 폭 3m, a/b = 차도 가장자리(a = a→b 오른쪽). 신호 = 교차로 신호 노드 / 구간 `signal`.
- **충돌 구역(`network/crossings.ts`)**: 횡단보도마다 1개. 지브라를 차폭/2(1.25m) 넓힌 사각형과 교차로 커넥터(교차로 횡단보도) 또는 그 구간 차선(구간 횡단보도)의 교차 구간 [enterS, exitS]를 컴파일 시 계산.
- **차량 예약**: 커넥터 grant 시 그 커넥터의 모든 구역이 (보행 점유·예약 0, 진입 자격 보행자 0)일 때만 grant하고 구역을 함께 예약. 구간 횡단보도는 차선 위 내부 정지선(enterS): 앞의 미허가 첫 차량이(차선 첫 정지선은 진입 커넥터/그 선두 차량도) 요청 거리 + v·T 안에서 통과 허가 요청 → 거부되면 정지선이 v=0 장애물·hard clamp. 신호 구간은 녹색일 때만, 통과 후 공간(차체 + 2m) 필요. 해제 = 후미가 exitS를 지날 때. 보행자 때문에 거부된 요청은 `blockedMark`에 넣지 않는다.
- **보행자 예약**: 밴드 선두(또는 노드 대기)가 연석 2m 안에서 자격(신호 WALK / 비신호 게이트 열림)이 있고 차량 예약 0이면 구역과 **건너편 띠의 자리 1개를 원자적으로 예약**한다. 띠 수용량 = ⌊길이/0.7⌋ + 1, 띠 인원 + 예약 ≤ 수용량; 예약하지 않은 진입도 남은 자리가 있어야 한다. 구역은 횡단 에지를 벗어날 때, 자리는 그 띠에 들어설 때 해제(경로 변경·제거·재투영 시 반환). 적색 대기자는 자격이 없어 차량을 막지 않는다.
- **비신호 게이트**: 대기 차량이 있고 보행 점유/자격이 12s 연속이면 신규 보행 진입 금지 → 차량 1대 통과 또는 구역이 5s 빈 상태가 되면 해제.
- **보행 신호**: 다리 L은 L 진입 차선 적색이고 녹색 직진 커넥터가 L 구역을 지나지 않는 위상의 녹색 시작부터 WALK 7s → CLEARANCE ⌈L/1.0⌉s → RED. 그런 위상이 없으면 "L 적색" 위상. 위상 녹색 = max(green, 7 + clearance − yellow). 구간 신호 = 고정 주기(녹 30s, 황 3s, WALK 7s, CLEARANCE), 차량 신호 헤드는 차선별로 스냅샷 `signals` 뒤에 붙는다.
- **방지턱**: 정지 장애물이 아니라 속도 제약 — 앞 90m 안의 방지턱에 대해 v > √(vt² + 2·b·d)면 (vt² − v²)/(2d)로 감속, 차체가 방지턱 위에 있는 동안 v ≤ vt(20km/h). 레인 좌표 = 호 길이를 차선 구간에 비례 매핑(setback 안 방지턱은 무시).
- **보호구역**: 차선 제한속도 min(기존, 30km/h)(커넥터 제한속도도 따라감). 비신호 구간 횡단보도와 비신호 교차로 다리 횡단보도에서는 완전 정지 후 진행.
- **allStop / 완전 정지**: 정지선 1.5m 안·v < 0.15가 10틱 → `stopTick`(차선 진입마다 리셋). grant 순서 = stopTick → id. IDM 장애물을 s0 − 0.8m 당겨 정지선 0.8m 앞까지 접근.
- **재컴파일**: 차체 아래 모든 엣지(경로 이력)가 같은 id·길이로 남아야 차량 유지, 이력은 재매핑해 경로에 보존한다. 구역 예약 = 기존 예약 중 후미가 아직 못 벗어난 것(odo 기준, 횡단보도 id로 재매핑) ∪ 실제 몸체가 걸친 구역 ∪ 현재 커넥터의 남은 구역. 보행자는 새 그래프에서 목표(시민: 목적지 문 / 차 타러 가는 연석, 테스트 보행자: 옛 목표 20m 안 노드)와 **같은 성분**의, 원래 위치 **20m 안**에만 배치(같은 id 횡단보도(옮겨졌으면 새 위치도 20m 안일 때만) → 보도/모서리 최근접점 → 최근접 노드, 간격 위반 시 띠 시작 노드도 20m 안일 때만). 횡단보도 위에 남은 보행자는 그 틱에 바로 경로를 받고 건너편 띠 자리를 수용량과 무관하게 먼저 되찾는다. 실패 → 시민은 귀가·`failedTrips` 집계, 테스트 보행자는 제거. 그 틱 신규 허가 없음(`noGrantTick`).

### Phase 2b — 보행·시민 (ADR 0008 §4)
- **PedGraph(`network/pedGraph.ts`)**: 보도(차도 가장자리 + 1.25m, 교차로 횡단선 s = setback + 2 사이), 모서리(노드 주위 다리 각도순; 50°–170° miter(한계 5m) / bevel, 170°–190° 직선, 반사각·막다른 길은 노드 둘레 호), 횡단, 출입구(지상 파츠 외곽 중 가장 가까운 보도에 가장 가까운 면의 중점 → 보도, 차도 중심선과 차도 반폭 이내로 지나면 다음 후보, 최대 80m). 건물마다 반대편 보도에도 같은 s의 하차 노드. 경로 A*: 비용 = 길이/1.3 + 횡단 8s, 출입구 에지는 출발·도착에서만.
- **이동(`citizens/peds.ts`, SoA)**: 에지 방향별 띠(진행 오른쪽 0.65m), 띠 안 간격 0.7m, 엣지 전이 시 다음 띠 입구 공간 확인(순차 적용), 횡단 에지는 허가 필요. 속도 clamp(1.3 + 0.5(r1 − r2), 0.8, 1.8). gaitPhase = 누적 보행거리/1.4m·2π.
- **시민(`citizens/citizens.ts`)**: 인구 = 주거 연면적/30(`AREA_PER_PERSON`), 일자리 = 용도별 `AREA_PER_JOB`, 취업자 55%(`WORKFORCE_SHARE`), `scale = ⌈인구/maxCitizens⌉`, 최대 나머지법(동률 = building id 순). 상태 Home/Leaving/Walking/Driving/Entering/AtWork/AtShop(+Displaced 예약), 합 = 전체. 이벤트 `(dueTick, personId, seq)`, seq가 다른 이벤트는 무시(Home 가드). 출근 07–09시(해시), 근무 8h(게임 시각), 퇴근 시 30% 상점 15–45분, 비취업자 30%/일 10–16시 상점. 다음 일정은 도착 시점 기준. 수단: 보행 경로 ≤ 1km 또는 차 없음(60% 보유) → 도보, 아니면 출입구 → 보도 접속점 → 차량(personId, 목적지 쪽 차선 우선) → 하차 노드 → 도보. 차량이 도착 전에 사라지면 통행 실패 = 목적지 도착(집계). 시민이 있으면 수요는 임의 차선 간 × 0.3. RNG 스트림: 배정 / 일정 / 수단 분리.
- **편집**: 건물 레이아웃이 바뀌면(서명 비교) 보행 그래프 재구성 + 재투영 + 시민 재조정(집 철거 = 시민 제거·집계, 사라진 건물 안 = 귀가·집계, 사라진 직장 = 해제 후 다음 귀가 때 재배정, 목적지 소멸 = 귀가로 변경).
- **스냅샷**: `crossingSig` = `crossingSignature(graph.crossings ids)`(순서 포함 32비트 FNV-1a, index.ts에서 export) — 렌더러는 같은 서명일 때만 `crossings`를 인덱스로 읽는다. `pedestrians`(PED_STRIDE 8, 슬롯 순, 위치는 할당 없이 `writePose`로 기록), `pedestrianIds`(시민 id, 테스트 보행자는 0x80000000+), `crossings`(pedSignal, 점유 보행자 수(허가 포함), 차량 예약 수), `occupancy`/`buildingIds`(정렬 id, 실내 에이전트 수). `stats.citizens.atWork`는 AtShop 포함, `walking`은 Leaving+Walking+Entering. 시계 `dayTime = (06:30 + 물리초 × 10) mod 86400`.

## 모듈 분할 (Phase 3a, 순수 이동)
- `src/simulation.ts` 틱 드라이버 / `src/snapshot.ts` 스냅샷 버퍼 작성(`writeSnapshot`, laneFlow scratch)
- `network/pedGraph.ts` 보행 그래프 빌더 / `network/pedQuery.ts` 공간 질의(`nearestNode`·`nearestEdge`)·`PedRouter`
- `citizens/peds.ts` 풀·띠·이동 / `citizens/reproject.ts` 재구성 후 재투영(`reprojectPeds`·`routeCrossers`·`walkerGoal`·`retargetWalkers`)
- `citizens/citizens.ts` 인구·일상·통행 / `citizens/schedule.ts` 게임 시계 변환·`hash01`·이벤트 heap·`schedule`

## 테스트 (vitest, `src/**/*.test.ts`)
그래프(차선 수·커넥터·일방통행·U턴), 경로(폐쇄 우회, 일방통행 준수), IDM 정지, 적색 정지·녹색 출발, 충돌 불변식(교차로 격자 3분 실행 동안 같은 엣지 차량 간 순간격 ≥ 0, 같은 노드 충돌 커넥터 동시 점유 없음), 결정성(같은 doc·seed → 같은 snapshot 바이트, 보행자 포함), 버스 정차, 재컴파일 후 차량 유지, 좌회전 양보, 후미 기준 예약 해제(버스), 출구 예약 중복 없음, 폐쇄 시 우회.
Phase 2b: 횡단보도 컴파일(`network/crossings.test.ts`), 방지턱·보호구역·allStop·구간 횡단보도·보행 신호(`traffic/streets.test.ts`), 보행 그래프·횡단 예약·간격·게이트(`citizens/peds.test.ts`), 시민 인구·하루 사이클·자가용·철거(`citizens/citizens.test.ts`), 격자 + 시민 매 틱 구역 불변식(`invariants.test.ts`), 차량 3000 + 보행자 5000 벤치(`bench.test.ts`, 수치만 출력).
