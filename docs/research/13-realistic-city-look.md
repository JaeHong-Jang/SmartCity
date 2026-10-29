# Research: 미니어처가 아닌 "실제 도시" 외관 + 렌더 성능 예산
> 결정하려는 것: 현재 "넓은 초록 평면 위의 작은 도시 덩어리" 화면을 실제 도시처럼 보이게 하려면 무엇을 어떤 순서로 바꿀지, 그리고 60fps(노트북 iGPU)를 지키는 예산
> 작성: sc-researcher (Sonnet 5.5) · 2026-10-29
> 선행 문서: `10-citysim-references.md`, `07-citizens-street-rendering-oss.md`, ADR 0005(렌더링), `12-smooth-roads-curved-buildings.md`

## 요약 (5줄 이내)
1. 미니어처처럼 보이는 가장 큰 원인은 (a) 카메라가 멀고 높아서 도시가 화면의 작은 부분을 차지하고, (b) 도시 밖이 끝없이 빈 균일 초록 평면이며, (c) 안개·그림자·창문 등 "크기 단서"가 약하다는 점이다. 코드상 사실: 건설 영역 halfSize 2000 m(4 km 정사각형), 카메라 FOV 50°·최대 거리 2500 m, 안개 1400~5200 m, 지면 약 12 km 평면 한 장.
2. 학술적으로 "흐림(블러) 그래디언트가 대상을 가깝고 작다고 느끼게 한다"는 근거가 있다(Meese 외 2012). 우리는 블러를 쓰지 않으므로 반대 방향, 즉 먼 거리에 대기 원근(안개)과 선명한 전경 디테일을 두는 것이 정석이다. 단, SimCity(2013)는 일부러 틸트시프트 미니어처 룩을 택했다 — 우리는 그 반대 목표임을 팀이 합의해야 한다.
3. 즉시 효과(빠른 개선, 성능 비용 거의 0): 지평선 안개 재설정 + 지면 색·텍스처 변주, 지면 가장자리 숨기기, 카메라 기본 높이·FOV·기울기 조정, 색 채도 낮추기, 하늘 그라디언트. 
4. 중간 규모: 가로수·가로등 인스턴싱, 창문 셰이더 패턴, 블록 지면(주차장·공원) 변주, 먼 스카이라인 임포스터.
5. 성능은 Cities: Skylines II가 반면교사다(독립 분석 기준 한 프레임 6705 드로 콜 중 그림자 패스가 4828, 72%). 우리는 "그림자 캐스터 제한 + 인스턴싱 + 거리 컬링"으로 드로 콜을 수백 개 이하로 묶는다.

> 검증 한계: 이 환경의 검색 도구는 요약만 돌려주는 경우가 많았다. 페이지를 직접 열어 확인한 것은 "검증됨", 검색 요약만 본 것은 "요약만", 기억·일반 지식은 "미검증"으로 표시했다. 특히 Cities: Skylines I/II·Townscaper 개발자가 "현실감을 위해 X를 했다"고 직접 말한 1차 자료(GDC 영상·개발 일기)는 이번에 확보하지 못했다. 그런 항목은 아래에서 일부러 근거 없이 단정하지 않았다.

---

## 0. 현재 렌더러 상태 (코드 확인)
| 항목 | 현재 값 | 위치 |
|---|---|---|
| 건설 영역 | `halfSize: 2000` (4 km × 4 km) | `packages/shared/src/defaults.ts:215` |
| 지면 | `halfSize*2 + 8000` = 12 km 평면 1장, 단색 `#5f7a4e` + 8 m/64 m 셰이더 격자, 영역 밖은 어둡고 탈채도 | `render/ground.ts` |
| 카메라 | `PerspectiveCamera(50°, near 줌 비례 0.5~60, far ≥ 6000)`, 거리 20~2500 m, 최대 극각 π/2−0.08, 기본 시작 (-180,260,260)→원점 | `render/camera.ts` |
| 안개 | `THREE.Fog(sky, 1400, 5200)` — 선형, 하늘색과 동일 | `CityRenderer.ts:86` |
| 조명 | HemisphereLight 1.25 + 그림자 태양 2.2, 그림자 맵 2048 한 장(PCF), 프러스텀은 카메라 거리 기반 120~900 m | `CityRenderer.ts`, `sceneKit.ts` |
| 톤매핑 | ACESFilmic, exposure 1.05, DPR ≤ 2, 안티에일리어싱 켬 | `sceneKit.ts` |
| 건물 | 타입별 `InstancedMesh` + 공용 외벽 재질, 창문 점등 인스턴스 속성(야간) | `render/buildings.ts` |
| 차량 | 차종별 `InstancedMesh`, 정점 색 | `render/vehicles.ts` |
| 도로 | 청크 메시, 인도·연석·차선 표시, 횡단보도·과속방지턱 지오메트리 포함 | `render/roads.ts`, `streetMarks.ts` |
| 없는 것 | 가로수·가로등 모델(코드 검색 미발견, 미검증), 후처리(AO/블룸/DoF), 먼 도시 임포스터, 지면 텍스처 변주 | — |

