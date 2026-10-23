# Research: 격자·배치·건물 제작·조작 UX·시뮬 루프 조사 (시티빌더 레퍼런스)
> 결정하려는 것: Phase 1 이후, (1) 객체 이동/회전 UX, (2) 세분화된 격자와 직접 배치 방식, (3) 직접 설계하는 고급 건물 에디터, (4) "진짜 도시 시뮬 게임" 느낌을 내는 최소 루프를 어떻게 구현할지.
> 작성: sc-researcher (Sonnet 5.5) · 2026-10-23
>
> 검증 표기: **[검증]** = 이번 세션에서 웹/GitHub API로 직접 확인. **[미검증]** = 배경지식이며 이번 세션에서 확인하지 못함(구현 전 재확인 필요). 별 수·최근 푸시 일자는 2026-10-23 기준 GitHub API 값.

## 요약 (5줄 이내)
1. 고정 격자 하나로 모든 것을 해결하는 게임은 거의 없다. 성공한 게임은 **"자유 도로 + 도로에 붙는 조닝 셀(CS1: 8m 셀)"** 또는 **"격자 스냅을 끄고 켤 수 있는 자유 배치(Move It 방식)"** 를 쓴다.
2. 우리 구조(서버 순서 커맨드 로그, 8m 스냅 매스블록)에는 **다중 해상도 스냅(8m 기본 / 2m 또는 1m 미세 / 스냅 끔) + 도로 부착 조닝 셀**을 병행하는 것이 가장 적합하다.
3. 건물 제작은 **모듈 키트(벽·창·지붕 조각) + 매스 블록 푸시/풀 + 층/파사드 규칙(경량 문법)** 조합이 학생에게 통제력과 쉬움의 균형이 가장 좋다. CGA 전체 구현은 과하다.
4. 조작은 three.js `TransformControls`(MIT)로 MVP를 만들되, 이동·회전은 **드래그 중 로컬 미리보기 → 종료 시 단일 `MoveObject` 커맨드**로 서버에 보내야 로그 크기와 충돌 처리가 단순하다.
5. 시뮬 느낌은 **RCI 수요 + 조닝 성장 + 서비스 커버리지 오버레이 + 예산** 순으로 가장 싸게 추가된다. 이미 있는 교통 시뮬이 가장 큰 자산이다.

## A. 시티빌더의 격자와 배치

| 게임 | 격자/배치 방식 | 셀 크기·부착 | 스냅 | 검증 |
|---|---|---|---|---|
| SimCity 4 | 타일 격자, 조닝 영역 + 로트(lot). 건물이 로트 크기에 맞춰 성장 | 타일 단위, 도로와 인접 타일에 조닝 | 타일 정렬 고정 | [미검증] 배경지식 |
| Cities: Skylines 1 | 도로는 자유 곡선, 조닝은 **도로 양옆에 8m 셀의 띠(깊이 약 4셀)** 로 자동 생성. 건물은 도로를 향해 정렬 | 8m 셀, 도로 방향에 맞춰 회전되는 로컬 격자 | 도로 기준 스냅이 기본, 자유 배치는 모드로만 | 8m·깊이 4: [미검증] (검색에서 수치 확인 못함). Move It의 "roadside grid 스냅" 존재: [검증] |
| Cities: Skylines 2 | CS1과 유사한 도로 부착 셀. 셀 규격과 로트 크기 변경 | [미검증] | [미검증] | [미검증] |
| Cities: Skylines Asset Editor / Move It | 에셋 에디터로 건물 메시·LOD·서브빌딩 제작. Move It은 건물·나무·소품·도로 노드를 선택해 이동, 건설 격자 제한 해제, Alt로 도로변 격자 스냅, Shift 저사양 표시, Ctrl 정밀 모드, 45도 회전 증분, Ctrl+Z/Y | - | 스냅/비스냅 토글 | Move It 기능: [검증](gamepressure·windowscentral 검색결과). Asset Editor 세부: [미검증] |
| SimCity 2013 | 곡선 도로 + 도로변 조닝 + 모듈형 부속 건물. 구역이 작고 도로 중심 | [미검증] | [미검증] | [미검증] |
| TheoTown | 등각 타일 격자(2D). 타일 단위 조닝·건물, 모드/플러그인 가능 | 타일 | 고정 | [미검증] |
| Townscaper | **불규칙(왜곡된 쿼드) 격자**. 클릭으로 블록을 쌓으면 주변 블록 관계(코너/벽/계단/아치)가 자동 결정되어 유기적 마을이 생김 | 정점 격자가 노이즈로 왜곡됨 | 격자 자체가 스냅 | 왜곡 격자·WFC는 Bad North 쪽 언급: [검증](Wikipedia, gamedeveloper 기사, 강연 "Organic Towns from Square Tiles"). Townscaper 내부 알고리즘(마칭큐브/듀얼그리드) 세부: [미검증] |
| Manor Lords | 자유형 플롯(plot) 배치. 도로에 붙은 부지를 드래그로 지정, 건물은 부지 안에서 생성 | 사실상 연속 좌표 + 도로 부착 | 도로변 부착 | [미검증] |
| Workers & Resources | 도로·철도 자유 곡선, 건물은 격자 없이 자유 배치(회전/높이 조절) | 연속 좌표 | 선택적 | [미검증] |
| Anno | 타일 격자(건물은 정수 타일 점유), 도로 타일 인접성에 따라 주택 성장 | 타일 | 고정 | [미검증] |
| Minecraft류 복셀 | 정수 복셀 격자, 클릭 배치/삭제 | 1 복셀 | 항상 | 개념은 three.js voxel painter 예제로 [검증] |

