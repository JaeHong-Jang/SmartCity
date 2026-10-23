# Research: Phase 3b — 버스 승객 모델, 보행자 스크램블 위상, 도로 접합 구역(zoning) 자동 성장

> 결정하려는 것: (1) 정류장 대기·승하차·정원·수단 선택을 기존 결정적 sim에 어떻게 최소로 넣을지, (2) 보행 전용(전방향·대각선) 위상을 신호 계획에 어떻게 넣을지, (3) 도로 옆 구역 지정과 건물 자동 성장을 명령 로그 모델에서 누가 어떻게 실행할지.
> 작성: sc-researcher (Sonnet 5.5) · 2026-10-23
> 검증 범위: 저장소 정적 분석(file:line은 2026-10-23 작업 트리 기준) + 웹 검색. 코드는 수정하지 않았다. 외부 사실 중 원문을 직접 읽지 못한 것은 "미검증"으로 표시했다. 신규 계수는 별도 표시가 없으면 **구현 제안값이며 미보정**이다.

## 요약 (5줄 이내)

- **버스:** 정류장별 FIFO 대기열 + 버스 정원 + `dwell = 기본 + max(승차·t_b, 하차·t_a)`(차량 도착 시 1회 계산)로 충분하다. 수단 선택은 이동시간 비교(도보/버스/자가용) + 시민별 해시 편향. 환승은 "공유 정류장 1회"까지만 MVP.
- **스크램블:** `SignalPhase`에 보행 전용 위상(`approaches: []`)을 추가하면 기존 WALK/CLEARANCE 계산(`signals.ts:170-181`)이 거의 그대로 동작한다. 대각선 횡단보도는 새 crossing 종류 + 충돌 구역 확장이 필요하다. 한국 전국 단위 설치 수치 기준은 **확인하지 못했다**.
- **구역:** 구역 = 도로 구간에 붙는 데이터(`ZoneStrip`) 또는 MVP로 기존 `Parcel` 재사용. 셀은 저장하지 않고 도로 기하에서 파생한다.
- **성장:** 서버 권위 "성장 감독(GrowthDirector)"이 문서 상태만 읽어(sim 상태 금지) `building.place` batch 명령을 생성한다. 클라이언트는 일반 명령처럼 seq 순서로 적용만 한다. 불변식 1·3 유지.
- 세 기능 모두 문서 v3 → v4 마이그레이션(`normalizeDoc`)이 필요하고, 공개 계약 변경이므로 Lead 승인 대상이다.

---

## 0. 현재 코드 현황 (재사용 지점)

### 0.1 버스 (file:line)

| 항목 | 위치 | 내용 |
|---|---|---|
| 데이터 | `packages/shared/src/model.ts:203-218` | `BusStop{id, segmentId, t, dir}`, `BusLine{stopIds, vehicleTypeId, buses}`. 정원·요금·배차 간격 없음 |
| 차종 | `model.ts:157-` `VehicleType` | `kind: 'bus'` 있음. **정원(capacity) 필드 없음** |
| 명령 | `commands.ts:46-49` | `busStop.add/remove`, `busLine.upsert/remove` |
| 정차 시간 | `sim/src/traffic/buses.ts:10` | `DWELL_SECONDS = 10` 고정 |
| 정류장 목표 | `buses.ts:19-25` | 해당 방향 **최우측 차선**의 `t × 길이` 지점 |
| 슬롯·스폰 | `buses.ts:28-113` | 노선당 `buses`대를 정류장에 균등 배치, 순환. 전역 차량 상한 공유(`:89`) |
| 정차 동작 | `buses.ts:116-136` | 도착(`:132`) → `dwell` 틱 카운트다운(`:118-120`) → 다음 정류장 경로(`:121-129`). 정차 중 `v=0`이며 뒤 차량의 정지 장애물(`vehicles.ts:37`, `:140`) |
| 틱 순서 | `simulation.ts:151`(maintainBuses), `:493`(updateBus) | `packages/sim/AGENTS.md` 틱 순서 (4) 수요·버스 |
| 통계 자리 | `sim/src/types.ts:166-167`, `citizens.ts:680-681` | `waitingBus`, `riding` 필드는 **있지만 항상 0** |
| 보행자 상태 | `types.ts:147` | `PedState.busStop = 3` 이미 예약됨 |
| 버스 전용 차선 | `model.ts:41-42`, `citizens.ts:500` | `busOnlyRightLane`. 시민 하차 지점은 버스 전용 차선 제외 |
| 문서 | ADR 0008 "버스 승객 상태머신(정원·대기열·환승)은 Phase 2c로 미룬다"(§4, §"Phase 2c로 미룸") | 이번이 그 후속 |

### 0.2 시민 (file:line)

- 상태/일과: `citizens.ts:17`(`CitState`), 이벤트 힙 `(due, pid, seq)` `:142-175`, `act` `:409`, `startTrip` `:424`, `failTrip` `:441`(통행 실패 = 목적지 도착으로 집계, 인원 보존), `arrive` `:456`.
- **현재 수단 선택(유일한 지점):** `updateCitizens`의 `Leg.plan` 분기 `citizens.ts:593-606` — 보행 경로 길이 `> WALK_MAX(1000m, :24)`이고 `hasCar`(`CAR_OWNERSHIP = 0.6`, `:26`, 생성 시 `rngMode`로 결정 `:255`)이면 자가용, 아니면 도보. 버스 선택지는 없다.
- 자가용 연석 대기: `CAR_WAIT = 30`(`:37`), `tryCar` `:492-520`.

### 0.3 신호 (file:line)

- `IntersectionControl{kind, crosswalkLegs?, phases?, yellow, allRed, offset}`: `model.ts:184-199`. `SignalPhase{approaches, green}`: `:177-182`.
- 상수: `PED_WALK = 7`, `PED_DESIGN_SPEED = 1`(m/s), `signals.ts:16-18`.
- `buildSignals`(`:126-228`): 사용자 위상 필터(`:144-153`, **`a.length`가 0이면 위상 버림**), 자동 위상(`:154`), 보행 헤드 생성(`:158-175`: `walks[k] = !ph.approaches.includes(leg) && !passes(k)`), 위상 녹색 연장 `max(green, 7 + clearance − yellow)`(`:181`), 구간 `green → yellow → allRed`(`:182-190`), 보행 신호 갱신은 `updateSignals`(`:230-`).
- 충돌 구역·예약: `network/crossings.ts`, `traffic/zones.ts`(차량이 구역을 점유/예약하면 보행자 진입 불가, 반대도 성립 — ADR 0008 §3).
- ADR 0008 §"Phase 2c로 미룸": "보행 전용 위상(스크램블)·`SignalPhase.crossingIds`".