진단: 스크린샷의 "초록 평면 위 작은 도시"는 위 표만으로 설명된다. 도시가 차지하는 영역(실제로는 건설된 극히 일부)이 4 km 사각형의 일부에 불과한데 카메라는 수백 m~2.5 km 위에서 FOV 50°로 내려다보고, 지평선까지 12 km짜리 균일 초록 평면이 보이며 안개는 1.4 km에서야 시작한다. 모든 거리에서 "크기 기준점"이 되는 요소(가로수, 가로등, 사람)가 없다.

---

## 1. 왜 미니어처로 보이는가, 어떤 단서가 고치는가

### 1.1 핵심 메커니즘 (근거 있음)
- **블러/깊이 단서**: Meese, Baker, Summers (i-Perception, 2012) 연구는 합성 틸트시프트(위아래 블러 그래디언트)가 실제 장면을 모형처럼 보이게 하며, 블러가 "대상이 가깝고 따라서 작다"는 깊이 단서로 작용한다고 설명한다. (검색 요약만. 원문 링크 아래.) 같은 맥락에서 "얕은 피사계 심도 + 높은 시점"이 미니어처 느낌을 만든다는 설명은 여러 블로그가 반복한다(품질 낮음).
- **밝고 균일한 조명**이 "모형 사진"의 기대와 맞아 미니어처 효과를 돕는다는 지적(Weburbanist, 블로그). 반대로 말하면 현실감을 원하면 강한 방향성 그림자·대기 감쇠·색 다양성이 필요하다. (해석: 이 줄은 출처 문장에서 내가 도출한 추론)
- **SimCity(2013)는 일부러 미니어처를 택했다**: Digital Trends·Gameswelt 프리뷰가 틸트시프트 사진에서 영감을 받아 "가상 도시를 축척 모형처럼 보이게" 했다고 보도, Will Wright 발언을 Softpedia가 인용. 기술적으로 DX9, 피사계 심도, 하늘 시뮬레이션 기반 구면조화(SH) 조명을 썼다고 PC Games Hardware 인터뷰가 전한다(독일어, 요약만). → 우리가 지금 가진 "미니어처 인상"은 장르의 정통 미학이기도 하다. "더 현실적으로" 가려면 의식적으로 반대로 가야 한다.

