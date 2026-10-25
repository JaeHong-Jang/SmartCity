# Research: 시티빌더·스마트시티 시뮬레이터 레퍼런스 비교
> 결정하려는 것: "시뮬레이터 모드"(돌발 상황 + 도시 전체 반응)를 포함해 다음에 채택할 기능과 순서
> 작성: sc-researcher (Sonnet 5.5) · 2026-10-25
> 선행 문서: `02-traffic-simulation.md`(Incident 타입·Max-Pressure 이미 조사), `09-transit-scramble-zoning.md`, ADR 0009, `roadmap.md` Phase 3

## 요약 (5줄 이내)
1. 시뮬레이터 모드는 "사건(Incident) 이벤트 → 도로 용량 변화 → 재탐색 → 정체 역전파 → 대응 주체(긴급차량·신호·안내) → KPI/타임라인" 한 사이클을 닫는 것이 핵심이다. 이미 있는 `closure.set` 명령과 결정론 sim이 출발점이다.
2. 대부분의 게임은 사고를 "차선 차단 + 지속시간 + 정리 차량 출동"으로 단순화한다. 현실 도구(SUMO)는 "재탐색 장치 + 지수평활 속도"로 우회를 구현한다. 둘 다 우리 구조에 작게 들어간다.
3. 건물 다양성은 "변형 풀 + 결정론적 시드 선택 + 레벨 단계 외관 교체"가 표준이다. 이미 있는 스튜디오 템플릿/주사위/파츠가 재료다.
4. AI가 놓은 건물을 못 찾는 문제는 "알림 목록 + 카메라 이동 + 펄스 하이라이트 + 미확인 배지"로 해결한다 (S 규모).
5. 상위 추천: (a) 사건 레이어+시뮬레이터 모드 MVP, (b) 변경 알림/카메라 점프, (c) 차량 클래스·색상, (d) 건물 변형 풀, (e) 기록/재생.

> 검증 한계: 웹 검색 도구가 위키/포럼 위주로 반환했다. 공식 페이지를 직접 읽은 것은 "검증됨", 검색 요약·기억 기반은 "미검증"으로 표시했다. CS2 내부 수식, SimCity 2013 내부 수치 등은 비공개이므로 수식을 지어내지 않았다.

---

## 0. 현재 코드 상태 (조사 기준선)
| 영역 | 이미 있는 것 | 근거 |
|---|---|---|
| 폐쇄 | `closure.set/remove` (segmentId, reason), sim `closed` 처리 | `packages/shared/src/apply.ts:335`, `commands.ts:51` |
| sim 구조 | `traffic/{signals,intersections,buses,recompile,demand,zones,vehicles}.ts`, `citizens/*`, 결정론+골든 해시 | `packages/sim/src` |
| 신호 | 고정/스크램블 위상, Max-Pressure는 계획(roadmap Phase 2·3) | `docs/adr/0004` |
| 계획 | Phase 3 "incidents 레이어, 정전, 긴급차량, 시나리오 스크립트, KPI" | `docs/roadmap.md` |
| 성능 | tick p95 7~10ms(목표 4ms 미달), 재컴파일 150~210ms | `roadmap.md` Phase 3a |

시사점: 폐쇄·재컴파일 경로가 이미 있으므로 사건 = "시한이 있는 폐쇄/차선 속도 저하 명령"으로 시작하면 신규 기반이 적다. 단, **재컴파일 비용(150ms+)** 때문에 사건마다 전체 재컴파일을 하면 안 된다 (아래 1.7).

---

## 1. 사건·장애 시뮬레이션과 도시 전체 대응 ("시뮬레이터 모드")