핵심 패턴(조사 결론):
- **조닝 셀은 도로의 파생 데이터**다. 도로가 바뀌면 셀이 재계산되고, 셀 위에 건물이 "성장"한다(CS1/SimCity). 반대로 플레이어가 직접 놓는 건물(Move It, Workers&Resources, Manor Lords)은 격자 스냅을 선택 사항으로 둔다. [개념 일부 검증: Move It 스냅 토글]
- **다중 해상도**: 보통 하나의 기본 격자(CS1은 8m) + "정밀 모드"(Ctrl) + "스냅 끔"으로 3단계를 제공한다. [Move It 쪽 검증]
- 우리가 "격자를 더 잘게 나눠 직접 배치"하려면 8m 위에 **2m/1m 보조 격자**와 **도로 가장자리 스냅**을 추가하는 것이 가장 자연스럽다.

## B. 커스텀 건물 제작 방식

| 방식 | 통제력 | 학습 난이도 | 협업(커맨드 로그) 적합성 | 비고 |
|---|---|---|---|---|
| CS Asset Editor식(외부 DCC 모델 임포트) | 최고 | 매우 높음 | 낮음(대용량 에셋 동기화) | 학생 팀에는 과함 [Asset Editor 세부 미검증] |
| Townscaper식 블록 쌓기 | 중간(규칙이 결과를 결정) | 매우 낮음 | 높음(셀 단위 소형 커맨드) | 도시 구조 설계 의도와는 거리가 있어 보조 기능으로 적합 |
| SketchUp식 푸시/풀 | 높음 | 중간 | 중간(면 단위 연산) | 우리 박스 파츠를 면 드래그로 늘리기만 구현해도 효과 큼 |
| BIM-lite(층·용도·면적·구조 속성 중심) | 중간 | 낮음~중간 | 높음(파라미터 JSON) | 스마트시티 관점(용도, 층수, 수용인구)에 직결 |
| 절차적 문법(CGA, 파사드 문법) | 높음(규칙 작성 시) | 높음 | 높음(규칙 JSON) | CityEngine이 대표. 오픈소스는 소규모뿐 |
| 모듈 키트(벽/창/문/지붕 조각) | 중간~높음 | 낮음 | 높음 | 조각 ID + 배치 파라미터만 저장 |

조사한 실제 구현체:
- CGA 구현체: `TheJanusStream/symbios-shape`(MIT, 별 1, 2026-09 푸시) [검증, 존재 확인만. 성숙도 낮음], `togzhan-krbkv/procedural-city-generator`(MIT, 별 1) [검증, 존재만]. 성숙한 JS/TS CGA 라이브러리는 이번 조사에서 **찾지 못함**.

**권장 균형(학생 대상)**: 현재 "박스 파츠 + 층 + 지붕" 매스 블록을 유지하고 아래 3단을 얹는다.
1. 매스 푸시/풀(면 핸들 드래그로 폭·깊이·높이 조절, 8m 또는 보조 격자에 스냅)
2. 층 단위 **파사드 규칙**(층 그룹별 창 간격·창 종류·바닥층 상점 등을 슬라이더/드롭다운으로)
3. 선택형 **모듈 키트**(창/문/발코니/지붕 장식 조각을 재질·프리셋으로 교체)
그리고 모든 건물에 BIM-lite 속성(용도, 연면적, 수용 인구/일자리, 에너지 등급)을 붙인다. 이 속성이 E절 시뮬 루프의 입력이 된다.