### 0.4 문서 모델 / 구역 개념 (file:line)

- `Zone = 'residential'|'commercial'|'office'|'industrial'|'public'`: `model.ts:45`. `BuildingType.zone`: `model.ts:127`. `Building{id, typeId, pos, rotation}`: `:~135`.
- `Regulation{coverage, far, maxHeight, setback}` `model.ts:224`, `Parcel{id, polygon, zone: ParcelZone, regulation}` `:236`, `CityDoc.parcels` `:289`.
- `shared/src/planning.ts`: `DEFAULT_REGULATIONS`(`:18`), `ALLOWED_USES`(`:28`), `buildingsInParcel`(`:59`, 건물 anchor가 폴리곤 안), `parcelCompliance`(`:65`, 경고 전용 violations: coverage/far/height/setback/outside/use).
- 명령: `parcel.upsert/remove` `commands.ts:52-53`, 검증 `apply.ts:319-333`(면적 ≥ 16 m², 겹침 금지 `enforcePolicy`), 한도 `LIMITS.parcels = 50_000`(`apply.ts:59`).
- 인구/일자리 환산: `shared/src/stats.ts` `AREA_PER_PERSON = 30`, `AREA_PER_JOB`, `WORKFORCE_SHARE = 0.55`, `designStats(doc)`(`stats.ts:48`) — **문서만으로 계산되는 설계 지표**. 성장 감독의 수요 입력으로 쓸 수 있다.
- 도로 편집에 따른 정리 선례: `pruneFeatures`(`apply.ts:773`, 호출 `:490`, `:902`) — 구간 끝 12 m/간격 6 m 규칙 위반 시설을 같은 트랜잭션에서 제거.
- 마이그레이션: `DOC_VERSION = 3`(`model.ts:274`), `normalizeDoc`(`:298`)가 `??=`로 컬렉션 추가.
- 서버 프로토콜: `{t:'applied', seq, cmd, by, ref?}`(`protocol.ts:38`) — 서버가 seq를 부여해 브로드캐스트.

---

## 1. 버스 승하차·정원·수단 선택

### 1.1 참고 모델 조사

