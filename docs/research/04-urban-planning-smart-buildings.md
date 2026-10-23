# Research: SmartCity 건설 고도화 도메인 조사·분석

> 결정하려는 것: 도시 공간 단위, 사용자 설계 건물의 저장 구조, 결정적 도시 성장 규칙  
> 작성: Sol 조사·분석 역할 · 2026-10-23 · Lead Conductor 검토용  
> 형식: `harness/templates/research-report.md` 확장. 현재 파일시스템이 읽기 전용이므로 보고서는 본문으로 제출한다.

## 요약

1. **필지는 폴리곤으로 저장하고, 세분화 격자는 편집 도구로 제공한다.** 도로 방향과 곡선에 대응하려면 둘을 분리해야 한다.
2. 건물은 **2m 격자로 그리는 층별 평면을 반복·압출하는 모델**을 권장한다. 기존 매스 모델은 이 구조로 변환한다.
3. 용도지역은 건축 가능 규칙, 층별 용도는 실제 활동으로 분리한다. 저층 상가·상층 주거가 자연스럽게 표현되어야 한다.
4. 성장의 첫 구현은 자동 건축보다 **입주·고용·공실·통행·전력 수요의 변화**에 집중한다. 사용자 설계 건물은 시뮬레이션이 임의로 바꾸지 않는다.
5. 스마트 설비는 장식 보너스가 아니라 면적·처리량·전력·연결 조건을 가진 설비로 표현한다.

**확인 수준:** 법령·공식 문서·논문에서 확인한 사항은 출처를 연결했다. 아래 게임 규칙·수치·인터페이스는 별도 표시가 없어도 **설계 제안**이며, 실측 보정·성능 벤치마크·플레이테스트는 미검증이다.

## 현재 구현에서 확인한 출발점

- [model.ts](/mnt/c/Users/User/Desktop/대학교/3학년/스마트시티%20프로젝트/packages/shared/src/model.ts:43): 건물 유형에 용도가 하나 있으며, 건물은 여러 직육면체 `BuildingPart`로 구성된다.
- [buildings.ts](/mnt/c/Users/User/Desktop/대학교/3학년/스마트시티%20프로젝트/packages/shared/src/editing/buildings.ts:23): 연면적은 `width × depth × floors`의 단순 합이다. 겹치는 매스를 실사용 면적으로 계산하려면 별도 규칙이 필요하다.
- [demand.ts](/mnt/c/Users/User/Desktop/대학교/3학년/스마트시티%20프로젝트/packages/sim/src/traffic/demand.ts:30): 주거/비주거를 나누고, 80m 이내 최근접 개방 도로에 연결한다. 통행 총량은 인구보다 차선 총길이와 `trafficDensity`에 좌우된다.
- [commands.ts](/mnt/c/Users/User/Desktop/대학교/3학년/스마트시티%20프로젝트/packages/shared/src/commands.ts:20): 편집은 Command, 복수 변경은 원자적 `batch`로 표현할 기반이 있다.

따라서 새 건물 편집기만 추가하면 도시 지표와 교통이 따로 움직인다. **층별 용도·수용량·출입구 → 활동 인구 → 통행 생성**을 함께 연결해야 한다.

## 1. 도시계획 공간 단위와 한국 규제

### 실제 제도·사례

게임에서 구분할 공간 단위는 다음과 같다.

| 단위 | 의미 | SmartCity에서의 역할 |
|---|---|---|
| 가구, block | 도로 등으로 둘러싸인 도시 공간 | 자동 분할의 입력, 구역 선택 |
| 필지, parcel | 토지의 등록·권리 단위 | 게임에서는 편집·배치·규제 적용 단위로 단순화 |
| 획지·개발대지, lot/site | 실제 개발 대상으로 구성한 토지 | 여러 필지를 합친 개발은 후속 |
| 용도지역, zoning | 허용 용도와 개발 강도를 정하는 규제 | 건물 형태·용도에 대한 허용 조건 |
| 격자, grid | 좌표를 일정 간격으로 나눈 편집 체계 | 스냅·브러시·선택 도구 |

현실의 필지와 건축대지가 항상 일치하는 것은 아니다. **MVP는 ‘게임 필지 하나 = 개발대지 하나’로 제한**하되, 법적 지적도를 재현한다고 표현하지 않는 것이 적절하다.

한국 도시지역의 주거·상업·공업·녹지지역은 다음처럼 세분된다.

| 대분류 | 세분 |
|---|---|
| 주거 | 제1·2종전용, 제1·2·3종일반, 준주거 |
| 상업 | 중심, 일반, 근린, 유통 |
| 공업 | 전용, 일반, 준공업 |
| 녹지 | 보전, 생산, 자연 |