### 1.2 단서별 처방 (이름은 단서, 근거 수준은 각 줄에 표시)
| 단서 | 현실감을 주는 방향 | 우리 코드에서의 의미 | 근거 수준 |
|---|---|---|---|
| **카메라 FOV·높이** | 더 좁은 FOV(30~40°)는 원경이 평평해져 "망원 미니어처" 느낌이 될 수 있고, 지나치게 넓으면 왜곡. 가장 큰 요인은 높이: 같은 도시도 지붕 위 30~80 m에서 내려다보면 실물로 느껴짐 | 기본 시작 높이 260 m, 거리 상한 2500 m. 기본/자동 맞춤 거리를 낮추고 "도시 생성 직후 도시 한복판으로 이동" | 일반 원리(미검증). FOV 수치는 실험으로 정할 것 |
| **눈높이 vs 탑다운** | 보행자·차량 눈높이(낮은 극각)에서 건물 입면이 크게 보여야 규모가 전달됨. 탑다운은 크기 단서가 적음 | 최대 극각이 이미 수평 직전(π/2−0.08)까지 가능 → 저고도 프리셋 단축키만 있으면 됨 | 일반 원리(미검증) |
| **대기 원근(안개)** | 멀수록 채도·대비 감소, 푸른 기운. 건물이 스카이라인 쪽에서 하늘색에 녹아야 거리감 | 현재 안개 1400~5200 m는 4 km 영역에도 너무 멀다 → 카메라-도시 거리와 연동해 near를 줄이고 `FogExp2` 또는 곡선 감쇠 검토 | 원리 일반적(미검증). three.js `Fog`/`FogExp2` 존재는 공식 문서로 확인 가능 |
| **규모 단서(인도·연석·차선·가로수·가로등·사람·차)** | 사람 1.7 m, 차 4.5 m, 차선 3.0~3.5 m, 가로등 8~10 m, 가로수 6~12 m, 층고 3~3.5 m가 정확해야 건물 크기가 읽힘. 같은 요소가 반복되면 눈금자 역할 | 인도·연석·차선·횡단보도는 이미 있음(`roads.ts`). 가로수·가로등이 없음. 보행자·차량은 있음 | 인체 치수는 일반 상식, 도시 설계 치수는 미검증 |
| **조명·그림자** | 낮은 태양각(30~50°)의 긴 그림자가 입체감과 규모 단서. 그림자의 부드러운 반그림자는 큰 광원(태양 각크기) 느낌. AO(건물 밑·골목 어두움)가 접지감 제공. Hemisphere 하늘/지면 색 차이가 외벽 음영을 자연스럽게 | 이미 태양 1개 + 헤미스피어 + PCF 그림자. 태양각은 `dayNight.ts`가 시간대로 결정. AO 없음 → 정점 색/바닥 접지 그라디언트(프리베이크 AO)가 값싼 대안 | 일반 원리(미검증). 공식: three.js `HemisphereLight` 문서 |
| **색·채도** | 미니어처/장난감 룩은 높은 채도·균일한 파스텔. 실제 도시는 회갈색 콘크리트·아스팔트·탁한 녹지에 소수의 포인트 색 | 지면 `#5f7a4e`와 하늘 `#aecbe0`가 균일. 건물 톤 변조는 있음(`buildingTone.ts`). 색 보정(채도 −10~25%, 대비 소폭 +)은 거의 무비용 | 일반 원리 + Weburbanist 간접. 구체 퍼센트는 실험 필요(미검증) |
| **건물 디테일** | 창문 격자(층고 리듬), 1층 상가·차양, 옥상 설비(실외기·물탱크·엘리베이터 기계실), 고저 변화·후퇴(setback), 건물 간 키 차이 | 창문 점등 속성·외벽 톤 변조·곡면 건물까지 있음. 옥상 설비 부재는 코드로 확인하지 못함(미검증) | Cities: Skylines After Dark가 "모든 건물에 창 점등용 텍스처 레이어 추가"(검색 요약, Gameluster/PC Gamer) |
| **지면 다양성** | 블록 내부 포장(보도·주차장·광장), 공원 잔디 변주, 나대지, 구획 경계 | 현재 지면은 단색 한 장 → 가장 큰 "비현실" 요인 | 일반 원리(미검증) |
| **지평선·스카이라인** | 도시 밖을 비우지 말고 흐릿한 먼 도시 실루엣·언덕·구름. 지형 경계를 안개와 하늘로 뭉개 지평선이 선으로 보이지 않게 | 지면 12 km 사각형 가장자리가 안개(5200 m)와 안 맞으면 선이 보일 수 있음 | 일반 원리(미검증) |
| **야간 조명** | 가로등 점 광원(빌보드 글로우), 창문 점등 분포의 불균일, 차량 헤드라이트, 신호등 | 창문 점등·정전 레이어는 이미 있음. 가로등 부재 | Cities: Skylines After Dark 창 점등 사례(요약) |