## C. 객체 조작 UX

관찰된 공통 패턴:
- **선택 → 핸들/기즈모 → 드래그 → 확정/취소(Esc)**. 이동·회전·삭제는 키 단축(G/R/Del 등)이 일반적(Blender식). Move It은 Ctrl+Z/Y와 정밀·스냅 토글을 제공 [검증].
- **다중 선택**: 박스(마퀴) 선택 + Shift 추가. Move It은 그룹 이동·회전·정렬·높이 조절을 지원 [검증].
- **도로 노드 이동**: Move It은 도로 노드를 직접 이동해 구간 형태를 바꾼다 [검증]. 연결된 도로 세그먼트가 따라 변형되고, 도로가 바뀌면 그 도로에 붙은 조닝 셀과 건물이 영향을 받는다. 건물이 도로에 붙어 있는 경우 처리 방식(자동 따라감 vs 분리)은 게임마다 다르다 [미검증].
- **three.js TransformControls**: translate/rotate/scale 모드, snap(translationSnap, rotationSnap), dragging-changed 이벤트로 OrbitControls 충돌 방지. 공식 예제 `misc_controls_transform` HTTP 200 확인 [검증]. three.js MIT [검증].

우리 구조에 맞춘 설계 원칙:
- 드래그 중에는 **클라이언트 로컬 프리뷰**만 갱신, 마우스 업에서 `MoveObject{id, pos, rot}` **한 개**만 전송. 낙관적 적용 + 서버 순서 확인(기존 구조와 일치). 실패 시 롤백.
- 도로 노드 이동은 `MoveRoadNode{nodeId, pos}`. 연결 세그먼트·교차로·신호 재계산은 결정적 함수로 모든 클라이언트가 동일하게 수행. 부착 건물은 **"도로 상대 좌표(도로 id, 도로선 상 위치 s, 옆 거리 d)"** 로 저장하면 노드 이동 시 자동으로 따라간다(권장). 절대 좌표 건물은 그대로 둔다.
- 되돌리기/다시하기는 **역커맨드(inverse command)** 를 클라이언트 로컬 스택에 두고 새 커맨드로 보내는 방식이 협업에 안전하다(타인의 변경과 충돌 시 해당 항목은 건너뜀).
- 충돌/겹침 검사: 이동 확정 시 AABB/OBB 중복 검사 후 경고(막지 말고 경고로 시작).
- 피킹 성능: 객체가 많아지면 `three-mesh-bvh`(MIT, 별 3.5k, 2026-10-22 푸시) [검증]. 건물이 Instanced라면 인스턴스별 AABB 공간 해시가 더 간단할 수 있다.

## D. 참고할 오픈소스 (존재/라이선스/활동 검증)