### 1.1 레퍼런스별 사건 종류와 대응
| 레퍼런스 | 사건 종류 | 전파/대응 메커니즘 | 플레이어에게 보이는 것 | 출처 |
|---|---|---|---|---|
| Cities: Skylines 2 | 교통사고(젖은 도로·악천후·시간대로 위험 증가), 정체, 정차 차량으로 차선 완전 차단 | 차량은 완전히 막힌 차선을 피해 차선 변경, 긴급차량에 양보 시도. 사고 후 정리는 도로 정비 서비스가 "현장 확보→잔해 제거". 도로 관리 부실이 사고 확률 상승 | 사고 아이콘/알림, 정비·경찰 출동 차량. 긴급차량이 정체에 갇힌다는 불만이 많음(일화적, 초기 버전) | [Paradox 교통 AI](https://www.paradoxinteractive.com/zh-CN/games/cities-skylines-ii/features/traffic-ai), [Steam 토론](https://steamcommunity.com/app/949230/discussions/0/3937895062997914548) (검증: 검색 요약 수준) |
| Cities: Skylines 1 재난 | 토네이도, 지진, 싱크홀, 뇌우, 산불, 건물 붕괴, 건물 화재(옆 건물로 전파), 쓰나미, 운석. 한 재난이 연쇄 유발(운석→바다→쓰나미) | 발생: 무작위/시나리오/플레이어 지정(강도 슬라이더, 종류별 쿨다운). 조기경보 건물(기상 레이더·지진 센서·산불 감시탑·쓰나미 부표·심우주 레이더)의 경보 시간·범위가 **긴급서비스 예산**에 비례. 지진은 지하 인프라 파괴·건물 붕괴, 뇌우는 송전선 파괴·화재, 쓰나미는 침수→건물 방치·도로 차단→서비스/물류 마비 | 재난 탭, 경보, 피해 지도, 대피소 | [Paradox Wiki Disasters](https://skylines.paradoxwikis.com/Disasters) (검증됨, v1.16 기준) |
| SimCity 2013 (GlassBox) | 에이전트 기반 전력·수도·하수·소방·경찰·응급, 재난(괴물·토네이도 등) | 서비스가 "차량 에이전트가 실제로 도로를 달려 도착"하는 방식이라 교통이 응급 대응을 직접 막음. 데이터 맵 오버레이(전력·수도·범죄 등) | 데이터 맵 토글, 서비스 차량 이동 | 미검증(기억 기반; 공식 GDC 글 fetch 실패) |
| Workers & Resources | 전력 부족/그리드 과부하 | 스위치 용량 한계(약 19MW, 포럼 보고), 전력이 끊기면 대중교통이 멈추고 출근이 끊겨 핵심 시설 가동 중단(연쇄 장애). 미연결 구간은 하이라이트 안 됨 | 전력 오버레이로 단절 구간 식별 | [Steam 토론](https://steamcommunity.com/app/784150/discussions/0/3757725715256174268) (플레이어 보고, 미검증) |
| Transport Fever 2 | 사건보다 "노선 적자·정체·대기" 중심 | 노선 관리자(수익/적재율/대기 승객) KPI | 라인 패널, 수입 그래프 | 미검증 (조사 시 해당 정보 미확인) |
| Frostpunk식 위기 피드백 | 추위·불만·희망 같은 **게이지 두 개 + 법령 선택** | 임계치 이벤트로 의사결정 강제 | 상단 게이지, 이벤트 카드 | 미검증(기억 기반) |
| SUMO | 임의 도로/차선 폐쇄, 목적지 변경 | 아래 1.2 | 별도 GUI(sumo-gui) 색상 | [SUMO Rerouter](https://sumo.dlr.de/docs/Simulation/Rerouter.html) (검증됨) |
| SCOOT / SCATS | 사건 자체보다 "수요 변화에 신호 적응" | 아래 1.3 | 관제실 | [Wikipedia SCOOT](https://en.wikipedia.org/wiki/Split_Cycle_Offset_Optimisation_Technique), [Hull 시](https://travel.hull.gov.uk/scoot-urban-traffic-control) (검색 요약, 미검증 부분 있음) |
| Virtual Singapore / 3DEXPERIENCity | 군중 분산·대피 경로, 홍수 분석(지형·건물 지오메트리 사용) | 3D 도시 모델 위 시나리오 시뮬레이션 | 3D 도시 위 오버레이 | [AEC Magazine](https://aecmag.com/features/news-dassault-systemes-helps-build-virtual-singapore/), [GovInsider](https://govinsider.asia/intl-en/article/meet-virtual-singapore-citys-3d-digital-twin) (출시 시기 홍보성 글, 실제 시나리오 결과는 미확인) |
| AnyLogic | 에이전트/이산사건/시스템다이내믹스 혼합 모델 | 미조사 | - | 미검증 (이번 조사에서 근거 못 찾음) |

### 1.2 사건 전파: SUMO의 우회 모델 (공개 규칙)
출처: [SUMO Rerouter](https://sumo.dlr.de/docs/Simulation/Rerouter.html), [Automatic Routing](https://sumo.dlr.de/docs/Demand/Automatic_Routing.html) (둘 다 직접 확인).
- **Rerouter 트리거**: 지정 edge에 차량이 진입하는 순간 동작. 시간 구간(`interval begin/end`)별 액션. 확률 속성(0~1).
- **closingReroute**: "하드"(차종 allow/disallow 지정)는 우회 불가 시 차량이 대기, "소프트"는 우회로가 없으면 무시하고 통과. `until`은 예상 종료 시각.
- **closingLaneReroute**: 한 차선만 권한 변경(반대 방향 두 개로 가변차로 모사).
- **목적지/경유/경로 확률 재배정**: `destProbReroute`, `viaProbReroute`, `routeProbReroute` (정규화 확률).
- **자동 재탐색 장치**: 일부 차량만 장치를 가짐(`probability`), `period`마다 재탐색, 엣지 속도를 지수평활: `v_new = w * v_prev + (1 - w) * v_mean` (`adaptation-weight` = w, 기본 꺼짐; 또는 최근 N=180 스텝 이동평균).
- **알려진 함정(메일링 리스트, 미검증)**: 차량이 트리거 지점에 도달해야 폐쇄를 안다(사전 인지 없음), 해제 후에도 회피가 남아 비현실적 대기열이 생긴 사례.

→ 우리 적용 포인트: ① 차량에 "정보 보유율"(스마트 안내 차량 비율)을 둬서 **우회하는 차량 비율**을 변수로 노출 → 스마트시티 효과 비교 실험 가능. ② 평활 가중치로 경로 진동 방지 (02 문서 1239행의 "즉시 우회 금지" 원칙과 일치).

### 1.3 자동 대응(스마트 시티 기능) 후보
| 대응 | 공개 규칙/원리 | 효과 | 출처 |
|---|---|---|---|
| 적응형 신호 SCOOT | 감지기 유량으로 **스플릿→사이클→오프셋** 순으로 점진 조정, 연동 구역(region) 단위. 고정식 대비 약 15% 개선 주장(인용 필요 표시 있음) | 수요 변동·사고 후 재분배 | [Wikipedia](https://en.wikipedia.org/wiki/Split_Cycle_Offset_Optimisation_Technique) (미검증 수치) |
| 적응형 신호 SCATS | 교차로 그룹을 서브시스템으로 묶고 **핵심 교차로 하나**를 기준으로 나머지가 추종, 저장된 플랜 라이브러리 선택 | 단순·견고 | [Wikipedia SCOOT 비교](https://trid.trb.org/View/203568) (미검증) |
| Max-Pressure | 상류 대기열 − 하류 대기열이 큰 위상 선택(신호 로컬 규칙, 모델 불필요) | 구현 단순, 안정성 증명 있음 | 이미 `02-traffic-simulation.md`·ADR 0004 조사됨(재조사 안 함) |
| 긴급차량 우선 신호 | 접근 시 해당 방향 녹색 보장 + 황색·전적색 보장 | 대응 시간 단축 | roadmap Phase 3 |
| 우회 안내 | 위 SUMO식 재탐색 | 정체 확산 완화 | 1.2 |
| 부하 차단(load shedding) | 전력 부족 시 우선순위 낮은 구역부터 차단 (Workers & Resources의 연쇄 장애가 반면교사) | 전체 정전 방지 | 일반 개념, 미검증 |

### 1.4 도시는 어떻게 "순환"을 보여주는가 (시각화)
공통 패턴:
- **오버레이(데이터 맵)**: 도로 혼잡도(녹→황→적), 전력/수도 연결, 서비스 도달 범위. CS1은 정보 뷰, 재난 시 피해 지도.
- **알림 아이콘**: 건물/도로 위에 떠 있는 문제 아이콘(전력 없음, 화재 등). 클릭 시 해당 위치로 이동. 우리 4번 항목과 동일 UI 재사용 가능.
- **KPI 상단 바**: 평균 통행시간, 정체 길이, 대기 시민, 미응답 사건 수.
- **타임라인/재생**: 다수 게임엔 약함. 디지털 트윈/시뮬레이터의 강점. 우리는 이미 결정론 + 명령 로그라 **무료에 가깝게** 재생 가능.
- **시나리오 비교**: 같은 도시에 같은 사건을 "대응 켬/끔"으로 두 번 돌려 KPI 비교 — 게임에는 거의 없고 연구 도구의 핵심 가치. 우리의 결정론이 직접 활용된다.

### 1.5 사건 유형별 최소 모델 제안 (공식 수식 없음, 아래는 설계안이며 보정 전 값)
| 사건 | 입력 | 효과 | 해제 | 대응 주체 |
|---|---|---|---|---|
| 사고(차선 1개) | 위치(세그먼트, 차선), 지속 T=60~300s | 차선 통과 불가, 나머지 차선 속도 계수 ×0.5(구경꾼 효과 가정, 미보정) | 시한 만료 또는 정리 차량 도착 후 지연 | 경찰·견인(긴급차량), 우회 안내 |
| 공사/폐쇄 | 세그먼트, 시한 | 전 차선 차단(기존 `closure`) | 시한/수동 | 우회 안내 |
| 정전 | 구역(반경) | 신호 소등→비신호 운영(전 방향 일시정지, 기존 12초 게이트 재사용 가능), 건물 창 소등 | 시한 | 복구 차량(선택) |
| 홍수/재난 구역 | 폴리곤 | 구역 내 도로 폐쇄 + 시민 대피 | 시한 | 대피 안내 |
| 수요 급증(행사) | 건물, 시간 | 특정 목적지 유입 급증 | 시한 | 버스 증편 |
| 화재 | 건물 | 소방차 출동(긴급차량), 진압 시간 | 도착+T | 소방 |

정체 역전파(spillback)는 별도 규칙이 필요 없다. 차선 용량이 줄면 IDM 추종 때문에 대기열이 자연히 상류로 자란다. 교차로 예약 시스템이 "하류 막힘 시 진입 금지(박스 방지)"를 이미 하고 있는지가 확인 대상이다 (미확인, 코드 점검 필요).

### 1.6 KPI 정의안 (측정 가능한 것만)
| KPI | 정의 | 데이터원 |
|---|---|---|
| 평균 통행시간 | 완료 여행의 (도착tick − 출발tick) 평균, 슬라이딩 윈도 | 차량/시민 완료 이벤트 |
| 정체 길이 | 속도 < 0.3×제한속도인 세그먼트 길이 합 | 스냅샷 |
| 대응 시간 | 사건 발생 → 긴급차량 도착 | 사건 로그 |
| 우회 비율 | 사건 후 경로가 바뀐 차량 수/전체 | 재탐색 로그 |
| 대기 시민 | 정류장 대기 수 (이미 `busLoad` 스냅샷) | 기존 |
| 복구 시간 | 사건 발생 → 평균 속도 기준선 90% 복귀 | 시계열 |
(주의: 로드맵에도 "실제 교통량 비교 전에는 현실 예측 주장 금지"가 있다. UI에 "게임 모델, 보정 전"을 명시한다.)

### 1.7 우리 프로젝트에 적용
| 항목 | 규모 | 닿는 모듈 | 메모 |
|---|---|---|---|
| **A. 시한 사건 레이어** (사고/공사/정전을 `incident.start`/`end` 명령 + `effectiveTick`) | **M** | `shared/commands.ts`, `apply/*`, `sim/traffic/world.ts`, `recompile.ts` | 기존 `closure`를 일반화. **재컴파일 대신 "차선 속도/통행 가능 플래그"의 틱 단위 오버라이드**로 구현해 150ms 비용 회피 |
| **B. 우회(재탐색) 모델** (SUMO식 정보 보유율 + 지수평활 엣지 시간 + 주기 재탐색) | **M** | `sim/network` A*, `traffic/vehicles.ts`, `demand.ts` | 골든 해시 갱신 필요. 재탐색 폭주 방지: 차량당 쿨다운 |
| **C. 긴급차량 + 우선 신호** | **M~L** | `traffic/vehicles.ts`(클래스), `signals.ts`, `intersections.ts` | 차량 클래스(3번)와 함께 설계. 보행자 충돌 구역 원자 예약과의 상호작용 주의 |
| **D. 정전(신호 소등→비신호)** | **S~M** | `signals.ts`, `traffic/zones.ts`, web 창문 점등 | 비신호 12초 게이트 재사용 |
| **E. KPI 수집 + 대시보드** | **S~M** | `sim/snapshot.ts`, web 현황 패널 | 읽기 전용, 위험 낮음 |
| **F. 시뮬레이터 모드 UI** (도시 사본에서 실행, 사건 팔레트, 일시정지/배속, 대응 켬/끔 A/B) | **M** | web 신규 패널, server는 사본 룸/읽기 전용 모드 | 실제 도시를 오염시키지 않는 **분기(fork) 실행**이 핵심. 체크포인트 직렬화 이미 있음 |
| **G. 적응형 신호 (Max-Pressure)** | **M** | `signals.ts` | 02·ADR 0004에서 이미 설계됨 |
| **H. 기록·재생** | **S** | 명령 로그+체크포인트 재사용 | 결정론이 이미 보장 |

권장 MVP 순서: A → E → B → F(최소) → D → C → G → H. 이유: A·E만 있어도 "도로를 막으면 정체가 퍼지는 것"을 숫자로 볼 수 있고, 이후 항목이 같은 KPI로 효과를 증명한다.

---

## 2. 건물 다양성

### 2.1 레퍼런스
| 기법 | 게임/자료 | 규칙·메커니즘 | 플레이어에게 보이는 것 | 출처 |
|---|---|---|---|---|
| 용도 × 밀도 × 레벨 풀 | CS2 | 주거 6종(저밀·중밀 연립·중밀·혼합(1층 상가)·저임대 등), 상업/산업/사무는 저·고밀. 건물 레벨 1~5, 외관은 **2레벨마다** "저렴→현대적" 교체, 레벨↑ 시 임대료/유지비↑, 중·고밀은 3·5레벨에서 가구 수 증가 | 같은 구역에서도 건물이 성장하며 바뀜 | [Paradox 구역·시그니처](https://www.paradoxinteractive.com/games/cities-skylines-ii/features/zones-signature-buildings) (검증됨) |
| 건축 테마 혼합 | CS2 | 북미/유럽 스타일 한 도시에서 혼합 | 지역색 | 같은 글 |
| 시그니처 건물 | CS2 | 조건(이정표, 행복도, 특정 용도 셀 수)을 만족해야 해금, 도시 내 1회, 무료, 이전 가능, 지역/도시 전체 효과 | 랜드마크, 성취감 | 같은 글 |
| 에셋 팩 | CS2 | 비치 프로퍼티 팩: 건물 60종 + 시그니처 6종 | 콘텐츠 확장 | [Paradox 개발일지](https://paradoxinteractive.com/games/cities-skylines-ii/news/beach-properties-creating-an-asset-pack) (검색 요약) |
| 레벨업 시 점유 면적 | CS1 | 풋프린트 유지, 가구 수만 변경 | - | Steam 포럼 (미검증, CS2 확인 불가) |
| 규칙 기반 조립 | Townscaper | 불규칙 쿼드 격자(육각→쿼드 분할→점 이동/이완), 코너 기반 마칭큐브식 타일, **WFC 인접 규칙**으로 모듈 선택, 모듈 우선순위(정원은 벽과 접할 때만 등장하는 희귀 레시피), 장식(창·벤치·덤불)은 **2단계로 나중에** 적용, 창은 스텐실 버퍼로 절개, 실패 셀은 조용히 비움 | 사용자는 블록만 놓고 아름다운 마을이 나옴 | [Game Developer: How Townscaper works](https://www.gamedeveloper.com/game-platforms/how-townscaper-works-a-story-four-games-in-the-making) (검증됨) |
| 건물 외관 절차 생성 | 일반 | 파사드를 "층 반복 + 베이 + 장식" 문법으로 생성 | - | 미조사 |

### 2.2 우리 프로젝트에 적용
현 자산: 3D 스튜디오(블록, 장식 14종, 주사위 5종, 템플릿, 셀→볼륨 변환), 파사드 셰이더(정점 속성), 설계(타입)별 지오메트리 굽기, 조닝 auto 건물, 성장 레벨업·쇠퇴는 "미룸" 상태.

| 제안 | 규칙 | 규모 | 닿는 모듈 |
|---|---|---|---|
| **변형 풀(variant pool)**: 용도×밀도×레벨별 템플릿 N개(3~6)를 두고 lot에서 **lot id + 시드로 결정론 선택** | 같은 lot은 항상 같은 변형, 이웃 lot 연속 중복 회피(인접이 직전과 같으면 재추첨) | **M** | `shared/growth.ts`, `growthPresets.ts`(프리셋 확장), 서버 GrowthDirector |
| **lot 크기 변형**: 8m 셀 기준 1×1/2×1/2×2 폭 변형 | 연속 빈 셀 수에 맞는 가장 큰 변형을 우선 | **M** | `growth.ts` lot 분할, web 고스트 |
| **레벨업**: 레벨 1~3, 수요·시간 충족 시 같은 풋프린트에서 층수/외관 교체 | CS2처럼 "2레벨마다 외관 교체", 가구 수 증가 | **M~L** | `growth.ts`, `stats.ts`(RCI), 지오메트리 굽기 |
| **색/재질 무작위화**: 정점 속성에 팔레트 인덱스(건물 id 해시) | 팔레트 6~8개 (파사드 셰이더 이미 정점 속성) | **S** | web 건물 렌더(인스턴스 속성), `shared` 해시 |
| **지붕/장식 2단계 적용**: 베이스 매스 먼저, 장식은 후처리 (Townscaper 방식) | 장식 규칙 테이블: 용도·층수·인접 도로 방향 | **S~M** | 스튜디오 주사위 로직 재사용 |
| **시그니처 건물**: 사용자 스튜디오 작품을 "도시당 1개, 조건 해금 랜드마크"로 지정 | 조건 예: 인구 N, 특정 용도 셀 수 | **M** | `model.ts`(필드), web 스튜디오 |
| WFC형 자동 조립 | 필요성 낮음. 스튜디오가 이미 사용자 제어를 제공. 장기 연구 항목 | **L** | 보류 |

권장: 색 팔레트(S) → 변형 풀(M) → 레벨업(M~L). 성능 주의: 설계(타입)별 지오메트리 굽기 개수가 늘면 드로우콜이 증가하므로 변형 수는 처음엔 용도당 3~4개로 제한한다 (실제 GPU 측정 미완 상태).

---

## 3. 차량 다양성

### 3.1 레퍼런스
검색으로 CS2의 공식 차량 모델 개수·LOD 표를 찾지 못했다 (미검증). 확인된 것은 CS1 워크숍 사례(자동차 에셋 1개에 색상 변형 4개, 버스 LOD 커스텀)뿐이다. 아래 표는 업계 일반 관행 + 우리 설계안이며 수치는 근거 아님.

| 항목 | 일반 관행 (미검증) | 근거 |
|---|---|---|
| 차량 클래스 | 승용(세단/해치/SUV), 밴, 트럭(소형/대형), 택시, 버스, 긴급(경찰/소방/구급), 공사/청소 | CS1·CS2 서비스 차량 구성, 일반 지식 |
| 모델 수 | 클래스당 2~5개, 총 15~40개 수준(게임별 상이) | 미검증 |
| 색 변형 | 모델당 팔레트 4~8색, 인스턴스 색을 정점/인스턴스 속성으로 | CS1 워크숍 색 변형 사례 |
| LOD | 근거리 풀 메시 / 원거리 박스+색 점 / 매우 원거리 점 | 일반 관행 |
| 서비스 차량 | 운영 주체가 따로 존재(출동 로직과 결합) | CS2 도로 정비 출동 |

### 3.2 우리 프로젝트에 적용
현 상태: 차량이 인스턴싱 렌더(차량 수천 대 목표), 차종은 타입 에디터에서 정의("건물·차량·도로 타입 에디터").
| 제안 | 규모 | 닿는 모듈 |
|---|---|---|
| 차량 `class` 필드(`car/suv/van/truck/taxi/bus/police/fire/ambulance`)를 sim에 추가: 길이·최대가속·차간거리 파라미터가 클래스별로 다름 (IDM 파라미터 이미 차종별일 가능성, 확인 필요) | **M** | `sim/traffic/vehicles.ts`, `idm.ts`, `types.ts`, 스냅샷 |
| 클래스별 지오메트리 1~2개 + **인스턴스 색상 팔레트** | **S~M** | web 차량 렌더(`InstancedMesh` 그룹을 클래스 단위로) |
| 수요 생성 시 클래스 분포(승용 80%, 밴 8%, 트럭 7%, 택시 5%) — 결정론 RNG | **S** | `demand.ts` |
| 긴급 차량(사이렌/경광등 점멸 애니메이션 없이 색+펄스만) | **M** | 1.7 C와 통합 |
| LOD: 거리 > X에서 단순 박스 | **S** | web (GPU 측정 후 필요성 판단) |
스냅샷 포맷 변경은 골든 해시에 영향을 주므로 클래스는 **스냅샷에 u8 한 칸 추가**로 최소화한다.

---

## 4. 새로 만든/바뀐 것의 피드백 (AI가 놓은 건물을 못 찾는 문제)

### 4.1 레퍼런스 패턴
| 패턴 | 사례 | 설명 | 출처 |
|---|---|---|---|
| 월드 알림 아이콘 | CS1/CS2 | 건물/도로 위 떠 있는 아이콘, 클릭 시 포커스. 모드가 "일반 알림 숨기기/중요 알림만 표시"를 추가할 만큼 수가 많음 → **우선순위 필터 필요** | [Steam 워크숍 변경 로그](https://steamcommunity.com/sharedfiles/filedetails/changelog/1764637396?p=3) (검색 요약) |
| 카메라 이동 | 4X/시티빌더 일반 | 알림 클릭 → 부드러운 카메라 이동 + 선택. Civ류의 "새 도시로 카메라 점프"도 같은 패턴 | [CivFanatics](https://forums.civfanatics.com/threads/camera-skip-to-newly-found-cities.604880) (미검증) |
| 변경 하이라이트 | 협업 도구(Figma 등) | 변경 요소 펄스 테두리 + 작성자 색 | 일반 관행, 미검증 |
| 이력 패널 | 협업 앱 | "누가 무엇을 언제" 목록, 항목 클릭 시 이동 | 일반 관행 |
교훈: 알림이 너무 많으면 사용자가 끈다 → 요약/묶음(예: "AI가 건물 7개 배치") + 미확인 배지.

### 4.2 우리 프로젝트에 적용
현재 AI 도우미는 다중 고스트 미리보기 후 승인 적용(ADR 0009). 승인 이후 위치 안내가 없는 것이 문제.
| 제안 | 동작 | 규모 | 닿는 모듈 |
|---|---|---|---|
| **변경 이벤트 피드** | 서버가 이미 순서화한 명령을 `{작성자, 종류, 대상 id 목록, bbox, tick}`로 요약해 클라이언트 목록에 쌓음 | **S** | web `useDoc` 계층, 패널 신규 |
| **"위치 보기" 카메라 점프** | 묶음 bbox에 맞춰 0.6s 이징으로 팬/줌 | **S** | web 카메라 컨트롤러 |
| **펄스 하이라이트** | 적용 직후 대상 인스턴스 외곽선/밝기 3s 펄스 (프레즌스 피어 색 재사용) | **S** | web 건물 렌더 오버레이 |
| **AI 적용 결과 토스트 + 버튼** | "건물 7개·구역 3개 배치됨 [보기]" | **S** | AI 도우미 패널 |
| **미확인 배지/미니맵 점** | 화면 밖 변경은 가장자리 화살표 | **S~M** | web HUD |
| 원격 사용자의 변경도 동일 처리 | 협업 UX(피어 선택 표시)와 통일 | **S** | 동일 |
→ 전체 **S~M**. 사건 알림(1.4)과 같은 컴포넌트를 쓰도록 `Notification {kind, targetBBox, severity}` 하나로 설계하면 시뮬레이터 모드에서도 재사용된다.

---

## 5. 기타 고가치 기능 TOP 5 (현재 부재 기준)
| 순위 | 기능 | 근거(레퍼런스) | 규모 | 닿는 모듈 |
|---|---|---|---|---|
| 1 | **시간 제어 + 기록/재생 + A/B 시나리오 비교** | 결정론+명령 로그 보유 → 연구용 디지털 트윈의 핵심 가치를 거의 무료로 확보. 게임엔 드묾 | S~M | server 로그/체크포인트, web 타임라인 |
| 2 | **서비스 커버리지 + 데이터 맵 오버레이**(소방/경찰/응급/전력 도달 범위, 혼잡도) | CS1 정보 뷰, SimCity 데이터 맵, W&R 전력 오버레이 | M | `shared/stats.ts`, web 오버레이 |
| 3 | **유틸리티 네트워크(전력/수도) 최소 모델**: 연결성 + 용량 + 정전 시 건물 소등 | CS1 재난(송전선 파괴), W&R 연쇄 장애(용량 한계·출근 중단) | M~L | `shared/model.ts`, sim 신규 레이어 |
| 4 | **조닝 성장 레벨업·쇠퇴** + 지가/만족도 (이미 "미룸" 항목) | CS2 레벨 1~5, 수요 | M | `growth.ts`, `stats.ts` |
| 5 | **대중교통 고도화**: 환승, 노선 KPI 패널(적재율·대기·수익) | Transport Fever 2 노선 관리자(미검증), 이미 "환승 미룸" | M | `sim/citizens/transit.ts`, `buses.ts` |
(차점: 지형 높이맵, 날씨(비→사고 확률↑, CS2 사례), 소음/오염 오버레이)

날씨 → 사고율 연결은 CS2가 공개한 사실(젖은 도로·악천후가 사고 위험 증가)이며, 사건 모델의 확률 입력으로 저비용 추가 가능(S, 낮밤 시계 모듈에 의존).

---

## 선택지 비교 (시뮬레이터 모드 접근)
| 선택지 | 장점 | 단점 | 사례/근거 |
|---|---|---|---|
| (1) 게임식: 랜덤 사건 + 알림 + 서비스 차량 | 몰입, 구현 예측 쉬움 | 반복 실험 어려움 | CS1/CS2/SimCity |
| (2) 연구식: 사용자가 사건 지정, 대응 켬/끔 A/B, KPI | 우리 결정론과 궁합 최고, 졸업/발표용 설득력 | 게임성 약함 | SUMO, 디지털 트윈 |
| (3) 혼합(권장): 도시 사본 위에서 (2)를 실행하되 UI는 (1)의 알림·오버레이 | 둘 다 확보 | UI 작업량 증가 | 본 문서 1.7 F |

## 권장안 (MVP / 후속)
**MVP (1~2 스프린트)**: 1.7 A(시한 사건: 차선 속도/통행불가 오버라이드), E(KPI 4개: 통행시간·정체 길이·우회 비율·복구 시간), 4.2 변경 피드+카메라 점프+펄스(AI 건물 찾기 즉시 해결), 색 팔레트(2.2).
**후속**: B 우회 모델 → F 사본 분기 실행 + A/B → D 정전 → C 긴급차량+우선 신호 → G Max-Pressure → 변형 풀/레벨업 → 차량 클래스.

## 근거 자료 (링크, 검증 상태)
- 검증됨(페이지 직접 확인): [SUMO Rerouter](https://sumo.dlr.de/docs/Simulation/Rerouter.html), [SUMO Automatic Routing](https://sumo.dlr.de/docs/Demand/Automatic_Routing.html), [CS1 Disasters (Paradox Wiki)](https://skylines.paradoxwikis.com/Disasters), [CS2 Zones & Signature Buildings](https://www.paradoxinteractive.com/games/cities-skylines-ii/features/zones-signature-buildings), [How Townscaper works](https://www.gamedeveloper.com/game-platforms/how-townscaper-works-a-story-four-games-in-the-making)
- 검색 요약만 확인(미검증 세부 포함): [CS2 Traffic AI](https://www.paradoxinteractive.com/zh-CN/games/cities-skylines-ii/features/traffic-ai), [SCOOT Wikipedia](https://en.wikipedia.org/wiki/Split_Cycle_Offset_Optimisation_Technique), [Hull SCOOT](https://travel.hull.gov.uk/scoot-urban-traffic-control), [TRID SCAT vs SCOOT](https://trid.trb.org/View/203568), [AEC Magazine Virtual Singapore](https://aecmag.com/features/news-dassault-systemes-helps-build-virtual-singapore/), [GovInsider Virtual Singapore](https://govinsider.asia/intl-en/article/meet-virtual-singapore-citys-3d-digital-twin), [Beach Properties 개발일지](https://paradoxinteractive.com/games/cities-skylines-ii/news/beach-properties-creating-an-asset-pack), [Steam W&R 전력 토론](https://steamcommunity.com/app/784150/discussions/0/3757725715256174268), [SUMO 사건 평가 논문(Coventry)](https://pureportal.coventry.ac.uk/en/publications/a-sumo-based-evaluation-of-road-incidents-impact-on-traffic-conge/)
- 못 확인(기억 기반 또는 근거 없음): SimCity 2013 GlassBox 세부(GDC 페이지 fetch 실패), Transport Fever 2, Frostpunk, AnyLogic, CS2 차량 모델 수/LOD.
- 라이선스: SUMO(EPL-2.0), 그 외는 게임/문서이므로 **코드를 가져오지 않고 메커니즘만 기술**했다. 위 어느 구현도 복사하지 않았다.

## 위험과 미해결 질문
1. 성능: tick p95가 이미 목표 초과(7~10ms). 재탐색 주기·사건 오버라이드는 증분 방식이 아니면 악화된다. 추가 전 `bench.test.ts` 기준선 확보.
2. 골든 해시: 사건·차량 클래스·재탐색은 모두 스냅샷/RNG 소비를 바꾼다. 기능 플래그 뒤에서 도입하거나 골든 재생성을 계획에 포함.
3. 현실성 주장: 사고 속도 계수·지속시간은 미보정 가정값이다. UI에 "게임 모델" 표기, 실데이터 비교는 후순위(로드맵과 일치).
4. 확인 필요(코드 점검): 교차로 예약이 하류 막힘 시 진입 금지(박스 방지)를 하는가, IDM 파라미터가 차종별인가.
5. 시뮬레이터 모드가 실제 도시를 오염시키지 않도록 사본(fork) 격리 방식(서버 룸 복제 vs 클라 워커 로컬 실행)을 ADR로 결정해야 한다. 클라 워커 로컬 실행이 협업 서버 부하 면에서 유리해 보이나 미검증.
6. 공동 편집 중 사건 시뮬레이션 상태를 모든 사용자에게 보일지(공유) 개인 실험으로 둘지 결정 필요.
