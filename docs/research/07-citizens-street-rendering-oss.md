# Research: 시민·보행자·도로 표시·생활감 렌더링 (오픈소스 사례와 표현 기법)
> 결정하려는 것: "집에서 나온 사람이 걷고, 횡단보도·과속방지턱 등 교통 요소가 보이는" 화면을 현 렌더 구조(Three.js 0.186, 청크 도로 메시, 타입별 InstancedMesh)에서 어떻게 최소 비용으로 구현할지.
> 작성: sc-researcher (Sonnet 5.5) · 2026-10-23
>
> 표기: **[검증]** = 이번 세션에서 GitHub API/HTTP/웹검색/코드로 직접 확인. **[미검증]** = 배경지식, 구현 전 재확인 필요. 알고리즘(보행 모델·신호 규칙)은 Sol 담당이라 제외.

## 현재 코드 사실 [검증, 코드 직접 확인]
- `roads.ts`: 256m 청크당 단일 머티리얼 1드로우콜, 높이 분리(Y_ROAD 0.06 / Y_MARK 0.08 / Y_WALK 0.2) + 머티리얼 `polygonOffset(-1,-2)`. 이미 중앙선(이중 황색 실선), 차선(백색 점선), 가장자리선, 정지선(차수 3+ 접속부), 버스전용차로(적색)가 있다. **횡단보도·과속방지턱·어린이보호구역 표시는 없다.**
- `meshBuilder.ts`: `band`, `wall`, `dashed`, `polygon`, `tri`만 제공. 횡단보도 줄무늬는 `band`+`slicePolyline` 반복 또는 `quad` 추가로 가능.
- `vehicles.ts`: 차종별 파트 베이크 + InstancedMesh, `VEHICLE_STRIDE=6`, id 기준 보간. 브레이크등/방향지시등 없음(파트 색 고정).
- `signals.ts`: 차량 신호등만(기둥+정사각 램프, 램프 색은 instanceColor). 보행 신호등 없음.
- `CityRenderer.ts`: 태양 고정(`_sunOffset`), 낮밤 없음. `buildings` 셰이더에 창문 패턴(`aFacade`) 있음 → 발광 uniform 추가 지점.
- sim 스냅샷에는 보행자 레코드가 아직 없다(`VEHICLE_STRIDE`, `SIGNAL_STRIDE`만). 보행자 스냅샷 계약은 Sol/리드 합의 필요.

## 요약 (5줄 이내)
1. 보행자는 **절차적 박스 사람(몸통+머리, 다리 2개를 정점 셰이더로 흔듦) 1개 InstancedMesh** 로 충분하다. 에셋 다운로드·스키닝 불필요, 드로우콜 1~2개로 수천~만 명 가능(아래 수치는 일부 미검증).
2. 횡단보도·과속방지턱·어린이보호구역은 **기존 `roads.ts` 청크 메시에 지오메트리로 추가**(별도 드로우콜 없음). 기존 높이 레이어+polygonOffset 방식을 그대로 확장한다.
3. 낮밤은 `CityRenderer`에 `timeOfDay` 하나를 두고 태양 방향/색, hemisphere 강도, 배경색, 건물 셰이더 `uNight` uniform으로 구동한다. 창문 발광은 uniform 하나라 비용이 거의 없다.
4. 오픈소스 중 구조 참고 가치는 **A/B Street(Apache-2.0)** 가 가장 크다. Citybound는 AGPL이라 코드 복사 금지, 개념만.
5. 한국 노면색은 법령 원문을 이번에 확보하지 못했다. 중앙선 황색·차선 백색은 통념이지만 **횡단보도/방지턱/보호구역 색은 구현 전 law.go.kr 확인** 필요.

## 1. 오픈소스·게임 사례 (교통 요소 목록)