### 1.3 게임별 참고 (확인된 것만)
- **Cities: Skylines II**: Photo Mode가 DoF·모션블러·블룸·비네팅·필름 그레인과 거리 구름·체적 구름·안개·대기 조절을 제공(Neowin이 요약한 Colossal Order 개발 일기). 성능 면에서는 독립 분석(Paavo Huhtala)이 한 프레임 약 87.8 ms, 드로 콜 6705(그림자 4828 = 72%), 입력 정점 약 1.21억, 래스터 삼각형 약 3,600만, 프러스텀 컬링만 있고 오클루전 컬링 없음, 모든 3D 객체가 그림자 캐스터, 그림자 4캐스케이드×2048², 일부 소품은 LOD 없음이라고 보고(검증됨: 페이지 직접 확인). → 교훈은 "디테일 때문에 느려지는 게 아니라 LOD·컬링·그림자 범위 부재 때문"이다.
- **Cities: Skylines (I)**: After Dark 확장에서 모든 건물에 창 점등 텍스처 레이어를 추가(검색 요약, 1차 개발 일기 직접 확인 못함 — 미검증).
- **SimCity 2013 / GlassBox**: 시뮬레이션이 에이전트 기반(자원·유닛·맵·글로벌)이며 수만 에이전트를 시뮬레이션(Andrew Willmott "Inside GlassBox", GDC 2012; PC Gamer 기사 요약). 렌더링 외관 자체는 위 틸트시프트 보도가 근거. 슬라이드 PDF 링크는 Willmott 페이지에 있으나 내용은 열어 보지 못했다(미검증).
- **Townscaper**: Stålberg 인터뷰는 "저사양에서도 좋아 보이는 아트 스타일 개발이 가장 큰 과제 중 하나"라고 말한다(Substack 요약). 조명·AO 구현에 대한 직접 자료는 확보 못함(미검증). → 단순한 팔레트와 일관된 조명의 가치만 확인 가능.
- **Citybound / A/B Street**: A/B Street은 OSM 기반 차선 단위 렌더링과 시뮬레이션 비교(OSM Wiki). 외관 현실감 관련 개발자 글은 확보하지 못했다(미검증).

---

## 2. 브라우저에서 큰/현실적인 도시를 그리는 사례와 기법
| 사례 | 기법 | 우리에게의 시사점 | 근거 |
|---|---|---|---|
| three.js "procedural city" (Jerome Etienne, "How to do a procedural city in 100 lines") | 무작위 크기·위치의 큐브 약 2만 개를 **병합 지오메트리 한 덩어리**로 | 병합 = 드로 콜 1. 단 정점 단위 편집·그림자 비용은 별도 | DZone 요약(검색), 원문 미확인 |
| Infinitown (Little Workshop) | 유한한 블록 격자를 재활용하며 카메라가 감아 도는 "무한 도시" | 먼 배경을 위해 **블록 타일 재사용** 아이디어. 인스턴싱 여부는 미확인 | 프로젝트 페이지 요약; 인스턴싱 확인 못함 |
| Mapbox GL JS / MapLibre `fill-extrusion` | 벡터 타일의 건물 폴리곤을 높이로 밀어 올림, 줌에 따라 `minzoom` 15(Mapbox 예제)/13(Stadia MapLibre 튜토리얼) 이상에서만 표시 | **줌 기반 표시/숨김**과 타일 단위 스트리밍. 단순 조명 | Mapbox 예제, Stadia 튜토리얼 |
| deck.gl | 인스턴싱 기반 레이어(수십만 개 원/기둥), 데이터는 속성 버퍼 | "한 지오메트리 × 속성 배열" 패턴이 우리 `InstancedMesh`와 동일 | Uber 블로그(요약) |
| CesiumJS / 3D Tiles | 계층 LOD + 화면 공간 오차(SSE) 기반 타일 선택, `dynamicScreenSpaceError`로 먼 타일 저해상 | 우리 도시는 작아서 과하지만 "거리·화면 크기로 LOD 선택"의 모범 | Cesium 공식 `Cesium3DTileset` 문서(요약) |
| Google Photorealistic 3D Tiles | 3D Tiles를 CesiumJS나 three.js(NASA 3DTilesRendererJS)로 렌더 | **우리 용도(가짜 도시 배경)로는 부적합**: Map Tiles API 정책상 시각화 전용, 캐시·오프라인·추출 금지, 로고·데이터 출처 표시 필수, 타일에서 파생한 3D 객체 금지(검증됨: 정책 페이지 직접 확인). 게임에 대한 언급은 없음 | 정책 페이지 |
| NASA-AMMOS 3DTilesRendererJS | three.js용 3D Tiles 구현, Apache-2.0, Google 타일 예제 포함 | 필요 시 자체 타일(예: 자체 제작 원경 데이터)을 올리는 용도 | GitHub/npm(요약) |
| 건물 창문 텍스처 | Shamus Young의 절차 도시: 64×64 창 격자 텍스처를 건물들이 공유 | **텍스처 아틀라스/공유 격자**로 창문 | Shamus Young 블로그(검색 요약) |

