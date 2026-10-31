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

  // ---- 시뮬레이터 모드 (ADR 0010, 타입은 src/scenario/types.ts) ----
  /** 실험 입력 검증 후 큐잉(없는 도로·차선·건물, 지난 tick, 중복 eventId 거부). 해당 tick의 step 시작에 (tick, order, eventId) 순으로 적용 */
  scenarioInput(input: ScenarioInput): { ok: true } | { ok: false; error: string }
  /** 대응 정책 변경. 현재 tick 경계의 `policy.set` 입력으로 기록되어(다음 step 맨 앞 적용) 그 입력을 반환. 잘못된 값은 RangeError */
  setPolicy(policy: ResponsePolicy): ScenarioInput
  /** 마지막 drain 이후 적용 시점 결과 전부(입력 적용·no-op, 자동 종료, 편집 후 장애물 이동·제거), 적용 순서. 읽어도 상태 불변 */
  drainScenarioOutcomes(): ScenarioOutcome[]
  /** 지금까지 받은 모든 입력(policy.set 포함, 받은 순) = ScenarioRecord.inputs. 허용 키만(SCENARIO_INPUT/TARGET/PARAM_KEYS) 저장 → 항상 JSON 왕복 가능 */
  scenarioInputs(): ScenarioInput[]
  /** 시나리오 상태가 생긴 tick(SimOptions.scenario면 0), 비활성이면 null = ScenarioRecord.activatedAtTick */
  scenarioActivatedAt(): number | null
  /** 활성화 tick(`since`)부터 누적한 KPI. 읽기 전용: 활성화하지 않는다(비활성이면 since = −1, 누적값 0) */
  kpi(): ScenarioKpi
  /** ADR 0015: 에이전트·관제가 보는 유일한 입력(인지된 사건만, 실시간 혼잡, 긴급 차량, 정규화 정책). 읽기 전용, 비활성이면 null */
  observation(): ObservationView | null
}
// SimSnapshot.control (ADR 0015 §6): 시나리오 상태가 있을 때만 — 에이전트 상태 + 최근 결정 30건(ControlView, src/control/types.ts)

// SimOptions.scenario: true → 생성 시점(tick 0)부터 시뮬레이터 모드(실험은 이것을 쓴다: warm-up까지 같은 규칙, 재생 일치)
simulationFromRecord(record, opts?, { warmup?: boolean = true, reroute?: boolean }): Simulation
  // 문서 사본·seed·tickRate, activatedAtTick(생략 = 0) 경계에서 활성화 + 초기 정책 + 입력 큐잉, warm-up 실행.
  // reroute = 스마트 대응 ON/OFF 비교용: 초기 정책과 모든 policy.set 입력의 reroute를 바꾸고 명시 preempt는 지운다(선점이 reroute를 따름).
