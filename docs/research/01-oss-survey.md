# 01. 오픈소스 조사 (OSS Survey)

작성: SmartCity 팀 research subagent / 조사 기준일: 2026-10-23
대상: 브라우저 기반 Cities: Skylines 스타일 3D 도시 빌더 (다중 사용자 실시간 공동 편집, TypeScript + Vite + Three.js, Web Worker 시뮬레이션 코어, Node.js WebSocket 서버).

## 0. 조사 방법과 신뢰도 표기

- GitHub REST API(`api.github.com/repos/...`)로 stars / license(SPDX) / 마지막 push / 주 언어를 직접 조회했다. 표의 수치는 **2026-10-23 조회값**이며 stars는 근사치다.
- 조회 도중 비인증 API rate limit(시간당 60회)에 걸려, 일부 repo는 **[미검증]**(기억/일반 지식 기반, repo 존재·수치 미확인)으로 표시했다.
- API가 `NOASSERTION`을 준 항목은 LICENSE 파일을 직접 읽거나 "알려진 라이선스"로 별도 표기했다.
- 웹 검색 결과 중 2차 자료(블로그, 포럼)는 그대로 인용하지 않고 "2차 출처"로 표시했다.
- **[검증]** = API/원문으로 repo 존재 및 수치 확인. **[미검증]** = 확인 못함.

---

## 1. 웹/3D 도시 빌더 및 도시 시뮬레이션

