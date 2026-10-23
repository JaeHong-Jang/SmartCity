**SmartCity 교통 시뮬레이션 설계 보고서 — 리드 오케스트레이터 전달용**

권장 구조는 **차선 기반 미시 시뮬레이션(lane-based microscopic simulation) + 20Hz 고정 틱(fixed tick) + IDM 종방향 운동 + 차선·회전 그래프 A* + 교차로 진입 허가(admission control)**다. 렌더링은 이 결과를 보간하여 60fps로 표시한다.

MVP에서는 자유로운 차선 변경과 비보호 좌회전을 생략한다. 대신 **실제로 주행 가능한 차선 경로, 교차로 내부 경로, 차량 후미 점유, 출구 공간 확보**를 처음부터 구현해야 한다. 이 네 가지를 생략하면 이후 사고·차선 폐쇄·긴급차량 대응을 추가할 때 핵심 구조를 다시 작성하게 된다.

아래에서 실제 사례에 대한 설명은 출처에 근거하며, “권장”으로 제시한 수치·구조·알고리즘 조합은 우리 프로젝트의 설계 제안이다. 성능 수치는 별도 표시가 없으면 측정 결과가 아닌 검증 목표다.

---

**0. 먼저 고정해야 할 시스템 경계**

```text
사용자 도로 편집·운영 명령
          ↓
서버: 검증 → seq/applyTick 부여 → 명령 배포
          ↓
순수 TS 시뮬레이션 코어
  ├─ 네트워크와 운영 제한
  ├─ 경로 탐색
  ├─ 차량·교차로·버스
  ├─ 이벤트와 통계
  └─ 체크포인트·상태 해시
          ↓
Web Worker: 고정 틱 실행·스냅샷 생성
          ↓
메인 스레드: 보간·Three.js 인스턴싱·UI
```

**서버가 명령 순서만 정하는 것으로는 동기화가 완성되지 않는다.** 같은 순서라도 서로 다른 틱에 적용하거나, 탐색 결과를 CPU 속도에 따라 다른 시점에 반영하면 상태가 달라진다.

```ts
interface CommandEnvelope {
  seq: number;
  applyTick: number;
  commandId: string;
  authorId: string;
  expectedRevision?: number;
  payload: CityCommand;
}
```

권장 계약은 다음과 같다.

- 모든 명령은 `(applyTick, seq)` 순서로 적용한다.
- 서버는 해당 틱의 명령 목록이 확정되었음을 알리는 워터마크(watermark)를 보낸다.
- 확정되지 않은 틱으로 클라이언트가 임의 진행하지 않는다.
- 같은 코어를 서버에서도 실행하여 기준 체크포인트(authoritative checkpoint)를 만든다.
- 늦게 접속한 사용자는 체크포인트와 이후 명령 로그로 합류한다.
- 체크포인트에는 차량 위치뿐 아니라 난수 상태, 탐색 작업, 신호, 예약, 이벤트 큐도 포함한다.

서버 시뮬레이션을 MVP에서 제외한다면 그 한계를 명시해야 한다. 상태 해시로 불일치는 발견할 수 있어도, 명령 중계 서버만으로는 어느 클라이언트의 상태가 옳은지 판정하기 어렵다.

---

**1. 도로 네트워크 데이터 모델**

**(a) 실제 사례와 표준 접근**