기법 정리: (1) 인스턴싱, (2) 병합 지오메트리, (3) LOD/타일 SSE, (4) 임포스터·빌보드(원경) — 일반 기법으로 위 사례 일부가 시사하나 임포스터 사용을 명시한 1차 자료는 확인 못했다(미검증), (5) 텍스처 아틀라스·셰이더 기반 창문, (6) 프러스텀·오클루전 컬링(CS2 분석이 "오클루전 없음"이 병목 요인이라 시사).

---

## 3. 성능 예산 (우리 스택)

### 3.1 목표 (제안, 실측 필요 — 미검증)
아래 숫자는 일반 경험칙에 기반한 **제안 시작값**이며 공식 보증 수치가 아니다. 첫 작업은 현재 값을 측정하는 것이다.
| 항목 | 목표 (노트북 iGPU, 1080p, 60fps) | 비고 |
|---|---|---|
| 드로 콜 | 메인 패스 ≤ 300, 그림자 패스 ≤ 100 | CS2 분석: 그림자가 72%를 차지한 사례 → 그림자 캐스터를 제한 |
| 삼각형 | 화면당 ≤ 1.5~2 M (보이는 것 기준) | 건물 곡면화(Phase 5d)로 늘 수 있음 → 측정 |
| 그림자 | 맵 1장 2048, 카메라 근처 프러스텀만 | 캐스케이드는 ‘필요 시’ |
| 프레임 | 프레임 16.6 ms 중 JS 4~6 ms 이하, sim은 워커라 메인 스레드 영향 최소 | roadmap에 sim tick p95 7~10 ms로 기록(워커) |
| DPR | 최대 1.5~2 (현재 `min(dpr,2)`) | iGPU에서는 1.5 상한 + 동적 해상도 고려 |

### 3.2 three.js 기법과 구체 API (공식 문서 확인한 것 표시)
- **`InstancedMesh`**(검증됨): `boundingSphere`가 있고 엔진이 프러스텀 컬링에 자동으로 계산한다. 하지만 `setMatrixAt`로 변환을 바꾸면 캐시된 구가 낡을 수 있어 `computeBoundingSphere()`를 다시 불러야 잘못된 컬링을 막는다. 인스턴스 *개별* 컬링은 안 됨 — 전체 구 하나만 본다. 우리 `buildings.ts`/`vehicles.ts`는 타입당 하나이므로 도시 전역이 한 구에 들어가 컬링이 사실상 안 된다. → 구역(청크)별로 `InstancedMesh`를 나누면 컬링이 살아난다(중간 규모 작업).
- **`BatchedMesh`**(검증됨): `new BatchedMesh(maxInstanceCount, maxVertexCount, maxIndexCount, material)`. `perObjectFrustumCulled`(기본 true), `sortObjects`(기본 true), `setVisibleAt(id, bool)`, `setGeometryIdAt(...)`, `optimize()`. 공식 문서에 LOD API는 없다. 다른 지오메트리를 한 드로 콜로 묶으니 *건물 형태가 다양한* 우리 경우에 맞는 후보지만, 인스턴스 개별 색/속성(우리의 `occ`, `tone` 인스턴스 속성)과의 호환은 확인 필요(미검증).
- **`BufferGeometryUtils.mergeGeometries`**(공식 문서 존재 확인): 정적 요소(가로수 가지·간판 등)를 청크 단위로 병합. 속성 구성이 같아야 하고 인터리브 속성 미지원이라는 포럼 보고가 있음(요약만).
- **`Object3D.frustumCulled`**: 청크 메시에 기본 true. 청크마다 `boundingSphere` 정확성 확인. 
- **LOD**: `THREE.LOD`는 객체 단위 거리 전환(공식 API; 본 조사에서 문서 직접 확인은 못함). 인스턴싱과 직접 결합이 안 되므로, 거리별로 인스턴스 버퍼를 *다른* InstancedMesh(저정밀)에 분배하는 패턴을 쓴다. 서드파티 InstancedMesh2(three.ez)가 인스턴스별 컬링·LOD를 제공(포럼 요약, 의존성 추가는 별도 판단).
- **셰이더 창문**: 외벽 재질의 `onBeforeCompile`(지면 격자가 이미 사용 중인 방식)로 월드 좌표/UV에서 창 격자를 프래그먼트에서 그린다. 텍스처 없이 해상도 무관, 야간은 기존 `occ` 속성으로 점등. 지오메트리 변경 0.
- **그림자**: 캐스케이드(CSM)는 three.js 애드온이 있으나 패스 수만큼 비용 증가 → 우리처럼 줌 비례 프러스텀 한 장(`updateSun`)이 현실적. 개선: 줌이 멀 때 그림자를 끄거나 해상도를 낮추기, 소형 객체(차량·보행자)는 캐스터 제외. 텍셀 스냅(그림자 카메라 이동을 텍셀 격자에 맞춤)으로 카메라 이동 시 그림자 일렁임 방지(일반 기법, 미검증).
- **`renderer.info`**: 이미 `autoReset=false`로 쓰고 있다. `calls`, `triangles`, `geometries`, `textures`로 프레임별 측정.