| 선택지 | 라이선스/활동 | 보여주는 교통·보행 요소 | 우리에게 유용한 점 | 검증 |
|---|---|---|---|---|
| A/B Street (`a-b-street/abstreet`) | Apache-2.0, 별 8186, 마지막 푸시 2025-09-10 | 보도, 횡단보도, 보행자, 교차로 정책(신호/정지), 자전거, 버스, 주차 | 보행자를 "보도-횡단보도 그래프 위의 이동"으로 모델링, 횡단보도·보도 렌더 방식 참고. Apache-2.0이라 코드 참조 가능(Rust, 포팅 필요) | 라이선스·활동 [검증]. 내부 모듈 위치(`map_model`, `sim`, `game`)는 [미검증] |
| SUMO (`eclipse-sumo/sumo`) | EPL-2.0, 별 4242, 푸시 2026-10-23(활발) | 보행자(`person`), 횡단보도 `crossing`/walkingarea 개념, sumo-gui 2D 표현 | 횡단보도를 네트워크 요소로 두는 데이터 모델(교차로 접속부에 crossing edge) | 라이선스·활동 [검증]. 세부 렌더는 [미검증] |
| CityFlow (`cityflow-project/CityFlow`) | Apache-2.0, 별 1030, 푸시 2025-08 | 차량 중심 RL 시뮬. 보행자 없음 | 대규모 차량 처리, 렌더는 별도 프런트. 우리에게 보행 참고는 낮음 | 라이선스·활동 [검증]. 보행 없음 [미검증] |
| MATSim (`matsim-org/matsim-libs`) | 별 650, 푸시 2026-10-22, 라이선스 API 값 없음(GPL-2.0로 알려짐) | 활동 기반(집→직장→집 일과 plans) | 시민 "집에서 나와 목적지로" 일과 모델의 개념. 렌더 아님 | 활동 [검증]. 라이선스 [미검증] |
| Citybound (`citybound/citybound`) | **AGPL-3.0**, 별 8171, 푸시 2023-01 (사실상 중단) | 개별 시민 에이전트, 도로 | **코드 복사 금지**(AGPL 전염). 개념만 | 라이선스·활동 [검증] |
| micropolisJS | GPL 계열 | 2D 타일 시뮬 | 개념만 | [미검증] |
| Cities: Skylines (CIM) | 상용 | 시민 이동, 보행자 횡단, 버스 정류장 대기, 신호등, 횡단보도 | 목표 연출 기준 | [미검증] |
| TM:PE (Traffic Manager: President Edition) 모드 | 오픈소스 모드(상세 미확인) | 신호 타이밍, 우선도 표지(양보/정지), 속도 제한 표지, 횡단보도 on/off, 차선 연결/화살표, 주차 금지, 대중교통 전용차로 | 우리가 제공할 "교통 요소" 체크리스트 기준 | 기능 목록 [미검증] (배경지식) |

우리 MVP 교통 요소 후보 목록(CS/TM:PE를 기준으로 구성): 횡단보도, 보행 신호등, 정지선, 과속방지턱, 속도 제한 표지, 어린이보호구역(적색 노면+표지), 버스 정류장, 신호등, 차선 화살표, 정지/양보 표지.

## 2. 보행자 대량 렌더링 (three.js)

| 선택지 | 장점 | 단점 | 사례/근거 |
|---|---|---|---|
| **A. 절차적 박스 사람 + 정점 셰이더 걷기** (몸통/머리 고정, 다리·팔은 `sin(phase)`로 정점 회전) | 에셋 0, 드로우콜 1, 색은 instanceColor로 다양화, 우리 `bakeVehicleGeometry`(파트 베이크+정점색) 패턴 재사용 | 셰이더 수정 필요(`onBeforeCompile`), 얼굴/옷 디테일 없음 | 기존 `vehicles.ts`가 같은 구조 [검증]. three.js 예제 `webgl_instancing_dynamic`, `webgl_instancing_performance` 존재 [검증, HTTP 200] |
| B. Vertex Animation Texture(VAT) | GPU만으로 복잡한 애니메이션, 수만 인스턴스 | 베이킹 파이프라인(Blender/스크립트) 필요, 과함 | 일반 기법. three.js 공식 VAT 예제 여부 [미검증] |
| C. InstancedSkinnedMesh / 스키닝 인스턴싱 | 정식 리깅 캐릭터 | **`webgl_animation_skinning_instancing` 예제는 존재하지 않음 [검증, 404]**. 코어에 InstancedSkinnedMesh 없음 추정 [미검증]. 인스턴스당 본 행렬 비용 큼 | `webgl_tsl_skinning`, `webgl_loader_gltf_instancing`, `webgl_instancing_morph`, `webgl_mesh_batch` 예제는 존재 [검증, files.json] |
| D. BatchedMesh (`webgl_mesh_batch`, `webgl_batch_lod_bvh`) | 서로 다른 지오메트리를 1드로우콜, LOD 예제 있음 | 이 용도엔 과함, 인스턴스별 변형 제한 | 예제 존재 [검증]. 성능 수치 [미검증] |
| E. 원거리 LOD: 점/빌보드 | 줌아웃 시 비용 절감 | 이중 메시 관리 | `webgl_buffergeometry_instancing_billboards` 예제 존재 [검증]. 구현 상세 [미검증] |
| F. CC0 캐릭터 에셋 (Kenney, Quaternius) | 품질 | glb 로더·애니메이션 클립 처리, 리포 용량, 인스턴싱과 충돌(스키닝) | 두 곳 모두 CC0 [검증, 2차 자료: 검색 요약. 개별 에셋 라이선스는 다운로드 페이지에서 재확인 필요] |