| 대상 | 모델링 방식 | 라이선스 / 검증 |
|---|---|---|
| **SUMO** | 차종 `personCapacity`(기본 4)와 `boardingDuration`(기본 0.5 s, "승·하차 1인당 소요")이 있다. 정차 `duration`은 **최소** 정차 시간이고, 승차 인원이 많으면 정차가 `boardingDuration`에 따라 늘어난다(메일링 리스트 개발자 답변). | 기본값은 공식 문서에서 직접 확인(검증됨): <https://sumo.dlr.de/docs/Definition_of_Vehicles%2C_Vehicle_Types%2C_and_Routes.html>. 라이선스는 EPL-2.0 (미검증, 문서에서 확인 못함). 참고만 하고 코드는 보지 않는다. |
| **MATSim** | 정류장은 링크 끝에 있고, 승객은 정류장에서만 승·하차한다. 정류장 지연은 승·하차 인원 × 차종별 1인당 지연이며 문 병렬 모드에서는 `max(승차 지연, 하차 지연) + 문 작동 지연`(Neumann et al. 2016). 정원 초과 시 승차 거부(교통 혼잡 연구에서 선형 증분 2.0 s/인 사용 — 발표 슬라이드, 코드 미확인). | 검색으로만 확인(미검증): <https://svn.vsp.tu-berlin.de/repos/public-svn/publications/vspwp/2013/13-14/NeumannEtAl2016MindTheGap_submitted_2016-02-05.pdf>, <https://www.mos.ed.tum.de/fileadmin/w00ccp/vvs/News_items/Subbaraman_MUM2025_Presentation.pdf>. MATSim 라이선스는 GPL로 알려져 있으나 이번에 확인하지 못함(미검증) → **코드 열람·복사 금지, 개념만 참고**. |
| **A/B Street** | 정류장·버스·대기 승객이 존재하지만 이번 조사에서 승하차 세부 규칙은 확인하지 못했다. | 저장소 <https://github.com/a-b-street/abstreet>, 라이선스 Apache-2.0(검색 결과로 확인). 승하차 로직은 **미검증** — 구현 전에 `sim` 크레이트의 transit 관련 소스를 직접 읽어 확인할 것(Apache-2.0이므로 아이디어 참고는 가능, 복사 시 NOTICE 고지 필요). |
| **Cities: Skylines 1/2** | 정류장마다 대기 승객 수가 있고 차량 정원이 있으며, 시민은 경로 비용(도보 + 대기 + 탑승)으로 수단을 정한다는 것이 일반적 이해이다. 정확한 수치·알고리즘은 비공개(클로즈드 소스)이므로 **세부는 미검증**. | 상용 게임. 공개 문서만 참고. 코드 없음. |
| **TCQSM (TCRP Report 165)** | 정차 시간 = 승차·하차 인원 × 1인당 시간(문 수, 요금 지불 방식에 따라 다름) + 문 개폐·정렬 손실. 전형적 1인당 승차 2–4 s(요금 선불 시), 하차 1–2 s 범위로 알려져 있으나 **정확한 표 값은 미검증**. | 미검증. 책은 TRB 발행(<https://www.trb.org>) — 수치는 구현 전 확인. |

핵심 공통 패턴(코드를 베끼지 않고도 수렴하는 것): ① 정류장별 대기열 ② 차량 정원 ③ 정차 시간 = 고정 손실 + 1인당 시간 × 인원(문 병렬이면 max) ④ 승차 거부 시 다음 차량 대기.

### 1.2 권장 최소 모델 (결정적)

**데이터 (문서, v4 마이그레이션 `??=`)**

- `VehicleType.capacity?: number`. 생략 시 `kind === 'bus' ? 40 : 4`(normalize 또는 sim 쪽 기본값). 상한 검증은 `apply.ts`의 `vehicleType.upsert` 검증에 추가(예: 1–200).
- (후속) `BusLine.headway` 등은 만들지 않는다 — 대수(`buses`)가 이미 배차를 결정한다.

**런타임 상태 (sim 내부, 문서 밖 — ADR 0008 §4와 동일 원칙)**

- 정류장 대기열: `queue[stopId][lineId] = personId[]` (FIFO). 삽입 순서 = 도착 틱 → 시민 id (`peds.ts` 갱신 순서가 이미 결정적이면 삽입 순서 자체가 결정적).
- 버스 탑승객: `bus.riders: {pid, alightStopIdx}[]`. 승차 시점에 하차 정류장을 확정한다.
- 시민 상태: `Leg`에 `toStop`, `waitBus`, `ride`, `fromStop` 추가. `CitState`는 기존 합계 불변식을 지키려면 **새 값 `waiting`, `riding`을 추가**하거나(`N_STATES` 변경 `citizens.ts:18`) 기존 `walking`/`driving`에 합산한다. 통계 필드 `waitingBus`, `riding`(`types.ts:166-167`)이 이미 있으므로 새 상태를 추가하는 쪽을 권장한다.

**정차 시간 (도착 시 1회 계산, 틱마다 재계산하지 않음)**

```
alight = 이번 정류장에서 내릴 승객 수
free   = capacity − (onboard − alight)
board  = min(대기열[stop][line].length, free)
dwell  = clamp( T_BASE + max(alight·T_ALIGHT, board·T_BOARD), T_BASE, T_MAX )
```

- 제안값(미보정): `T_BASE = 4 s`(문 개폐·정렬), `T_BOARD = 1.5 s`, `T_ALIGHT = 1.0 s`(문 병렬 가정), `T_MAX = 40 s`. 기존 `DWELL_SECONDS = 10`(`buses.ts:10`)은 승객 0명일 때 `T_BASE`로 대체하되, 기존 테스트(`buses.test.ts`)가 10 s를 가정하는지 확인 후 `T_BASE = 10`으로 두어 회귀를 피하는 선택지도 있다(권장: 호환을 위해 `T_BASE = 10`에서 시작해 별도 튜닝).
- 도착 틱(`buses.ts:132`)에서 승·하차 집합을 확정하고 **즉시 상태 전이**(대기열에서 제거, riders에 추가, 하차자는 목록에 보관)한다. 하차자의 보행자 스폰은 dwell 종료 틱(`:120`)에 일괄 한다. 이렇게 하면 dwell 도중 편집/재컴파일이 와도 인원 보존 처리 지점이 둘뿐이다.
- 승차 순서는 FIFO. 정원 초과로 남은 대기자는 대기열에 남고 다음 같은 노선 버스를 기다린다(승차 거부 이벤트는 통계로만 집계).

**시민 이벤트 연동**

- 정류장 도착(보행자가 정류장 노드에 도달)은 `updateCitizens`(11단계, `citizens.ts:544-`)에서 처리해 대기열에 넣는다. 인내 시간 초과(예: 게임 시각 15분)는 기존 이벤트 힙에 `(due, pid, seq)`로 등록하고, `seq`가 다르면 무시하는 Home 가드 패턴(`citizens.ts:142-175`)을 그대로 쓴다. 초과 시 `walkToDoor`(`:522`)로 전환하거나 `failTrip`(`:441`).
- 버스가 사라지는 경우(편집·재컴파일·정체 제거 제외 대상은 버스이므로 주로 편집): 탑승객 전원 `failTrip`(목적지 도착으로 집계) — 자가용 사라질 때(ADR 0008 §4)와 같은 규칙. 정류장 삭제 시 대기자는 `walkToDoor` 또는 귀가.
- 인원 보존 불변식: `home + atWork + walking + driving + waiting + riding = total`을 `invariants.test.ts`에 추가.

**환승**

- MVP: **직행 + 공유 정류장 1회 환승**. 두 노선이 같은 `BusStopId`를 `stopIds`에 가지면 같은 정류장에서 하차 후 다른 대기열로 이동(보행 0). 서로 다른 정류장 사이 도보 환승은 후속.
- 노선 탐색은 정류장×노선 그래프에서 비용 최소 경로를 구하는 BFS/Dijkstra 소규모 계산(노선 수 ≤ 수십). 문서 revision(`graphRevision` 증가 시) 마다 한 번 캐시.

### 1.3 수단 선택 (도보 / 버스 / 자가용)

현재 규칙(`citizens.ts:600`)을 **일반화된 시간 비교**로 확장한다. 모든 항은 이미 sim이 아는 값으로 계산하며 RNG 스트림을 새로 소비하지 않는다(해시만 사용 → 기존 스트림 순서 불변).

```
T_walk = L_walk / 1.3
T_car  = T_curb(≈CAR_WAIT/2) + L_drive / v_eff + T_park_walk      (자가용 보유자만)
T_bus  = L_walk_to_stop/1.3 + 0.5·headway(line) + L_ride / v_bus + Σdwell_est + L_walk_from_stop/1.3
       + (환승 시 + 환승 페널티 180 s)
cost_m = T_m · (1 + ε_m(pid))      ε = ±15 % 시민별 해시 편향, hash01(pid, 'mode', m)
선택  = argmin cost_m, 동률은 도보 < 버스 < 자가용
```

- `headway(line) ≈ 노선 총 길이 / v_bus / buses` (순환 노선이므로 대수로 근사). `v_eff`, `v_bus`는 상수(예: 8 m/s, 5 m/s)로 시작하고, 후속에 `laneFlow`(`AGENTS.md` 모델 사양)로 보정.
- 기존 동작과의 호환: 버스 노선이 없거나 접근 불가하면 비교 대상에서 빠져 기존 `WALK_MAX` 규칙과 같은 결과가 나오게 한다(회귀 테스트: 노선 없는 문서의 결과 불변).
- `T_walk`가 100–150 m 이하면 항상 도보(정류장까지 걸어가는 것이 더 길다)는 비교에서 자연히 성립한다.

**대안 비교**

| 선택지 | 장점 | 단점 |
|---|---|---|
| A. 이동시간 최소(위 권장) | 설명 가능, 결정적, 구현 작음 | 혼잡 피드백은 상수 근사 |
| B. 확률적 로짓(MNL) | 연구에서 표준 | RNG 스트림 추가·재현 시험 복잡, 계수 보정 필요 |
| C. 거리 임계만(현행) | 이미 있음 | 버스를 쓸 이유가 없음 |

### 1.4 위험

- 정류장 위치가 "최우측 차선"(`buses.ts:24`)인데 보행 그래프의 정류장 접속 노드는 아직 없다 → `PedGraph`에 정류장 노드(보도 위, 정류장 `t`의 최근접점) 추가 필요. 반대편 보도 정류장(`dir`)은 `dir`별로 같은 s의 노드를 둔다.
- 버스 병목: 정차 시간이 길어지면 뒤 차량 정지 장애물(`vehicles.ts:37`)이 교통 지체를 만든다. 정류장 만(bay)은 범위 밖.
- 경로 예산: 시민 수단 비교는 정류장 쌍 탐색을 포함하므로 틱당 150건 보행 경로 예산(AGENTS.md 틱 순서 (5))과 별도로 "수단 평가 예산"이 필요할 수 있다(미측정).

---

## 2. 보행자 스크램블(전방향 · 대각선 횡단) 위상

### 2.1 정의와 근거

- Barnes dance / 스크램블 = 모든 차량 진행을 정지시키고 보행자가 모든 방향(대각선 포함)으로 건너는 보행 전용 위상. FHWA CMF 설명: "special phase added to the regular two-phase… stops vehicle traffic in all directions and allows pedestrians to cross in any fashion, including diagonally" — <https://cmfclearinghouse.fhwa.dot.gov/detail.php?facid=4118> (검색 결과 요약으로 확인, 원문 미열람 → 미검증).
- NYC DOT 연구는 이 위상을 예외적 사례에만 쓰고, 일반적으로는 병행 보행 + LPI(선행 보행 간격)를 쓴다고 서술 — <https://www.nyc.gov/html/dot/downloads/pdf/barnes-dance-study-sept2017.pdf> (검색 요약, 원문 미열람 → 미검증).
- 1,297개 교차로·15개 도시 연구는 스크램블이 보행자 사고를 유의하게 줄였다고 보고. 반면 FHWA CMF 목록의 NYC 값은 1.1(악화 방향)이어서 **상충**한다 — 효과 수치는 게임 규칙에 쓰지 말고 체감 모델링에만 쓴다. (검색 요약, 미검증)
- MUTCD에는 스크램블에 대한 수치 기준(warrant)이 없고 FHWA *Signalized Intersections: Informational Guide*를 참조하라는 정보가 있으나 포럼 글 수준(미검증). LPI 최소 3초 권고는 MUTCD 쪽 정보로 검색에서 확인(미검증).
- **한국:** 서울시 교통 누리집이 대각선 횡단보도 217곳(2012–2023) 분석에서 교차로 사고 18.4 % 감소, 대각선 이동거리 평균 5.6 m 단축, 전방향 동시 보행으로 보행자·차량 상충이 사라졌다고 발표 — <https://news.seoul.go.kr/traffic/archives/515739> (검색 요약, 미열람 → 미검증). **경찰청·도로교통공단의 전국 단위 설치 수치 기준과 보행신호 시간 기준은 이번 검색에서 확인하지 못했다.** 보행 속도 1.0 m/s 가정(`signals.ts:18`)은 이미 ADR 0008에 채택되어 있고, 한국 지침 값은 "경찰청 교통신호기 설치·관리 매뉴얼"에서 직접 확인이 필요하다(미검증).
- 국회도서관에 어린이보호구역 대각선 횡단보도 권장 설치 기준 연구가 있다는 정보(수치 미확인): <https://dl.nanet.go.kr/detail/KINX2021028077>.

### 2.2 기하

- 4지 교차로는 보행 구역의 네 모서리(연석 코너)가 있고, 대각선 횡단은 **마주보는 코너 쌍** 2개(X자)다. 3지(T)는 대각선 1개. 5지 이상은 MVP에서 스크램블 비활성(지원 안 함, 검증 오류 또는 무시).
- 대각선 길이 `L_d = |코너_i − 코너_j|`. 예: 교차로 폭 ≈ 20 m 정사각이면 `L_d ≈ 28 m`.
- 보행자 정리 시간(clearance) = `⌈L_d / 1.0⌉ s` → 약 28 s (현행 규칙 `signals.ts:166` `clearanceOf = ceil(length / PED_DESIGN_SPEED)`와 동일 식, `length`만 대각선 길이로). 스크램블 위상 길이 `≈ PED_WALK + clearance = 7 + 28 = 35 s`.
- 코너 좌표: 이미 `junctionPolygon`(교차로 다각형, `AGENTS.md` setback 서술)과 PedGraph 모서리 노드가 있다. 새 형상은 "코너 노드 ↔ 코너 노드" 에지 하나다.
- ADR 0008의 PedGraph 규칙은 "교차로 중심 통과 금지"(§4)이므로 **대각선 에지는 그 규칙의 명시적 예외**로 추가한다(스크램블 켜짐 노드에만).

### 2.3 차량 전적색과 안전

- 스크램블 위상은 모든 차선이 적색(`laneGreen = 0`)이다. 직전 위상의 `yellow → allRed(2 s)` 뒤에 온다.
- **추가 안전장치는 기존 충돌 구역 예약으로 이미 보장된다**: 보행자는 구역에 차량 예약이 0이어야 진입 허가를 받는다(ADR 0008 §3, `zones.ts`). 대각선 구역을 모든 커넥터와의 교차로 컴파일하면(차폭/2 확장 포함, `crossings.ts`) 교차로 안 마지막 차량이 빠져나가야 WALK 진입이 일어난다 → 별도 "클리어런스 타이머" 불필요.
- 위상 전환: 스크램블 종료 → CLEARANCE 끝(적색 보행) → 다음 차량 위상 녹색 시작. 차량 녹색 시작 전에 대각선 구역 점유 보행자가 남으면 기존 규칙대로 차량은 계속 막힌다(ADR 0008 "시간이 끝나도 실제 점유가 남아 있으면 차량은 계속 막힌다").
- 우회전 차량이 일반 횡단보도를 지나는 상충은 스크램블이 "독점 보행"일 때 사라진다. 병행(additive) 모드에서는 기존 양보 규칙 유지.

### 2.4 신호 계획 모델에 넣는 방법

**제안 A (권장, 최소 변경):**

- `IntersectionControl.scramble?: boolean`(또는 `{ exclusive: boolean }`). 켜지면 `buildSignals`가 phases 맨 뒤에 `{ approaches: [], green: 0 }` 형태의 **보행 전용 위상**을 하나 추가한다.
- 동작 근거(코드 확인):
  - `walks[k] = !ph.approaches.includes(leg) && !passes(k)`(`signals.ts:~171`) → `approaches`가 비어 있으면 모든 다리에서 자동으로 `true`. 즉 모든 일반 횡단보도가 스크램블 위상에서 WALK가 된다.
  - 녹색 연장 `max(green, 7 + clearance − yellow)`(`:181`) → 스크램블 위상에서는 `yellow = 0`이어야 하므로 위상별 `yellow` 건너뜀이 필요하다. 이미 `intervals` 구성부는 `d <= 0`이면 건너뛴다(`:191-196`). 즉 해당 위상에 한해 `yellow = 0`으로 쓰도록 분기 1줄 + clearance를 `max(일반 횡단 clearance, 대각선 clearance)`로.
  - 수정이 필요한 곳: 사용자 위상 필터가 빈 위상을 버린다(`signals.ts:144-153`, `if (a.length)`), `autoPhases`(`:97`)에는 스크램블이 없으므로 `buildSignals`에서 후처리로 추가.
- **독점 모드(exclusive):** 스크램블 켜짐이면 일반 위상에서는 `walks[k] = false`(횡단보도 적색)로 두어 서울식 전방향 동시 보행신호를 흉내. **병행 모드(additive):** 기존 WALK를 유지하고 스크램블 위상에서만 대각선 추가. MVP는 독점만(결과 예측이 쉽다).
- 사이클 비용: 4지 교차로 기본 사이클은 `2×(20+3+2) = 50 s` → 스크램블 추가 시 `+35 s ≈ 85 s`. 지체 증가는 설계자가 알도록 HUD에 사이클을 표시(UI 범위).

**제안 B:** `SignalPhase.crossingIds?`(ADR 0008이 예고)로 위상별 "WALK 허용 횡단보도"를 명시. 유연하지만 문서 스키마/UI가 커진다. 현재 요구(스크램블 1종)에는 과하다 → 후속.

### 2.5 변경 요약 (구현 단계 참고, 이번에는 코드 수정 없음)

| 영역 | 변경 | 위치 |
|---|---|---|
| shared | `IntersectionControl.scramble?: boolean` + 검증(degree 3–4, 보도 있는 다리가 2개 이상) + `intersection.set` 검증 | `model.ts:184-199`, `apply.ts`(`intersection.set`) |
| sim network | `RoadGraph.crossings`에 `kind: 'diagonal'` 추가(코너 쌍), 충돌 구역 컴파일 | `network/crossings.ts` |
| sim ped | 대각선 에지 예외, 코너-코너 연결 | `network/pedGraph.ts` |
| sim signal | 보행 전용 위상 삽입, 위상별 yellow 0, 대각선 clearance | `traffic/signals.ts:126-228` |
| 스냅샷 | `crossings` 배열에 대각선이 같이 들어감(stride 3 불변) | `types.ts:143` |
| 렌더 | 대각선 지브라 | web (범위 밖) |

### 2.6 위험

- 두 대각선(X)이 교차하는 중심에서 보행자 간 충돌은 띠(band)·간격(0.7 m) 규칙이 에지 단위라 교차 에지 사이에는 적용되지 않는다 → 허용(보행자끼리 겹침 시각 아티팩트)하거나 간이 간격 검사를 추가. 결정 필요.
- 비신호(uncontrolled/allStop) 교차로에는 스크램블이 의미 없음 → 검증에서 거부.
- 효과 수치는 상충 자료가 있으므로 게임 규칙의 근거로 단정하지 않는다.

---

## 3. 도로 접합 구역(zoning)과 자동 성장

### 3.1 참고 모델

| 대상 | 핵심 | 근거 |
|---|---|---|
| **Cities: Skylines 1** | 도로 양옆에 **8 m × 8 m 셀** 격자가 생기고, 구역 깊이는 최대 **4셀**(약 32 m)이다. 얕게(2셀) 칠할 수 있고 건물은 구역이 허용하는 깊이에 들어가는 크기만 선택된다. 도로 정면 기준으로 건물이 도로를 향해 회전한다. 구역 칠하기는 한 면만/양면 선택. | 개발자 일지 <https://admin-forum.paradoxplaza.com/forum/developer-diary/cities-skylines-dev-diary-2-zoning.804803>(검색 요약: 깊이 4셀 확인), 커뮤니티 포럼의 셀 8 m 설명(2차 출처, 미검증). 도로 폭 2셀 주장은 사용자 이해 수준(미검증). |
| **Cities: Skylines 2** | 칠하기 도구가 블록 전체/단일 셀을 칠하며 밀도 3단계(저·중·고, 주거·상업·사무만 고밀), 산업은 넓은 땅이 필요. 블록 크기·도로 길이가 실제 미터로 계산된다는 커뮤니티 설명. 수요는 주거/상업/산업별로 있고 미리 많이 칠하면 빈 땅이 남는다. 레벨업 규칙은 이번 검색에서 확인 못함(미검증). | <https://techraptor.net/gaming/news/cities-skylines-2-developers-discuss-zoning-in-new-in-depth-video>, <https://www.skool.com/engineer-plays-6981/vanilla-foundations-key-differences-between-cs1-and-cs2>(2차 출처). |
| **SimCity 4** | 구역을 도로 옆 격자에 칠하면 시뮬이 빈 필지에 건물을 **성장**시킨다. 수요는 주거/상업/산업 3 바(RCI)로 표시되고 일자리·인구·세율·교통에 영향받으며, 건물은 필지 부가가치(land value)·서비스·교통에 따라 부유도/밀도가 오르내리는 것으로 알려져 있다. 세부 공식은 공개되지 않음(미검증). | 일반 지식. 링크 없음 → 미검증. |
| **고전 SimCity식 RCI** | 주거 수요 ↔ 일자리 여유, 상업 수요 ↔ 주거 인구, 산업 수요 ↔ 일자리 필요(노동력 대비)로 상호 연동되는 음의 피드백 구조. | 일반 지식(미검증). |

공통 패턴: ① 구역은 **도로에 종속된 셀 집합**(도로 앞면에서 깊이 N) ② 건물은 "필지(lot) = 셀 연속 구간"에 맞춰 선택·회전 ③ 성장은 수요 × 빈 필지 × 확률 ④ 레벨업은 조건(지가·서비스·수요) 충족 시 더 큰 건물로 교체.

### 3.2 우리 모델에 대한 설계 선택지

**(a) 구역을 문서에 어떻게 저장하나**

| 선택지 | 장점 | 단점 |
|---|---|---|
| A1. **`ZoneStrip`** — 구간에 붙는 데이터 `{id, segmentId, side: 'left'\|'right', t0, t1, zone, depth}`; 셀·필지는 도로 기하에서 **파생** | 도로 편집(분할·이동)과 함께 갱신 가능(`pruneFeatures`·분할 재매핑 선례 `apply.ts:773`), 문서 작음(스트립 수 ≪ 셀 수) | 새 컬렉션/명령/분할 재매핑/마이그레이션 필요 |
| A2. 셀 단위 저장 | 단순 개념 | 셀 수 폭발(100 m 도로 양면 × 4깊이 × 12.5셀/100m ≈ 100셀), 도로 이동 시 정합성 지옥 |
| A3. **기존 `Parcel` 재사용**(구역 도구가 `parcel.upsert` batch 발행, 필지 = 1 lot) | **새 스키마·명령 없음**: `Parcel{polygon, zone, regulation}`(`model.ts:236`), `parcelCompliance`(`planning.ts:65`), 겹침 검사(`apply.ts:329`), `LIMITS.parcels = 50_000`을 그대로 사용 | 도로가 바뀌어도 필지는 자동 갱신 안 됨(도로 위에 겹치면 정리 규칙 필요), "도로 접합"은 도구 UI에서만 보장 |

**권장:** MVP는 **A3**(필지 재사용), 선택 필드 하나만 추가: `Parcel.auto?: true`(자동 성장 허용 표시, 마이그레이션 `??=` 불필요 — 옵션 필드). 도로 부착 정보가 필요해지면(도로 이동 시 재생성) 후속에서 A1로 전환한다. A3는 사용자가 직접 그린 필지(Phase 2a)와 동일한 개념이므로 규제 검사·UI·테스트를 공짜로 재사용한다.

**(b) 필지 생성(도로 접합) 알고리즘 — 순수 함수 `lotsAlongSegment(doc, seg, side, t0, t1, depthCells)`**

- 구간 곡선을 샘플링해 호 길이로 8 m 간격 앞면 점 배열을 만든다(셀 폭 8 m, 깊이 `depthCells × 8 m`, 최대 4셀 — CS1 값을 게임 기본으로 채용).
- 앞면 시작은 도로 가장자리 + 보도(`roadHalfWidth` + 보도폭) 바깥. 교차로 setback/횡단보도 구역(`CROSSWALK_ZONE`)과 겹치는 앞면은 제외(교차로 모서리는 이미 `junctionPolygon`, setback이 있음).
- 연속 셀 폭을 **lot 폭 W**(기본 2–4셀 = 16–32 m)로 자르고, 각 lot을 직사각형 폴리곤으로 만들어 `parcel.upsert`. 다른 도로·건물·필지와 겹치면 해당 lot 생략.
- 출력은 결정적(구간 id 정렬 → 측면 → 앞면 순서). 클라이언트(도구)에서 계산 후 **명령 batch**로 제출하므로 서버는 일반 검증만 수행한다.

**(c) 성장을 누가 실행하나**

| 선택지 | 장점 | 단점 |
|---|---|---|
| G1. **결정적 클라이언트 sim이 성장** (각자 계산) | 서버 단순 | 각 클라이언트의 sim 틱 타이밍이 다르면 문서가 갈라짐. **불변식 1·3 위반**(문서 변경이 명령이 아님) → **기각** |
| G2. **서버 권위 GrowthDirector가 명령 생성** (권장) | 모든 변경이 `building.place` 등 일반 명령 → seq 순서로 브로드캐스트(`protocol.ts:38`), 재현·Undo·로그 가능 | 서버 코드 추가. 서버가 `sim`에 의존하지 않도록 **문서만** 읽어야 한다(AGENTS.md: 서버는 Phase 3에 sim 의존 예정) |
| G3. 사용자 승인형(제안 → 클릭) | 안전 | 게임성 낮음 |

**G2 상세**

- 주기: 서버 룸이 고정 간격(예: 벽시계 5–10 s, 또는 연결된 클라이언트가 있을 때만)마다 `growthStep(doc, epoch)`를 호출. 벽시계는 **발생 시점만 정할 뿐**, 결과는 명령 로그에 박제되므로 재현성은 보존된다(리플레이는 로그만 적용).
- 입력: **문서만**. 수요는 `designStats(doc)`(`stats.ts:48`) 기반(인구, 직종별 일자리). sim 내부 상태(교통 흐름, 시민 위치)는 쓰지 않는다 — 클라이언트마다 다를 수 있어서가 아니라 서버에 sim이 없고 동기화 위험이 있기 때문(Phase 3 이후 재검토).
- 난수: `shared/rng.ts`의 시드 RNG를 `hash(meta.seed, epoch, lotId)`로 구동(`Math.random` 금지, AGENTS.md 불변식 2). `epoch`는 서버가 보관하는 단조 카운터이며 문서에 저장할 필요는 없지만, 서버 재시작 후 재현을 위해 `meta`에 `growthEpoch?`를 두는 선택지도 있다(권장: 불필요 — 결과는 로그에 있다).
- 출력: `{ type: 'batch', commands: [...] }`, `by: 'system'`. 한 epoch당 최대 N개(예: 8) 건물만 배치해 급격한 변화를 막는다.
- 협업: 사용자가 같은 순간 같은 lot에 건물을 놓으면 서버가 seq 순서로 처리하고, 두 번째 명령은 검증 실패(`building.place`의 기존 충돌 검증)로 거부 — 기존 충돌 처리 경로 그대로(`ApplyResult` 오류).
- Undo: 시스템 명령은 개인 Undo 스택에 넣지 않는다(UI 정책, 결정 필요).

**(d) 수요(RCI) 최소식 (문서 지표만 사용)**

```
pop      = designStats.population
workers  = pop · WORKFORCE_SHARE
jobs     = Σ jobsByUse                      (stats.ts:65)
R_demand = clamp( (jobs − workers) / max(jobs, 100), −1, 1 )    일자리 여유 → 주거 수요
C_demand = clamp( (pop · 0.15 − jobs_commercial) / max(pop·0.15, 100), −1, 1 )
I_demand = clamp( (workers − jobs) / max(workers, 100), −1, 1 )   실업 → 일자리(산업/사무) 수요
```

- 계수(0.15 등)는 **임의 제안값(미보정)**. 목표: 음의 피드백 루프만 성립하면 된다.
- 기본 가드: 수요 > 0.1일 때만 성장. 어떤 구역도 "노동력 0·일자리 0"일 때는 최소 수요를 주어 시작을 허용(부트스트랩).

**(e) 성장·레벨업 규칙**

- 후보: `Parcel.auto`이고 빈 lot(필지 안 건물 0, `buildingsInParcel` `planning.ts:59`), `zone`이 수요가 양인 용도. lot을 id 순으로 순회, `hash < p`이면 선택(p = 수요 × 계수).
- 건물 선택: `BuildingType` 중 `zone`(`model.ts:127`)이 일치하는 것에서 lot 폭·깊이에 **footprint가 들어가는** 것만, 낮은 레벨부터(레벨 = 층수/면적 순서). 추가 필드 `BuildingType.growth?: { level: number; lot: { w: number; d: number } }`(선택) — 없으면 프리셋 건물 사용 불가(성장 대상 아님). 기존 사용자 제작 건물(스튜디오)을 성장 후보에 올릴지는 `growth` 태그로 선택(창의적 건물 존중).
- 배치: 건물 `pos` = lot 앞면 중심에서 `setback`(규제값)만큼 안쪽, `rotation` = 도로 접선 방향(도로를 향함). 배치 전 가상 `Parcel`로 `parcelCompliance`(`planning.ts:65`) 검사 → violations 없을 때만 `building.place`. 규제값은 `DEFAULT_REGULATIONS[zone]`(`planning.ts:18`)과 `ALLOWED_USES`(`:28`) 재사용.
- 레벨업: 이미 건물이 있는 auto lot에서 같은 구역·`level + 1` 타입이 lot에 들어가고 `parcelCompliance`가 통과하며(`far` 여유), 수요 > 0.3, `hash < p_up`이면 `batch [building.remove, building.place]`로 교체(현재 `building.setType` 명령은 없다 — 신규 추가보다 batch 교체를 권장, `commands.ts:33-35`). 사용자가 직접 놓은/수정한 건물은 `auto` 표식이 없어 건드리지 않는다 → **성장 건물에 표식이 필요**: `Building.auto?: true`(선택 필드) 또는 id 접두사 규약(`g-…`). 규약(접두사)이 스키마 변경 없이 가장 싸지만 취약하므로 선택 필드를 권장.
- 쇠퇴/철거: MVP에서는 하지 않는다(범위 밖).

**(f) 도로 편집과의 상호작용**

- A3(필지 재사용) 한계: 도로를 필지 위로 그으면 겹침 → 기존 `segment.add` 검증이 건물 겹침을 막듯이, 필지 겹침은 경고 수준으로 두거나 `pruneFeatures` 방식으로 겹치는 auto 필지를 같은 트랜잭션에서 제거(도로-필지 충돌 정책 결정 필요). 건물이 있는 auto 필지는 건물 철거와 연결해야 하므로 MVP에서는 "필지 겹침은 도로 추가를 거부하지 않고 필지만 제거 + 건물은 기존 도로-건물 충돌 규칙에 위임".
- 건물 → 시민/버스: 새로 성장한 주거·상업 건물은 이미 `designStats`/시민 `reconcileCitizens`(`citizens.ts:283`)가 건물 변경 시 인구·일자리를 재계산하므로 별도 연동 불필요.

### 3.3 변경 요약 (구현 단계 참고)

| 영역 | 변경 | 위치 |
|---|---|---|
| shared | `Parcel.auto?`, `Building.auto?`(선택), `BuildingType.growth?`(선택), `DOC_VERSION` 3→4(필요 시) | `model.ts:236`, `:~135`, `:127`, `:274`, `normalizeDoc :298` |
| shared | `lotsAlongSegment` 순수 함수 + 테스트 | 새 파일 `planning.ts` 또는 `editing/` |
| shared | `growthStep(doc, epoch, rng)` 순수 함수 → `Command[]` (서버·테스트 공용) | 새 파일 |
| server | 룸 타이머 → `growthStep` → 명령 시퀀싱 | `apps/server`(범위 밖, 구현 시) |
| web | 구역 칠하기 도구(도로 클릭 + 측면 + 깊이), 수요 막대(RCI) | 범위 밖 |

`growthStep`을 `shared`의 순수 함수로 두면 서버가 sim에 의존하지 않고(의존 방향 표 준수) 테스트도 문서 입력→명령 출력만으로 가능하다.

### 3.4 위험

- 서버가 명령을 만들면 **서버 부하/악용**: epoch당 건물 수 상한, 룸에 접속자가 없으면 정지, 총 `LIMITS.buildings`·`parcels` 초과 방지 필요.
- 필지 폴리곤이 도로 곡선을 따르지 않고 직사각형이므로 곡선 도로에서는 lot 사이에 틈/겹침이 생긴다 → lot 폭을 작게(8–16 m) 하고 곡률이 큰 구간은 lot 생략.
- 수요 계수는 임의값 → 플레이테스트로 조정 필요(미보정).
- 사용자 의도와 충돌(구역을 칠했는데 건물이 안 생김)을 UI가 설명해야 한다(수요 0, 폭 부족, 규제 위반 사유 표시 — `parcelCompliance` violations 재사용).

---

## 선택지 비교 (종합)

| 주제 | 선택지 | 장점 | 단점 | 사례/근거 |
|---|---|---|---|---|
| 버스 정차 | 고정 10 s(현행) | 단순 | 승객 영향 없음 | `buses.ts:10` |
| 버스 정차 | **기본 + 승·하차 × 시간(문 병렬 max)** | 결정적·단순 | 계수 미보정 | SUMO `boardingDuration`, MATSim 문 병렬 모드 |
| 수단 선택 | **이동시간 비교 + 해시 편향** | RNG 스트림 불변, 설명 가능 | 상수 근사 | 현행 `WALK_MAX` 일반화 |
| 스크램블 | **`approaches: []` 보행 전용 위상** | 기존 WALK 로직 재사용 | 빈 위상 필터 수정, 대각선 형상 | `signals.ts:144-181` |
| 스크램블 | `SignalPhase.crossingIds` | 유연 | 스키마·UI 큼 | ADR 0008 예고 |
| 구역 저장 | **MVP: `Parcel` 재사용, 후속: `ZoneStrip`** | 스키마 최소 | 도로 이동 자동 반영 없음(MVP) | CS1 셀 8 m·깊이 4 |
| 성장 실행 | **서버 GrowthDirector → 명령** | 불변식 1·3 | 서버 코드·상한 필요 | AGENTS.md |

## 권장안 (MVP / 후속)

**MVP (Phase 3b)**
1. 버스: `VehicleType.capacity?`, 정류장 FIFO 대기열, 도착 시 1회 계산 dwell(`T_BASE 10 s` 호환 시작), 승차 거부 시 다음 버스 대기, 버스 소멸 시 승객 `failTrip`, `CitState`에 waiting/riding 추가해 `waitingBus`/`riding` 통계 활성화, 수단 선택을 시간 비교로 일반화(노선 없음 → 기존 결과 불변 회귀 테스트).
2. 스크램블: `IntersectionControl.scramble?`, 독점 모드, degree 3–4만, 보행 전용 위상 + 대각선 crossing(충돌 구역 확장) + PedGraph 대각선 에지.
3. 구역: 도로 접합 lot 생성(`lotsAlongSegment`) → `parcel.upsert` batch(`Parcel.auto`), 서버 `growthStep` 순수 함수 + 룸 타이머, 수요 3식, 규제 검사 통과 시 `building.place`(건물에 `auto` 표식), 레벨업은 batch 교체.

**후속**
- 도보 환승·노선 탐색 고도화, 정류장 만, 혼잡 기반 `v_eff`.
- `SignalPhase.crossingIds`, 병행 스크램블, LPI.
- `ZoneStrip`(도로 편집에 연동), 쇠퇴/철거, 지가(land value) 기반 레벨업, 밀도 3단계.

## 근거 자료 (링크, 미검증 표시)

| 자료 | 링크 | 상태 |
|---|---|---|
| SUMO 차종 속성 정의(personCapacity, boardingDuration, stop duration) | <https://sumo.dlr.de/docs/Definition_of_Vehicles%2C_Vehicle_Types%2C_and_Routes.html> | 열람 확인. 라이선스 EPL-2.0은 미검증 |
| SUMO 메일링 리스트(정차 시간이 승차 인원에 따라 늘어남) | <https://www.eclipse.org/lists/sumo-user/msg12930.html> | 검색 스니펫만, 미열람 |
| MATSim 정류장 승·하차 지연, 문 병렬 모드 | <https://svn.vsp.tu-berlin.de/repos/public-svn/publications/vspwp/2013/13-14/NeumannEtAl2016MindTheGap_submitted_2016-02-05.pdf> | 검색 스니펫만, 미열람. MATSim GPL 여부 미검증 |
| MATSim 혼잡(선형 2.0 s/인) 발표 | <https://www.mos.ed.tum.de/fileadmin/w00ccp/vvs/News_items/Subbaraman_MUM2025_Presentation.pdf> | 슬라이드, 미열람 |
| A/B Street | <https://github.com/a-b-street/abstreet> | Apache-2.0 (검색 결과). 승하차 로직 미확인 |
| FHWA CMF Clearinghouse Barnes Dance | <https://cmfclearinghouse.fhwa.dot.gov/detail.php?facid=4118> | 검색 스니펫만 |
| NYC DOT Barnes Dance 연구 | <https://www.nyc.gov/html/dot/downloads/pdf/barnes-dance-study-sept2017.pdf> | 검색 스니펫만 |
| 서울시 대각선 횡단보도 효과(217곳, 18.4 %) | <https://news.seoul.go.kr/traffic/archives/515739> | 검색 스니펫만 |
| 대각선 횡단보도 어린이보호구역 기준 연구(국회도서관) | <https://dl.nanet.go.kr/detail/KINX2021028077> | 서지 정보만, 수치 미확인 |
| CS1 구역 개발자 일지(깊이 4셀) | <https://admin-forum.paradoxplaza.com/forum/developer-diary/cities-skylines-dev-diary-2-zoning.804803> | 검색 스니펫 확인 수준 |
| CS2 구역 도구 | <https://techraptor.net/gaming/news/cities-skylines-2-developers-discuss-zoning-in-new-in-depth-video> | 스니펫만 |
| CS1 vs CS2 비교(커뮤니티) | <https://www.skool.com/engineer-plays-6981/vanilla-foundations-key-differences-between-cs1-and-cs2> | 2차 출처 |
| 경찰청 교통신호기 설치·관리 매뉴얼(보행 속도, 대각선 기준) | 링크 확보 못함 | **미검증 — 구현 전 직접 확인 필요** |
| MUTCD 보행 정리 속도·LPI | 링크 확보 못함 | **미검증** |
| TCQSM/TCRP 165 정차 시간 | <https://www.trb.org> | **미검증** |
| SimCity 4 RCI·성장 공식 | 링크 없음 | 미검증(일반 지식) |

라이선스 원칙: 위 OSS(SUMO, MATSim, A/B Street)는 개념만 참고하며 코드를 가져오지 않는다. A/B Street(Apache-2.0)는 아이디어 확인용으로 열람할 수 있으나 복사 시 라이선스 고지가 필요하다. SUMO/MATSim 코드는 열람하지 않는다.

## 위험과 미해결 질문

1. 시스템 생성 명령(성장)을 Undo 스택/`by` 표기/활동 로그에서 어떻게 보이게 할지.
2. `CitState`에 waiting/riding을 추가하면 `N_STATES`·스냅샷·HUD·`invariants.test.ts` 모두 영향 → 공개 계약(`types.ts`) 변경이므로 Lead 승인 필요(`packages/sim/AGENTS.md`).
3. 대각선 에지가 교차로 중심을 지나는 것을 ADR 0008의 "중심 통과 금지"와 어떻게 조화할지(예외 명문화 필요 → 새 ADR 권장).
4. 한국 전국 기준의 대각선 횡단보도 설치 수치와 보행속도는 **확인하지 못했다.** 게임 상수(1.0 m/s, WALK 7 s)는 기존 ADR 값을 유지.
5. 수요 계수, `T_BOARD`/`T_ALIGHT`, 수단 선택 상수는 모두 미보정. 보정 방법(시뮬 통계 로그 기반 튜닝)을 정해야 한다.
6. 성장 감독의 주기를 벽시계로 할지, 룸에 연결된 클라이언트의 sim 시계를 서버에 보고시킬지(후자는 서버가 sim을 모르는 현 구조와 충돌).
7. A3(필지 재사용) 선택 시 `Parcel` 50,000 한도와 필지 겹침 검사 비용(`apply.ts:329` O(n) 전수 검사)이 lot이 수천 개일 때 batch 검증 시간에 미치는 영향 — 측정 필요.
8. 사용자가 제작한 스튜디오 건물이 성장 후보가 되어야 하는지(`BuildingType.growth` 태그 정책).