| 프로젝트 | 라이선스 | 별/최근 푸시 | 배울 점 | 사용 방식 |
|---|---|---|---|---|
| victorqribeiro/isocity | MIT | 3.2k / 2024-10 | 2D 등각 도시 빌더 UI, 타일 배치, 조닝/도시 느낌의 최소 구현 [검증 존재·라이선스] | 코드 참고 가능 |
| graememcc/micropolisJS | 라이선스 파일에 GPL 계열 문구, API는 NOASSERTION [부분 검증, 확인 필요] | 732 / 2025-07 | SimCity 클래식의 **RCI 수요, 전력 확산, 서비스 커버리지, 맵 스캔 루프** 구현 | **개념만** 참고(GPL 가능성) |
| SimHacker/MicropolisCore (C++/Python) | NOASSERTION (GPL3 추정) [미검증] | 211 / 2026-10 | 시뮬 알고리즘 문서화 | 개념만 |
| lincity-ng/lincity-ng | GPL-2.0 | 643 / 2026-10 | 자원/수송 중심 도시 경제 모델 | **개념만** |
| OpenTTD/OpenTTD | GPL-2.0 계열(API NOASSERTION) [부분 검증] | 8.4k / 2026-10 | 타일 지형 편집, 경제/수송 루프, 모듈화된 UI | 개념만 |
| citybound/citybound (Rust) | AGPL-3.0 | 8.2k / 마지막 푸시 2023-01 | 대규모 교통 시뮬, 도로 계획 UI 아이디어 | 개념만, 사실상 정체됨 |
| three.js `misc_controls_transform` 예제 / TransformControls | MIT | three.js 116k / 매일 활동 | 이동/회전 기즈모 | **직접 사용** |
| three.js `webgl_interactive_voxelpainter` 예제 | MIT | 위와 동일 | 레이캐스트 + 고스트 미리보기 + 격자 스냅(`floor/round` 패턴) 코드 확인 [검증] | 직접 참고 |
| gkjohnson/three-mesh-bvh | MIT | 3.5k / 2026-10 | 정밀 피킹, 대량 메시 레이캐스트 | 필요 시 도입 |
| mxgmn/WaveFunctionCollapse (C#) | NOASSERTION [확인 필요] | 25k / 2026-10 | WFC 원조. Townscaper류 규칙 기반 타일 결합 | 개념 |
| BorisTheBrave/DeBroglie (C#) | MIT | 528 / 2025-12 | WFC 제약(비국소) 확장, Sylves(그리드 라이브러리)와 연계 | 개념, 포팅 참고 |
| kchapelier/wavefunctioncollapse (JS) | MIT | 526 / 2023-08 | JS WFC 구현 | 코드 참고 가능 |
| "Townscaper three.js/webgl" 클론 | 검색에서 **의미 있는 결과 없음** | - | `ccookie.itch.io/groundscaper`는 Townscaper 격자 재현 시도(웹 검색 결과) [검증, 라이선스·코드 미확인] | 찾지 못함 |
| TS/three.js 시티빌더 신생 저장소(`reneodlt/civitas`, `patrick-ve/slopcity-3000`, `nextagencyio/massilia`) | 대부분 라이선스 없음 또는 AGPL(civitas) | 별 0~5 | 별 수가 적고 품질 불명 | 라이선스 없으면 참고 금지, AGPL은 개념만 |
| CitiesSkylines-addons/move-it, SamsamTS/CS-MoveIt | 라이선스 표기 없음(None) | 소규모 | Move It 소스 구조(원본은 C#, 2023 이후 정체) | 소스 열람 전 라이선스 확인, 개념만 |

사용 원칙: GPL/AGPL/라이선스 미표기는 **코드 복사 금지, 알고리즘/UX 아이디어만 참고**. 라이선스가 `NOASSERTION`으로 표시된 곳은 LICENSE 파일을 직접 확인해야 한다.

## E. 시뮬 게임 느낌의 핵심 루프

| 루프 | 설명 | 우리 구조 대비 추가 비용 | 우선순위 |
|---|---|---|---|
| 조닝 + 성장 | 도로 인접 셀에 R/C/I 구역 지정, 조건 충족 시 건물이 "자라남" | 중. 커맨드 `PaintZone`, 성장은 **서버 결정적 틱**에서 시드 기반으로 수행해야 클라이언트 간 일치 | 높음 |
| RCI 수요 | 주거/상업/산업 인구·일자리 균형으로 수요 바(bar) 산출 | **낮음**(건물 속성 합산만) | 높음 |
| 서비스 커버리지 | 소방·경찰·병원·학교·버스정류장 반경(도로 거리) 커버 | 중. 도로 그래프 BFS 필요, 기존 교통 그래프 재사용 가능 | 중 |
| 예산/세금 | 세수 - 유지비 = 잔액, 구역 세율 슬라이더 | 낮음(서버 값 하나 + HUD) | 중 |
| 지가/오염/소음 오버레이 | 셀 단위 스칼라 필드를 색으로 표시 | 낮음~중(히트맵 텍스처). 필드 계산은 블러/확산으로 단순화 | 중 |
| 정보 뷰(교통 혼잡, 전력, 수도) | 시각화 모드 전환 | 교통은 **이미 시뮬 데이터가 있어 가장 쌈**. 전력·수도는 별도 네트워크 필요 | 교통 높음, 그 외 후속 |
| 시나리오/재난 | 사고·정전 | Phase 3 계획과 일치 | 후속 |

참고: micropolisJS가 RCI·전력·커버리지를 "맵 스캔"으로 처리하는 방식은 단순하고 결정적이라 개념 참고 가치가 높다(코드는 GPL 가능성으로 복사 금지). [존재·라이선스 부분 검증, 알고리즘 상세 미검증]

가장 싼 순서: RCI 수요(건물 속성 합산) → 예산 HUD → 교통 정보 뷰 → 지가/커버리지 오버레이 → 조닝 성장.

## 선택지 비교: 격자 방식

| 선택지 | 장점 | 단점 | 우리 적합도 / 사례 |
|---|---|---|---|
| 자유형(연속 좌표) | 표현력 최고, 도로와 어떤 각도로도 맞출 수 있음 | 정렬이 흐트러지기 쉬움, 겹침/인접 판정이 복잡, 조닝 불가 | **보조 모드(스냅 끔)로 필요**. Workers&Resources, Move It |
| 균일 미세 격자(1~2m) | 구현 단순, 결정적, 협업 로그 작음 | 도시가 "체스판" 느낌, 도로 각도와 불일치 | **기본 스냅 3단(8/2/1m)의 일부**. 현재 8m 스냅의 자연스러운 확장 |
| 도로 부착 조닝 셀 | 도로 변경 시 자동 재계산, 성장·수요·서비스 모델과 직결 | 도로 재구성 시 셀 재계산 비용, 복잡한 교차로 모서리 처리 | **조닝/성장 루프의 필수 기반**. CS1 8m 셀 방식 |
| 불규칙 격자(Townscaper) | 유기적 외형, 규칙 기반 자동 완성 | 일반 도시 구조 설계와 맞지 않음, 구현·튜닝 어려움 | 부적합(보조 장난감 모드로나 가능) |
| 복셀 | 건물 에디터 구현이 쉽고 직관적 | 도시 스케일에서 해상도/성능 문제, 현실 도시 구조와 거리 | **건물 내부 에디터 보조 수단**으로만 고려 |

## 권장안 (MVP / 후속)

1. **객체 이동·회전**
   - MVP: `TransformControls` 단일 객체 이동(XZ 평면) + 회전(Y축, 15/45도 스냅), 드래그 종료 시 `MoveObject` 1개 커맨드, Esc 취소, Delete 삭제, 카메라는 중클릭 팬/우클릭 회전/휠 줌 + WASD 팬 유지. 이동 중 겹침 경고.
   - 후속: 박스 선택/Shift 다중 선택과 그룹 이동, 도로 노드 이동(연결 세그먼트 재계산 + 도로 상대 좌표로 부착된 건물 동반 이동), 역커맨드 기반 undo/redo, 정렬/분배 도구.
2. **격자 시스템**
   - MVP: 스냅 단계 **8m / 2m / 스냅 끔**을 단축키로 전환(Move It의 정밀·스냅 토글 개념), 도로 가장자리 스냅(건물 정면을 도로선에 정렬), 격자 시각화는 줌에 따라 8m→2m 페이드.
   - 후속: **도로 부착 조닝 셀**(8m 폭 띠, 깊이는 파라미터) 생성/재계산과 `PaintZone` 커맨드, 셀 점유 상태, 필요 시 1m 정밀 모드.
3. **커스텀 건물 에디터**
   - MVP: 기존 매스 블록 에디터에 면 핸들 푸시/풀(폭·깊이·높이), 층별 파사드 파라미터(창 간격·창 비율·바닥층 구분), 용도·층수·수용 인구 속성, 프리셋 라이브러리(공유 가능한 JSON).
   - 후속: 모듈 키트(창/문/발코니/지붕 조각), 경량 규칙 기반 생성(층 그룹 반복 규칙, CGA 부분집합), 건물 템플릿 팀 공유/버전, 스마트시티 속성(태양광 지붕, 에너지 등급).
4. **시뮬 루프**
   - MVP: 건물 속성 합산 기반 RCI 수요 바 + 예산 HUD(세수/유지비) + 교통 혼잡 정보 뷰.
   - 후속: 조닝 성장(서버 결정적 시드 틱), 서비스 커버리지(도로 BFS) 오버레이, 지가·소음 히트맵, 전력/수도 네트워크, 재난 시나리오(기존 Phase 3).

## 근거 자료 (링크, 미검증 표시)

- [검증] three.js 저장소 https://github.com/mrdoob/three.js (MIT, 활발)
- [검증] TransformControls 예제 https://threejs.org/examples/misc_controls_transform.html (HTTP 200)
- [검증] voxel painter 예제 https://threejs.org/examples/webgl_interactive_voxelpainter.html (소스 확인)
- [검증] three-mesh-bvh https://github.com/gkjohnson/three-mesh-bvh (MIT)
- [검증] isocity https://github.com/victorqribeiro/isocity (MIT)
- [검증] micropolisJS https://github.com/graememcc/micropolisJS (LICENSE 파일 문구 확인 필요)
- [검증] Lincity-NG https://github.com/lincity-ng/lincity-ng (GPL-2.0)
- [검증] OpenTTD https://github.com/OpenTTD/OpenTTD
- [검증] Citybound https://github.com/citybound/citybound (AGPL-3.0, 2023 이후 정체)
- [검증] DeBroglie https://github.com/BorisTheBrave/DeBroglie (MIT), WFC(JS) https://github.com/kchapelier/wavefunctioncollapse (MIT), WFC 원조 https://github.com/mxgmn/WaveFunctionCollapse
- [검증] Townscaper 개요 https://en.wikipedia.org/wiki/Townscaper, 해설 https://gamedeveloper.com/blogs/how-townscaper-works-a-story-four-games-in-the-making, 격자 재현 시도 https://ccookie.itch.io/groundscaper
- [검증] Move It 기능 설명(2차 출처) https://www.gamepressure.com/download.asp?ID=83257, https://www.windowscentral.com/best-cities-skylines-mods-pc
- [부분] CGA 구현체 https://github.com/TheJanusStream/symbios-shape (MIT, 소규모)
- [미검증] CS1 8m 셀·깊이 4, CS2 셀 규격, SimCity 4/2013, TheoTown, Manor Lords, Workers & Resources, Anno의 격자 세부, CS Asset Editor 세부 기능

## 위험과 미해결 질문

- **라이선스**: micropolisJS·OpenTTD·MicropolisCore는 GPL 계열 가능성. 코드 복사 없이 개념만. 라이선스 `NOASSERTION`/`None` 저장소는 LICENSE 직접 확인 전 참고만.
- **게임별 격자 수치(CS1 8m 등)는 이번 세션에서 웹으로 확인하지 못했다**. 설계 근거로 쓰기 전 공식 위키/문서로 재확인.
- **성장 동기화**: 조닝 성장은 난수가 들어가므로 서버 시드 틱으로만 처리하지 않으면 클라이언트 간 불일치 위험.
- **도로 상대 좌표 부착 건물**: 도로 재구성 시 건물이 부지 밖으로 밀리는 경우의 정책(경고/분리/삭제) 필요.
- **되돌리기 충돌**: 협업 중 타인이 같은 객체를 수정한 뒤 내 undo가 실행될 때의 규칙 정의 필요.
- **JS/TS 성숙한 CGA 라이브러리 부재**: 직접 경량 규칙 엔진을 만들어야 한다. 범위를 층/파사드 반복 규칙으로 제한할 것.
- 미해결: 조닝 셀 깊이/폭을 사용자가 편집 가능하게 할지, 건물 로트 크기 규칙(셀 N×M)을 어떻게 정할지.

## 부록: 권장 레퍼런스 Top 10

1. three.js TransformControls 예제 https://threejs.org/examples/misc_controls_transform.html (MIT, 직접 사용)
2. three.js voxel painter 예제 https://threejs.org/examples/webgl_interactive_voxelpainter.html (스냅/고스트 패턴)
3. Move It (CS1 모드) 기능 설명 https://www.gamepressure.com/download.asp?ID=83257 (UX 기준선)
4. Townscaper 해설 https://gamedeveloper.com/blogs/how-townscaper-works-a-story-four-games-in-the-making (규칙 기반 블록 결합)
5. micropolisJS https://github.com/graememcc/micropolisJS (RCI·커버리지 루프, 개념만)
6. isocity https://github.com/victorqribeiro/isocity (MIT, 웹 시티빌더 UI)
7. three-mesh-bvh https://github.com/gkjohnson/three-mesh-bvh (MIT, 피킹)
8. DeBroglie https://github.com/BorisTheBrave/DeBroglie (MIT, WFC 제약 개념)
9. kchapelier/wavefunctioncollapse https://github.com/kchapelier/wavefunctioncollapse (MIT, JS WFC)
10. Citybound https://github.com/citybound/citybound (AGPL, 도로 계획·교통 아이디어, 개념만) / Lincity-NG https://github.com/lincity-ng/lincity-ng (GPL, 경제 모델 개념)