**결론**: 다운로드 없이 절차적 박스 사람으로 가능하다(A). 걷기 애니메이션 아이디어: 지오메트리에 속성 `aLimb`(0=몸통, +1=오른다리/왼팔, -1=왼다리/오른팔)를 베이크하고, 셰이더에서 힌지(엉덩이/어깨 높이) 기준으로 X축 회전. 위상은 `instance 속성 phase + uTime * speed`; 속도가 0이면(대기 중) 진폭 0. `speed`는 인스턴스 속성 또는 스냅샷 속도에서 계산. InstancedBufferAttribute 1개 추가로 충분.

## 3. 도로 표시 렌더링

| 방식 | 장점 | 단점 | 적합도 |
|---|---|---|---|
| **A. 청크 메시에 지오메트리 직접 추가** (현행 `band`/`dashed`) | 드로우콜 0 추가, 편집 시 청크 재빌드 로직 재사용, 정확한 폭/각도 | 줄무늬 수만큼 삼각형 증가(횡단보도 1개 = 줄무늬 8~12개 × 2삼각형, 무시 가능) | **MVP 권장** |
| B. 디칼(DecalGeometry) | 임의 표면에 투영 | 오브젝트당 생성 비용, 평면 도로엔 과함 | 비추천 |
| C. 텍스처(아틀라스/타일링 UV) | 화살표, 글자("어린이 보호") 같은 복잡한 마크 | UV·머티리얼 분리 필요(현재 정점색 단일 머티리얼 1드로우콜 구조 깨짐) | 후속(화살표/문자) |
| D. 별도 InstancedMesh 평면 | 횡단보도를 "객체"로 취급, 토글 쉬움 | 드로우콜 추가 | 횡단보도 개수가 매우 많을 때만 |

z-fighting: 현재 방식(높이 0.06/0.08/0.2 분리 + `polygonOffsetFactor -1, Units -2`)을 유지한다 [검증, roads.ts]. 새 마크는 `Y_MARK` 이상(예: 횡단보도 0.085, 방지턱 위 마크 0.09)을 쓰고, 방지턱은 실제 높이 8~10cm 쐐기 단면을 `wall`/`tri`로 올리는 방식을 권장(사선 패턴은 노란/검정 `band` 교차). 카메라가 멀 때 depth precision이 떨어지므로 `camera.near`를 키우거나 logarithmicDepthBuffer 없이 높이 분리를 쓴다(현 방식 유지) [일반 지식, 미검증].

한국 노면 표시 색 [검증 필요]:
- 중앙선 황색, 차선 백색: 통념. 우리 코드도 이미 이 색. 법령 원문 미확인 [미검증].
- 어린이보호구역: 검색 결과 [검증 약함, 2차 자료] "30km/h 제한 표시 테두리는 적색, 내부 흰색/검정"(세계일보 2023 보도), "횡단보도 황색 의무화(2023 시행규칙 개정)"는 단일 비공식 PDF 출처. **"적색 노면"이 법적 요구인지, 구간 착색(적색/녹색 미끄럼방지 포장)인지는 이번에 확인하지 못함.** 시각 연출용으로는 보호구역 구간에 적갈색 `band`를 까는 정도로 충분하나 "규정"이라 주장하지 말 것.
- 과속방지턱 사선 색(황색/흑색) 및 횡단보도 줄무늬 규격(폭 0.45~0.5m 등): 이번 조사에서 확인 못함 [미검증]. 원문은 도로교통법 시행규칙 별표 6(노면표시)과 교통안전시설 설치·관리 지침(경찰청/도로교통공단) 확인 필요.

## 4. 생활감 표현