이는 전체 국토의 용도지역을 모두 열거한 것은 아니다. 관리·농림·자연환경보전지역 등은 별도다. [국가법령정보센터, 국토계획법 시행령 제30조](https://law.go.kr/lsLinkCommonInfo.do?lsJoLnkSeq=1023116947)

규제는 서로 다른 질문에 답한다.

| 규제 | 의미 | 게임 판정 |
|---|---|---|
| 건폐율 | 대지에 비해 건축물이 지면을 얼마나 덮는가 | 건축면적/필지면적 |
| 용적률 | 대지에 비해 연면적을 얼마나 만드는가 | 산입 연면적/필지면적 |
| 높이제한 | 건축물 최고 높이를 얼마나 허용하는가 | 최고 지붕점 포함 높이 |
| 건축선 | 건축 가능한 도로 측 기준선 | 도로 경계·지정선 침범 검사 |
| 대지 안의 공지 | 건축선·이웃 경계에서 필요한 이격 | 경계별 후퇴 거리 |
| 일조 관련 높이제한 | 방향과 높이에 따른 추가 이격 | 북측 경계에 대한 높이별 검사 |

건폐율·용적률은 국가 시행령의 범위 안에서 조례가 정한다. 예를 들어 제2종일반주거지역은 일반 규정상 건폐율 60% 이하, 용적률은 조례로 정할 수 있는 범위가 100~250%다. **100%는 개별 건물이 반드시 채워야 하는 최소 용적률이라는 뜻이 아니다.** 특례·완화도 별도로 존재한다. [시행령 제84조](https://www.law.go.kr/lsLinkCommonInfo.do?chrClsCd=010202&lsJoLnkSeq=1032698453), [제85조](https://www.law.go.kr/LSW/lsLinkCommonInfo.do?lsJoLnkSeq=1032871571)

건축선 지정과 대지 안의 공지도 구분해야 한다. 모든 도로에 일률적으로 “3m setback”이라는 한국 법정값이 존재하는 것은 아니다. [건축법 제46조](https://law.go.kr/LSW/LsiJoLinkP.do?docType=JO&joNo=004600000&languageType=KO&lsNm=%EA%B1%B4%EC%B6%95%EB%B2%95&paras=1), [제58조](https://www.law.go.kr/lsLinkCommonInfo.do?lsJoLnkSeq=1032219037)

일조 관련 규정은 전용·일반주거지역에서 정북 방향 인접 대지경계선에 대한 이격을 다룬다. 시행령 제86조 제1항에는 높이 10m 이하 부분의 1.5m 이상 이격, 10m 초과 부분의 해당 부분 높이 절반 이상 이격이 제시되지만, 조례·적용 제외·공동주택 관련 추가 규정이 있다. 이를 모든 건물에 적용하는 단일 사선으로 구현하면 부정확하다. [건축법 시행령 제86조](https://www.law.go.kr/LSW/lsSideInfoP.do?docCls=jo&joBrNo=00&joNo=0086&lsiSeq=288339&urlMode=lsScJoRltInfoR)

### 데이터 모델 권장안

`Zone = residential` 하나에 규제와 실제 사용을 함께 담지 않는다.

- `ZoningProfile`: 허용 용도, 건폐율, 용적률, 높이, 경계별 후퇴, 선택적 일조 규칙.
- `Parcel`: 경계 폴리곤과 적용 규칙 ID.
- `FloorSpace.use`: 주거·상업·업무·공업·공공 등 실제 사용.
- `CompiledBuilding`: 검증된 면적·수용량·높이 등 파생값.

게임 산식은 다음처럼 명시한다.

\[
BCR=\frac{A_{\text{건축면적}}}{A_{\text{필지}}},\qquad
FAR=\frac{\sum_f A_{\text{산입 층면적},f}}{A_{\text{필지}}}
\]

MVP에서는 건축면적을 **지상 건물 외곽의 수평 투영 합집합**, 용적률 산입 면적을 **지상 각 층의 바닥면적 합**으로 정의한다. 이는 필로티·처마·발코니·지하층 등 실제 법정 산정 예외를 생략한 게임 규칙이다.

예를 들어 400㎡ 필지에 200㎡ 평면을 4층 쌓으면 건폐율 50%, 게임 용적률 200%다. 1층을 상업으로 바꾸면 상업 200㎡·주거 600㎡가 된다.

### MVP / 후속

| MVP | 후속 |
|---|---|
| 저층주거·중층주거·복합상업·공업·녹지 등 소수 게임 프로필 | 한국 16개 도시지역 세분 프리셋 |
| 건폐율·용적률·높이·전면/측면/후면 이격 | 지구단위계획·조례·복수 필지 개발 |
| 위반 이유와 남은 건축 가능 영역 표시 | 북측 일조 규칙과 시각화 |
| 프로필 수치를 ‘게임 규칙’으로 표시 | 지역·시행일을 고정한 법규 모드 |

일조 규칙을 후속으로 미뤄도 `northDirection`과 경계별 제약을 표현할 여지는 지금 확보하는 것이 좋다.

## 2. 도로에서 블록·필지를 만드는 알고리즘

### 실제 사례

Vanegas 외의 **Procedural Generation of Parcels in Urban Modeling**은 straight skeleton 기반과 OBB 기반 재귀 분할을 비교한다. 전자는 도로 접면을 따라 필지를 만드는 데, 후자는 다양한 크기의 분할을 만드는 데 유용하다. [저자 연구 페이지](https://twak.org/project/parcels/), [논문 검색 본문](https://www.cs.purdue.edu/cgvlab/papers/aliaga/eg2012.pdf)

Esri CityEngine도 Recursive·Offset·Skeleton 분할을 구분한다. 문서상 Skeleton 분할은 도로에 정렬되고 접근 가능한 필지를 생성하는 방식이다. [Esri, Block parameters](https://doc.arcgis.com/en/cityengine/2024.0/help/help-layers-block-parameters.htm)

Straight skeleton은 폴리곤 경계를 안쪽으로 이동시키며 만드는 직선 골격이다. 안쪽 오프셋 결과는 하나가 아니라 **0개 또는 여러 폴리곤**이 될 수 있다. 따라서 `inset(): Polygon`보다 `inset(): MultiPolygon` 계약이 안전하다. [CGAL, 2D Straight Skeleton and Polygon Offsetting](https://doc.cgal.org/Manual/3.5.1/doc_html/cgal_manual/Straight_skeleton_2/Chapter_main.html)

### 권장 파이프라인

1. **도로 점유 영역 생성**  
   곡선을 규정된 오차로 샘플링하고, 차도·보도·교차로 영역을 합집합한다. 연석 반경과 조인 방식도 고정한다.

2. **블록 후보 추출**  
   맵 또는 지정 개발구역에서 도로 점유 영역을 뺀다. 도로망 면 추출을 병용할 수 있다. 외부의 거대한 잔여 영역은 자동 개발하지 않는다.

3. **필지 분할**  
   도로에 접한 경계와 접면 길이를 기록한 뒤, 목표 면적·전면 폭·깊이로 분할한다.

4. **유효성 검사**  
   자기교차, 미세 조각, 겹침, 도로 침범, 최소 폭, 접근 가능성을 검사한다.

5. **결과를 Command로 확정**  
   자동 분할은 미리보기 플래너다. 생성된 실제 폴리곤·ID를 원자적 Command로 확정한다.

### 선택지 비교

| 방식 | 장점 | 결함·경계 조건 | 권장 |
|---|---|---|---|
| 전역 정사각 격자 | 구현·브러시 편집이 쉬움 | 사선 도로·곡선 주변에 잘린 셀과 계단 경계 | 편집 보조 |
| OBB 재귀 분할 | 이해하기 쉽고 목표 면적 제어가 편함 | 맹지·가느다란 필지 발생 가능 | MVP 자동 분할 |
| 도로 접면 스트립 분할 | 전면 폭·깊이와 접근성 제어 | 코너·서로 만나는 스트립 처리 필요 | MVP 보완 |
| Straight skeleton | 도로 방향을 따르는 분할 | 퇴화·동시 이벤트·수치 안정성 부담 | 후속 |
| 사용자 절단선 | 의도한 도시 구조를 직접 설계 | 잘못된 절단·접근 단절 처리 필요 | MVP 필수 |

**권장:** MVP는 OBB 후보 분할에 도로 접면 검사를 붙인다. 자식 중 하나가 맹지가 되면 다른 절단을 시도하고, 계속 실패하면 분할을 중지하거나 공지로 남긴다. 모든 블록을 억지로 같은 크기의 필지로 채우지 않는다.

수동 편집은 `분할선 그리기`, `인접 필지 합치기`, `경계 이동`을 제공한다. 건물이 있는 필지를 자를 때는 건물을 가로지르는 변경을 거부하거나, 사용자가 명시적으로 이전·철거하는 원자적 작업으로 처리한다.

### MVP / 후속

- **MVP:** 평면 지형, 지상 도로, 단순 폴리곤 수동 분할·합치기, 조건이 맞는 블록의 자동 분할, 2m 스냅.
- **후속:** skeleton 분할, 안뜰·구멍, 경사지, 골목 접근권, 교량·터널을 고려한 다층 토지 이용.

도로 수정마다 확정 필지를 재생성하면 사용자 작업이 사라진다. **확정 필지는 유지하고, 도로 변경 후 충돌·접근 상실을 표시**해야 한다.

## 3. 사용자 설계 건물 데이터 모델

### 실제 사례와 선택지

buildingSMART IFC는 건물·층·공간을 구분한다. SmartCity에 IFC 전체를 도입할 필요는 없지만, **형상과 층별 공간의 의미를 분리**하는 구조는 참고할 만하다. [buildingSMART, IfcBuildingStorey](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2/HTML/schema/ifcproductextension/lexical/ifcbuildingstorey.htm), [IfcSpace](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2/HTML/schema/ifcproductextension/lexical/ifcspace.htm)

CGA는 형상 규칙으로 건물 외관을 생성하는 사례다. 이는 벽·창을 모두 개별 저장하지 않고도 외관 다양성을 만드는 근거가 된다. [Müller 외, Procedural Modeling of Buildings, 2006](https://doi.org/10.1145/1141911.1141931)

| 모델 | 사용자 자유도 | 렌더링·저장 비용 | 주요 한계 |
|---|---|---|---|
| 현재 파라메트릭 매스 | 폭·깊이·층수·매스 조합 | 파트 수에 비례. 공통 박스 인스턴싱에 적합 | 층별 용도·중정·불규칙 평면이 어려움 |
| 층별 폴리곤 압출 | L자·단차·테라스·복합용도 | 고유 평면 정점과 층 패턴 수에 비례 | 삼각분할·중복 벽 제거·평면 검증 필요 |
| 그리드/복셀 모듈 | 셀 추가·삭제로 직관적 제작 | 채운 셀 수 또는 경계 복잡도에 비례 | 셀별 객체·메시를 만들면 급증 |
| 벽·창·지붕 키트 | 세밀한 외관 커스텀 | 피스 수·재질 종류·배치 데이터에 비례 | 제작 시간이 길고 실사용 면적 계산이 별도 |

분석적 비용 예시로 40×40m, 20층 건물은 층당 한 층의 셀만 저장해도 1m 셀에서 32,000개, 2m에서 8,000개, 4m에서 2,000개 셀이 필요하다. 이는 3차원 전체 복셀화보다 작은 경우다. 바이트 셀 배열의 원시 비용과 JSON 객체·GPU 인스턴스 비용은 크게 다르므로, 이 숫자를 실제 메모리 측정값으로 해석하면 안 된다.

### 권장안: 그리드로 편집하고 폴리곤으로 저장

- 기본 편집 단위 **2m**, 세밀 편집 **1m**, 빠른 배치 **4m**.
- 건물별 로컬 격자를 도로·필지 전면 방향에 정렬한다.
- 셀 브러시 결과를 평면 경계로 변환한다.
- 같은 평면이 반복되는 층은 `repeat`로 압축한다.
- 층별 공간에 용도를 지정한다.
- 외벽·창·지붕은 스타일 규칙으로 생성한다.
- 개별 외관 피스는 선택적 장식 계층으로 후속 추가한다.

사용자는 “격자를 세분화해서 직접 짓는” 경험을 얻고, 저장·시뮬레이션은 수천 개 장식 셀에 종속되지 않는다.

복합용도는 다음처럼 표현한다.

```text
층 1       : 상업 160㎡ + 공용·설비 40㎡
층 2~5 반복: 주거 160㎡ + 공용·설비 40㎡
옥상       : 태양광·녹화·설비 배치
```

시뮬레이션에는 상업 160㎡, 주거 640㎡를 전달한다. 공용부를 주거 인구나 일자리로 다시 계산하지 않는다.

### MVP / 후속

| MVP | 후속 |
|---|---|
| 직교 평면, 층 복제·추가·삭제 | 자유각 폴리곤·곡면 |
| 층별 용도와 공용·설비 면적 | 실·세대·임대 단위 |
| 반복층, 단차, 평지붕 | 중정·복잡한 지붕·연결교 |
| 외관 스타일·창 간격·색 | 벽·창·발코니 키트 |
| 같은 건물 설계의 재사용 | 사용자 설계 라이브러리·버전 분기 |

설계 자산은 불변 버전으로 참조해야 한다. 한 건물 수정이 같은 유형의 모든 건물을 바꾸는 동작은 별도 명령으로 제공한다.

## 4. 스마트시티 요소를 부착하는 방법과 효과

### 실제 사례

- **태양광:** PVWatts는 일사·온도·손실 등을 사용해 발전량을 추정한다. [PVWatts 공식 API 문서](https://developer.nlr.gov/docs/solar/pvwatts/)
- **녹색지붕:** EPA는 열섬 완화·냉난방·우수 관리 효과를 설명한다. 효과 크기는 기후와 건물 조건에 따라 다르다. [US EPA, Using Green Roofs](https://www.epa.gov/heatislands/using-green-roofs-reduce-heat-islands)
- **스마트 그리드:** DOE의 GEB는 효율 향상과 부하 이동·감축을 구분한다. [US DOE, Grid-Interactive Efficient Buildings](https://www.energy.gov/cmei/buildings/grid-interactive-efficient-buildings)
- **EV 충전:** SUMO는 배터리·충전소·충전소 탐색을 별도 모델로 다룬다. [SUMO, Stationfinder](https://sumo.dlr.de/docs/Simulation/Stationfinder.html)
- **스마트 가로등:** FHWA는 교통·보행 활동에 따른 조도 조절과 에너지 절감을 다룬다. [FHWA Lighting Handbook, 2023](https://highways.fhwa.dot.gov/sites/fhwa.dot.gov/files/2023-05/FHWA-Lighting-Handbook_0.pdf)
- **자율주행 승하차:** 미국 DOT도 자동화 차량 도입에 필요한 커브 측 승하차 공간을 다룬다. [USDOT, Automated Vehicles 3.0](https://www.transportation.gov/sites/dot.gov/files/docs/policy-initiatives/automated-vehicles/320711/preparing-future-transportation-automated-vehicle-30.pdf)
- **지하 물류:** 싱가포르 URA는 지상 배송 교통을 줄이는 지하 물류망을 계획 수단으로 제시한다. 실제 보급 규모·일반적인 효과율은 이번 조사에서 검증하지 않았다. [URA, Better and More Efficient Delivery](https://www.ura.gov.sg/land-planning/long-term-plan/space-for-our-dreams-exhibition/move/better-efficient-delivery/)

### 우리 모델 권장안

설비는 `host + 위치 + 용량 + 비용 + 가동 조건`으로 표현한다. 설치 여부와 실제 작동 상태를 분리한다.

| 요소 / 부착 대상 | 최소 효과 모델 | 비용·제약·역효과 | 범위 |
|---|---|---|---|
| 태양광 / 지붕 | 발전량 = 설치면적×효율×적산일사×손실계수 | 면적 점유, 야간 발전 0 | MVP |
| 녹색지붕 / 지붕 | 냉방 수요 일부 감소, 우수 저류 용량 증가 | 유지비·물·구조 조건 | MVP는 냉방 효과 |
| EV 충전 / 필지·건물 | 공급전력 = 포트 수×출력×이용률 | 전력 피크·대기열·차량 접근 | MVP |
| 스마트 그리드 / 건물·구역 | 유연 부하를 시간대 사이 이동 | 통신·제어·편의 저하 조건 | 후속 |
| 센서 / 건물·필지·도로 | 사고 탐지 지연·관측 오차 감소 | 전력·통신·고장 | MVP |
| 스마트 가로등 / 도로 | 전력 = 정격×점등시간×조광률 | 최소 조도, 과도 조광의 위험 | 후속 |
| 자율주행 승하차존 / 도로변 | 처리량 = 면 수×3600/평균 점유초 | 넘친 대기열은 차로를 방해 | 후속 |
| 드론 포트 / 지붕·필지 | 지정 화물 흐름 일부를 항공 경로로 이동 | 전력·소음·기상·처리량 | 후속 |
| 지하 물류 / 필지 접속점·망 | 연결된 화물 OD 일부를 지하 경로로 이동 | 건설비·환적·고장·망 용량 | 후속 |

공통 에너지·탄소 회계는 다음 정도면 충분하다.

\[
E_{\text{부하}}=\sum_u A_u e_u s_u(t)+E_{\text{설비}}
\]

\[
E_{\text{구매}}=\max(0,E_{\text{부하}}-E_{\text{자가소비 발전}})
\]

\[
CO_2=E_{\text{구매}}EF_{\text{전력}}
+\sum_k VKT_k EF_k
\]

- \(e_u\): 용도별 단위면적 에너지 원단위.
- \(s_u(t)\): 시간대별 이용 패턴.
- \(VKT_k\): 차종별 차량 주행거리.
- 계수는 시나리오 설정으로 버전 관리한다. **한국 실측 원단위·배출계수는 미검증**이다.

센서는 설치만으로 혼잡을 줄이지 않는다. 센서가 제공한 정보로 신호 제어·사고 대응이 바뀔 때 효과가 발생한다. EV 충전기도 전기차 주행의 배출을 계산하는 기반이지, 설치 개수에 비례하는 탄소 할인 쿠폰이 아니다.

드론 포트는 소형 배송 드론과 승객용 eVTOL을 구분해야 한다. FAA 버티포트 자료는 주로 후자에 대한 참고이며 소형 배송 드론 규격으로 전용할 수 없다. [FAA, Vertiport Design Standards](https://www.faa.gov/headquartersoffices/ang/vertiport-design-standards-advanced-air-mobility)

## 5. 도시 지표·수요·성장의 최소 모델

### 실제 게임·시뮬레이터 사례

SimCity는 RCI 구역과 인구·행복도·지가·밀도 등의 정보 화면을 제공한다. 다만 시리즈·버전별 내부 수요식은 다르므로 하나의 공식을 “SimCity 공식”으로 가져오면 안 된다. [EA, SimCity 2013 공식 매뉴얼](https://akamai.cdn.ea.com/eadownloads/u/f/manuals/GAME-SIMCITY/SimCity_2013.pdf)

Cities: Skylines II 개발 문서는 주거·상업·공업·업무의 상호 의존과 저층 상가·상층 주거를 설명한다. Economy 2.0에서도 수요·임대·행복도 규칙이 조정되었다. **사례는 참고하되 현재 버전의 정확한 내부 수식은 미검증**이다. [Paradox, Zones & Signature Buildings](https://www.paradoxinteractive.com/games/cities-skylines-ii/features/zones-signature-buildings), [Economy 2.0 Part 1](https://www.paradoxinteractive.com/games/cities-skylines-ii/news/dev-diary-economy-part-one)

A/B Street는 건물의 도로·보도 연결과 하루 일정에 따른 통행을 구분한다. CityFlow는 경로·발생 간격·시간을 입력받는 교통 흐름 모델이다. 도시 성장 모델을 교통 엔진 앞단에 두는 구조가 적합하다. [A/B Street, map_model](https://a-b-street.github.io/abstreet/rustdoc/map_model/index.html), [Travel demand](https://a-b-street.github.io/docs/tech/trafficsim/travel_demand.html), [CityFlow, Flow File Format](https://cityflow.readthedocs.io/en/latest/flow.html)

### 지표는 용량과 실제 이용을 분리한다

| 지표 | 권장 정의 |
|---|---|
| 인구 | 주거 수용량과 실제 거주자를 별도 집계 |
| 일자리 | 일자리 용량과 실제 고용자를 별도 집계 |
| RCI 수요 | 추가 공간의 필요도. 입주율과 별개 |
| 공실 | 준공 용량−입주·입점 용량 |
| 지가 | 접근성·서비스·환경·수요로 만든 지수 |
| 에너지 | kWh와 최대 kW를 분리 |
| 탄소 | 기간별 kgCO₂e와 인당 지표 |
| 교통 | 통행시간·대기·미처리·실패 통행 |
| 만족도 | 주거·고용·접근성·환경·서비스 부족의 가중 지수 |

지가를 실제 원/㎡로 표시하려면 별도 보정이 필요하다. MVP에서는 0~100 지수가 더 정직하다.

### 권장 최소 규칙

**① 면적을 용량으로 변환**

\[
K_R=\left\lfloor\frac{A_{R,\text{유효}}}{a_{\text{인당}}}\right\rfloor,\quad
K_{J,u}=\left\lfloor\frac{A_{u,\text{유효}}}{a_{\text{일자리},u}}\right\rfloor
\]

게임 시작값의 예로 주거 30㎡/인, 업무 20㎡/일자리 등을 둘 수 있지만, 이는 법정 수용 인원이나 검증된 국내 평균이 아니다. 규칙 프로필로 관리한다.

**② 입주와 고용은 접근·공급 조건에 묶는다**

\[
0\le P_b\le K_{R,b},\qquad
0\le E_{b,u}\le K_{J,b,u}
\]

입주에는 빈 주거 용량·전력·출입구·지역 유입 예산이 필요하다. 고용은 전체 노동력과 접근 가능한 일자리를 넘을 수 없다.

**③ RCI는 목표 공간과 현재 용량의 차이로 만든다**

\[
D_u=\operatorname{clamp}
\left(\frac{T_u-K_u}{\max(T_u,K_u,1)},-1,1\right)
\]

- 주거 목표 \(T_R\): 현재 인구 + 고용·만족도 조건을 충족하는 예정 유입 + 목표 공실.
- 상업 목표 \(T_C\): 거주자·주간 활동 인구에 필요한 서비스 규모.
- 공업·업무 목표 \(T_I,T_O\): 노동력, 상업 공급 필요, 시나리오 외부 수요로 배분.
- 첫 도시의 정체를 막는 초기 유입·사업 수요는 **명시적인 시나리오 예산**으로 제공한다.

순간적인 수요는 완만하게 갱신한다.

\[
\bar D_{t+1}=\bar D_t+\alpha(D_t-\bar D_t)
\]

증축·퇴거 판단에는 별도 임계값과 지속 시간을 둔다. “사람이 늘어 일자리가 늘고, 일자리가 늘어 사람이 늘어나는” 무한 증폭을 막으려면 외부 유입·수요에 상한과 속도 제한이 필요하다.

**④ 사용자 건물의 성장과 자동 건축을 구분**

MVP 성장:

```text
설계·배치 → 공사 → 사용 가능 → 입주·입점 → 활동·통행·에너지 발생
                                     ↓
                              부족·공실·만족도 피드백
```

자동 성장은 후속 기능으로 두고, `자동 개발 허용` 필지에서 승인된 템플릿만 선택하도록 한다. 음수 수요가 사용자 건물을 자동 철거하게 해서는 안 된다.

**⑤ 통행은 도시 활동에서 생성**

\[
Q_{\text{person}}(t)=
Pq_{\text{통근}}(t)+Pq_{\text{쇼핑}}(t)+Eq_{\text{업무}}(t)
\]

이후 교통수단 분담률과 평균 재차인원으로 차량 통행을 만든다. 혼합용도 내부 이동과 도보 통행은 차량으로 생성하지 않는다.

현재의 차선 길이 기반 발생률은 별도 교통 실험 모드로 남기고, 도시 모드에서는 대체하는 것을 권장한다. 차량 상한 때문에 생성하지 못한 수요는 사라지게 하지 말고 `보류/미처리 통행`으로 집계한다.

**⑥ 지가·만족도는 이전 경제 주기의 결과를 사용**

\[
L_b=\operatorname{clamp}
(L_0+w_aA_b+w_sS_b+w_dD_b-w_pP_b^{pollution}-w_cC_b,0,100)
\]

만족도도 통근시간·고용·공급 안정성·녹지 접근·오염·안전을 사용한다. 계수·임계값은 **게임 설계값이며 미검증**이다.

경제 갱신은 교통 20Hz와 분리해 고정 틱 배수로 실행한다. 모든 경제 주기는 이전 주기의 상태를 읽고 결과를 한 번에 반영해 순회 순서 편향을 막는다.

## 6. Phase 3 돌발 상황과 연결할 건물 속성

### 실제 사례

NIST의 건물 대피 연구는 층·이동 경로·계단·행동 지연 등을 다룬다. ASET/RSET 접근에서는 위험한 상태가 되기까지의 가용 시간과 대피에 필요한 시간을 비교한다. [NIST, Building Egress](https://www.nist.gov/el/fire/safety-building-occupants-building-egress), [NIST, GSA Elevator Research](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication1620.pdf)

SmartCity는 화재·연기·보행 미시 모델 없이 대피 안전성을 판정할 수 없다. MVP 지표는 **게임용 대피 소요 추정과 병목 비교**로 한정한다.

### 필요한 속성

| 범주 | 지금 확보할 속성 | Phase 3 활용 |
|---|---|---|
| 수용 | 용도별 설계 수용량·실제 점유 | 시간대별 대피 대상 |
| 출입 | 위치·폭·접근 모드·도로 연결 | 탈출·구조 진입 |
| 수직 이동 | 층 높이·계단 수·유효 폭 | 고층 대피 병목 |
| 취약성 | 침수 기준 높이·재료·내화 프로필 | 재난 노출·피해 |
| 보호 | 경보·스프링클러·비상전력 | 탐지·기능 유지 |
| 시설 | 병상·구급차·소방차·대피소 정원 | 대응 자원 배정 |
| 의존성 | 전력·도로·통신 연결 | 연쇄 장애 |

단순 대피시간은 다음처럼 분해할 수 있다.

\[
T_{\text{대피}}\approx
T_{\text{탐지}}+T_{\text{경보}}+T_{\text{준비}}
+T_{\text{이동}}+T_{\text{대기}}
\]

단일 출구 병목의 처리시간은 \(N/(qW)\)로 근사할 수 있다. \(q\)는 단위 폭당 인원 처리율, \(W\)는 유효 폭이다. 여러 출구·계단의 공유 병목은 단순 합으로 계산하면 안 된다.

응급시설 커버리지는 반경보다 다음 비용을 사용한다.

\[
T_{\text{응답}}=
T_{\text{출동준비}}+
T_{\text{사용 가능한 도로경로}}+
T_{\text{현장접근}}
\]

경로가 없으면 미커버다. 병원까지 300m여도 다리 폐쇄로 단절되면 접근할 수 없고, 도착 가능해도 병상·차량이 부족하면 서비스가 충족되지 않는다.

**MVP:** 수용량, 시간대별 점유, 출입구, 시설 종류·정원·차량 수, 도로 기반 응답시간.  
**후속:** 계단·보행 그래프, 재난별 위험장, 피난 경로 용량, 병원 배정·환자 이송.

## 권장 데이터 모델 초안

아래는 계약 방향을 보여주는 축약 초안이다. 기존 `CityDoc`의 도로·신호·버스 등 컬렉션은 유지한다.

```ts
type Id = string;

// 정수 mm. 면적 계산·좌표 범위는 JS 안전 정수 범위 안에서 제한한다.
interface Point2 {
  x: number;
  z: number;
}

interface Polygon2 {
  outer: Point2[];
  holes: Point2[][]; // MVP에서는 빈 배열만 허용 가능
}

type Use =
  | 'residential' | 'commercial' | 'office'
  | 'industrial' | 'public'
  | 'circulation' | 'utility';

interface RuleSet {
  id: Id;
  version: number;
  northMilliDegrees: number;
  profiles: Record<Id, ZoningProfile>;
  // 수용량·에너지·경제·성장 계수도 이 버전에 귀속
}

interface ZoningProfile {
  id: Id;
  allowedUses: Use[];
  maxCoverageBps: number;   // 5000 = 50%
  maxFarBps: number;        // 20000 = 200%
  maxHeightMm: number;
  setbackMm: { front: number; side: number; rear: number };
  daylight?: {
    kind: 'gameNorthRule';
    lowHeightMm: number;
    lowClearanceMm: number;
    highClearanceRatioBps: number;
  };
}

interface Parcel {
  id: Id;
  revision: number;
  boundary: Polygon2;       // ワールド座標
  zoningProfileId: Id;
  frontages: {
    outerEdgeIndex: number;
    segmentId: Id;
    side: 'left' | 'right'; // segment a→b 基準
    fromPpm: number;        // 弧長比率
    toPpm: number;
  }[];
  development: 'manual' | 'auto';
}

// 道路からの派生キャッシュ。確定フィル地の同一性には使わない。
interface BlockView {
  key: string;
  boundary: Polygon2;
  sourceRoadRevision: number;
}

interface FloorSpace {
  id: Id;
  polygon: Polygon2; // 建物ローカル座標。同じ階で内部重複禁止
  use: Use;
}

interface FloorBand {
  id: Id;
  bottomLevel: number; // MVP は 0 以上
  repeat: number;
  floorHeightMm: number;
  spaces: FloorSpace[];
}

interface BuildingDesign {
  id: Id;
  version: number;     // 既存版は不変
  bands: FloorBand[];
  roof: { kind: 'flat'; parapetHeightMm: number };
  facadeStyleId: Id;
  egress: { stairCount: number; totalStairWidthMm: number };
}

interface Building {
  id: Id;
  revision: number;
  parcelId: Id;
  design: { id: Id; version: number };
  origin: Point2;
  rotationMilliDegrees: number;
  entrances: {
    id: Id;
    localPosition: Point2;
    widthMm: number;
    modes: ('walk' | 'car' | 'service' | 'emergency')[];
    access: {
      segmentId: Id;
      side: 'left' | 'right';
      atPpm: number;
    };
  }[];
}

type AssetHost =
  | { kind: 'building'; buildingId: Id; bandId: Id;
      repeatIndex: number; surface: 'roof' | 'floor';
      localPosition: Point2 }
  | { kind: 'parcel'; parcelId: Id; position: Point2 }
  | { kind: 'road'; segmentId: Id; side: 'left' | 'right';
      fromPpm: number; toPpm: number };

type AssetSpec =
  | { kind: 'solar'; areaM2: number; peakKw: number }
  | { kind: 'greenRoof'; areaM2: number }
  | { kind: 'evCharger'; ports: number; kwPerPort: number }
  | { kind: 'smartGrid'; flexibleKw: number; storageKwh: number }
  | { kind: 'sensor'; detects: 'traffic' | 'fire' | 'flood';
      latencyTicks: number }
  | { kind: 'smartLight'; ratedWatts: number;
      minimumDimmingBps: number }
  | { kind: 'pickupZone'; bays: number; dwellTicks: number }
  | { kind: 'dronePort'; pads: number; serviceTicks: number }
  | { kind: 'undergroundLogistics'; networkNodeId: Id;
      parcelsPerHour: number };

interface SmartAsset {
  id: Id;
  host: AssetHost;
  spec: AssetSpec;
}

interface EmergencyFacility {
  id: Id;
  buildingId: Id;
  kind: 'hospital' | 'fireStation' | 'shelter';
  peopleCapacity: number;
  responseVehicles: number;
  dispatchDelayTicks: number;
}

interface ConstructionDoc {
  schemaVersion: 2;
  ruleSet: { id: Id; version: number };
  parcels: Record<Id, Parcel>;
  designs: Record<Id, BuildingDesign>;
  buildings: Record<Id, Building>;
  assets: Record<Id, SmartAsset>;
  facilities: Record<Id, EmergencyFacility>;
}

// コンパイル結果。形状・用途から導出し、手入力値と二重管理しない。
interface CompiledBuilding {
  buildingId: Id;
  footprintAreaM2: number;
  grossFloorAreaM2: number;
  usableAreaByUse: Partial<Record<Use, number>>;
  maxHeightMm: number;
  residentCapacity: number;
  jobCapacityByUse: Partial<Record<Use, number>>;
}

// 再開可能なスナップショットに保存。編集文書とは別の sim 状態。
interface BuildingRuntime {
  buildingId: Id;
  phase: 'construction' | 'operational' | 'disabled';
  residents: number;
  jobsFilledByUse: Partial<Record<Use, number>>;
  occupantsNow: number;
  constructionProgressBps: number;
}
```

※ 위 코드의 주석 중 좌표·좌우·파생 캐시 등은 각각 **월드 좌표, a→b 기준 좌우, 필지 동일성과 분리된 블록 캐시**를 뜻한다. 실제 도입 시 프로젝트 표준인 한국어 또는 영어 주석으로 통일하면 된다.

계약상 추가 조건은 다음과 같다.

- `BuildingDesign` 참조는 ID와 버전을 함께 사용한다.
- 층 구간 중첩, 같은 층 공간 중첩, 빈 평면, 음수 높이를 검증한다.
- 지붕 설비는 실제 노출 지붕면 안에 있어야 한다.
- 필지 경계 변경 시 접면 인덱스·건물 포함 여부를 함께 검증한다.
- 설비 종류별 허용 host는 런타임 검증이 필요하다.
- 출입구와 도로 사이 연결 경로가 다른 필지·건물을 가로지르지 않는지 검사한다.

필요한 명령은 `parcel.split/merge/reshape`, `parcel.setZoning`, `design.createVersion`, `building.setDesign`, `asset.place/remove`, `facility.set` 등이다. 복수 객체 변경에는 revision 전제조건과 원자적 적용이 필요하다.

편집 문서 변경은 모두 `applyCommand()`로 처리한다. 입주·공사 진행 같은 시간 변화는 결정적 `step()`의 런타임 전이로 처리하고, 자동 개발이 건물 형상을 생성한다면 승인된 Command 경로를 사용한다. 재개 스냅샷에는 틱·RNG·입주·대기 수요·공사 상태도 포함해야 한다.

## MVP 결정 요약

| 결정 | 권장 MVP | 후속 |
|---|---|---|
| 토지의 권위 데이터 | 폴리곤 필지 | 복수 필지 개발·입체 토지 |
| 격자 | 로컬 2m 기본, 1·4m 선택 | 자유각·정밀 제약 |
| 블록 | 도로에서 계산하는 파생 캐시 | 증분 갱신 |
| 필지 생성 | 수동 분할·합치기 + 접면 검증 OBB | skeleton·골목 |
| 규제 | 소수 게임 프로필, 건폐율·용적률·높이·후퇴 | 일조·지역 조례 |
| 건물 | 직교 층별 평면·반복층·층별 용도 | 실·세대·외관 키트 |
| 성장 | 공사·입주·고용·공실 | 허용 필지의 자동 건축 |
| 교통 연결 | 명시적 출입구·도로 접속 | 주차·보행·환적 |
| 스마트 요소 | 태양광·녹색지붕·EV 충전·센서 | 그리드·PUDO·드론·지하 물류 |
| 도시 지표 | 인구·고용·수요·공실·전력·탄소·혼잡·만족도 | 임대료·세수·공급망 |
| 재난 연결 | 점유·출입구·시설 정원·도로 응답시간 | 보행 대피·위험장 |
| 협업 | 서버 seq, revision, 원자적 Command | 고급 동시 편집 |

## 피해야 할 함정과 검증 시나리오

| 함정 | 입력 → 잘못된 결과 | 필요한 방어 |
|---|---|---|
| 격자를 토지 경계와 동일시 | 사선 도로 → 계단형 필지·잔여 조각 | 폴리곤과 편집 격자 분리 |
| 접근 없는 자동 필지 | 중앙 필지 생성 → 도로 없이 건물 운영 | 도로 접면·접근 경로 검사 |
| 도로 수정 때 전체 재생성 | 폭 확장 → 사용자 건물·ID 소실 | 확정 필지 유지·충돌 표시 |
| 최근접 도로 자동 재연결 | 출입 도로 폐쇄 → 이웃 필지를 넘어 다른 도로로 이동 | 명시적 출입구 유지 |
| 매스 면적 단순 합 | 같은 위치의 매스 2개 → 인구·일자리 두 배 | 합집합 또는 겹침 금지 |
| 설계 자산의 암묵적 공유 | 한 건물 층 추가 → 같은 유형 전체 증축 | 불변 설계 버전 |
| 설비 보너스 중복 | 같은 지붕에 태양광·녹화·포트 무제한 | 공간·면적·전력 예산 검사 |
| 스마트 설비 만능 효과 | 센서 설치 → 제어 변경 없이 혼잡 감소 | 관측→행동→결과 연결 |
| 인구 대신 도로가 수요 생성 | 빈 도로 확장 → 통근량 증가 | 활동 기반 통행 |
| 처리하지 못한 수요 삭제 | 차량 상한 도달 → 혼잡·수요 감소처럼 표시 | 미처리·실패 수요 집계 |
| 평균 혼잡도만 표시 | 단절로 차량 0대 → ‘원활’ | 미도달·취소·단절 지표 |
| 무한 성장 피드백 | 주거→일자리→주거 반복 → 무제한 팽창 | 외부 수요·이주 예산·속도 제한 |
| 자체 난수·기하 오차 | 동일 명령 재생 → 클라이언트별 필지 차이 | 확정 결과 전송·정규화·정렬 |
| 반경 기반 응급 커버리지 | 가까운 병원, 다리 폐쇄 → 커버로 표시 | 도로 경로·자원 용량 |
| 시간·전력 단위 혼용 | 시간 가속 → 에너지 수백 배 오차 | 틱·게임 시간·kW·kWh 명시 |

수치 기하는 정수 좌표만 사용한다고 자동으로 결정적이 되지 않는다. 교점 반올림, 곡선 샘플링, 폴리곤 시작점·방향, 동률 처리와 라이브러리 버전까지 고정해야 한다.

**Lead 결정 요청:** 위 MVP 경계를 확정한 뒤 `필지·규제`, `건물 설계·면적 산정`, `활동·성장·교통 연결`의 세 계약으로 나눠 ADR에 반영하는 것을 권장한다.

**검증 증거와 한계:** 저장소 타입·면적 함수·수요 생성 코드·Command 정의를 읽어 현재 구조를 확인했다. 외부 근거는 법령·공식 개발 문서·연구 자료를 조회했다. 코드 변경·테스트·빌드·성능 측정은 수행하지 않았으며, 국내 실측 계수·조례별 적합성·게임 밸런스·재난 예측 정확도는 미검증이다.