A/B Street는 도로(road), 차선(lane), 교차로(intersection), 회전(turn)을 구분한다. 회전은 특정 진입 차선을 특정 출구 차선에 연결한다. CityFlow도 도로 간 연결인 `roadLink`와 차선 간 경로인 `laneLink`를 별도로 표현한다. [A/B Street 지도 모델](https://a-b-street.github.io/docs/tech/map/details.html), [CityFlow 도로망 형식](https://cityflow.readthedocs.io/en/latest/roadnet.html)

SUMO 역시 도로·차선·연결(connection)을 구분하고, 교차로 안쪽의 주행을 내부 차선(internal lane)으로 모델링한다. [SUMO 도로망](https://sumo.dlr.de/docs/Networks/SUMO_Road_Networks.html)

**(b) 접근별 장단점**

| 접근 | 장점 | 단점 |
|---|---|---|
| 도로 중심선 그래프만 사용 | 편집·탐색이 단순함 | 전용차선·회전 제한·부분 폐쇄를 정확히 표현하기 어려움 |
| 차선·회전 그래프 | 실제 주행 가능성을 검증할 수 있음 | 교차로 생성과 경로 탐색이 복잡해짐 |
| 모든 도로를 자유 공간으로 표현 | 임의 주행과 복잡한 형상을 표현 가능 | 충돌 회피·경로 계획 비용이 커서 도시 건설 MVP에 과함 |

**(c) MVP 권장안**

편집용 모델(authoring model)과 실행용 모델(runtime model)을 분리한다.

- 편집용: 노드, 양방향 도로 세그먼트, 베지어 제어점, 도로 단면.
- 실행용: 방향이 있는 차선, 차선별 길이 표, 회전 연결, 정지선, 충돌 관계.
- 도로 메시(mesh)는 이 모델에서 생성하는 표시 결과로 취급한다.
- 메시의 정점이나 Three.js 객체를 시뮬레이션의 기준 데이터로 사용하지 않는다.

**(d) 핵심 자료구조**

```ts
type EntityId = number;
type ModeMask = number;

interface RoadNode {
  id: EntityId;
  xMm: number;
  yMm: number; // 지도 평면
  zMm: number; // 고도
  level: number;
  junctionId?: EntityId;
}

interface RoadSegment {
  id: EntityId;
  revision: number;
  fromNode: EntityId;
  toNode: EntityId;
  centerline: CubicBezierMm;
  roadTypeId: EntityId;
  laneIds: EntityId[];
}

interface Lane {
  id: EntityId;
  segmentId: EntityId;
  direction: 1 | -1;
  lateralIndex: number;
  widthMm: number;
  lengthMm: number;
  speedLimitMmps: number;
  allowedModes: ModeMask;
  pathGeometryId: EntityId;
}

interface LaneConnector {
  id: EntityId;
  junctionId: EntityId;
  fromLane: EntityId;
  toLane: EntityId;
  turn: "LEFT" | "STRAIGHT" | "RIGHT" | "UTURN";
  pathGeometryId: EntityId;
  lengthMm: number;
  allowedModes: ModeMask;
  signalGroupId?: EntityId;
}
```

`LaneConnector`도 길이와 경로를 가진 주행 구간(drivable path)이다. 차량은 `차선 → 연결 → 차선` 순서로 움직인다.

공개 식별자(stable ID)와 TypedArray의 밀집 인덱스(dense index)는 분리한다. 배열 압축이나 슬롯 재사용으로 저장 파일·명령·경로의 참조가 바뀌면 안 된다.

**곡선 도로와 호 길이(arc length)**

3차 베지어(cubic Bézier)를 편집 기준으로 사용한다.

\[
B(t)=(1-t)^3P_0+3(1-t)^2tP_1+3(1-t)t^2P_2+t^3P_3
\]

차량 위치는 매개변수 \(t\)가 아니라 실제 거리 \(s\)로 저장한다.

\[
s(t)=\int_0^t \|B'(u)\|\,du
\]

실행 시 적분하지 않고 도로 생성 시 누적 길이 룩업 테이블(LUT)을 만든다.

```ts
interface PathGeometry {
  xMm: Int32Array;
  yMm: Int32Array;
  zMm: Int32Array;
  cumulativeMm: Int32Array;
}
```

`sampleAtS(s)`는 누적 길이 배열을 검색하고 인접 표본을 보간한다.

차선 중심선은 도로 중심선을 횡방향으로 이동시켜 생성한다.

\[
L(s)=C(s)+dN(s)
\]

다만 곡선의 오프셋(offset)은 일반적으로 원래 베지어와 같은 형태의 정확한 베지어가 아니다. **차선별 표본 경로와 길이를 따로 계산**해야 한다. 급커브에서는 차선 경로의 자기 교차, 중앙분리대 침범, 최소 회전 반경을 검사한다.

MVP는 평면 도로로 시작하되 `zMm`, `level` 필드는 둔다. 향후 고가·지하 도로가 평면상 교차해도 자동 연결되지 않도록 한다.

**세그먼트 분할(segment splitting)**

기존 도로 중간에 연결하는 작업은 하나의 원자적 트랜잭션(atomic transaction)이어야 한다.

```text
연결 위치 결정
→ 기존 세그먼트 분할
→ 새 노드 생성
→ 차선 재생성
→ 교차로 영역·정지선 생성
→ 연결 경로·충돌표 생성
→ 차량·정류장·경로 참조 이관
→ 한 틱 경계에서 일괄 반영
```

베지어는 드 카스텔조(de Casteljau) 알고리즘으로 분할한다. 분할점 \(u\)에서:

```text
A = lerp(P0, P1, u)
B = lerp(P1, P2, u)
C = lerp(P2, P3, u)
D = lerp(A, B, u)
E = lerp(B, C, u)
F = lerp(D, E, u)

왼쪽 곡선 = [P0, A, D, F]
오른쪽 곡선 = [F, E, C, P3]
```

실행 중인 도시에서는 추가 처리가 필요하다.

- 새 교차로가 차지할 영역으로 차량 진입을 먼저 차단한다.
- 해당 영역에서 차량 후미까지 빠져나온 후 적용한다.
- 영역 밖 차량은 기존 차선의 거리 대응표로 새 차선에 이관한다.
- 정류장·사고 위치·예약·경로 참조도 함께 갱신한다.
- 안전한 적용 조건을 만들지 못하면 편집을 보류하거나 실패 처리한다.

**새 차선의 \(s\)를 세그먼트 길이 비율만으로 계산하면 안 된다.** 교차로 때문에 끝부분이 잘리고, 안쪽·바깥쪽 차선의 길이가 다르기 때문이다. 기존 곡선 구간과 새 차선의 호 길이를 연결하는 매핑이 필요하다.

동시 편집은 `expectedRevision`으로 검증한다. 먼저 처리된 명령이 세그먼트를 분할했다면 뒤 명령은 기존 참조를 무조건 적용하지 않고, 재해석 가능한 경우에만 변환하고 나머지는 충돌 결과를 반환한다.

**교차로 자동 생성 규칙**

MVP에서는 우측통행(right-hand traffic)을 고정한다.

1. 같은 높이·레벨의 도로만 연결 후보로 본다.
2. 진입 도로를 접선 방향 기준으로 정렬한다.
3. 도로 폭과 각도로 교차로 경계를 생성하고 차선 끝을 정지선까지 자른다.
4. 진입·출구 방향, 차량 모드, 회전 제한으로 연결 후보를 만든다.
5. 후보마다 내부 경로와 충돌 관계를 생성한다.
6. 유효한 연결만으로 신호 계획을 만든다.

세부 기본값:

- U턴은 기본 금지.
- 편집 형상이 정상적인 2방향 연속 도로라면 신호 없는 연결로 처리.
- 3·4지 교차로를 MVP 지원 범위로 제한.
- 과도하게 짧은 세그먼트, 예각 접속, 교차로 영역 중첩은 거부.
- 차선 번호를 무조건 일대일 대응시키지 않고 회전 방향과 단면을 함께 사용.
- 4차선은 **왕복 총 4개 주행 차선**, 2차선은 **왕복 총 2개**로 명확히 정의.

**도로 타입(road type)**

```ts
interface LaneSpec {
  direction: 1 | -1;
  widthMm: number;
  allowedModes: ModeMask;
  permittedTurns: number;
}

interface RoadType {
  id: EntityId;
  lanes: LaneSpec[];
  medianWidthMm: number;
  speedLimitMmps: number;
}
```

지원 프리셋은 왕복 2차선, 왕복 4차선, 일방통행, 버스전용차선이다. 버스전용 여부를 색상이나 도로 이름에서 추론하지 말고 모드 비트마스크(mode bitmask)로 검사한다.

**고정밀 좌표와 스냅(snapping)**

- 저장·명령 좌표: 밀리미터 정수.
- 편집 미리보기: Float64 계산 가능.
- GPU 좌표: 카메라 주변 원점 기준 Float32.
- 스냅 후보 검색: 공간 인덱스.
- 선택 순서: 노드 → 세그먼트 투영점 → 격자.
- 동률 처리: 거리 → 대상 종류 → 안정적 ID.

스냅 반경은 화면 픽셀을 월드 거리로 변환하되 상·하한을 둔다. 최종 명령에는 스냅 대상 ID와 확정 위치를 넣어 클라이언트마다 스냅 결과를 다시 판단하지 않게 한다.

후속 단계에서는 입체 교차, 가변 폭, 테이퍼(taper), 회전차선 포켓, 수동 차선 연결 편집을 추가한다.

---

**2. 차량 운동 모델**

**(a) 실제 사례와 표준 접근**

IDM은 앞차와의 간격·상대 속도로 가속도를 계산하는 차량 추종 모델(car-following model)이다. 반면 A/B Street는 이산 이벤트(discrete event)와 차선 대기열 중심 모델을 사용한다. **A/B Street가 IDM 기반이라고 가정해서는 안 된다.** [IDM 설명](https://traffic-simulation.de/info/info_IDM.html), [A/B Street 시뮬레이션 설명](https://a-b-street.github.io/docs/tech/trafficsim/discrete_event/index.html)

**(b) 장단점**

| 모델 | 장점 | 단점 |
|---|---|---|
| IDM 고정 틱 | 가감속·정체파·느린 차량 영향이 자연스럽게 나타남 | 수치 적분과 안전 보정 필요 |
| 이벤트·대기열 | 불필요한 갱신을 줄이기 좋음 | 연속 가감속과 복잡한 점유 관계를 별도로 처리 |
| 링크 단위 대기열 | 대도시 수요 분석에 유리 | 보이는 차량의 세부 움직임을 표현하기 어려움 |

**(c) MVP 권장안**

IDM을 20Hz로 실행한다. 차량은 경로 위 앞 범퍼(front bumper)의 거리 \(s\), 속도 \(v\), 차량 길이를 가진다.

```ts
interface VehicleLogicalState {
  pathId: EntityId;  // lane 또는 connector
  sMm: number;      // 앞 범퍼 위치
  speedMmps: number;
  vehicleTypeId: EntityId;
  routeId: EntityId;
  routeCursor: number;
}
```

**(d) IDM 수식과 초기 파라미터**

앞차와의 순 간격을 \(g\), 상대 속도를 \(\Delta v=v-v_l\)라 하면:

\[
\dot v=a\left[
1-\left(\frac{v}{v_0}\right)^\delta
-\left(\frac{g^*}{g}\right)^2
\right]
\]

\[
g^*=g_0+\max\left(
0,\;vT+\frac{v\Delta v}{2\sqrt{ab}}
\right)
\]

- \(v_0\): 희망 속도(desired speed)
- \(T\): 희망 시간 간격(time headway)
- \(g_0\): 정지 간격(minimum gap)
- \(a\): 가속도 계수
- \(b\): 편안한 감속도(comfortable deceleration)
- \(\delta\): 가속 지수

다음은 **우리 MVP의 초기 튜닝값**이다. 보편 표준이나 실측 보정값으로 취급하지 않는다.

| 파라미터 | 승용차(car) | 버스(bus) | 트럭(truck) |
|---|---:|---:|---:|
| 길이 | 4.5m | 12m | 10m |
| 차량 희망 최고속도 | 50km/h | 45km/h | 45km/h |
| \(T\) | 1.5s | 2.0s | 1.8s |
| \(g_0\) | 2.0m | 2.5m | 2.5m |
| \(a\) | 1.5m/s² | 0.8m/s² | 0.7m/s² |
| \(b\) | 2.0m/s² | 1.5m/s² | 1.5m/s² |
| \(\delta\) | 4 | 4 | 4 |
| 비상 감속 상한 | 8m/s² | 5m/s² | 5m/s² |

실제 목표 속도는 다음 최솟값이다.

\[
v_0^{effective}
=\min(v_{type},v_{lane},v_{curve},v_{incident})
\]

곡률 \(\kappa\)에 따른 제한은 다음처럼 둘 수 있다.

\[
v_{curve}
=\sqrt{\frac{a_{lat,max}}{\max(|\kappa|,\epsilon)}}
\]

**속도 제한이 낮아지는 위치를 미리 보도록 해야 한다.** 교차로 연결에 진입한 뒤에야 회전 제한 속도를 적용하면 정지선에서 급감속한다.

**적분과 안전 처리**

고정 간격은 \(\Delta t=0.05s\)다. 기본 적분은 등가속도(ballistic) 방식으로 한다.

\[
v'=v+\dot v\Delta t
\]

\[
s'=s+v\Delta t+\frac12\dot v\Delta t^2
\]

틱 도중 정지한다면 음수 속도로 계속 적분하지 않는다.

\[
t_{stop}=-v/\dot v
\]

\(0<t_{stop}<\Delta t\)이면 정지 시점까지만 이동하고 남은 시간은 정지한다.

안전 처리는 별도 계층으로 둔다.

- \(g\)의 분모 하한 설정.
- IDM 가속도에 차량별 감속 상한 적용.
- 앞차·정지선·폐쇄 지점을 넘지 않는 위치 제한.
- 같은 차선의 추월 금지.
- 진입 허가 없이 다음 경로로 넘어가지 못하도록 제한.
- 한 틱에 여러 짧은 경로를 지나는 경우 잔여 거리를 순차 소비.

차량 추종에 사용하는 앞차는 현재 차선에만 있는 것이 아니다. 허용된 다음 연결이나 출구 차선에 앞차가 있으면 경로를 따라 간격을 계산해야 한다.

적색 신호와 진입 불허는 정지선에 있는 가상 정지 장애물(virtual obstacle)로 표현할 수 있다. 이는 IDM에서 사용하는 일반적인 확장 방식이다. [IDM 적분·정지선 처리](https://traffic-simulation.de/info/info_IDM.html)

안전 보정으로 겹침을 막았다고 운동 모델이 적절한 것은 아니다. 보정 횟수와 초과 거리를 계측하여 자주 발생하면 적분·예측·진입 제어를 수정한다.

**교차로 내부 경로와 차량 후미**

연결 경로에서도 동일한 \(s,v\) 모델을 사용한다. 차량 앞부분이 다음 차선에 들어갔어도 후미가 교차로 안에 남을 수 있다.

따라서 차량의 길이만큼 이전 경로를 추적하는 점유 이력(occupancy trail)이 필요하다.

```ts
interface PathOccupancy {
  pathId: EntityId;
  rearSMm: number;
  frontSMm: number;
}
```

특히 긴 버스가 짧은 연결과 짧은 차선을 동시에 걸칠 수 있으므로 “이전 구간 하나만 기억”하는 구조에 의존하지 않는다.

**MOBIL과 차선 변경**

MOBIL은 다음 두 조건을 결합한다.

안전 조건:

\[
a'_{newFollower}\ge -b_{safe}
\]

유인 조건:

\[
\Delta a_{ego}
+p(\Delta a_{oldFollower}+\Delta a_{newFollower})
>a_{threshold}
\]

\(p\)는 예의 계수(politeness factor)다. [MOBIL 모델](https://traffic-simulation.de/info/info_MOBIL.html)

**MVP에서는 주행 중 차선 변경을 생략해도 된다. 단, 경로 탐색도 그 제약을 따라야 한다.**

- 경로는 처음부터 끝까지 유효한 차선·연결의 연속이어야 한다.
- 도로 진입 시 선택한 차선에서 필요한 다음 회전을 할 수 있어야 한다.
- 정류장에 도달할 수 있는 버스 차선을 경로에 포함한다.
- 한 차선만 막히면 그 차선 차량은 기다리거나 상류에서 우회한다.
- 옆 차선으로 순간 이동시키지 않는다.

단점은 편중된 차선 이용과 제한적인 사고 회피다. 따라서 후속 단계는 **필수 차선 변경(mandatory lane change) → MOBIL 기반 선택적 추월(discretionary lane change)** 순으로 권장한다. 차선 변경 중에는 두 차선 모두에 점유가 존재해야 한다.

**결정성(determinism)**

권장 구현 규약:

1. 틱·타이머는 정수.
2. 거리·속도는 정수 단위와 명시적 반올림 규칙 사용.
3. IDM은 고정소수점(fixed-point) 연산으로 계산.
4. \(\delta=4\)는 거듭제곱 함수 대신 곱셈으로 계산.
5. 제곱근·기하 계산은 결정적 구현 또는 정규화된 결과 표 사용.
6. 모든 동률은 안정적 ID로 해소.
7. 난수는 시드가 있는 PRNG 사용.
8. 차량·사고·수요 난수 스트림을 분리.
9. 이전 상태에서 의도를 계산한 뒤 충돌을 해결하고 다음 상태를 일괄 확정.
10. 브라우저별 재생 해시를 비교.

정수 저장만으로 충분하지 않다. 중간 곱셈이 `Number.MAX_SAFE_INTEGER`를 넘지 않도록 단위와 계산 순서를 설계해야 한다. 고정소수점 나눗셈·반올림·포화(saturation)는 공통 유틸리티로 구현한다.

`Float64 + Math 함수 + 마지막 반올림`을 교차 브라우저 비트 결정성의 보증으로 삼지 않는다. ECMAScript의 일부 수학 함수는 구현 근삿값(implementation-approximated)을 허용한다. [ECMAScript 수학 함수 규정](https://tc39.es/ecma262/2023/multipage/numbers-and-dates.html)

---

**3. 경로 탐색(pathfinding)**

**(a) 실제 사례와 표준 접근**

Citybound 개발자는 모든 쌍 최단경로(all-pairs shortest path)의 메모리·사전 계산·도로 변경 비용 때문에 **A*와 경로 캐시**로 전환한 사례를 설명한다. 동적으로 도로를 건설하는 우리 프로젝트와 직접 관련된다. [Citybound 경로 탐색 설계](https://aeplay.org/citybound-devblog/the-road-to-alpha-week-1-a-slow-start)

SUMO는 차량별 재탐색과 일시적 도로·차선 제한을 지원한다. Cities: Skylines II의 공개 설계는 시간 등 여러 비용과 도중 사건에 따른 경로 조정을 설명한다. 다만 이 문서로 내부 알고리즘이나 자료구조까지 확정할 수는 없다. [SUMO 라우팅](https://sumo.dlr.de/docs/Simulation/Routing.html), [Cities: Skylines II Traffic AI](https://www.paradoxinteractive.com/games/cities-skylines-ii/features/traffic-ai)

**(b) 장단점**

| 접근 | 장점 | 단점 |
|---|---|---|
| Dijkstra | 구현과 정답 검증이 쉬움 | 목적지가 하나일 때 탐색 범위가 넓음 |
| A* | 하한 휴리스틱으로 탐색량 감소 | 휴리스틱의 허용성(admissibility) 관리 필요 |
| 모든 쌍 사전 계산 | 조회가 빠름 | 도로 편집과 차선 제한 변경에 취약 |
| 도로 수준 탐색 후 차선 보정 | 그래프가 작음 | 보정 단계에서 실제로 주행 불가능한 경로가 드러날 수 있음 |

**(c) MVP 권장안**

- 차선을 정점으로, 합법적 연결을 간선으로 보는 **차선 그래프 A***.
- 반환 결과는 구체적인 `LaneId/ConnectorId` 배열.
- 이진 힙(binary heap) 사용.
- 동률은 `(f, g, laneId)`처럼 완전히 정의된 순서로 처리.
- 탐색 중에는 하나의 불변 비용 스냅샷(cost snapshot)을 사용.
- 비교·디버깅용으로 Dijkstra도 유지.

**(d) 비용과 휴리스틱**

\[
c(l\rightarrow l')=
\frac{L_l}{v_l^{free}}
+t_{connector}
+\widehat d_{queue}
+p_{turn}
+p_{restriction}
\]

단위는 모두 시간으로 통일한다. 혼잡과 회전 페널티는 음수가 되지 않게 한다. 폐쇄 차선은 매우 큰 비용을 주기보다 탐색 대상에서 제외한다.

혼잡 추정은 즉시 속도를 그대로 쓰지 않고 지수이동평균(EWMA)으로 완화한다.

\[
\widehat t_e^{k+1}
=(1-\alpha)\widehat t_e^k+\alpha t_e^{observed}
\]

첫 구현에서는 자유 주행 시간과 정지 대기열을 사용한다.

\[
\widehat t_e
=\frac{L_e}{v_e^{free}}
+\frac{N_e^{queued}}{\mu_e}
\]

여기서 \(\mu_e\)는 예상 방출률(discharge rate)이다. 이후 실제 구간 통과 시간으로 보정한다. 동일한 대기시간을 관측 통행시간과 별도 대기열 항에 이중 반영하지 않는다.

A* 휴리스틱은 다음처럼 보수적으로 둔다.

\[
h(n)=\frac{\|p_n-p_{goal}\|}{v_{max,network}}
\]

정점 위치와 비용에 포함된 구간의 시작·끝 정의를 일치시켜야 한다. 정수 시간으로 양자화할 때 휴리스틱은 아래로, 이동 비용은 보수적으로 반올림하여 하한 성질을 보존한다. 확신이 없으면 \(h=0\), 즉 Dijkstra로 검증한다.

**캐시(cache)**

```ts
interface RouteCacheKey {
  startLaneId: EntityId;
  destinationAccessId: EntityId;
  vehicleClass: number;
  topologyEpoch: number;
  restrictionEpoch: number;
  costEpoch: number;
}
```

- 차량 클래스마다 버스전용·중량 제한이 다르므로 키에 포함.
- 목적지는 건물 중심점보다 실제 접근 차선(access lane)으로 정의.
- 정적 경로 유효성과 혼잡 비용의 신선도는 구분.
- 첫 버전은 전역 epoch로 단순 무효화.
- 후속 단계는 변경된 차선·구간에 의존하는 캐시만 무효화.
- LRU 같은 제한된 캐시 사용.

같은 출발·목적지의 요청은 하나의 탐색 결과를 공유한다. 단, 혼잡을 반영해 차선을 분산시키려면 동일 경로 캐시만으로는 부족하므로 이후 복수 후보 경로와 결정적 배분을 추가한다.

**재탐색(rerouting) 시점**

필수 재탐색:

- 남은 경로에 폐쇄·삭제·진입 제한이 발생.
- 목적지 접근 차선이 바뀜.
- 기존 경로를 물리적으로 계속 주행할 수 없음.

선택적 재탐색:

- 장시간 정지.
- 기존 예상 시간 대비 충분한 개선 가능성.
- 이전 재탐색 이후 쿨다운 경과.

초기값 예시:

- 혼잡 비용 갱신: 1초마다.
- 재탐색 쿨다운: 15초.
- 경로 변경: 15%이면서 10초 이상 개선될 때.

이 값들은 튜닝 대상이다. 차량별 검사 틱을 ID로 분산해 한 틱에 모든 차량이 검사하지 않게 한다. 이미 교차로 안에 들어간 차량은 현재 연결을 바꾸지 않고 다음 안전한 경계부터 새 경로를 적용한다.

**틱당 예산**

결정적 실행에서는 “2ms가 지날 때까지 탐색”을 사용하지 않는다. 컴퓨터마다 완료 시점이 달라진다.

```ts
const MAX_EXPANSIONS_PER_TICK = 5_000; // 초기 튜닝값
const QUANTUM = 128;

function processRoutingJobs() {
  let remaining = MAX_EXPANSIONS_PER_TICK;

  while (remaining > 0 && hasPendingJobs()) {
    const job = pickDeterministically();
    const used = job.expand(Math.min(QUANTUM, remaining));
    remaining -= used;
    finalizeOrRequeue(job);
  }
}
```

예산은 확장 정점 수 또는 간선 완화 횟수로 정의한다. 우선순위는 긴급 임무, 무효 경로, 일반 출발, 혼잡 최적화 순으로 두되 오래 기다린 요청의 우선순위를 올려 기아(starvation)를 막는다.

탐색 작업은 자신이 시작한 비용 스냅샷을 유지한다. 완료 시 현재 폐쇄 상태를 다시 검증한다. 대기 차량은 안전한 위치에 정지하며, 잘못된 경로로 출발하지 않는다.

**폐쇄 대응**

1. 해당 차선·연결의 신규 진입을 차단.
2. 영향받는 경로를 무효화 표시.
3. 필수 재탐색 큐에 등록.
4. 현재 구간을 나갈 수 있으면 안전한 출구까지 진행.
5. 출구가 없으면 대기 상태와 재시도 시점 기록.
6. 불가피한 제거·견인은 명시적 이벤트로 처리.

후속 단계는 도로 수준 상위 탐색과 차선 수준 하위 탐색의 계층화(hierarchical routing), 공통 목적지 역방향 탐색, 대규모 작업 전용 워커다. 도로가 자주 바뀌는 MVP에서 정적 도로망용 전처리 기법부터 도입할 필요는 없다.

---

**4. 교차로 제어와 신호 체계**

**(a) 실제 사례와 표준 접근**

SUMO는 신호가 차선 자체보다 **차선 간 연결(link)** 을 제어한다고 설명한다. 우선권이 있는 녹색과 양보가 필요한 녹색도 구분한다. 내부 차선을 사용하면 교차로 안의 대기와 점유를 표현할 수 있다. [SUMO 신호 체계](https://sumo.dlr.de/docs/Simulation/Traffic_Lights.html), [SUMO 교차로 모델](https://sumo.dlr.de/docs/Simulation/Intersections.html)

**(b) 장단점**

| 접근 | 장점 | 단점 |
|---|---|---|
| 고정 주기(fixed-time) | 단순하고 재현 가능 | 방향별 수요 변화에 둔감 |
| 감응식(actuated) | 적은 구현 비용으로 빈 녹색 시간 감소 | 검지·최소 녹색·최대 대기 규칙 필요 |
| 적응형(adaptive) | 도시 전체 운영 최적화 가능 | 안정성·관측·평가 설계가 필요 |
| 교차로 전체 단일 잠금 | 안전 검증이 쉬움 | 병렬 통과가 사라져 처리량이 지나치게 낮음 |
| 충돌 관계 기반 진입 | 비충돌 이동을 함께 허용 | 연결 생성과 점유 관리가 중요 |

**(c) MVP 권장안**

- 고정 주기 신호.
- 보호 회전(protected movement) 중심.
- 비보호 좌회전과 적색 우회전은 생략.
- 모든 차량에 출구 공간 확인 적용.
- 연결별 충돌 행렬(conflict matrix)과 보수적 예약 사용.
- 신호 제어기(controller)와 안전 검사기를 분리.

**(d) 핵심 자료구조**

```ts
interface SignalStage {
  id: EntityId;
  protectedConnectorIds: EntityId[];
  permissiveConnectorIds: EntityId[]; // MVP는 비어 있음
  greenTicks: number;
  minGreenTicks: number;
  maxGreenTicks: number;
  yellowTicks: number;
  allRedTicks: number;
  nextStageIds: EntityId[];
}

interface JunctionRuntime {
  stageId: EntityId;
  state: "GREEN" | "YELLOW" | "ALL_RED";
  elapsedTicks: number;
  activeConnectorCounts: Uint16Array;
  waitingRequests: EntryRequest[];
}
```

여기서 `SignalStage`는 동시에 허용하는 이동 집합이다. 미국식 링·배리어(ring-barrier)의 개별 현시(phase)와 용어를 혼용하지 않는다.

MVP는 하나의 상태 기계로 충분하다. 후속 단계에서는 두 링이 배리어에서 동기화되는 제어기를 만들고, 그 결과를 같은 `허용 연결 집합`으로 변환한다. 차량 코드를 다시 작성할 필요가 없다.

**자동 신호 계획**

차선 변경을 생략하면 공유 차선(shared lane)에서 회전 대기 차량이 직진을 막을 수 있다. 기본 계획은 이를 감안해야 한다.

- 일반적인 공유 차선 4지 교차로: **진입 방향별 순차 녹색**을 기본값으로 사용.
- 좌회전 전용차선이 있는 교차로: 직진·우회전 그룹과 보호 좌회전 그룹을 분리 가능.
- 모든 동시 허용 그룹은 생성된 충돌 관계로 검증.
- 복잡한 형상에서 검증 실패 시 더 작은 비충돌 그룹으로 분할.

진입 방향별 제어는 처리량이 낮지만 MVP에서 이해·디버깅이 쉽다. 교차로 전체에서 한 대씩만 통과시키는 방식과 달리, 같은 흐름의 차량은 간격을 유지하며 연속 통과할 수 있다.

초기 신호 시간은 예를 들어 녹색 15초, 황색 3초, 전적색 1초에서 시작할 수 있다. 다만 교차로 폭과 접근 속도에 따라 조정해야 하며, **전적색 시간이 지났다는 이유로 아직 점유 중인 교차 이동을 허용해서는 안 된다.**

황색은 정지 가능한 차량은 정지시키고, 이미 안전하게 멈추기 어려운 차량은 허가를 유지하여 통과시키는 방식이 바람직하다. 결정 시점과 기준을 고정하고 `committed` 상태로 기록한다.

**충돌 행렬(conflict matrix)**

연결 \(i,j\)의 차량 통과 영역(swept envelope)이 겹치거나 같은 출구에 합류하면 충돌 관계를 가진다.

\[
C_{ij}=
\begin{cases}
1 & \text{동시 점유가 위험한 연결}\\
0 & \text{그 외}
\end{cases}
\]

생성 시 다음을 고려한다.

- 경로 중심선 교차.
- 차량 폭과 안전 여유를 포함한 영역 겹침.
- 같은 출구 차선으로의 합류.
- 긴 차량의 회전 중 차체 침범.
- 향후 횡단보도와의 충돌.

폭이나 회전 반경이 지원 범위를 넘는 차량은 금지하거나 충돌표를 다시 생성한다.

교차로별 연결 수가 적으므로 비트셋(bitset)이 적합하다. JavaScript 비트 연산은 32비트이므로 32개 초과 연결은 여러 `Uint32` 워드로 처리한다.

**MVP 예약(reservation)**

정밀한 미래 시간표 예약보다 다음의 현재 점유 기반 규칙을 권장한다.

```text
허용 신호·우선권 확인
AND 교차하는 연결의 점유 없음
AND 출구 차선의 진입 공간 확보
AND 합류 충돌 없음
→ 진입 허가와 출구 공간을 원자적으로 예약
```

동일 연결을 따라가는 차량은 IDM으로 간격을 유지하며 통과할 수 있다. 해당 연결의 점유 카운트가 0이 되기 전까지 충돌 연결의 진입을 막는다.

잠금 해제는 차량 앞부분이 아니라 **후미가 충돌 영역을 벗어난 시점**에 한다. 예상 통과 시간이 지났다는 이유만으로 해제하지 않는다. 사고 차량이 멈춰 있으면 예약도 유지되어야 한다.

이 방식은 교차로 공간을 다소 보수적으로 사용한다. 후속 단계는 충돌 구역(conflict zone)별 점유와 시간창(time-window) 예약으로 세분화한다.

**비신호 교차로**

MVP는 정지 표지(STOP)와 명시적 주도로·부도로 우선권을 사용한다. 우측 우선(priority to the right)은 지역별 규칙 프리셋으로 나중에 추가한다.

```text
완전 정지 확인
→ 선행 우선권 요구 확인
→ 대기 순서 결정
→ 충돌·출구 검사
→ 통과
```

동률은 도착 틱, 접근 순서, 차량 ID로 해소한다. 우측 우선을 추가할 때는 네 방향 차량이 모두 서로를 기다리는 순환 상황에 대한 타이브레이커가 반드시 필요하다.

현재 교차로 안에 차량이 없다는 조건만으로 부도로 차량을 통과시키면, 빠르게 접근하는 주도로 차량과 충돌할 수 있다. 접근 차량의 예상 도착시간도 확인한다.

\[
TTC_{priority}>t_{clear,minor}+t_{margin}
\]

첫 버전에서는 보수적인 접근 구역 검사를 사용해도 된다.

**그리드락(gridlock) 방지**

가장 중요한 규칙은 **출구 공간 없는 진입을 금지**하는 것이다.

\[
S_{entryFree}-S_{reserved}
\ge L_{vehicle}+g_0
\]

전체 차선의 빈 공간이 아니라 **입구부터 실제로 진입 가능한 연속 공간**을 검사해야 한다. 여러 차량이 같은 빈 공간을 동시에 보고 들어가지 못하도록 출구 공간 예약을 원자적으로 처리한다.

이 규칙은 교차로를 막는 상황을 줄이지만, 도로망 전체의 순환 교착(deadlock)을 완전히 없애지는 못한다. 다음도 필요하다.

- 생성 지점에서 차량을 무제한 밀어 넣지 않기.
- 짧은 순환 도로의 과밀 유입 제한.
- 대기 의존 관계와 장시간 정지 감지.
- 명시적인 견인·운영 개입.
- 생성·도착·대기·제거 차량 수를 구분한 보존 통계.

**감응 신호와 적응형 신호**

SUMO는 차량 통과 간격에 따라 녹색을 연장하는 감응 제어와 최소·최대 녹색 시간을 지원한다. [SUMO 감응 제어](https://sumo.dlr.de/docs/Simulation/Traffic_Lights.html#type-actuated)

우리 확장 순서는 다음이 적합하다.

1. 고정 주기.
2. 검지 수요에 따른 녹색 연장·빈 단계 생략.
3. 최대압력(max-pressure) 기반 선택.
4. 인접 교차로 협조와 정책 최적화.
5. 필요할 때 강화학습(reinforcement learning).

최대압력의 기본적인 이동 압력은 다음처럼 구성할 수 있다.

\[
P_{ij}=q_{ij}-\sum_k r_{jk}q_{jk}
\]

\[
p^*=\arg\max_{p\in SafeStages}
\sum_{(i,j)\in p}\mu_{ij}P_{ij}
\]

다만 유한한 도로 저장 용량을 무시하면 정체 전파에 문제가 생긴다. 출구 포화도와 진입 가능 공간을 별도 제약으로 둬야 한다. [유한 용량을 고려한 역압 제어 연구](https://arxiv.org/abs/1309.6484)

어떤 제어기도 최소 녹색, 황색, 전적색, 충돌 배제, 최대 대기를 직접 무시할 수 없도록 한다. AI는 다음 허용 단계를 제안하고, 안전 상태 기계가 실제 전환을 수행한다.

---

**5. 대중교통: 버스**

**(a) 실제 사례와 표준 접근**

SUMO는 정류장을 차선 위 구간으로 정의하고, 차량의 노선에 정차 지점과 정차시간을 추가한다. 고정 시간표에서는 최소 정차시간과 출발 가능 시각을 구분한다. [SUMO 대중교통](https://sumo.dlr.de/docs/Simulation/Public_Transport.html)

**(b) 장단점**

| 접근 | 장점 | 단점 |
|---|---|---|
| 정류장 목록만 저장 후 구간별 탐색 | 편집이 간단함 | 목록이 실제로 연결되는지 검증 필요 |
| 모든 경로를 고정 저장 | 운행이 안정적 | 도로 편집·폐쇄 시 복구 필요 |
| 개별 승객까지 시뮬레이션 | 수송 효과를 정밀하게 분석 | 보행·환승·수요 모델로 범위가 커짐 |

**(c) MVP 권장안**

- 방향이 있는 정류장 목록을 노선 원본으로 저장.
- 정류장 쌍마다 버스 권한으로 경로 계산.
- 버스도 일반 차량 운동·점유·신호 코드를 사용.
- 정류장은 차도 내 정차(in-lane stop).
- 고정 정차시간으로 시작.
- 승객은 정류장·목적지별 집계량으로 확장 가능하게 설계.

**(d) 자료구조와 정차 상태**

```ts
interface BusStop {
  id: EntityId;
  laneId: EntityId;
  startSMm: number;
  endSMm: number;
  berthCount: number;
}

interface BusLine {
  id: EntityId;
  stopIds: EntityId[];
  loop: boolean;
  routeRevision: number;
  headwayTicks: number;
  firstDepartureTick: number;
}

type BusState =
  | "RUNNING"
  | "APPROACHING_STOP"
  | "DWELLING"
  | "WAITING_DEPARTURE";
```

정류장 앞에서 가상 정지 목표를 추가하고, 버스가 지정 위치에 충분히 가까워지고 속도가 임계값 이하가 되었을 때 정차를 시작한다. 버스 후미와 문 위치를 고려하여 정류장 길이를 검증한다.

MVP에서는 15초 등 고정 정차시간을 쓴다. 승객을 추가하면 다음처럼 확장한다.

\[
t_{dwell}
=t_{door}
+\max(N_{board}\tau_b,\;N_{alight}\tau_a)
\]

이는 승·하차가 병렬로 진행되는 문 구성을 가정한다. 같은 문을 함께 쓰면 합산하거나 문별 서비스를 모델링한다.

차도 내 정차이므로 뒤 차량은 정상적으로 대기한다. 차선 변경이 없는 MVP에서는 추월하지 않는다. 후속 단계에서 버스 베이(bus bay)와 재진입 우선권을 추가한다.

**배차 간격(headway)**

\[
departure_k=firstDeparture+kH
\]

스케줄 시각이 되었더라도 차량·차고지 출구 공간이 없으면 지연 출발한다. 실제 출발 시각을 기준으로 다음 스케줄을 계속 밀면 운행 계획 자체가 변하므로 예정 시각과 실제 시각을 구분한다.

필요 차량 수의 초기 추정은:

\[
N_{fleet}\ge
\left\lceil\frac{T_{roundtrip}+T_{layover}}{H}\right\rceil
\]

혼잡 시 실제 왕복 시간이 늘어나면 배차 간격이 벌어질 수 있다. 버스를 즉시 생성해서 간격을 맞추지 않는다.

도로 폐쇄가 생기면 정류장 순서를 유지하며 구간 경로를 다시 계산한다. 정류장 접근 자체가 불가능하면 “정류장 건너뛰기”, “임시 정류장”, “노선 운휴” 중 명시적 정책으로 처리한다.

후속 단계는 승객 수요, 정원, 환승, 차고지 회차, 버스 몰림(bus bunching), 간격 유지 대기(holding), 대중교통 신호 우선(transit signal priority)이다.

---

**6. 돌발 상황 시뮬레이션을 위한 훅**

**(a) 실제 사례와 표준 접근**

SUMO는 일시적인 차선 권한 변경과 재탐색을 제공하며, 긴급차량을 별도 차량 클래스와 동작으로 구분한다. Cities: Skylines II도 사고·정차 차량 회피를 공개 기능으로 설명한다. [SUMO 폐쇄 대응](https://sumo.dlr.de/docs/Simulation/Routing.html#handling-of-temporary-obstructions), [SUMO 긴급차량](https://sumo.dlr.de/docs/Simulation/Emergency.html), [Cities: Skylines II Traffic AI](https://www.paradoxinteractive.com/games/cities-skylines-ii/features/traffic-ai)

**(b) 장단점**

도로 객체를 직접 삭제·수정하면 구현은 빠르지만 원복, 중첩 사건, 재생이 어렵다. **기본 네트워크와 운영 제한(operational restriction)을 분리**하면 초기 자료구조는 늘어나지만 사고·공사·침수·행사를 같은 방식으로 처리할 수 있다.

**(c) MVP 권장안**

사건의 시각 표현보다 먼저 다음 세 가지를 공통 기능으로 구현한다.

- 주행 가능 여부 변경.
- 속도·진입 제한 변경.
- 장애물 점유와 경로 무효화.

**(d) 핵심 자료구조**

```ts
interface Incident {
  id: EntityId;
  kind: "CRASH" | "WORKZONE" | "FLOOD" | "FIRE";
  startTick: number;
  endTick?: number;
  affectedLaneIds: EntityId[];
  severity: number;
  seed: number;
}

interface LaneRestriction {
  id: EntityId;
  sourceIncidentId: EntityId;
  laneId: EntityId;
  fromSMm: number;
  toSMm: number;
  startTick: number;
  endTick?: number;
  kind: "NO_ENTRY" | "BLOCKED" | "SPEED_LIMIT";
  allowedModes?: ModeMask;
  speedLimitMmps?: number;
}

interface PriorityRequest {
  id: EntityId;
  vehicleId: EntityId;
  junctionId: EntityId;
  connectorId: EntityId;
  priorityClass: number;
  requestedAtTick: number;
  expiresAtTick: number;
}
```

반드시 구분할 상태:

- `NO_ENTRY`: 신규 진입 금지, 이미 있는 차량은 빠져나갈 수 있음.
- `BLOCKED`: 특정 거리 구간이 물리적으로 막힘.
- `SPEED_LIMIT`: 통행은 가능하지만 감속 필요.
- 차량 클래스별 통행 예외.

한 사건이 끝났을 때 단순히 `lane.closed=false`로 바꾸면 안 된다. 같은 차선의 다른 공사·사건 제한이 남아 있을 수 있다. **활성 제한들을 합성하여 유효 상태를 계산**한다.

```text
유효 통행 권한 = 기본 권한 ∩ 활성 제한의 허용 권한
유효 속도 제한 = 기본 제한과 활성 제한 속도의 최솟값
물리 장애물 = 활성 장애물 구간의 합집합
```

**사고 발생 파이프라인**

```text
사건 명령 또는 결정적 발생 조건
→ 사고 차량·장애물 점유 생성
→ 차선·연결 운영 제한 추가
→ 제한 epoch 갱신
→ 관련 경로 무효화
→ 대응 임무 생성
→ 복구 조건 충족
→ 사건 소유 제한과 장애물만 제거
```

갑자기 차량 바로 앞에 장애물을 생성하는 상황은 평상시 무충돌 추종 모델의 전제를 깨뜨릴 수 있다. 사고는 평상시 안전 불변식의 실패와 구분되는 명시적 상태로 기록한다.

**긴급차량 우선신호(preemption)**

긴급차량에 녹색을 즉시 부여하는 대신:

```text
요청 수신
→ 접근 경로·예상 도착 확인
→ 기존 흐름 종료
→ 황색·전적색
→ 충돌 영역 비움 확인
→ 긴급 이동 허용
→ 차량 후미 통과 확인
→ 정상 계획 복귀
```

버스의 녹색 연장(priority)과 긴급차량의 신호 선점(preemption)은 같은 개념으로 합치지 않는다.

MVP에서는 자료구조와 안전한 제어 경로를 준비하고, 긴급차량의 역주행·갓길 주행·일반 차량의 피양은 후속 단계로 둔다.

**지금 저장할 관측·업무 훅**

- 차량: `missionId`, 우선순위, 목적지, 출동·도착 틱.
- 도로: 제한 출처, 수용량, 관측 통행시간.
- 교차로: 이동별 대기열, 최대 대기시간, 유출량, 출구 포화도.
- 사건: 감지·신고·출동·도착·복구 시점.
- 수요: 출발·목적지·출발 시각·이동 목적.

도시 전체 대응은 차량 이동만으로 완성되지 않는다. 장기적으로 임무 배정(dispatch), 대응 자원, 대피 수요, 접근 불가능 지역을 연결할 수 있어야 한다.

외부 AI나 최적화기는 코어 상태를 직접 수정하지 않고 **미래 틱에 적용할 명령을 반환**하게 한다. 그래야 기록·재생·공동 시뮬레이션이 유지된다.

---

**7. 성능과 렌더링 연결**

**(a) 실제 사례와 표준 접근**

MATSim은 대규모 분석을 위해 계산 효율적인 대기열 기반 접근을 사용한다. CityFlow는 대규모 교통 신호 실험용 시뮬레이터이며, A/B Street는 이벤트 기반으로 불필요한 갱신을 줄인다. 서로 다른 정밀도·목적의 사례이므로 처리 차량 수를 그대로 비교하면 안 된다. [MATSim 교통 모델](https://www.matsim.org/files/book/partOne-latest.pdf), [CityFlow 논문](https://arxiv.org/abs/1905.05217), [A/B Street 실행 모델](https://a-b-street.github.io/docs/tech/trafficsim/discrete_event/index.html)

**(b) 장단점**

- SoA는 순회와 전송이 효율적이지만 디버깅용 도구가 필요하다.
- 단일 워커는 실행 순서를 통제하기 쉽지만 탐색·도로 컴파일이 몰리면 지연된다.
- 여러 워커는 병렬화가 가능하지만 결과 반영 시점을 결정적으로 맞춰야 한다.
- 인스턴싱은 드로 콜을 줄이지만 GPU 부하·그림자·컬링까지 해결하지는 않는다.

**(c) MVP 권장안**

- 단일 시뮬레이션 워커.
- 차량 상태 SoA와 TypedArray.
- 차선별 순서 자료구조.
- 렌더링 전용 스냅샷 풀.
- ArrayBuffer 소유권 전송.
- 틱 보간.
- 차량 종류·공간 청크별 인스턴싱.

**(d) SoA 자료구조**

```ts
interface VehiclesSoA {
  stableId: Uint32Array;
  generation: Uint32Array;
  pathIndex: Uint32Array;
  sMm: Int32Array;
  speedMmps: Int32Array;
  accelerationMmps2: Int32Array;
  lengthMm: Int32Array;
  typeIndex: Uint16Array;
  state: Uint8Array;
  routeHandle: Uint32Array;
  routeCursor: Uint32Array;
}
```

차량 1만 대의 IDM 계산을 20Hz로 실행하면 초당 약 20만 회의 기본 갱신이다. 이것만으로 목표 달성 여부를 판단할 수는 없지만, **매 프레임 전체 재탐색·객체 생성·3D 충돌 검사**를 하는 구조를 피하면 측정·최적화 가능한 범위로 좁힐 수 있다.

**차선별 순서**

차선 변경이 없는 MVP에서는 차량의 상대 순서가 보존된다.

- 차선·연결별 앞→뒤 목록 유지.
- 선행 차량 조회를 O(1)에 가깝게 구성.
- 경로 이동 때 목록에서 제거·삽입.
- 매 틱 모든 차량을 공간 좌표로 정렬하지 않음.
- 계산은 이전 상태를 읽고, 확정 단계에서 목록·점유를 갱신.

대규모 삽입·삭제를 위해 TypedArray 기반 `next/prev/head/tail` 인덱스 구조를 사용할 수 있다. 이후 차선 변경 시 필요한 앞뒤 차량 검색을 별도 보완한다.

**공간 해시(spatial hash)**

다음 용도로 사용한다.

- 도로 편집 스냅 후보.
- 사고·침수 영향 영역.
- 긴급차량 주변 반응.
- 렌더링 청크와 객체 선택.

정상적인 차선 추종의 앞차 검색에는 공간 해시보다 차선 순서가 적합하다.

\[
cell(x,y)=
\left(
\left\lfloor x/h\right\rfloor,
\left\lfloor y/h\right\rfloor
\right)
\]

긴 세그먼트는 통과하는 모든 셀에 등록하거나 별도 경계 상자 인덱스를 사용한다. 동적 객체는 매 틱 해시 전체를 재생성하기보다 셀 변경 시 갱신하는 방식을 검토한다.

**틱 실행 순서**

```ts
function step(tick: number) {
  applyCommands(tick);
  applyScheduledEvents(tick);
  advanceRestrictionsAndSignals(tick);

  processRoutingBudget();
  updateDemandAndBusSchedules(tick);

  buildLaneObservations();
  collectEntryRequests();
  resolveEntryRequestsDeterministically();

  computeVehicleIntents();       // 이전 상태 읽기
  enforceSafetyAndOccupancy();
  commitVehicleStates();
  updateQueuesAndRearOccupancy();

  accumulateMetrics();
  maybeEmitStateHash(tick);
  maybePublishRenderSnapshot(tick);
}
```

순서는 버전이 있는 시뮬레이션 계약으로 취급한다. 렌더러의 카메라·프레임률이 이 순서나 결과에 영향을 주면 안 된다.

**워커 → 메인 전송**

`ArrayBuffer`를 전송하면 원래 송신 측 버퍼가 분리(detach)된다. TypedArray 자체가 아니라 그 기반 버퍼를 전송 목록에 넣는다. [MDN Transferable objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)

```ts
postMessage(
  {
    tick,
    topologyRevision,
    count,
    buffer: snapshotBuffer
  },
  [snapshotBuffer]
);
```

권장 규칙:

- 시뮬레이션의 실제 상태 버퍼를 전송하지 않는다.
- 렌더링 전용 버퍼에 필요한 필드만 채운다.
- 메인은 보간에 필요한 두 스냅샷을 보유한다.
- 더 오래된 스냅샷 버퍼를 워커로 반환하여 재사용한다.
- 메인이 느리면 스냅샷 발행을 건너뛰되 시뮬레이션 틱은 버리지 않는다.
- 새로 받은 스냅샷이 여러 개면 표시 지연을 제어하며 오래된 것을 폐기한다.

정적 경로 기하는 변경될 때만 전송한다. 동적 스냅샷에는 차량 ID, 경로 ID, \(s\), 속도, 상태 등만 담을 수 있다.

차량당 32바이트의 동적 스냅샷을 보낸다고 가정하면:

\[
10{,}000\times32\times20
=6.4\text{ MB/s}
\]

이는 스레드 사이의 논리적 페이로드 계산이다. 실제 패킹 비용·메시지 지연·GPU 업로드 비용은 따로 측정해야 한다.

`SharedArrayBuffer`는 후속 선택지다. 교차 출처 격리(cross-origin isolation)와 동기화 규칙이 필요하므로 MVP의 필수 조건으로 삼지 않는다.

**틱 보간(interpolation)**

화면은 확보된 두 상태 사이의 약 한 틱 지연된 시각을 표시한다.

\[
\alpha=
\operatorname{clamp}
\left(
\frac{t_{render}-t_k}{t_{k+1}-t_k},
0,1
\right)
\]

같은 경로 위에서는:

\[
s_{render}=(1-\alpha)s_k+\alpha s_{k+1}
\]

그다음 경로 기하에서 위치와 방향을 계산한다.

경로가 바뀌는 틱에서는 두 월드 좌표를 직선 보간하면 회전 모서리를 잘라 지나간다. 이전·이후 경로의 연결 관계를 사용하여 경로를 따라 보간한다.

- 신규 차량: 생성 시점 이전에 표시하지 않음.
- 제거 차량: 제거 시점 이후 잔상 제거.
- 슬롯 재사용: ID와 generation 확인.
- 도로 편집: topology revision이 맞는 기하로 표시.

**Three.js 렌더링**

`InstancedMesh`는 같은 기하·재질을 가진 다수 객체의 드로 콜을 줄이는 공식 수단이다. [Three.js InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html)

권장 구성:

- 승용차·버스·트럭 모델별 인스턴싱.
- 넓은 도시를 공간 청크로 분할하여 컬링(culling).
- 거리별 LOD.
- 멀리 있는 차량 그림자 축소·제거.
- 프레임마다 `Vector3`, `Matrix4` 등을 대량 생성하지 않기.
- 차량별 개별 `Mesh`, 충돌 바디, DOM 라벨 생성 피하기.

후속 단계에서 경로 기하와 \(s\)를 GPU가 직접 해석하도록 옮길 수 있지만, 먼저 CPU 보간·인스턴싱으로 병목을 측정한다.

**성능 검증 기준**

20Hz 시뮬레이션의 틱 간격은 50ms이고, 60fps 렌더링의 프레임 간격은 약 16.7ms다. 두 예산은 독립적으로 검사한다.

초기 목표:

| 측정 항목 | 제안 통과 기준 |
|---|---|
| 시뮬레이션 | 1만 대·수백 교차로에서 20Hz 유지 |
| 틱 처리시간 | 선언한 기준 기기에서 p95 20ms 이하 목표 |
| 렌더링 | 지정 해상도·카메라·그림자 설정에서 60fps 목표 |
| 메모리 | 장시간 실행 시 지속 증가 없음 |
| 명령 재생 | 같은 코어 버전·입력의 상태 해시 일치 |
| 돌발 상황 | 대량 재탐색에도 탐색 예산 유지 |
| 차량 수 보존 | 생성·운행·도착·제거 수의 일관성 |

검증 시나리오는 최소 다음을 포함한다.

1. 자유 흐름과 1만 대 운행.
2. 신호 대기열과 정체 역류(spillback).
3. 긴 버스와 짧은 구간.
4. 간선도로 폐쇄와 대량 재탐색.
5. 운행 중 도로 분할·편집.
6. 체크포인트 복원·늦은 접속·명령 재생.
7. 서로 다른 브라우저에서 동일 입력 재생.

원활한 자유 흐름만으로 통과 판정하면 안 된다. 대기·충돌 요구·경로 무효화가 몰리는 상태가 실제 최악 조건이다.

---

**MVP 결정 요약**

| 항목 | 결정 | 이유 |
|---|---|---|
| 실행 구조 | DOM 없는 순수 TS 코어, 단일 워커 | 테스트·재생·서버 실행 공유 |
| 시간 | 20Hz, 정수 틱 | 결정성과 렌더링 독립성 |
| 공동 시뮬레이션 | 서버가 순서·적용 틱 확정, 기준 체크포인트 제공 | 명령 순서만으로는 동기화 부족 |
| 도로 모델 | 편집용 node/segment와 실행용 lane/connector 분리 | 편집 편의와 교통 정확성을 함께 확보 |
| 곡선 | 3차 베지어 편집, 차선별 호 길이 표 | 일정 속도와 정확한 거리 계산 |
| 좌표 | 정수 mm, 렌더링은 로컬 Float32 | 안정적 저장·명령·대규모 화면 표시 |
| 교차로 생성 | 같은 높이의 3·4지, 제약 검사 | 자동 생성 범위를 통제 |
| 도로 타입 | 총 차선 수 명확화, 방향·모드 권한으로 구성 | 버스전용·일방통행 확장 |
| 도로 편집 | 원자적 트랜잭션과 안전한 차량 이관 | 운행 중 참조·점유 손상 방지 |
| 차량 운동 | IDM, 경로 위 앞 범퍼 \(s\) | 가감속·대기열·버스 공통 처리 |
| 수치 결정성 | 고정소수점, 명시적 반올림·동률 규칙 | 브라우저별 상태 분기 억제 |
| 차선 변경 | MVP 생략, 끝까지 유효한 차선 경로 보장 | 구현 범위를 줄이면서 도달 가능성 유지 |
| 경로 탐색 | 차선 그래프 A*와 제한된 캐시 | 회전·차량 권한·폐쇄 반영 |
| 탐색 예산 | 고정 연산량 기반 점진 탐색 | 비용 분산과 결정성 |
| 혼잡 | 완화된 통행시간, 쿨다운·개선 임계값 | 경로 진동 억제 |
| 신호 | 고정 주기, 보호 회전, 공유 차선은 방향별 제어 | 안전성과 설명 가능성 |
| 교차로 안전 | 충돌표·후미 점유·출구 예약 | 교차 충돌과 막힌 교차로 방지 |
| 비신호 교차로 | STOP·명시적 우선권 | 순환 양보와 접근 충돌 통제 |
| 버스 | 정류장 목록→검증된 경로, 차도 내 고정 정차 | 기존 차량 모델 재사용 |
| 배차 | 예정 시각과 실제 출발 분리 | 차량 부족·혼잡을 드러냄 |
| 돌발 상황 | 기본 도로 위 제한·장애물 레이어 | 중첩 사건·원복·재생 지원 |
| 스마트 신호 | 감응식→최대압력→필요 시 RL | 단계적으로 검증 가능한 확장 |
| 차량 자료구조 | SoA·TypedArray·차선별 순서 | 메모리·선행 차량 조회 비용 절감 |
| 화면 연결 | 재사용 Transferable 스냅샷과 경로 보간 | 전송·GC 비용과 곡선 표시 문제 완화 |
| 3D 표시 | 차종·청크별 인스턴싱과 LOD | 1만 대 렌더링 목표에 적합 |

**피해야 할 함정**

- **도로 중심선 그래프만으로 경로를 계산하기.** 회전차선·전용차선에서 실제로 못 가는 경로가 생긴다.
- **차선 변경을 생략하면서 경로에는 차선 변경을 허용하기.**
- **베지어의 \(t\)를 거리처럼 사용하기.** 곡선에서 속도가 불균일해진다.
- **도로 중심선 길이를 모든 차선 길이로 재사용하기.**
- **차량 앞부분이 나가면 점유를 해제하기.** 버스 후미가 충돌한다.
- **초록불이면 무조건 교차로에 진입시키기.** 막힌 출구가 도시 전체 교착으로 번진다.
- **교차로 전체를 차량 한 대의 잠금으로 만들기.** 처리량이 비현실적으로 낮아진다.
- **서로 다른 차량이 같은 출구 공간을 중복 예약하게 두기.**
- **명령 순서만 맞으면 결정적이라고 가정하기.** 적용 틱·난수·탐색 완료 시점도 상태를 바꾼다.
- **벽시계 시간으로 경로 탐색 예산을 정하기.** 기기마다 다른 틱에 결과가 나온다.
- **현재 속도만 보고 모든 차량을 즉시 우회시키기.** 경로 진동과 재탐색 폭주가 발생한다.
- **사고·공사를 도로 객체 삭제로 표현하기.** 복구와 중첩 제한 처리가 어려워진다.
- **운행 중인 도로를 차량·정류장·예약 이관 없이 분할하기.**
- **막힌 차량을 조용히 삭제하기.** 정체가 좋아 보이고 대응 성과가 왜곡된다.
- **버스 배차를 무제한 차량 생성으로 맞추기.**
- **긴급 우선신호가 황색·전적색·충돌 검사를 건너뛰게 하기.**
- **실제 시뮬레이션 버퍼를 Transferable로 넘기기.** 워커가 자신의 상태를 잃는다.
- **월드 좌표 직선 보간으로 교차로 회전을 표시하기.**
- **차량 1만 개를 개별 Mesh·물리 바디로 생성하기.**
- **자유 흐름 화면만 보고 성능을 판정하기.** 폐쇄·대기열·동시 편집·대량 재탐색까지 검증해야 한다.
- **시뮬레이터가 실행된다는 이유로 현실 예측력을 주장하기.** 실제 스마트시티 의사결정에 쓰려면 수요·통과량·통행시간·대응시간의 별도 보정(calibration)과 검증(validation)이 필요하다.