| 요소 | 기법 | 파일 | 비고 |
|---|---|---|---|
| 낮/밤 | `timeOfDay`(0~24h) → 태양 위치 `(cos, sin)` 회전, 색온도 보간, `hemi.intensity`, `scene.background/fog` 보간 | `CityRenderer.ts` `updateSun()` 확장 | 그림자 프러스텀은 이미 카메라 추적 [검증] |
| 창문 발광 | `uNight` uniform을 건물 머티리얼의 emissive에 곱함. 창별 무작위 점등은 `hash(건물 id/창 셀)` | `buildingGeometry.ts` `createBuildingMaterial` 셰이더 | uniform 1개, 모든 건물 InstancedMesh 공유 머티리얼 [검증: 공유 머티리얼] |
| 가로등 | 기둥+램프 InstancedMesh(signals.ts 방식 재사용), 도로 중심선을 따라 일정 간격 배치 | 신규 `streetlights.ts` 또는 `signals.ts` 확장 | 광원(PointLight)은 수십 개도 부담 → 램프 메시만 emissive, 노면 광원 효과는 가짜 광채 평면 [일반 지식] |
| 신호등 3D | 현재 사각 램프 → 3구(적/황/녹) 박스, 보행 신호등은 2구 | `signals.ts` | 스냅샷에 보행 신호 상태 필드 필요(Sol/sim 계약) |
| 차량 브레이크등/방향지시등 | 후미 파트를 별도 "램프" 파트로 분리하고 인스턴스 속성 `aBrake`(0/1)로 emissive 토글 | `vehicles.ts` + 스냅샷에 가감속 정보 필요 | 속도 차분으로 클라이언트 추정 가능(2스냅샷 비교) |
| 버스 정류장 대기 인원 | 정류장 위치에 보행자 인스턴스를 "정지 상태"로 배치 | 보행자 레이어 | 대기 로직은 sim(Sol) |

## 5. 성능 수치 근거
- 코드 내 이미 `renderer.info`로 드로우콜/삼각형 집계 중 [검증, CityRenderer.ts]. 새 레이어 추가 후 HUD 값으로 실측하는 것이 가장 확실한 근거다.
- InstancedMesh는 타입당 1드로우콜. 인스턴스 수천~만 단위는 일반적으로 가능하나 구체 FPS 수치는 기기 의존이라 **이번에 인용 가능한 출처를 확인하지 못함 [미검증]**. 공식 예제 `webgl_instancing_performance`가 존재하므로 로컬에서 직접 측정 권장.
- 병목 후보: (1) 매 프레임 `setMatrixAt` CPU 루프(현재 차량도 동일, 보행자 1만 명이면 1만 compose), (2) 그림자 맵에 보행자 포함 시 지오메트리 2배 처리 → 보행자는 `castShadow=false` 권장.
- 드로우콜 예산 가이드(내부 가정): 도로 청크 N + 건물 설계 수 + 차종 ~5 + 보행자 1 + 신호/가로등 4 + 오버레이. 새 항목은 +6 이내로 억제.

## 권장안 (MVP / 후속)

### MVP (파일 단위)
1. `apps/web/src/render/roads.ts` `buildSegment()` 확장
   - **횡단보도**: 교차로 접속부(degree ≥ 3, 정지선 앞/뒤)에 도로 폭 전체에 수직 줄무늬 `band` 반복(줄무늬 길이는 보도 방향, 폭 0.5m, 간격 0.5m, 색 백색 `C_WHITE`, `Y_MARK+0.005`). 어느 접속부에 둘지는 sim/문서에 crosswalk 데이터가 생기기 전까지는 "차수 ≥ 3 접속부 전부"로 시작하되 데이터 확정 후 필터링.
   - **과속방지턱**: 세그먼트 속성(또는 도로 타입 플래그)이 있을 때 구간 중앙에 폭 3~4m, 높이 0.1m 쐐기 + 황색/흑색 사선(`tri`/`band` 교차).
   - **어린이보호구역**: 해당 세그먼트 `band`로 적갈색 덧칠 + 후속에서 표지 인스턴스.
   - `segSig`에 신규 속성을 포함시켜 청크 diff가 정상 동작하게 한다 [검증: segSig 구조].