### 3.3 측정 방법
1. 기준선: 동일 도시 문서 + 고정 카메라 3종(탑다운 원거리, 중간, 눈높이)에서 `renderer.info.render.calls/triangles` 기록(이미 통계 코드 있음 — `CityRenderer.ts`의 stat 수집).
2. 프레임 타임: `performance.now()` 이동평균 + 90/99퍼센타일. `EXT_disjoint_timer_query_webgl2` GPU 타이머는 지원 가변(미검증).
3. Chrome DevTools Performance·Spector.js로 패스별 드로 콜 확인(Spector 설명은 미검증).
4. 변경 전후 스크린샷 비교(Playwright e2e 이미 있음) + 프레임 통계 비교를 PR 증거로 첨부.
5. iGPU 노트북 한 대를 기준기로 고정(예: 팀원 노트북) — 데스크톱 GPU 결과로 판단하지 않는다.

---

## 4. 제안 (우선순위)

### 4.1 빠른 개선 (S, 비용 거의 0, 위험 낮음)
| # | 항목 | 시각 효과 | 성능 | 위험 |
|---|---|---|---|---|
| Q1 | 안개 재조정: 가까운 시작 ~400~800 m, 먼 끝 ~3500 m 정도에서 지평선이 하늘색에 녹도록(수치는 시각 확인 후 결정). 하늘색-안개색 일치 유지, 야간은 이미 `dayNight`가 갱신 | 큼 (대기 원근, 지평선 선 제거) | 0 | 낮음 — 조작 시 거리 많이 멀리 보기 어려워질 수 있음 |
| Q2 | 지면 색 변주: 영역 밖은 현재 어둡고 탈채도 → 대신 *완만한 노이즈로 색·명도 변주*(프래그먼트 셰이더에 2~3옥타브 value noise), 도시 영역 안은 잔디/나대지 섞기 | 큼 (균일 평면 제거) | 거의 0 (프래그먼트 몇 연산) | 낮음 |
| Q3 | 색 보정: 하늘·지면·헤미스피어 채도 소폭 낮춤, 톤매핑 exposure 재튜닝 | 중 | 0 | 낮음 (취향) |
| Q4 | 카메라 기본값: 시작 거리 축소, 도시 영역(건물/도로 바운딩)에 자동 맞춤 버튼, 눈높이 프리셋(F 키 등) | 중~큼 (규모감) | 0 | 낮음 |
| Q5 | 하늘 그라디언트: `scene.background`를 단색→수직 그라디언트(작은 캔버스 텍스처 또는 구체 셰이더), 지평선 가까이 밝게 | 중 | 0 | 낮음 |
| Q6 | 그림자 캐스터 정리: 차량·보행자 `castShadow=false`(현재 상태는 확인 필요), 멀리 줌아웃 시 그림자 끄기 | 성능 이득 | 이득 | 낮음 |

### 4.2 중간 규모 (M, 며칠)
| # | 항목 | 시각 효과 | 성능 | 위험 |
|---|---|---|---|---|
| M1 | **가로수·가로등 인스턴싱**: 도로 세그먼트 인도 위에 결정적 간격으로 배치(시드 해시), 모델 2~3종 `InstancedMesh`. 렌더 전용(sim 불변) | 큼 (규모 눈금자) | 드로 콜 +3~5, 삼각형 수 개당 100~300 이하로 제한 | 중 — 편집 시 재배치 비용, 도로 변경 시 dirty 처리(`dirty.ts`) |
| M2 | **셰이더 창문/층 리듬**: 외벽 재질 `onBeforeCompile`로 창 격자·층선·1층 상가 띠, 야간 점등은 기존 `occ` 연결 | 큼 (건물 규모) | 프래그먼트 비용 약간 | 중 — 곡면 건물 UV와 호환 확인 |
| M3 | **블록 지면 변주**: 건설된 필지/블록별 지면 색(주차장 아스팔트·보도 포장·공원) | 중~큼 | 청크 메시 몇 개 | 중 — 필지 데이터(`parcels.ts`) 활용 |
| M4 | **인스턴싱 청크화**: 건물을 구역(예: 256 m 격자)별 `InstancedMesh`로 분할 → 프러스텀 컬링 활성, `computeBoundingSphere` 갱신 | 성능 이득 | 큼(큰 도시) | 중 — 드로 콜 증가 vs 컬링 득 균형 측정 |
| M5 | 옥상 설비·건물 높이 변화 변형 풀(ADR 0010의 프리셋 변형 풀 활용) | 중 | 낮음 | 낮음~중 |
| M6 | AO 흉내: 정점 색 프리베이크(건물 하단 어둡게), 도로-건물 접지 그림자 블롭 | 중 | 0 | 낮음 |