| 프로젝트 | 상태 | stars | 라이선스 | 마지막 push | 언어 |
|---|---|---|---|---|---|
| [citybound/citybound](https://github.com/citybound/citybound) | [검증] | ~8.2k | AGPL-3.0 | 2023-01 (사실상 정체) | Rust |
| [a-b-street/abstreet](https://github.com/a-b-street/abstreet) | [검증] | ~8.2k | Apache-2.0 | 2025-09 | Rust |
| [OpenTTD/OpenTTD](https://github.com/OpenTTD/OpenTTD) | [검증] | ~8.4k | GPL-2.0 (API는 NOASSERTION; 알려진 라이선스, 재확인 필요) | 2026-10 활발 | C++ |
| [simutrans/simutrans](https://github.com/simutrans/simutrans) | [검증] | ~104 (미러 repo로 추정) | Artistic License 계열 (API NOASSERTION, [미검증]) | 2026-10 | C++ |
| [rawprogress/fable-cities](https://github.com/rawprogress/fable-cities) | [검증] | ~82 | MIT (README "Source code: MIT", LICENSE 파일 존재; 에셋은 CC0 표방) | 2026-09 | JavaScript (Three.js r185) |
| [reneodlt/civitas](https://github.com/reneodlt/civitas) | [검증] | ~5 | AGPL-3.0 | 2026-10 | TypeScript |
| [zeikar/cimulity](https://github.com/zeikar/cimulity) | [검증] | ~5 | MIT | 2026-09 | TypeScript |
| [herozhong0125/city-builder](https://github.com/herozhong0125/city-builder) | [검증] | ~2 | MIT | 2026-09 | JavaScript (Three.js) |
| [MichaelKowal/city-builder](https://github.com/MichaelKowal/city-builder) | [검증] | ~3 | 없음(=all rights reserved) | 2023-11 | TypeScript |
| [volkhin/RoadTrafficSimulator](https://github.com/volkhin/RoadTrafficSimulator) | [검증] | ~478 | MIT | 2017-02 (정체) | JavaScript(CoffeeScript 원본) |

### 각 프로젝트별 활용 포인트

- **Citybound** – 분산 액터 모델 기반 대규모 교통/도시 시뮬레이션, 곡선 도로·차선·교차로 편집 UX가 핵심. *빌릴 것*: 도로 계획(planning)을 "제안 → 확정" 2단계로 보여주는 UX 개념, 차선 단위 그래프 모델링 개념. *라이선스*: AGPL-3.0 → **코드 복사 금지**(MIT 프로젝트에 AGPL 전염). 개념·논문식 아이디어만 참고. *리스크*: 2023-01 이후 정체, Rust라 직접 포팅 가치 낮음.
- **A/B Street** – 교통 마이크로시뮬레이션 + 도로망 편집(교차로 폴리곤 생성, 신호 편집기). Apache-2.0이라 MIT와 호환(고지·NOTICE 유지 조건). *빌릴 것*: 교차로 지오메트리 생성 로직(`map_model` 내 도로 폴리라인 → 교차로 폴리곤), 신호 phase 모델, 차량 큐잉/그리드락 처리 개념. 산하 [a-b-street/osm2streets](https://github.com/a-b-street/osm2streets)(교차로/차선 모델링 라이브러리, [미검증]: rate limit으로 수치 확인 실패)도 함께 볼 것. *리스크*: Rust. 코드를 직접 쓰기보다 알고리즘을 TS로 재구현하는 방식 권장(그 경우에도 출처 표기).
- **OpenTTD / Simutrans** – 개념 참고용. GPL 계열이므로 코드는 가져오지 않는다. *빌릴 것*: 경제/운송 노선(버스 노선, 정류장 용량) 모델, 타일 기반 시뮬레이션 틱 구조, 멀티플레이 **lockstep + command 배포** 구조(OpenTTD는 명령을 서버가 순서화해 모든 클라이언트에 배포하는 방식으로 알려져 있음; 상세 문서는 직접 확인 안 함 [미검증]).
- **fable-cities** – Three.js(r185)로 만든 "Cities: Skylines급" 브라우저 도시 빌더. MIT. 신호등, 횡단보도, 보행자, 건설 현장, 건물 인스펙터까지 README에 명시. 같은 스택이라 **구조 비교용 1순위**. *리스크*: 이름·README로 보아 AI 에이전트로 생성된 코드베이스(README: "a team of AI agents"). 품질·성능 미검증, 별 82개로 커뮤니티 검증 적음. `THIRD-PARTY-NOTICES.md`로 에셋 라이선스 확인 필요.
- **civitas (msimcity)** – 권위 서버(TypeScript, WebSocket) + three.js 클라이언트 + shared 패키지 구조의 멀티플레이 도시 빌더. 우리 설계(권위 서버 + 공유 타입 패키지)와 거의 동일 형태라 구조 참고 가치가 높다. **AGPL-3.0**이므로 코드 복사 불가, 구조만 참고. 건물을 "데이터(파일당 kind family) → compile" 하는 방식(`docs/buildings.md`)도 참고할 만함.
- **cimulity, herozhong0125/city-builder** – 소규모 MIT 프로젝트. 코드 단위 참고용(별 수 매우 적음, 신뢰도 낮음).
- **RoadTrafficSimulator (volkhin)** – 교차로 신호 + 차선 이동을 JS로 구현한 고전 데모. MIT. 신호 사이클/차선 전환 개념 참고용. 2017년 이후 정체.

> 참고: 검색 결과(`city builder three.js` 등)에서 별 100개 이상인 성숙한 Three.js 도시 빌더 OSS는 **발견하지 못했다**. 이 분야에서 "표준 오픈소스"는 사실상 없다는 것이 결론이다. 따라서 우리 프로젝트는 개념(Citybound, A/B Street, OpenTTD) + 라이브러리(Three.js 생태계)를 조합하는 방식이 현실적이다.

---

## 2. 교통 시뮬레이션

| 프로젝트 | 상태 | stars | 라이선스 | 마지막 push | 언어 |
|---|---|---|---|---|---|
| [eclipse-sumo/sumo](https://github.com/eclipse-sumo/sumo) | [검증] | ~4.2k | EPL-2.0 (+ 보조 라이선스 가능) | 2026-10 활발 | C++/Python |
| [cityflow-project/CityFlow](https://github.com/cityflow-project/CityFlow) | [검증] | ~1.0k | Apache-2.0 | 2025-08 | C++ |
| [movsim/traffic-simulation-de](https://github.com/movsim/traffic-simulation-de) | [검증] | ~1.06k | **GPL-3.0** (LICENSE 원문 확인) | 2026-09 | JavaScript |
| [movsim/movsim](https://github.com/movsim/movsim) | [미검증] | - | - (알려진 바 GPL) | - | Java |
| A/B Street (위 표 참조) | [검증] | | Apache-2.0 | | Rust |
| [volkhin/RoadTrafficSimulator](https://github.com/volkhin/RoadTrafficSimulator) | [검증] | ~478 | MIT | 2017 | JS |

- **SUMO** – 업계 표준 미시 교통 시뮬레이터. 서버에서 돌릴 수는 없고(우리 시뮬은 JS), **검증용 기준(reference)**으로 사용: 같은 도로망/수요를 SUMO와 우리 코어에서 돌려 평균 속도·지체를 비교(교차검증). 차량 모델(Krauss, IDM), 신호 프로그램 정의, junction priority 규칙 문서를 학습 자료로 활용. 코드 이식은 EPL-2.0(약한 카피레프트)이라 부담, 문서/개념만 참고.
- **CityFlow** – 강화학습용 대규모 교통 시뮬레이터(수천~수만 차량). 도로망 JSON 포맷, 신호 phase 정의가 단순하고 깔끔해 **데이터 포맷 설계 참고**에 좋다. Apache-2.0. C++ 코어라 포팅은 비추천, 구조(roadnet/flow JSON)만 참고.
- **traffic-simulation.de (Treiber)** – IDM(Intelligent Driver Model)과 MOBIL(차선 변경)을 JS로 구현한 교육용 시뮬레이터. 수식과 구현 방식을 학습하기에 최고의 자료. **단, GPL-3.0이므로 코드를 가져오면 우리 프로젝트가 GPL이 된다.** 대응: 논문(Treiber, Kesting의 *Traffic Flow Dynamics*)의 공개된 **수식**으로 직접 구현. 수식 자체는 저작권 대상이 아니지만, 코드 구조·변수 명명까지 베끼지는 말 것(clean-room에 가깝게).
- 1D 차선 기반 IDM의 단순성이 "수천 대 + 60fps" 목표에 적합. 교차로(충돌 회피, 우선권)는 IDM만으로 해결되지 않으므로 교차로 내부는 별도 규칙(예약 기반 또는 가상 선두차량)이 필요하다. 이는 A/B Street, SUMO 문서를 참고.
- **JS/TS 도로·교통 엔진**: 성숙한 TS 엔진은 확인하지 못했다. 검색에서 나온 것은 대부분 별 0~1개의 소규모 데모(예: `rickpet1764/moveet`, `SaintPepsi/traffic-microsim` 등)로 **참고 가치 낮음**. 사실상 직접 구현이 필요하다.

---

## 3. 도로 편집 도구 / 교차로 지오메트리

### 3.1 Cities: Skylines 방식(개념)

(공식 소스는 비공개이고, 아래는 모딩 커뮤니티에서 알려진 일반 구조이다. 직접 검증한 문서는 없음 [미검증].)

- 도로는 **Node(교차점/끝점) + Segment(두 노드를 잇는 3차 Bezier)** 의 그래프. Segment는 양 끝 방향(tangent)을 가진 Bezier 곡선이며, 차선은 곡선에서 오프셋된 곡선들.
- 교차로 메시는 각 노드에서 연결 segment들을 **각도순 정렬** → 인접 segment의 가장자리 폴리라인끼리 교차/라운딩 → 노드 주변 다각형(교차로 패치)을 채우고, 각 segment는 교차로 패치 경계에서 잘라낸다(도로 시작점을 교차로 반경만큼 뒤로 이동).

### 3.2 구현에 쓸 만한 자료

- **A/B Street / osm2streets** – 실제 OSS 코드로 교차로 폴리곤 생성(각도 정렬, 인접 가장자리 교차점 계산)을 구현. Apache-2.0. **교차로 지오메트리의 가장 현실적인 코드 레퍼런스.**
- 웹 검색에서 확인한 자료(2차):
  - Malmö University 학위논문(2022, Bezier 스플라인 교차 검출: Bezier subdivision, convex hull, SAT 사용) – [diva-portal](https://www.diva-portal.org/smash/get/diva2:1675311/FULLTEXT02)
  - Unity 포럼 "Procedurally Generated Road Networks and Intersections" – 교차로를 별도 메시로 만들고 겹치는 도로 정점을 잘라내는 방식 – [링크](https://discussions.unity.com/t/procedurally-generated-road-networks-and-intersections/532867)
  - Unreal 쪽 MetaRoad, Procedural Road Toolkit 등은 상용/마켓 자산이라 코드 재사용 불가, 개념만.
- 한 번 더 찾아볼 것(미조사): 모딩 위키의 NetNode/NetSegment 문서, Sebastian Lague·Freya Holmér 등의 Bezier/spline 강의(개념 학습용; 내용 미확인 [미검증]).
- 곡선 처리 라이브러리: Three.js 내장 `CubicBezierCurve3`/`CatmullRomCurve3`로 충분. 길이 기반 균일 샘플링(arc-length parameterization) 직접 구현 필요. 폴리곤 삼각분할은 [mapbox/earcut](https://github.com/mapbox/earcut) [검증] (ISC, ~2.6k stars, 2026-10 활발, JS) – 건물 풋프린트 및 교차로 패치 삼각분할에 적합. Boolean/offset 연산이 필요하면 clipper2 계열 JS 포팅([미검증]) 검토.

### 3.3 권장 설계

- 도로 그래프(Node/Segment/Lane)는 **시뮬 코어(Worker)가 소유하는 데이터 모델**, 메시 생성은 렌더 쪽에서 파생(같은 입력 → 같은 메시, deterministic)한다.
- 교차로는 "각도 정렬 → 인접 edge 교차 → 패치 폴리곤" 알고리즘을 순수 TS 함수로 만들고 **단위 테스트**(기하 케이스 많음: 2갈래, T형, 5갈래, 예각, 너무 짧은 segment).

---

## 4. 렌더링 / 성능 라이브러리

| 라이브러리 | 상태 | stars | 라이선스 | 마지막 push | 언어 |
|---|---|---|---|---|---|
| [mrdoob/three.js](https://github.com/mrdoob/three.js) | [검증] (v0.186.0) | ~116.8k | MIT | 2026-10-23 | JS |
| [BabylonJS/Babylon.js](https://github.com/BabylonJS/Babylon.js) | [검증] | ~26.2k | Apache-2.0 | 2026-10-23 | TS |
| [yomotsu/camera-controls](https://github.com/yomotsu/camera-controls) | [검증] | ~2.4k | MIT | 2026-10-21 | TS |
| [gkjohnson/three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | [검증] | ~3.5k | MIT | 2026-10-22 | JS |
| [pmndrs/drei](https://github.com/pmndrs/drei) | [검증] | ~10k | MIT | 2026-10-21 | JS (React 의존) |
| [mapbox/earcut](https://github.com/mapbox/earcut) | [검증] | ~2.6k | ISC | 2026-10 | JS |
| [dimforge/rapier.js](https://github.com/dimforge/rapier.js) | [검증] **archived** | ~0.7k | Apache-2.0 | 2026-07 | TS |

- **Three.js InstancedMesh / BatchedMesh** – 수천 대 차량의 핵심. `InstancedMesh`: 같은 geometry·material에 대한 인스턴스별 matrix/color. `BatchedMesh`: 서로 다른 geometry를 하나의 draw call로 묶고 인스턴스별 가시성·색상(검색 2차 출처에 따르면 r183에서 인스턴스별 opacity/wireframe 추가) 지원. 우리 요구(사용자 정의 차량 모델 여러 종류)엔 BatchedMesh가 유리하나, **WebGPU 백엔드에서 `setMatrixAt` 지연/버퍼 재생성 이슈 보고**가 포럼에 있다(r182, 2차 출처). 프로토타입에서 반드시 실측. 차량 종류가 적으면 종류별 InstancedMesh가 가장 단순하고 안전.
- **성능 설계 요점**: 차량 위치는 Worker가 `Float32Array`(SharedArrayBuffer 또는 transferable)로 매 틱 전달 → 메인 스레드는 이전/현재 틱 사이를 보간해 렌더. 차량당 JS 객체 할당 금지. SharedArrayBuffer는 COOP/COEP 헤더 필요(Vite dev 서버/배포 서버 설정 필요).
- **WebGPU 현황**: 공식 매뉴얼은 `WebGPURenderer`가 WebGPU 미지원 시 WebGL 2 백엔드로 자동 폴백한다고 설명(공식 문서 2차 요약으로 확인). 일부 2026 블로그는 r171부터 production-ready라고 주장하나 **공식 선언은 찾지 못함 [미검증]**. 셰이더는 TSL(노드 기반, WGSL/GLSL 컴파일). 권장: **초기엔 `WebGLRenderer`로 개발**, 렌더러 접근을 얇은 래퍼 뒤에 두고, 후기에 WebGPURenderer를 A/B 실측 후 채택. 커스텀 GLSL(ShaderMaterial)은 WebGPURenderer에서 그대로 안 되므로 TSL 이식 비용 존재.
- **three-mesh-bvh** – 가속 레이캐스팅. 건물/지형 피킹(마우스로 도로를 지형 위에 찍기), 많은 건물 위 선택 시 유용. MIT, 활발. 지형 레이캐스트에는 지형이 단순 heightmap이면 직접 수식으로 풀어도 됨.
- **camera-controls (yomotsu)** – OrbitControls 대비 smooth damping, `dollyToCursor`, `truck/pan`, `fitToBox`, 애니메이션 전환 API가 풍부해 RTS/시티빌더 카메라(커서 위치로 줌, 드래그 팬, 회전)에 적합. 순수 TS, MIT. 권장.
- **Babylon.js 비교**: Babylon은 엔진 완결형(씬 그래프, GUI, 물리 Havok 통합, Inspector, WebGPU 지원 성숙, TS 네이티브)이고 Apache-2.0. 대신 번들 크기가 크고, 서드파티 생태계·튜토리얼 규모·커뮤니티 예제는 Three.js가 우세(stars 116.8k vs 26.2k). 우리는 시뮬 코어를 DOM/렌더러에서 분리하는 구조이고 렌더 요구가 "InstancedMesh + 커스텀 지오메트리 + 카메라"에 가까워 Three.js로 충분. 결론은 6장.
- **Rapier.js**: `dimforge/rapier.js` repo는 **archived**(Rapier의 JS 바인딩은 메인 repo로 이관된 것으로 보이나 이관처는 확인 못함 [미검증]). 재난 시뮬(충돌, 붕괴) 단계에서 물리 필요 시 재조사 필요. 도시 규모에서는 전체 물리 엔진 대신 단순화된 규칙 기반 모델이 현실적.
- **drei** – React Three Fiber 전용이라 비 React 스택에서는 불필요. 일부 유틸 아이디어만 참고.

---

## 5. 실시간 협업

| 프로젝트 | 상태 | stars | 라이선스 | 마지막 push | 언어 |
|---|---|---|---|---|---|
| [yjs/yjs](https://github.com/yjs/yjs) | [검증] | ~23k | MIT (LICENSE 원문 확인) | 2026-10 | JS |
| [automerge/automerge](https://github.com/automerge/automerge) | [검증] | ~6.7k | MIT | 2026-10 | JS(Rust 코어) |
| [colyseus/colyseus](https://github.com/colyseus/colyseus) | [검증] | ~7.5k | MIT | 2026-10 | TS |
| [liveblocks/liveblocks](https://github.com/liveblocks/liveblocks) | [검증] | ~4.8k | **혼합**: LICENSE에 "두 가지 라이선스" 명시(일부 코드 비-MIT, 전문 미확인) | 2026-10 | TS |
| [partykit/partykit](https://github.com/partykit/partykit) | [검증] | ~5.7k | MIT | 2026-10 | TS |
| [ueberdosis/hocuspocus](https://github.com/ueberdosis/hocuspocus) (Yjs 서버) | [미검증] | - | MIT (알려진 바) | - | TS |

### 비교

- **Yjs / Automerge (CRDT)** – 오프라인 편집, 분산 병합에 강하다. 하지만 도시 편집은 **"도로 A를 도로 B와 교차시키기", "건물을 도로 옆에 세우기"** 처럼 의미 제약(교차 계산, 충돌 검사, 비용/예산 검증)이 있는 명령 기반 작업이다. CRDT는 필드 수준 자동 병합이라 **"결과가 항상 유효한 도시"를 보장하지 못한다**(두 사용자가 동시에 같은 부지에 건물을 놓으면 둘 다 병합되어 무효 상태가 될 수 있음). 시뮬레이션이 결정적이어야 하는 점도 문제: CRDT는 상태 병합이지 명령 순서가 아니다. → 주 상태에는 부적합. 단, **커서/선택/채팅/presence** 같은 비중요 협업 상태에는 Yjs awareness가 쓸 만하다.
- **Colyseus** – Node.js 룸 기반 권위 서버 프레임워크(상태 동기화 스키마, 룸, 매치메이킹). 게임 서버에 가깝고 MIT. 하지만 상태 스키마 델타 동기화는 "수천 대 차량" 같은 파생 상태가 아니라 **명령 로그**를 기준으로 하는 우리 구조와 철학이 달라, 주 동기화 메커니즘으로는 과함. 룸/재접속/인증 같은 인프라를 빌려 쓸 수는 있다.
- **Liveblocks** – 상용 SaaS 중심(호스팅 서버 필요), 오픈소스 클라이언트 + 비공개 서버. 외부 의존·비용·라이선스 혼합 이슈 → 부적합.
- **PartyKit** – Cloudflare 기반 서버리스 WebSocket 룸. 배포 환경이 Cloudflare로 고정되므로 현 단계에선 보류.
- **일반 ordered command log over WebSocket (권장)** – 클라이언트는 "의도(command)"만 서버로 보낸다 → 서버가 **검증하고 전역 순번(seq)을 부여**해 모든 클라이언트에 브로드캐스트 → 모든 클라이언트(와 서버)가 같은 순서로 같은 결정적(deterministic) 시뮬에 적용. 장점: 도시 편집의 유효성 검증을 서버 한 곳에서 수행, 로그 = 저장/리플레이/타임머신/디버깅/재난 시나리오 재현, 신규 접속자는 스냅샷 + 이후 로그만 받으면 됨, 구현이 단순. OpenTTD의 방식과도 같은 계열. 단점: 낙관적 UI(클라이언트 예측 + 서버 확정 시 롤백) 직접 구현 필요, 서버가 SPOF.

### 결론 (권위 있는 명령 로그가 필요한 도시 에디터)

**plain ordered command log over WebSocket(자체 구현) + 주기적 스냅샷**이 가장 적합하다. Yjs awareness 등 CRDT는 presence(커서 등)에만 선택적으로 사용. 시뮬 동기화 방식은 두 가지가 있다.
1. *서버 권위 시뮬 + 상태 스트림* (클라이언트는 렌더만): 부정행위 방지, 클라이언트 단순. 대역폭 큼.
2. *결정적 lockstep*: 모든 클라이언트가 같은 명령을 같은 틱에 적용. 대역폭 작음. 단, 부동소수점 결정성(JS 엔진/브라우저 간) 리스크 → 정수/고정소수점 또는 동일 연산 순서 보장 필요.
도시 편집 명령은 서버 권위로, 차량 이동 같은 고빈도 파생 상태는 각 클라이언트 로컬 시뮬로 두는 하이브리드가 현실적이다(편집 명령의 적용 틱을 서버가 지정).

---

## 6. 절차적/파라메트릭 건물 생성

| 프로젝트 | 상태 | stars | 라이선스 | 마지막 push | 언어 |
|---|---|---|---|---|---|
| [Aljullu/threejs-procedural-building-generator](https://github.com/Aljullu/threejs-procedural-building-generator) | [검증] | ~46 | MIT | 2019-05 | JS |
| [hec-ovi/glb-buildings-skill](https://github.com/hec-ovi/glb-buildings-skill) | [검증] | ~5 | MIT | 2026-08 | TS |
| [mapbox/earcut](https://github.com/mapbox/earcut) | [검증] | ~2.6k | ISC | 2026-10 | JS |
| [marian42/wavefunctioncollapse](https://github.com/marian42/wavefunctioncollapse) | [검증] | ~4.9k | MIT | 2021-03 | C# |
| [OSMBuildings/OSMBuildings](https://github.com/OSMBuildings/OSMBuildings) | [검증] | ~1.0k | 라이선스 NOASSERTION (미확인) | 2021-04 | JS |

- **풋프린트 extrusion**: 2D 폴리곤 → `earcut`으로 지붕/바닥 삼각분할 → 벽은 엣지마다 quad를 층 수만큼 반복. 지붕 형태(평지붕, 박공, 사각뿔)는 풋프린트에서 파생(박공은 straight skeleton이 정석, 단순화하려면 사각형 풋프린트에 한정). 사용자 입력이 되는 파라미터(풋프린트, floors, roof, zone)는 **JSON 스키마로 정의하고 서버가 검증**(층 수, 면적 상한 등으로 DoS 방지).
- **메시 성능**: 사용자가 만든 건물이 수천 개가 되면 건물별 geometry는 draw call 폭증. → 같은 파라미터 해시끼리 geometry 공유, 정적 건물은 청크 단위로 병합(`BufferGeometryUtils.mergeGeometries`) 또는 BatchedMesh. 파라메트릭 건물을 **서버 로그에는 파라미터만 저장, 메시는 클라이언트에서 생성**하는 것이 명령 로그 설계와 맞다.
- **Aljullu 저장소**: 2019년 이후 정체이지만 MIT로 파라메트릭 건물 생성의 간단한 구현 참고 가능.
- **WFC (wavefunctioncollapse)**: 모듈러 타일 기반 도시/건물 레이아웃에 쓰이는 알고리즘. 사용자 풋프린트 기반 편집과는 방향이 다르므로 자동 생성 시나리오(랜덤 도시)가 필요할 때만.
- **msimcity(civitas)의 `docs/buildings.md` 방식** – 건물을 데이터 파일로 정의하고 컴파일해 표로 만드는 구조. AGPL이라 코드는 쓰지 못하지만 "건물=데이터" 접근은 우리 요구와 맞다.

---

## 7. Top 10 – 실제로 공부해야 할 레퍼런스

| # | 대상 | 링크 | 무엇을 | 라이선스/사용 방식 |
|---|---|---|---|---|
| 1 | A/B Street (+ osm2streets) | https://github.com/a-b-street/abstreet | 교차로 폴리곤, 신호, 차량 모델 구조 | Apache-2.0 → 알고리즘 재구현, 고지 유지 시 코드 사용 가능 |
| 2 | traffic-simulation.de | https://github.com/movsim/traffic-simulation-de | IDM / MOBIL 수식·구현 아이디어 | **GPL-3.0 → 코드 복사 금지**, 논문 수식으로 재구현 |
| 3 | fable-cities | https://github.com/rawprogress/fable-cities | 같은 스택(Three.js) 시티빌더 구조·성능 비교 | MIT, 단 AI 생성 코드 품질 검증 필요 |
| 4 | three.js InstancedMesh / BatchedMesh 문서 | https://threejs.org/docs/ | 차량 렌더링 | MIT |
| 5 | camera-controls | https://github.com/yomotsu/camera-controls | RTS형 카메라 | MIT, 직접 의존 |
| 6 | three-mesh-bvh | https://github.com/gkjohnson/three-mesh-bvh | 피킹/레이캐스트 가속 | MIT, 직접 의존 |
| 7 | SUMO | https://github.com/eclipse-sumo/sumo | 교통 모델·신호 프로그램 문서, 검증 기준 | EPL-2.0 → 문서/개념만 |
| 8 | CityFlow | https://github.com/cityflow-project/CityFlow | roadnet / flow JSON 포맷, 대규모 시뮬 구조 | Apache-2.0 |
| 9 | Citybound | https://github.com/citybound/citybound | 도로 편집 UX, 차선 단위 모델 | **AGPL-3.0 → 개념만** |
| 10 | civitas (msimcity) | https://github.com/reneodlt/civitas | 권위 서버 + shared 패키지 + 건물 데이터화 구조 | **AGPL-3.0 → 구조 참고만** |

(차선: Yjs https://github.com/yjs/yjs – presence 용도, Colyseus https://github.com/colyseus/colyseus – 룸/재접속 인프라 아이디어, earcut https://github.com/mapbox/earcut – 의존성으로 사용.)

---

## 8. 권장 스택 (Recommended stack)

| 영역 | 선택 | 근거 |
|---|---|---|
| 언어/빌드 | TypeScript + Vite | 시뮬 코어를 `packages/sim-core`로 분리(DOM-free)하면 Worker, Node 서버, 테스트에서 모두 재사용. Worker는 Vite의 `new Worker(new URL(...), import.meta.url)` 지원. |
| 렌더링 | **Three.js** (WebGLRenderer로 시작, WebGPURenderer는 추후 실측 후 전환) | 생태계/예제/인력 풀 압도적(~117k stars vs ~26k). 요구 렌더가 "InstancedMesh + 커스텀 메시 + 카메라" 위주라 Babylon의 엔진 기능(풀 Inspector, GUI, Havok 통합)의 이점이 크지 않다. 팀 학습 자료도 Three.js가 풍부. Babylon.js는 WebGPU와 TS 지원이 성숙하고 Apache-2.0이라 법적 장애는 없으므로, **렌더 계층을 인터페이스 뒤에 두어** 필요하면 교체 가능하게 한다. 단, 두 엔진으로 같은 장면을 만드는 실측은 하지 않았으므로 성능 우위 주장은 [미검증]. |
| 카메라 | **camera-controls (yomotsu)** | OrbitControls 대비 dollyToCursor, 부드러운 감쇠, 이동 제한, 전환 애니메이션을 기본 제공. MIT, TS, 활발히 유지(2026-10). |
| 차량 렌더 | 종류별 `InstancedMesh` 먼저, 필요시 `BatchedMesh` | 단순·안정적. BatchedMesh는 WebGPU 백엔드 이슈 보고가 있어(2차 출처) 실측 후 도입. |
| 피킹 | three-mesh-bvh (필요 시) | 정적 건물 많을 때. 지형 단순하면 불필요. |
| 시뮬 | 자체 구현 TS 코어, 고정 틱(예: 20Hz), 렌더는 보간 | 차선 기반 IDM(수식 직접 구현, GPL 코드 비사용), 교차로는 예약/우선순위 규칙, 신호는 phase 테이블. SoA(`Float32Array`) 레이아웃, 공간 분할(그리드)로 선두차량 탐색. |
| 동기화 | **Node.js `ws` + 자체 ordered command log + 스냅샷** | 위 5장 결론. Yjs는 presence에만 선택적 사용. |
| 폴리곤 | earcut | 건물 풋프린트/교차로 패치 삼각분할. |
| 검증 도구 | SUMO | 교통 모델 교차검증(개발 도구로만 사용, 배포물에 포함하지 않음). |

핵심 리스크: ① 결정성(JS 부동소수점) – 서버 권위 + 클라이언트 예측 허용 오차 설계 필요, ② 교차로 지오메트리와 교차로 내 차량 이동의 복잡도, ③ 사용자 정의 건물/차량 수에 따른 draw call과 메모리, ④ WebGPU 전환 시 셰이더 이식 비용.

---

## 9. 라이선스 주의사항 (License cautions)

프로젝트가 **MIT**라는 전제:

1. **GPL/AGPL 코드는 복사·포팅 금지**: traffic-simulation.de(GPL-3.0), Citybound(AGPL-3.0), civitas/msimcity(AGPL-3.0), OpenTTD(GPL-2.0), SlimCityGame(AGPL-3.0 [검증]). 번역(다른 언어로 포팅)도 파생물로 간주될 수 있다. 개념·수식·알고리즘 이름까지만 참고하고, 가능하면 코드를 읽은 사람과 구현한 사람을 분리(clean-room)한다.
2. **수식/알고리즘 자체**(IDM, MOBIL, Bezier 등)는 논문에 공개된 지식이므로 직접 구현 가능. 출처 논문을 코드 주석과 문서에 인용.
3. **Apache-2.0 코드**(A/B Street, CityFlow, Babylon.js): MIT와 호환. 복사 시 원 저작권 고지, LICENSE/NOTICE 유지, 수정 표시 필요. 특허 조항 때문에 일부 팀은 Apache 코드를 MIT 파일에 섞는 것을 꺼리므로 파일 단위로 출처를 표기.
4. **EPL-2.0**(SUMO): 약한 카피레프트. 파일 단위로 수정 공개 의무. 우리 코드에 포함하지 말고 외부 도구로만 쓴다.
5. **에셋(모델, 텍스처, 폰트)**: 코드가 MIT여도 에셋은 별도 라이선스다. fable-cities는 "CC0 only"를 표방하나 `THIRD-PARTY-NOTICES.md`로 직접 확인 필요. 에셋은 CC0 / CC-BY(고지 필요)만 허용하고 출처 목록을 repo에 둔다.
6. **라이선스 없음(None) repo**는 기본적으로 all rights reserved이므로 코드 사용 금지(예: MichaelKowal/city-builder, ErencanPelin/ThreeJS-City-Builder).
7. **API가 NOASSERTION인 repo**(Simutrans, OSMBuildings, ssloy/tinyrenderer, SpacetimeDB 등)는 LICENSE 파일을 직접 읽기 전에 사용하지 말 것. Liveblocks는 LICENSE에 두 가지 라이선스가 있음.
8. **AI 생성 코드 repo**(fable-cities 등)는 학습 데이터 출처 불명 코드를 포함할 수 있으므로 코드 복사보다 구조 참고를 권장.
9. **의존성 감사**: CI에 `license-checker` 같은 도구를 넣어 GPL/AGPL 의존성이 전이 의존으로 들어오지 않게 확인한다 (도구 자체는 [미검증]).
10. **서버 네트워크 사용(AGPL)**: 프로젝트가 웹 서비스이므로 AGPL 코드를 서버에서 쓰면 소스 공개 의무가 사용자(네트워크 접속자)에게도 발생한다. AGPL 라이브러리는 서버·클라이언트 모두 사용 금지.

---

## 10. 미검증 / 추가 조사 필요 항목

- GitHub 비인증 API 한도로 확인하지 못한 repo: osm2streets, hocuspocus, react-three-fiber, turf, three-bvh-csg, flatbush 등(존재/수치 미확인).
- OpenTTD 멀티플레이 구조 문서, Cities: Skylines NetNode 구조의 1차 출처.
- three.js WebGPURenderer의 공식 production-ready 선언, BatchedMesh의 WebGPU 동등성.
- Rapier.js 이관 후 위치.
- Babylon vs Three.js의 동일 장면(수천 InstancedMesh 차량) 실측 성능 비교 (프로토타입 필요).
- 수천 대 차량 60fps 목표에 대한 실제 Worker→메인 전송/보간 비용.