2. `apps/web/src/render/pedestrians.ts` (신규, `vehicles.ts` 복제 후 단순화): 박스 사람 지오메트리 베이크(정점색 + `aLimb` 속성), `InstancedMesh` 1개, `onBeforeCompile`로 다리/팔 스윙, 스냅샷 보행자 버퍼(`PED_STRIDE`: x, z, heading, speed, id, 상태)를 id 기준 보간(현 `interpAlpha`/`lerpAngle` 재사용 [검증: export됨]). `castShadow=false`, 줌 아웃 시 LOD는 후속.
3. `CityRenderer.ts`: `PedestrianLayer` 추가(`frame()`에서 `update`), `timeOfDay` 상태 + `updateSun()` 확장, 건물 머티리얼 `uNight` 연결.
4. `buildingGeometry.ts` `createBuildingMaterial`: `uNight` uniform, 창문 영역 emissive 섞기(기존 `windowRatio`/창 마스크 계산 재사용 [검증: 셰이더에 창 계산 존재]).
5. `signals.ts`: 보행 신호등(2구) 인스턴스 추가, 차량 신호는 3구로 개선.

### 후속
- 가로등(`streetlights.ts`), 차량 브레이크등/방향지시등, 버스 정류장 구조물과 대기 인원.
- 원거리 LOD(빌보드/점), 노면 화살표·글자(텍스처 아틀라스 머티리얼 분리).
- 보행자 가시성: 건물 출입구 연출(집에서 나오는 모습 = 건물 위치에서 스폰 + 페이드).
- WebGPU/TSL 전환(`webgl_tsl_skinning`, `webgl_tsl_instancing` 예제 존재 [검증])은 ADR 0005가 "안정성 확인 후"로 미뤄 둠.

## 근거 자료 (링크)
- A/B Street: https://github.com/a-b-street/abstreet — Apache-2.0, 푸시 2025-09-10 [검증, GitHub API]
- SUMO: https://github.com/eclipse-sumo/sumo — EPL-2.0, 푸시 2026-10-23 [검증]
- CityFlow: https://github.com/cityflow-project/CityFlow — Apache-2.0 [검증]
- MATSim: https://github.com/matsim-org/matsim-libs — 라이선스 API 미표기 [미검증]
- Citybound: https://github.com/citybound/citybound — AGPL-3.0, 중단 [검증]
- three.js 예제 존재 확인(HTTP 200 / files.json): `webgl_instancing_dynamic`, `webgl_instancing_performance`, `webgl_instancing_morph`, `webgl_mesh_batch`, `webgl_batch_lod_bvh`, `webgl_buffergeometry_instancing_billboards`, `webgl_tsl_skinning` — https://github.com/mrdoob/three.js/tree/dev/examples [검증]. `webgl_animation_skinning_instancing`는 404.
- Kenney / Quaternius CC0: https://kenney.nl , https://quaternius.com [2차 자료 검색요약만, 원 사이트 미접속 → 미검증]
- 한국 노면표시 관련 보도: https://www.segye.com/newsView/20230222519617 (30km/h 표시 테두리 적색) [2차, 약한 검증]. 법령 원문(도로교통법 시행규칙 별표, 교통안전시설 설치·관리 지침)은 **미확인**.

## 위험과 미해결 질문
1. **데이터 계약**: 횡단보도·방지턱·보호구역은 렌더만으로는 의미가 없다. 도로/교차로 문서 모델에 속성이 있어야 편집·sim과 일치한다(현재 `model.ts`에 없음 [검증: grep 결과 없음]). 속성 위치는 리드/Sol과 합의 필요.
2. **보행자 스냅샷 포맷**: 현재 sim 스냅샷에 없음. 인원 수천 명이면 Float32Array 크기·전송량 검토 필요(차량과 같은 구조로 시작).
3. **한국 규정 색/규격 미확인**: "규정대로"라는 문구를 UI/문서에 쓰기 전에 원문 확인. 연출용으로는 문제 없음.
4. **횡단보도가 신호·sim과 어긋날 위험**: 렌더가 접속부마다 자동으로 그리면 sim에서 안 건너는 곳에 횡단보도가 보임 → sim 데이터가 출처가 되도록.
5. **성능 수치 미실측**: 보행자 1만 명 목표는 구현 후 HUD(`render.drawCalls`, fps)로 확인. 그림자·CPU matrix 루프가 먼저 병목이 될 가능성.
6. **셰이더 `onBeforeCompile` 유지보수**: three.js 0.186 내부 청크 이름 의존. 버전 업 시 깨질 수 있어 테스트 한 건(셰이더 컴파일 스모크) 권장.
7. **MATSim 라이선스 및 TM:PE 기능 목록은 미검증**: 인용 시 재확인.