new KpiSeries(kpiEveryTicks(tickRate)).record(tick, sim)          // 게임 30초마다 KPI 시계열 포인트
```

기록 형식 (ScenarioRecord, scenarioVersion 1):
- 엄격하다: 입력은 허용 키(SCENARIO_INPUT/TARGET/PARAM_KEYS)만, 모르는 키·비유한 숫자·형식이 다른 정책은 거부한다(실시간과 재생이 같은 검증).
- 아직 저장·내보내기가 없다. 기록은 세션 중 메모리에만 있으므로 추가 키를 가진 옛 v1 기록은 존재하지 않는다(Lead 결정, 정규화 코드 없음).
- 내보내기/가져오기를 추가할 때는 scenarioVersion을 올리고 옛 버전용 정규화기를 함께 넣는다.

워커 메시지 규칙 (apps/web/src/sim/sim.worker.ts):
- 한 tick의 메시지는 동기적으로 순서대로 보낸다: outcomes → snapshot → runTo done. 재시도 큐는 없다.
- 모든 송신은 하나의 `post()`를 거친다. postMessage는 직렬화 실패(DataCloneError, 버퍼 복사 중 할당 실패의 RangeError 등)에서 throw한다. 현재 메시지·버퍼 계약(평범한 데이터 + 검증된 버퍼)에서 송신 예외는 정상 복구 대상으로 취급하지 않고 즉시 치명 처리한다: 루프 정지, sim 제거, `{t:'status', status:'error', error:'메시지 전송 실패: …'}`를 한 번 시도, 이후 작업 무시(새 init / initRecord만 재시작). 그래서 실패한 메시지 뒤의 어떤 것도 전달되지 않는다.
- 그 밖의 치명 오류: step 실패, step 밖의 스냅샷 생성 실패(`스냅샷 생성 실패: …`). 반환 버퍼는 도착 시 sanitizeBuffers로 거르므로 풀 때문에 스냅샷이 실패하지 않는다.
- 비치명: 잘못된 메시지·입력·정책(`{t:'error'}` / 결과 응답), 메시지 처리기 예외, runTo 중 KPI 오류(`{t:'runTo', error}`).

시뮬레이터 모드 규칙 (ADR 0010):
- `w.sc`는 활성화(SimOptions.scenario, 첫 scenarioInput / setPolicy, 기록 재생의 activatedAtTick 경계 — 그 tick에 도달하는 즉시) 전까지 null이다. 기록 재생은 경계 전의 setPolicy·scenarioInput을 거부한다. `*.end`에 `target.eventId`를 주면 그 사건만 끝내고, 없으면 같은 도로·차선의 가장 먼저 시작한 사건을 끝낸다. 큐잉 시 검증은 정적(형식·종류·지난 tick·중복 id·대상 도로/차선/건물 존재)만 하고, 끝낼 사건이 없음(모름·아직 시작 전·이미 종료)은 적용 시점에 기록되는 no-op이다 — 실시간 수락과 기록 재생이 구조적으로 같다. null이면 기존 코드 경로 그대로(골든 해시 불변). `SimSnapshot.scenario`(장애물·통제 차선·KPI·`activeEvents`(eventId 순, endTick null = 종료 입력까지)·`recentLog`(최근 20건, applied·reason)·`incidents`(활성 화재·응급, 화재 진행도)·`damagedBuildings`·`dispatches`(출동 차량 id·단계·시설)·`preempted`(제어 중 교차로))도 그때부터만 붙는다. KPI 추가: `avgResponseTime`/`maxResponseTime`(게임 분), `responses`, `extinguished`, `damaged`, `medicalCompleted`, `dispatchFailed`, 그리고 순간값(누적 아님) `respondingNow`(활성 사건의 아직 현장 미도착 출동 수, 출발 대기 포함)·`respondingElapsedSum`(그들의 호출 후 경과 게임 분 합)·`oldestPendingMinutes`(최대) — 미도착을 포함한 평균 = (avg × responses + elapsedSum) / (responses + respondingNow). `stats`는 바뀌지 않는다.
- 입력 종류: `closure.start/end`(차선과 그 차선으로 가는 커넥터 신규 진입 금지, 내부 차량 배출), `accident.start/end`(차선 위치 s에 비차량 정지 장애물, 기본 9 m·2400 tick, 겹치면 앞 빈 위치로 이동), `surge.start`(eventId 해시 RNG로 유입 N + 유출 N 자가용 통행 사전 생성), `fire.start/end`·`medical.start/end`(4c2-①, 아래), `blackout.start/end`(4c2-②, 아래), `policy.set`. `*.end`는 같은 segmentId·lane(화재·응급: buildingId)의 활성 사건 중 가장 먼저 시작한 것을 끝낸다.
- 경로: 통제 차선은 모든 신규 탐색에서 제외, 사고 차선은 600 s 고정 패널티(목적지가 장애물 앞이면 없음). 정책 ON의 정보 차량(`hash01(id, seed) < informedShare`)은 사건 시작·종료 때 (등록 tick, 차량 id) 순 큐로 tick당 5대씩 자유류 비용 재탐색(먼저 등록된 요청은 추월당하지 않음). 금지 커넥터 앞 선두 차량은 정책과 무관하게 즉시 복구 탐색, 경로가 없으면 "경로 없음" 대기(정체 제거 예외).
- 재컴파일: 장애물을 남은 차량·출구 예약·다른 장애물과 다시 검사해 겹치면 배치 규칙(앞 빈 자리 → 뒤 → 없으면 종료·로그)으로 옮기고, 차선이 사라지면 종료(`lane gone`). 재탐색 큐는 (등록 tick, 차량 id) 순(같은 tick 묶음은 id 순 병합, 중복 없음).
- 정책 = "스마트 대응" `ResponsePolicy { reroute, informedShare, preempt? }`: `preempt` 생략 = `reroute`를 따름(`preemptOn`), 그래서 4c1 기록은 그대로 재생된다. `policy.set` params `preempt`(0|1)는 선택. 엄격 검증(`policyError`)·화이트리스트·워커 `inputShapeError`가 같은 규칙.
- **정책 정규화(ADR 0015 §3, `control/policy.ts`)**: 독립 요인 `preempt`·`reroute`·`battery`·`detection`(`policyFactors`), 생략 = 기존(preempt·battery ← reroute, detection ← legacy), 명시값은 그대로 기록(재작성 없음). 예약 요인 `adaptive`·`drone`·`precheck`·`onboard`는 OFF 고정: 정책 객체 false / params 0은 허용·무시하고 **기록하지 않는다**(`setPolicy`·직접 `policy.set` 모두 큐잉 때 제거), true / 1은 거부(`policyError`·`validate`·워커 `inputShapeError`). 표 = `POLICY_TABLE`. 엔진 3(재생 결과 불변, 기록에 예약 키 허용) — 엔진 1·2 기록은 초기 정책·입력 어디에든 예약 키가 있으면 거부, 없으면 그대로 재생.
- 시설(ADR 0010 §8): `BuildingType.service`(shared). 화재·응급은 해당 서비스(fireStation / hospital) 건물 중 **자유류 경로 비용이 가장 작은 곳**(동률 = 건물 id)에서 긴급차량 1대를 보낸다. 차종 = 문서의 `fire-truck` / `ambulance`(kind `emergency`), 없으면 첫 `emergency` 차종(id 순). 시설 없음 / 경로 없음(접속 도로 없음·폐쇄 포함) / 긴급 차종 없음 → `dispatch.failed`(reason `출동 불가: …`, KPI `dispatchFailed`), 사건은 그대로 진행.
- 화재·응급(`scenario/emergency.ts`): 입력 검증은 정적(건물 존재, `burnTicks`·`suppressTicks`·`treatTicks` 1 이상 정수). 적용 시 건물이 없으면 no-op, 피해 건물·이미 불타는 건물의 `fire.start`는 no-op. 화재 진행도 = (tick − 시작)/burnTicks × 100(기본 2400 = 게임 20분), 소방차 도착 → 진압 suppressTicks(기본 600) 후 진화(진행도 고정), 그 전에 100 도달 → 피해(`damagedBuildings`, 시나리오 상태만, 문서 불변; 동률이면 피해). 응급: 구급차 도착 → treatTicks(기본 360) 처치 → 출동한 병원으로 이송 → 도착 = `medical.complete`. 출동 실패한 응급 호출은 종료 입력까지 대기(`activeEvents`에 남음). 차량은 출발 시설 접속점에서 공간이 생기면(tick당 최대 8대) 생성되고 일반 IDM·교차로 규칙을 따른다(강제 양보 없음). 현장 작업 중에는 도로 밖에 주차(차선을 막지 않음). 사건이 끝나면(진화·피해·종료 입력) 출발 전 차량은 취소, 출동 중 차량은 귀소 경로로 바꾸고(경로가 없으면 현장까지 갔다가 귀소), 작업 중이면 귀소한다. 긴급차량은 통행 KPI(완료·통행시간·inProgress)에 섞이지 않고, 90 s 정체 제거 대상이 아니며, 차량 상한 예외(상한에 걸려도 생성, `w.vehicles`에는 포함). 편집으로 차량이 사라지면 `dispatch.lost`. 대응 시간 = 호출 tick → 현장 도착(활성 사건일 때만, 게임 분).
- 편집 후 재검사(리뷰 #2, `recheckIncidents`, 매 refreshDerived): 대상 건물이 사라진 사건은 `fire.end`/`medical.end`(reason `target gone`)로 끝나고 도착·진화·피해 KPI를 세지 않는다. 출발 전 차량은 `dispatch.cancel`, 출동 중·현장 작업 중 차량은 `dispatch.cancel` 후 귀소(출동 시 저장한 현장 접속점에서 출발). 환자를 이미 태운 이송은 계속한다. 시설이 사라지면: 출발 대기 차량은 `dispatch.cancel`(reason `facility gone`) 후 남은 시설에서 다시 출동, 귀소·이송 중 차량은 같은 서비스의 남은 시설 중 자유류 경로가 가장 짧은 곳으로 목적지 변경, 현장으로 가는 차량·작업 중 차량은 현장을 떠날 때 새 시설을 고른다. 남은 시설이 없으면 `dispatch.lost`(`귀소할 시설 없음` / `이송할 병원 없음`, 차량은 도로에서 제거 = `removed`).
- 고아 사건 없음(재검토 R1): 미션이 영구히 끝나면(시설·경로 없음, 편집으로 차량 소멸) 사건을 항상 정리한다. 이송 중이던 환자 → `medical.end`(reason `patient transport lost`, `medicalCompleted` 미증가). 현장 도착 전 차량을 잃으면 즉시 재출동(화재는 그동안 계속 탄다). 출동 불가(첫 실패만 `dispatch.failed` 기록·집계)인 화재·응급은 `DISPATCH_RETRY_TICKS`(600 = 게임 5분)마다 다시 출동을 시도한다(도로가 생기거나 폐쇄가 풀리면 출동). 불변식(`testkit.checkIncidentInvariants`): 활성 사건은 살아 있는 미션(도로 위 차량·출발 대기·현장 작업)이 있거나, burning / waiting 상태로 재시도가 예약돼 있다.
- 결과 스트림 추가 종류(eventId = 화재·응급 사건): `dispatch.start`(reason `vehicle N from 시설`), `dispatch.arrive`(reason 대응 시간), `fire.extinguished`, `fire.damaged`, `medical.complete`, `dispatch.return`, `dispatch.cancel`, `dispatch.failed`, `dispatch.lost`, 종료 입력이 끝낸 사건의 `fire.end`/`medical.end`(reason `by 입력id`). 모두 applied true.
- 신호 제어 상태 머신(ADR 0010 §4, `scenario/preempt.ts`): 교차로당 제어원 하나, 우선순위 DARK(4c2-② 자리만, 미구현) > PREEMPT > NORMAL. NORMAL = 제어 레코드 없음 = 기존 고정 주기(`updateSignals`)만. 선점 ON이면 출동 중·이송 중 긴급차량이 다음 신호 정지선까지 max(150 m, 15 s × 속도) 안에서 그 접근로의 위상을 요청(`(차량 id, 위상, ETA tick)`). 교차로당 요청은 ETA → 차량 id 순으로 하나씩 처리하고, 처리 중인 차량은 정지선을 지날 때(커넥터 진입)까지 유지(번갈아 전환 없음). 전환 규칙: 녹색은 한 위상의 접근로에만; 녹색을 끝내려면 최소 녹색 min(5 s, 계획 녹색), 그 위상 보행 신호의 정리(CLEARANCE)가 황색 끝까지 끝남(점등 WALK는 단축, CLEARANCE는 전부), 계획의 황색·전적색 전부; 스크램블 보행 위상은 CLEARANCE 종료 후. 제어 중에는 새 WALK를 시작하지 않는다. 요청이 없으면 같은 규칙으로 녹색을 끝내고 **계획의 다음 위상 시작**에서 고정 주기로 돌려준다 — 고정 주기 시계는 선점 중에도 계속 흐르고, 반환 시 그 교차로 offset을 다시 맞춘다(`sc.offsets`, 계획 식별자가 같을 때만 재구성 후 유지, 이웃 연동은 깨짐). 인수 시 최소 녹색·황색은 계획 재구성 tick(`SignalSet.builtAt`) 이후부터 센다.
- **구간 신호 횡단보도 안전 전환(모든 모드, `signalClearing.ts` `reconcileMids`)**: `MidSignal.key` = [횡단보도 id, 녹·황·WALK·정리, 헤드 차선 id]. 끌 때 WALK·CLEARANCE 중이면 `World.midClearing`(차량 적색 + CLEARANCE, 이전·새 횡단보도 중 긴 정리) 후 비신호(또는 바뀐 신호의 녹색), 차량 녹·황이면 즉시 비신호. 켤 때(또는 녹·황 중 변경) 새 주기가 차량 녹색이면 그대로, 아니면 전체 황색부터(`switchMidOn`, `MidSignal.offset` 재설정 = `signalOffsets['mid:'+id]`). key가 같으면 기존 동작.
- **정리 시간 = 현재 기하(리뷰 R2·R3)**: 정리 레코드는 `{start, end}`. 재구성마다 `extendClearances`가 진행 중인 정리(교차로·DARK·구간)를 `start + ⌈현재 길이/1.0⌉ s`까지 늘린다(이미 끝난 것은 제외). 신호를 끄는 구간도 새 그래프 길이로 계산한다. 검사기 `SignalWatch.sufficient`가 이를 확인한다.
- **정전·DARK(4c2-②, `scenario/blackout.ts` + `traffic/signalDark.ts`)**: 커버리지 = 신호 교차로·구간 신호·건물 → 반경 400 m 안 가장 가까운 변전소(동률 id, `Simulation.powerCoverage()`), 발전소는 목록만. `blackout.start` 대상 = 변전소 `buildingId`(그 담당 구역) 또는 params x·z·radius(원), `durationTicks` 기본 3600(게임 30분); `blackout.end`(eventId, 또는 buildingId의 가장 먼저 시작한 것). 매 tick(정전 중이거나 DARK가 있을 때만, 입력 직후·신호 갱신 전) `updatePower`: 미급전 신호 → 배터리(`ResponsePolicy.battery`, 생략 = reroute; 신호마다 1800 tick = 게임 15분, 급전 복귀 시 재충전) 동안 정상 운영(선점 포함) → 소진(`battery.depleted`) → DARK(`signal.dark`). DARK 교차로: 진입 차선 laneGreen 1 + laneStopReq 1(전방향 일시정지, 정지 후 FCFS), 노드 회전 우선순위 없음(`World.dark.nodeDark`), 횡단보도 비신호(소등 순간 WALK·CLEARANCE는 끝까지 정리), 헤드 표시 3(소등), 선점 요청·제어 없음(DARK > PREEMPT). DARK 구간 신호: 구간 정리 규칙으로 비신호. 마지막 정전이 끝난 다음 tick에도 한 번 더 갱신해 상태·배터리·순간 KPI를 비운다(리뷰 R1). 복구(`signal.restored`): 교차로는 황+전적색 동안 진입 정지(`signalClearing`) 후 첫 위상(또는 대기 선점 요청), 구간 신호는 `switchMidOn`. 재컴파일 시 `reapplyDark`. 건물 정전은 시나리오 상태만. KPI·View는 types.ts.
- **편집 시 신호 안전(모든 모드, `traffic/signalClearing.ts`)**: `buildSignals`가 계획마다 `PlanIdentity`(id 기반 key)를 만든다. 재구성(`refreshDerived`)마다 `reconcileSignals`가 이전 계획과 key를 비교해, 바뀐 교차로·신호가 없어진 교차로·새로 신호가 생긴 교차로(이전 FCFS 차선을 녹색으로 간주)를 `World.signalClearing`에 넣는다. 정리 규칙은 아래와 같다(그동안 교차로로 들어가는 차선 정지). 정리가 끝나면 새 계획을 첫 위상 시작에서 시작한다(`World.signalOffsets`, key가 같을 때만 재구성 후 유지). key가 같은 재구성은 아무것도 하지 않는다(골든 핵심 경로). 매 tick 처리는 `stepClearings`(정리 중인 교차로가 있을 때만, 시나리오에서는 `updatePreemption` 안에서 대기 요청에 넘길 수 있음). 이전 계획 표시는 tick의 순수 함수(`shownAt`)로 복원한다.
- 편집·재컴파일(리뷰 #1): 제어 레코드는 인덱스가 아니라 **계획 식별자**(`PlanIdentity.key` = 위상 접근로 id, 헤드 차선 id, 횡단보도 id, 녹색·황색·전적색·주기·offset·스크램블)에 묶인다. 제어 중인 교차로의 계획이 바뀌거나 신호가 사라지면 제어는 **편집 시 정리(`World.signalClearing`, 안정 id만 사용)**로 바뀐다: 녹색이던 차선(id)은 즉시 계획 황색(편집이 녹색을 끊으므로 최소 녹색 없음) → 전적색, WALK는 즉시 CLEARANCE 전부, 그동안 그 교차로로 들어가는 모든 차선 정지. 신호 헤드가 없어진 교차로는 황색을 표시할 수 없어 황색 + 전적색 동안 적색으로 붙잡고, 남은 CLEARANCE를 횡단보도에 표시한다(신규 횡단 없음). 정리가 끝나면 새 계획을 **첫 위상 시작**에서 시작하거나(offset 재설정), 남은 요청이 있으면 새 계획의 위상으로 선점을 이어가거나, 비신호가 된 교차로는 새 제어(FCFS·allStop)로 넘긴다. `SignalView.phaseIndex`·`preempted[].phase`는 정리 중 −1. 제어되지 않는 교차로도 같은 정리를 거친다(위 항목). 계산은 긴급 출동이 있거나 제어 중인 교차로가 있을 때만(없으면 0 비용). `SignalPlan.ctl`이 표시 상태(스냅샷 신호 헤드·`signals()`).
- **감지(ADR 0013, `scenario/detection.ts`·`coverage.ts`)**: `ResponsePolicy.detection` = `legacy`(생략, 사건 시작 tick에 인지 = 이전과 바이트 동일) | `reports`(시민 신고) | `sensors`(min(신고, 유효 센서)). 대상은 사고·화재만(응급·통제·급증·정전은 즉시). 사건 시작 시 후보 tick을 `shared` `hash01(seed, epoch, 'report|e' / 'detect|e|s' / 'miss|e|s')`로 고정(RNG 소비 없음, 지연은 게임 초 → `CLOCK_SCALE`·tickRate로 올림). 매 tick 입력 직후·전력 전에 도래 후보를 (tick, 센서 먼저·센서 id) 순으로 보고, 그 tick에 정전인 센서는 무효(`detection.unpowered`), 첫 유효 후보에서 인지 1회(`detection.known`). 미인지 화재의 전소는 감지보다 먼저 판정(동률 = 전소, `missedDamaged`). 인지 전: 사고 장애물은 물리적으로 즉시 막지만 라우터 비용(`Router.obsRear` = 알려진 사고만, `compose`)·우회 알림·화재 출동은 없음 — 실시간 혼잡(`w.stopped`)은 일반 교통정보로 보여도 된다(계약). 현장 복구(`scenario/onsite.ts`, reports·sensors 사고만): 막힌 차선에서 장애물 40 m 안에 멈춘 차량은 같은 방향 인접 차선으로 옮김(공간·경로가 있을 때, 우측 먼저), 그 차선에 들어가기 직전(40 m) 차량은 그 탐색에만 사고 패널티를 둔 재탐색 1회, tick당 탐색 5회. 공유 라우터에는 공개하지 않음. 인지 전 종료·전소·대상 소멸 = `detection.missed`. 커버리지 = 센서 부채꼴(닫힌 경계) → 차선 구간·건물, 그래프·건물·센서가 바뀔 때만 다시 계산. 센서 명령만 있는 편집은 sim 재구성을 하지 않는다. 기록 engine 1 = legacy, `ReplayOptions.detection` = 비교 프리셋 ②.
- 공정성: 재탐색·정책은 수요 RNG를 쓰지 않는다. 시나리오 모드에서는 시민의 도착·출발 시점 결정(상점 선택, 퇴근 후 상점 여부, 상점 체류 시간, 차종, 일자리 배정)이 공유 스트림 대신 `hash01(시민 id, 게임 일·결정 종류, seed)`이고, 차량 상한에서도 수요 추첨을 계속한 뒤 `droppedTrips`로 센다.

## 중앙 관제 틀 (ADR 0015 P8a, `src/control/` + `scenario/controlAdapter.ts`)
- 관측 → 제안 → 중재 → 안전 실행 → 결과. **기존 tick의 같은 호출·같은 순서에 끼운 어댑터**: 관제 상태(`ScenarioState.control`)는 물리 모델이 다시 읽지 않는다(골든·시뮬레이터 결과 스트림·KPI 바이트 불변, `control/unchanged.test.ts`가 11c7f04 지문으로 확인). 상한 아래에서는 어떤 경로도 바뀌지 않는다.
- **에이전트는 순수 함수**(`control/a1Detection.ts`·`a4Emergency.ts`·`a5Reroute.ts`): 입력 = `ObservationView`(또는 그 안의 인지된 사건) + 선언된 읽기 전용 조회(`DispatchQueries`: 차종·시설·접속 여부·자유류 경로 비용, `SignalQueries`: 자기 차량의 다음 신호 교차로·현재 서비스 차량, `RerouteQueries`: 정보 차량 id), 출력 = 제안 초안. 물리 상태 접근(조회 구현, 관측 보고 생성)·실행·감사 문구는 전부 `scenario/controlAdapter.ts`. 관측에 없는 내부 필드를 바꿔도 제안은 같다(`control/review.test.ts`).
- **관측 경계**: 사건은 `control.ts observe` 한 곳에서만 `known`에 들어가고, 그 전에 항상 A0의 observe 단계 중재를 거친다 — 입력 즉시 인지(통제·응급·정전·급증, legacy 사고·화재), 신고 접수(A0), 센서 감지(A1). `ObservationView`(`observation.ts`) = 활성 사건 ∩ known + 차선별 정지 차량(일반 혼잡) + 자기 긴급 차량(id·속도·단계) + tickRate + 정규화 정책. 미인지 사건(det.pending)·큐 입력·KPI·화재 진행도는 없다. 중재기는 known에 없는 사건을 가리키는 제안을 거절한다(`REJECT_UNOBSERVED`).
- **제안** `Proposal { id(A0가 submit 때 결정적 `${agent}:${stage}:${tick}:${n}`), agent, stage, priority, key(충돌 범위), rank, issuedTick, expiresTick, eventId, action }`. 같은 tick에 중재·실행하므로 대기 중 취소는 큐에서 빼는 것, 채택 후 취소는 실행기의 취소(`dispatch.cancel`·`dispatch.lost` → 감사 `cancelled`).
- **중재**(`arbiter.ts arbitrate`, 순수): 전체 순서 = 우선순위(생명 > 확산 > 효율) → key → rank(사전식) → agent → id, 입력 순서와 무관. 그 순서로 만료 → 관측 경계 → 남은 예산 → key당 첫 제안 채택·나머지 거절.
- **단계 예산**: tick·단계별 누적(`ControlState.used`, `stageCap` 기본 `STAGE_CAP` 4096) — 사건마다 따로 submit해도(기존 인터리빙 유지) 한 tick 합계로 제한. 초과 규칙(모두 감사 로그에 사유): observe → 입력 즉시 인지는 `deferred`에 넣어 다음 tick 관측 단계 맨 앞(만료 처리 직후, 그 tick 입력 전)에 재제안(backlog가 크면 여러 tick 이어질 수 있음; 그동안 사고는 물리적으로만 존재·라우터 비용 없음, 응급·화재는 출동 없음, 사건이 먼저 끝나면 `cancelled`), 신고·센서 보고는 후보를 되돌려 다음 tick에 다시 보고. dispatch → `retryAt = tick + 1`(출동 불가 집계 없음). signal → 이번 tick 서비스 없음, 다음 tick 다시 요청. route → 안내 취소(차량은 기존 경로). 기존 실행 예산(재탐색 5/tick, 긴급차 출발 8/tick)은 그대로.
- **단계(tick 순서)**: `observe`(입력 적용, 감지 처리) → `signal`(고정 주기 갱신 직후: A4 요청 → A0가 교차로당 하나(제어 중 차량 유지 → ETA → 차량 id) → **단일 안전 실행기** `scenario/preempt.ts updatePreemption`이 목표 위상만 받아 황색·전적색·보행 정리·반환을 결정) → `route`(A5 우회 안내 = 사건 시작·종료 때) / `dispatch`(A4 출동 선택 = 입력·인지·재시도·시설 삭제 시점 그대로, 실행 = 미션 생성).
- **에이전트**(`catalog.ts AGENTS`): A0 중앙 관제, A1 영상 감지(눈, detection = sensors일 때), A4 긴급 대응(출동 항상 ON, 우선신호 = preempt), A5 통제·우회 안내(reroute). A2·A3·A6·A7·A8은 자리만(OFF). 근거 = 출처 유형·성과 상태·보고서 참고문헌 번호.
- **감사 로그**(`control.ts`): 확정 결정·거절·취소만(출동 실패 첫 1회, 출동 취소, 차량 소멸 1회). 교차로에서 같은 차량 요청이 계속 채택되면 한 번만, 뒤에서 기다리는 요청의 반복 거절은 `repeated`로 집계만. 저장 상한 `AUDIT_MAX` 2000(초과 시 가장 오래된 것 삭제, `dropped` 집계), 스냅샷은 최근 30건의 **복사본**(`RECENT_DECISIONS`, target까지 복사). 상태 `동작` = 최근 200 tick 안 결정 또는 진행 중 작업(A4 출동·제어).

## 모델 사양 (docs/architecture/overview.md D4 요약)
- **틱**: 기본 20Hz, 모든 갱신은 틱 단위. 1틱 순서: (1) 문서 변경 시 재컴파일·차량/보행자 재배치 (시나리오: 만료 → 입력 적용 → 도래한 감지 처리(ADR 0013) → 전력 갱신) (2) 신호·보행 신호 갱신 (시나리오: 이어서 신호 제어 상태 머신) (3) 시민 이벤트 (4) 수요 생성·버스 (5) 경로 큐 처리(차량 100 + 보행 150 /틱; 시나리오: 재탐색 → 수요 급증 → 화재·응급 시계·긴급차량 생성) (6) 비신호 게이트 갱신 → 보행 횡단 허가 → 교차로 진입 허가 → 구간 횡단보도 통과 허가 (7) IDM 가속 계산(모든 차량, 이전 상태 기준) (8) 위치 적분·엣지 이동·구역 해제 (9) 보행 이동 (10) 도착/정체 제거 + 버스 정류장 처리(차량 id 순: 도착 틱에 하차·승차·dwell 결정, dwell 끝 틱에 하차 승객 보행자 생성) (11) 시민 상태 갱신(도착·실패·하차·정류장 합류·탑승 버스 소멸 = 통행 실패, 수단 선택).
- **차선 배치**: `laneOffset()`(shared) 사용(중앙분리대 도로는 각 방향 차선이 분리대 가장자리에서 시작). forward = a→b. 횡단보도·충돌 영역·보도 오프셋은 `carriagewayWidth`(보도 사이 전체 폭, 분리대 포함)를 쓴다 — 횡단은 분리대를 포함해 한 번에. 각 노드 setback = 연결된 도로 중 최대 `roadHalfWidth` + 1m (degree 1이면 0, degree 2이고 같은 도로 타입·각도 차 < 20°면 1m). 교차로 횡단보도가 있는 끝은 그 방향 **모든 차선**을 `CROSSWALK_ZONE`=4m 더 자른다(`laneStartA/B` = setback + 4). setback·`junctionPolygon`은 불변. trim 후 차선 < 2m면 그 구간의 교차로 횡단보도를 만들지 않는다.
- **커넥터**: 진입 차선 끝 → 진출 차선 시작, 3차 베지어(접선 길이 = 거리의 0.4). 회전 판정: 진입 방향 대비 각도 |θ|<35° 직진, θ>0 우회전, θ<0 좌회전 (`angleBetween`, 양수 = 우회전). 차선 규칙: 1차선은 모든 회전, 다차선은 최우측=우회전+직진, 최좌측=좌회전+직진, 중간=직진. 직진 차선 매핑 `min(i, n_out-1)`, 우회전 → 진출 최우측, 좌회전 → 진출 최좌측. U턴은 degree 1(막다른 길)에서만. **차선 이동 커넥터**(ADR 0003): 직진 커넥터에 더해 인접 진출 차선(i±1)으로 가는 직진 커넥터도 만든다(경로 비용 +1s). 어떤 경우에도 모든 진입 차선이 최소 1개 진출 커넥터를 갖도록 보정.
- **충돌표**: 같은 노드 커넥터 쌍 중 폴리라인 최소 거리 < 2.5m(차폭 반영)이거나 같은 진출 차선으로 합류하면 충돌. 같은 진입 차선을 공유하면 충돌 아님.
- **경로**: 차선+커넥터 그래프 A*. 비용 = 길이/제한속도(+ 좌회전 4s, 우회전 2s, U턴 15s, 차선 이동 1s 페널티) + 차선 대기열(정지 차량 수 × 2s, 경로 계산 시점 값). 휴리스틱 = 직선거리/40m/s. 동률은 엣지 index 작은 쪽. 폐쇄 세그먼트 차선은 진입 불가. 버스전용 차선은 bus만.
- **IDM**: `a·[1 − (v/v0)^4 − (s*/gap)^2]`, `s* = s0 + max(0, vT + vΔv/(2√(ab)))`. car s0=2, T=1.2 / truck·bus s0=3, T=1.5. v0 = min(엣지 제한속도, 차량 maxSpeed), 커넥터는 회전 반경 기반 `min(√(2.5·R), 다음 차선 제한)`. 가속 하한 −9 m/s².
- **선행 차량 탐색**: 같은 엣지의 앞 차량 → 없으면 경로상 다음 엣지들(누적 150m까지). 진입 허가가 없으면 정지선(차선 끝)을 v=0 가상 선행차로 둔다.
- **교차로 관리자 (ADR 0004)**: 정지선까지 거리 ≤ max(12m, v²/(2b) + 5m) 인 각 차선 선두 차량이 요청. 허가 조건: (1) 신호 노드면 해당 접근로 녹색(황색·전적색 중 신규 허가 없음), (2) 충돌 커넥터에 점유·허가 차량 없음, (3) 진출 차선 빈 공간 − 이미 허가된 차량들의 몫 ≥ min(차량 길이 + 2m, 진출 차선 길이) → 허가와 동시에 그 공간을 예약. 처리 순서: 직진·우회전 요청 먼저, 좌회전·U턴 나중(비보호 좌회전 양보). 좌회전은 충돌하는 직진/우회전 요청이 대기 중이면 허가 안 함. 같은 우선순위 안에서는 도착 틱 → 차량 id. 앞선 요청이 충돌 때문에 막혔다면 그와 충돌하는 뒤 요청은 허가하지 않는다(공정성), 진출 공간 부족으로 막힌 요청은 예외. **예약 해제는 차량 후미(s − 차량 길이)가 커넥터를 벗어날 때.**
- **신호**: `intersections[nodeId]`가 없고 degree ≥ 3이면 자동 신호. 자동 위상: 접근로를 각도로 정렬해 가장 마주보는 쌍을 묶음(4지 = 2위상, 3지 = 쌍 1 + 단독 1, 5지 이상 = 접근로별). 기본 green 20s, yellow 3s, allRed 2s, `offset` 적용. 위상 목록에 없는 접근로는 단독 위상으로 추가, 사라진 세그먼트 참조는 무시. `kind: 'uncontrolled'`는 신호 없이 FCFS. `SignalView.cycle`(초) = 전체 주기, `SignalView.scramble` = 보행 전용 위상이 실제로 켜졌는지.
- **수요**: `demand` 옵션이 켜져 있으면 틱마다 확률적으로 통행 생성. 건물이 있으면 출발 주거 ↔ 도착 비주거(가중치 = `floorArea`), 각 건물은 가장 가까운 비폐쇄 세그먼트(최대 80m)에 접속. 건물이 없으면 임의 차선 간 통행. 생성률 ≈ `trafficDensity × min(차선 총길이/60, 2000) / 30` 대/초, 동시 차량 상한 `maxVehicles`. 차량 타입은 `spawnWeight` 가중 선택. 출발 위치에 차체 길이+5m 공간이 없으면 생성 보류.
- **버스**: 노선별 `buses`대를 정류장들에 균등 배치, 정류장 순환. 정류장 위치 = 해당 방향 최우측 차선의 `t × 길이`. 도착하면 `clamp(10 + max(하차·1.0, 승차·1.5), 10, 40)` s 정차(승객 0명이면 정확히 10 s, state 'dwelling', 뒤 차량에게 정지 장애물), 이후 다음 정류장 경로. 승객 모델은 아래 Phase 3b.
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

### Phase 3b — 버스 승객 (ADR 0009 §2)
- **정류장 노드**: 노선에 속한 정류장만, 진행 방향 쪽 보도(forward = a→b 오른쪽)의 `t × 길이` 지점(보도 구간으로 clamp)에서 보도를 분할한 노드(`PedGraph.stopIds`(정렬)·`stopIndex`·`stopNode`·진행 방향 `stopTx/Tz`·보도 쪽 법선 `stopNx/Nz`). 그 쪽 보도가 없으면 승객 서비스 없음. 노선이 없는 정류장은 노드를 만들지 않는다(노선 없는 문서는 3a와 해시 동일). 보행 그래프 재구성 서명(`buildingSignature`)에 노선 정류장(id·세그먼트·t·dir)을 포함.
- **소유권**: 시민은 건물 | 보행자 | 자가용 | 정류장 대기열 `(stop, line)`(보행자 유지, `PedState.busStop`, 정렬 = (도착 tick, personId)) | 버스 `riders` | 버스 `alighting` 중 하나. 상태 `CitState.waiting`(8) = 대기열, `riding`(9) = riders/alighting. `stats.citizens.waitingBus/riding` = 각 상태 수. 정리 함수 `detachBus`(대기열 제거 시 seq++로 대기 이벤트 무효)는 `arrive`·`removeCitizen`에서 항상 호출.
- **도착 틱(차량 id 순)**: 정류장이 서비스되면 (그 정류장 하차자 ∪ 하차 정류장이 노선에서 빠졌거나 서비스되지 않는 탑승자) → `alighting`; `board = min(대기열, max(0, capacity − 남는 탑승자), 20)`을 FIFO로 태움(승차 = seq++). capacity = `VehicleType.capacity ?? (bus ? 40 : 4)`; 정원이 줄어도 탑승자는 유지, 신규 승차 없음. dwell 끝 틱에 `alighting`이 정류장 노드에서 보행자로 생성되어 목적지 문으로 걷는다(정류장이 사라졌으면 통행 실패).
- **대기 한도**: 게임 30분(물리 180 s) 이벤트 `(due, pid, seq)`; 만료 시 그 자리에서 목적지로 걷는다.
- **정리 경로**: 버스 소멸(despawn·재컴파일·노선 변경/삭제) → `updateCitizens`가 `c.ride.alive === false`를 보고 `failTrip`(1회). 하차 정류장이 노선에서 빠짐 → 다음 서비스 정류장에서 하차. 정류장 삭제·보도 소멸 → 재구성 후 `retargetCitizens`가 대기자를 걷게 함(20 m 안에서 새 정류장 노드로 옮길 수 있으면 대기 유지). 노선 삭제 또는 노선에서 정류장 제외 → `syncTransit`(파생 갱신 끝)이 대기자를 걷게 함, 서비스 정류장이 하나도 없는 노선의 탑승자는 `failTrip`. 집 철거 → `removeCitizen`이 모든 관계에서 제거.
- **수단 선택(`busOption`, `citizens/transit.ts`)**: 출발 문 → 정류장, 정류장 → 도착 문 보행 경로가 600 m 이하인 서비스 정류장 쌍을 가진 노선(대수 > 0, 차종 존재, 모든 구간 경로 존재 — 폐쇄로 끊기면 제외)이 후보. 버스 시간 = 도보/1.3 + 노선 순환 길이/8/대수/2 + 유향 승차 길이/8 + 중간 정류장×15 + 도보/1.3(최소값, 동률 = 노선 id → 정류장 순서). **후보가 없으면 기존 규칙 그대로**(경로 > 1 km이고 차 보유 → 자가용, 아니면 도보; RNG 사용 동일). 후보가 있으면 도보 = 경로/1.3, 자가용 = 경로/8 + 15 s(기존 규칙이 자가용을 허용하는 통행만, 아니면 ∞), 각 × 시민별 `hash01(id, mode, …)` 편향 [0.85, 1.15) → 최소, 동률 도보 < 버스 < 자가용. 캐시(노선 정보, 문별 근처 정류장, 문 쌍 결과)는 매 파생 갱신(재컴파일 포함) 끝에 비운다.
- **스냅샷**: `busLoad` = riders + alighting(차량 순서), `stopWaiting`(정렬 `busStopIds`) = 정류장의 모든 노선 대기열 합. 대기 보행자 위치 = 정류장 노드에서 진행 반대 방향으로 ⌊순번/2⌋ × 0.65 m, 보도 법선 방향 ±0.325 m(2열), 차도를 향함(순번 = 대기열 키 정렬 순서로 정류장별 누적). `VehicleView.passengers/capacity`(버스).

### Phase 3b — 보행 전용 위상 (ADR 0009 §3)
- `IntersectionControl.scramble`이 켜져 있고 `kind = 'signal'`, 차수 3–4, 횡단보도 있는 다리 ≥ 2이면(아니면 컴파일 시 무시) `buildSignals`가 차량 위상 뒤에 `approaches: []` 위상을 붙인다: 구간 하나 `allRed` = `7 + ⌈최장 횡단 / 1.0⌉` s(yellow 0), 모든 교차로 횡단보도가 WALK 7 s → CLEARANCE ⌈최장 횡단⌉ s. 차량 위상에는 WALK 없음, 녹색 연장도 없음. 사용자 위상 필터(빈 위상 제거)와 무관한 후처리. 안전은 기존 원자 구역 예약 그대로(보행자가 남아 있으면 차량 위상이 시작돼도 grant 없음).

## 모듈 분할 (Phase 3a, 순수 이동)
- `src/simulation.ts` 틱 드라이버 / `src/snapshot.ts` 스냅샷 버퍼 작성(`writeSnapshot`, laneFlow scratch)
- `network/pedGraph.ts` 보행 그래프 빌더 / `network/pedQuery.ts` 공간 질의(`nearestNode`·`nearestEdge`)·`PedRouter`
- `citizens/peds.ts` 풀·띠·이동 / `citizens/reproject.ts` 재구성 후 재투영(`reprojectPeds`·`routeCrossers`·`walkerGoal`·`retargetWalkers`)
- `citizens/citizens.ts` 인구·일상·통행(버스 승하차·정리 포함) / `citizens/schedule.ts` 게임 시계 변환·`hash01`·이벤트 heap·`schedule`
- `citizens/transit.ts` (3b) 정류장 대기열, dwell·정원 규칙, 수단 선택용 노선 추정(`busOption`), 스냅샷 대기 순번

## 테스트 (vitest, `src/**/*.test.ts`)
그래프(차선 수·커넥터·일방통행·U턴), 경로(폐쇄 우회, 일방통행 준수), IDM 정지, 적색 정지·녹색 출발, 충돌 불변식(교차로 격자 3분 실행 동안 같은 엣지 차량 간 순간격 ≥ 0, 같은 노드 충돌 커넥터 동시 점유 없음), 결정성(같은 doc·seed → 같은 snapshot 바이트, 보행자 포함), 버스 정차, 재컴파일 후 차량 유지, 좌회전 양보, 후미 기준 예약 해제(버스), 출구 예약 중복 없음, 폐쇄 시 우회.
Phase 3b: 승하차·FIFO·20명 상한·dwell·정원 축소·대기 한도·정리 경로 6종·수단 선택 회귀와 장거리 버스 선택·하루 불변식(`citizens/transit.test.ts`), 보행 전용 위상 시간·무시 조건·보행자 잔류 시 차량 차단(`traffic/scramble.test.ts`), 골든 트레이스 "노선·스크램블 없는 문서 = 3a 해시"와 버스 회랑(`golden.test.ts`).
4c2-①: 시설 필드·v5→v6 마이그레이션(`shared/facilities.test.ts`), 화재 진화/피해·응급 이송·출동 불가 3종·검증·재생 속성·ON/OFF 수요 RNG·상한 예외(`scenario/emergency.test.ts`), 신호 상태 머신 매 tick 안전 불변식(단일·스크램블 교차로, 상충 요청, 격자 + 시민) + 선점 ON/OFF 대응 시간(`scenario/preempt.test.ts`), 긴급 출동 벤치(`bench.test.ts`).
4c2-②: 구간 신호 켜기·끄기(Sol 재현·50 seed 토글)·메인 200 seed(`traffic/signalEdits.test.ts`), 전방향 일시정지 동시 도착·혼잡 FCFS·교착(`traffic/allstop.test.ts`), 커버리지·검증·DARK·배터리·복구·DARK>PREEMPT·보기·재생·200 seed 정전 무작위(`scenario/blackout.test.ts`), 정전 벤치.
편집 시 신호 안전: 메인 모드 재현·식별자 불변 재구성 무변화·골든 dense 스크립트·무작위 편집 200 seed(`traffic/signalEdits.test.ts`, 검사기 `testkit.SignalWatch`·`randomPlanEdit`).
Phase 2b: 횡단보도 컴파일(`network/crossings.test.ts`), 방지턱·보호구역·allStop·구간 횡단보도·보행 신호(`traffic/streets.test.ts`), 보행 그래프·횡단 예약·간격·게이트(`citizens/peds.test.ts`), 시민 인구·하루 사이클·자가용·철거(`citizens/citizens.test.ts`), 격자 + 시민 매 틱 구역 불변식(`invariants.test.ts`), 차량 3000 + 보행자 5000 벤치(`bench.test.ts`, 수치만 출력).