### 4.3 대형 (L, 주 단위, 별도 ADR 권장)
| # | 항목 | 시각 효과 | 성능 | 위험 |
|---|---|---|---|---|
| L1 | **먼 스카이라인 임포스터**: 영역 밖 링에 저폴리 건물 실루엣을 안개 색으로(절차 생성, 시드 고정, 인스턴싱 1~2드로 콜) | 큼 (지평선) | 낮음 (수백~수천 삼각형) | 중 — "가짜 도시"로 오해 방지 UI 표시 필요 |
| L2 | 후처리: SSAO/GTAO + 약한 블룸 + 선택적 DoF(원경만) | 큼 | **iGPU에서 크다** — 옵션으로 두고 품질 슬라이더 | 높음 |
| L3 | 지형 높낮이(완만한 언덕 지평선) | 중~큼 | 중 | 높음 — 도로/건물 고도 모델과 충돌(ADR 0003) |
| L4 | WebGPU/GPU 구동 컬링 | 큼(대규모) | — | 높음 — 현재 범위 밖. 권고하지 않음 |

### 4.4 결정 사안: "더 큰 맵 / 자동 맞춤 카메라" (빈 평면 문제)
선택지:
| 선택지 | 장점 | 단점 |
|---|---|---|
| A. 맵 `halfSize` 확대 | 가장 직관적 | 무의미한 빈 땅만 늘어남. 서버/문서/그리드 모두 영향, 성능 이득 없음. **권장하지 않음** |
| B. 맵 크기 유지 + **자동 맞춤 카메라** + 지평선 안개 + 지면 변주 + 먼 임포스터 | 빈 평면 인상을 해소하고 코드 변경 범위가 렌더 전용 | 임포스터는 가짜 배경이라는 점 |
| C. 지면을 영역 밖에서 서서히 사라지게(안개/하늘로 페이드) | 가장 값싼 지평선 처리 | 배경이 비어 보일 수 있음 → B와 함께 |
**권고: B+C.** 순서는 Q1(안개) → Q2(지면 변주) → Q4(자동 맞춤·낮은 시작 카메라) → M1(가로수·가로등) → L1(임포스터). 맵 크기는 *지어진 건물이 영역을 채우기 시작할 때* 별도 결정한다(데이터 마이그레이션 비용이 크므로 렌더 개선과 분리).
구현상 주의: 지면은 12 km 단일 평면이라 가장자리가 보일 때 선이 생긴다. 안개 far < 지면 반지름(6 km 근처에서 완전히 안개색)로 두면 가장자리가 사라진다. 카메라 `far`는 이미 ≥ 6000이다.

### 4.5 위험과 미해결 질문
- 현실감 목표와 장르 미학(SimCity식 장난감 룩) 사이의 선호는 사용자에게 한 번 확인(기본값은 현실감 쪽으로 가되 "스타일" 프리셋으로 되돌릴 수 있게).
- 기능 추가 후 항상 `renderer.info` 수치와 e2e 스크린샷을 같이 남긴다. 본 문서의 예산은 가이드이며 기기별로 다시 정한다.
- 렌더 전용 변경(가로수, 창문, 임포스터)은 sim 상태를 읽지 않고 시드 해시로만 배치해야 AGENTS.md 불변식 4를 지키며 골든 해시에 영향이 없다.
- 현재 가로수/가로등 모델 유무, 차량·보행자 `castShadow`, 옥상 설비 유무는 코드 전체 검색으로 확정하지 못했다(미검증). 구현 전 `rg`로 확인.

---

