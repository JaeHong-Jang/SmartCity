# apps/web — 3D 도시 편집기 클라이언트

루트 `AGENTS.md` 확장. 근거: ADR 0001(협업 UX), 0005(렌더링), 0006(교통 범위). Vite + TypeScript + React(HUD 전용) + Three.js(명령형, React 밖).

## 구조 (기능별 폴더, 폴더 간 의존 방향: ui → app → {net, sim, render, tools} → shared/sim 패키지)
```
index.html, vite.config.ts (/ws 프록시 → localhost:8780, `SMARTCITY_SERVER_URL`로 변경)
src/
  main.tsx                 부트스트랩: store 생성 → transport 연결 → renderer 마운트 → React HUD
  app/store.ts             ClientStore: doc(확정), seq, tool, toolOptions, selection, peers, presence, connection, pending, toasts, simSpeed, overlays. subscribe/getState (useSyncExternalStore)
  app/dispatch.ts          dispatch(cmd): transport로 전송 + pending 등록(ghost 유지) → applied/rejected 처리
  net/transport.ts         interface Transport { connect(); send(msg: ClientMessage); onMessage(cb); close() }
  net/wsTransport.ts       재접속(지수 백오프), seq 누락 감지 시 재접속, ping
  net/localTransport.ts    서버 없을 때: 브라우저 내 시퀀서(applyCommand) + localStorage 저장/복원
  sim/protocol.ts          워커 메시지 타입 (init, command, setSpeed, snapshot, returnBuffers)
  sim/sim.worker.ts        Simulation 실행, 20Hz × simSpeed(0/1/2/4) 틱, 스냅샷 버퍼 왕복 재사용
  sim/simStream.ts         interface SimulationStream { latest(); previous(); subscribe() } + WorkerSimStream
  render/CityRenderer.ts   씬·라이트·안개(카메라 거리 연동)·그림자(보이는 범위 맞춤, 텍셀 스냅)·렌더 루프·레이어 조립, 지면 교차 좌표 계산, 최초 입장 1회 자동 맞춤·도시 보기·눈높이 보기, 성능 통계(프레임 p50/p95/p99, 그림자 패스 분리, 보간 CPU)
  render/cityView.ts       카메라 프리셋(순수 함수): 건물·도로 범위(기준점 4~96 백분위로 이상치 제한 후 남은 건물의 실제 회전 footprint와 교차점+15 m의 합집합, 한 번에 계산·순서 무관) 프레임, 19° 보기: 최초 입장·'도시 보기' = 연면적이 가장 밀집한 600 m 정사각형(옆으로 커지지 않음, 높이는 닿는 건물 최고점, 안에 다 들어온 건물은 화면 안, 경계에 걸친 건물은 화면 밖으로 이어질 수 있으나 카메라 뒤로는 가지 않음, 나머지는 화면 밖·안개), 그 시점에서 '도시 보기' 한 번 더 = 도시 전체(작은 도시는 둘이 같음). 둘 다 8개 모서리를 투영해 가로·세로 FOV 모두 맞는 거리, 상한 2 km 초과 시 중심 유지·외곽 잘림, 도로 위에서 길을 따라 보는 눈높이(건물 충돌 검사)
  render/sky.ts            하늘 그라디언트 돔(톤 매핑 없이 출력 색공간 변환만: 지평선 = 안개 출력색, 경계 없음) + 카메라 거리 연동 안개 범위
  render/paving.ts         렌더 전용 도시 바닥: 도로 그래프 면(블록) 중 건물·필지로 채워진 블록·필지·건물 주변은 포장, 녹지 필지는 잔디(포장 위 높이). 밤엔 어둡게. 도로/건물/필지 변경 시에만 재계산
  render/perfStats.ts      프레임 시간 링 버퍼·백분위(할당 없음)
  render/camera.ts         camera-controls: 좌클릭 없음(도구용), 우드래그 회전(Shift+우드래그 이동), 휠클릭 드래그 이동, 휠 줌(커서 기준), WASD/방향키 이동, Q/E 회전, R/F 줌, 거리 20~2500m, 지면 아래 금지
  render/ground.ts         큰 지면(안개 밖까지) + 들판 색 노이즈 + 셰이더 그리드(8m/64m, 안개 전에 페이드, 선택 도구일 땐 옅게)
  render/roads.ts          RoadGraph → 256m 청크별 병합 메쉬(노면, 인도, 교차로 면, 차선 표시: 중앙 황색 실선, 차선 백색 점선, 정지선, 버스전용 적색 노면). 변경 청크만 재생성
  render/buildings.ts      파트 형태별 InstancedMesh(박스/박공/피라미드), onBeforeCompile 창문·층 패턴
  render/vehicles.ts       차량 타입별 parts → 정점색 병합 지오메트리 베이크 → 타입별 InstancedMesh, 용량 2배 확장, 스냅샷 2개를 vehicleId 기준 보간(graphRevision 다르면 보간 생략)
  render/signals.ts        신호등 헤드 인스턴스(색 = 스냅샷 color)
  render/overlays.ts       로컬/동료 고스트, pending 펄스, 선택 하이라이트, 버스 노선, 폐쇄 표시, 교통 흐름 오버레이(laneFlow 색), 신호 위상 화살표, 동료 커서+이름
  render/dirty.ts          명령 종류 → 영향 도메인(도로/건물/차량/정류장/노선/필지) 표 + 선택 영향 판정. CityRenderer·OverlayLayer가 무효화에 사용 (새 명령은 여기에 분류해야 컴파일됨)
  tools/types.ts           interface Tool { id; onPointerDown/Move/Up(e: ToolPointer); onKey?(e); cancel(); ghost(): Vec2[] }
  tools/selectTool.ts      클릭 선택(노드/세그먼트/건물/정류장) → Inspector
  tools/roadTool.ts        직선/곡선(C 토글: 시작→제어점→끝), 연속 그리기, planRoad 미리보기(길이 m·각도°·교차 지점 하이라이트), G 그리드 스냅 토글, 우클릭(5px 미만 움직임)/Esc 취소
  tools/buildingTool.ts    선택한 건물 타입 고스트, 근처 도로(40m)에 자동 정렬(정면이 도로를 향함, 인도 바깥에 붙임), Shift = 자유 배치, ,/. 회전 15°, 도로 침범 시 빨강·배치 불가(buildingBlocksRoad)
  tools/bulldozeTool.ts    호버 하이라이트, 클릭 철거(세그먼트/건물/정류장)
  tools/busLineTool.ts     도로 위를 순서대로 클릭 → 정류장 자동 생성(클릭한 쪽 = 진행 방향), Enter/첫 정류장 클릭으로 완료 → busStop.add들 + busLine.upsert 를 한 batch
  tools/closureTool.ts     세그먼트 클릭으로 폐쇄 토글
  tools/picking.ts         문서 공간 질의(가장 가까운 노드/세그먼트/건물/정류장, 공간 해시)
  ui/App.tsx               레이아웃: 상단바(도시 이름, 접속 상태, 동료 목록, 내보내기/가져오기), 좌측 도구 모음, 우측 패널(인스펙터/에디터), 하단 상태바(FPS, 드로우콜, 차량 수, 평균 속도, 제거 수, 시뮬 속도, 교통 밀도, 오버레이 토글)
  ui/Toolbar.tsx           도구 버튼 + 단축키(1 선택, 2 도로, 3 건물, 4 철거, 5 버스, 6 폐쇄), 아래쪽에 보기 버튼(ViewButtons: 도시 보기 — 밀집 지역, 한 번 더 누르면 도시 전체 / 눈높이 / 용도지역 색 토글)
  ui/PerfOverlay.tsx       개발 서버 전용 성능 오버레이(` 키 또는 ?perf=1)
  dev/benchCity.ts         성능 기준 도시 생성기(개발·e2e 전용, 결정적: 도로 1,012·건물 2,000). 측정: e2e/perf/p6-bench.spec.ts, 결과 docs/perf/p6-baseline.md
  ui/Inspector.tsx         노드: 신호 종류·위상(접근로 체크, 녹색 초)·황색·전적색·오프셋·자동 복원 / 세그먼트: 도로 타입 변경·폐쇄 / 건물: 타입·회전·철거 / 정류장
  ui/RoadTypeEditor.tsx    도로 타입 생성·편집(차선 수 정/역, 폭, 제한속도 km/h, 인도, 버스전용)
  ui/BuildingEditor.tsx    건물 타입 생성·편집: 이름·존·파트 표(오프셋, 폭, 깊이, 층수, 층고, 시작 높이, 지붕, 색) + 미니 3D 미리보기(회전)
  ui/VehicleEditor.tsx     차량 타입 생성·편집: 물리 치수·속도·가감속·출현 비중 + 파트 표 + 미니 3D 미리보기
  ui/BusLinePanel.tsx      노선 목록, 대수·차량 타입·색 편집, 삭제
  ui/Toasts.tsx            거부 사유, 연결 상태 알림
```

## 규칙
- 렌더러/도구는 store를 읽고 `dispatch(Command)`로만 변경한다. Three 객체는 React state에 넣지 않는다.
- 메인 스레드 doc과 워커 doc은 같은 `applied` 명령 스트림을 같은 순서로 적용한다.
- 렌더 루프 안에서 할당 금지(Vector3/Matrix4 등은 모듈 스코프 재사용).
- 모든 UI 문구는 한국어.
- 성능 목표: 차량 5,000대 + 건물 2,000동에서 데스크톱 60fps, 드로우콜 < 150.
- 테스트: 순수 로직(tools/picking, 버스 정류장 방향 판정, 건물 자동 정렬 계산, store reducer)은 vitest. 화면은 Playwright 스모크(`e2e/`).