## 5. 근거 자료 (링크, 검증 상태)
- Meese, Baker, Summers, "Blur and perceived scale (fake tilt-shift)", i-Perception 2012 — https://journals.sagepub.com/doi/abs/10.1068/id223 (검색 결과 요약만, 본문 미열람; 제목은 정확한 서지 확인 필요)
- Weburbanist 틸트시프트 글 — https://weburbanist.com/2008/12/01/tilt-shift-photos-life-size-miniature-photography/ (블로그, 요약만)
- SimCity 틸트시프트 룩: Softpedia https://games.softpedia.com/blog/SimCity-Benefits-from-Tilt-Shift-Look-Says-Will-Wright-335739.shtml ; Gameswelt https://www.gameswelt.de/simcity-2013/preview/stadt-im-glaskasten-158926/2 ; PC Games Hardware https://www.pcgameshardware.de/Sim-City-Spiel-15619/Specials/Sim-City-5-Technik-Interview-vor-Release-1057030/ (모두 요약만)
- Andrew Willmott, Inside GlassBox (GDC 2012) — https://www.andrewwillmott.com/talks/inside-glassbox (페이지 확인됨, 슬라이드 미열람)
- GlassBox 개요 기사 — https://www.pcgamer.com/simcity-inside-the-glassbox-engine ; https://gamedeveloper.com/design/gdc-2012-breaking-down-em-simcity-em-s-glassbox-engine (요약만)
- Paavo Huhtala, Cities: Skylines 2 performance — https://blog.paavo.me/cities-skylines-2-performance/ (검증됨, 직접 열람)
- Iceflake/CS2 성능 블로그 보도 — https://www.pcgamesn.com/cities-skylines-2/performance-blog (요약만)
- CS2 개발 일기(카메라·포토 모드) — https://www.neowin.net/news/the-latest-cities-skylines-ii-dev-diary-takes-a-look-at-its-in-game-camera-and-photo-mode/ (요약만)
- Cities: Skylines After Dark 창 점등 — https://gameluster.com/cities-skylines-after-dark-expansion-set-for-24th-september-release/ (요약만)
- Townscaper 인터뷰 — https://xraispotlight.substack.com/p/how-to-make-procedural-generation (요약만)
- A/B Street — https://wiki.openstreetmap.org/wiki/A/B_Street (요약만)
- Jerome Etienne 절차 도시 — https://dzone.com/articles/prodecedural-city-100-lines (2차 요약; 원 블로그 미확인)
- Infinitown — https://littleworkshop.fr/projects/infinitown/ (요약만)
- Mapbox 3D 건물 — https://docs.mapbox.com/mapbox-gl-js/example/3d-buildings/ ; MapLibre(Stadia) https://docs.stadiamaps.com/tutorials/adding-3d-buildings-to-your-maps-with-maplibre/ (요약만)
- Cesium Cesium3DTileset 문서 — https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html (요약만)
- Google Photorealistic 3D Tiles 정책 — https://developers.google.com/maps/documentation/tile/policies ; https://developers.google.com/maps/documentation/tile/3d-tiles (정책 페이지 검증됨)
- NASA-AMMOS 3DTilesRendererJS — https://github.com/NASA-AMMOS/3DTilesRendererJS (요약만; 라이선스 Apache-2.0은 npm 요약 기준, 직접 확인 필요)
- three.js 문서: BatchedMesh https://threejs.org/docs/pages/BatchedMesh.html (검증됨) ; InstancedMesh https://threejs.org/docs/pages/InstancedMesh.html (검증됨) ; BufferGeometryUtils https://threejs.org/docs/pages/module-BufferGeometryUtils.html (존재만 확인)
- InstancedMesh2 (three.ez) — https://discourse.threejs.org/t/instancedmesh2-easy-handling-and-frustum-culling/58622 (서드파티, 요약만)
- Shamus Young, Procedural City Part 2 — https://shamusyoung.com/twentysidedtale/?p=2954 (요약만)
- 3D Tiles 렌더러 three.js 예제 — https://threejs.org/examples/webgl_loader_3dtiles.html (요약만)

찾았으나 확보 못한 것(요청 항목): Cities: Skylines I/II·Townscaper·Citybound 개발자의 "현실감/미니어처" 관련 GDC·포스트모템 1차 자료, Citybound(Anselm Eickhoff) 렌더링 글, Probable Futures 도시 데모, Google 타일 상업 약관의 세부 요금. 이들은 추가 조사 과제로 남긴다.
