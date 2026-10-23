# Research: apps/web 리팩토링·성능 감사 (Phase 3a)
> 결정하려는 것: 동작 보존 리팩토링에서 무엇을 어떤 순서로 건드리고, 무엇은 건드리지 않을지
> 작성: sc-researcher (Sonnet 5.5) · 2026-10-23
> 범위: `apps/web/src/**` (테스트 제외). 소스 수정 없음. 라인 번호는 이 시점 기준.
> 실행한 것: `npm run build -w @smartcity/web`, `tsc --noEmit --noUnusedLocals --noUnusedParameters`, export 사용처 grep 스크립트. 프로파일러 실측(프레임 시간, 베이크 시간)은 **하지 않음** — 아래 "비용" 서술은 코드 읽기에 따른 추정이며 "미검증"이다.

## 요약 (5줄 이내)
- 프레임당 핫패스(`vehicles`/`pedestrians`/`CityRenderer.frame`)는 이미 모듈 스코프 임시 객체·typed array·버퍼 왕복으로 잘 최적화되어 있다. 큰 낭비는 프레임이 아니라 **"문서가 바뀔 때마다 전부 다시 만드는" 경로**에 있다.
- 최대 낭비: `OverlayLayer.refresh()`가 모든 `docVersion` 변경(원격 명령 포함)마다 버스 노선 경로 탐색(`routeBetween`: 정류장 쌍마다 전체 도로 인접리스트 재구성 + O(n²) Dijkstra), 필지 규제 검사, 라벨 DOM 재생성을 수행한다.
- 도로 편집마다 `compileNetwork` 전체 + `segSig` 문자열 전체 + 더티 청크마다 모든 세그먼트 순회. 오버레이/픽 인덱스/버스 경로가 같은 곡선 샘플링(`sampleSegmentCurve`)을 각자 반복한다.
- React 쪽은 `useStore`가 참조/원시값만 반환해서 구조적으로 건전하다. 문제는 `doc`+`docVersion` 이중 구독 보일러플레이트 16곳과 `simStats` 4Hz 객체 갱신으로 인한 불필요 리렌더 정도.
- 번들은 단일 청크 1,314 kB(gzip 368 kB). three.js가 대부분이라 lazy-load 이득은 스튜디오/편집기 약 145 kB(소스 기준) 수준으로 작다. 죽은 코드는 소량(실제 미사용 export 2개, 미사용 필드 2개).

## 선택지 비교 (우선순위 항목)

형식: `[P] 제목 — 위치 — 근거 — 제안 — 위험`

### P1 (효과 큼 · 위험 낮음~중간)

**[P1-1] 오버레이 전체가 모든 docVersion에서 재구성됨 — `render/overlays.ts:203-217`**
- 근거: `refresh()`는 `docChanged`(=`docVersion` 변동)이면 `buildPeers`, `parcels.update`, `buildSelection`, `buildTransit`, `buildClosures`, `buildPhases`를 무조건 호출한다. 도로 한 구간 추가·원격 사용자의 건물 이동 등 무관한 명령에도 실행된다. `CityRenderer.ts:20-22`는 이미 명령 타입별 분류(`ROAD_COMMANDS` 등)를 갖고 있지만 오버레이는 이를 쓰지 않는다.
- 제안: 명령 타입 → 영향 레이어 매핑을 한 곳(예: `render/dirty.ts`)에 두고, `CityRenderer`의 `store.onApplied` 훅에서 `overlays.invalidate(kind)`로 세분화한다(transit: busLine/busStop/segment/node/roadType 계열, closures: closure.* + 도로 변경, parcels: parcel.* + building.* + buildingType.*, selection: 선택된 id가 `touches` 되었을 때만). `store.onReset`은 전체 무효화.
- 위험: 중간. 무효화 누락 시 오버레이가 낡은 상태로 남는 시각 버그. 완화: 현재 동작(전부 갱신)을 기본값으로 두고 제외 목록만 좁히며, 명령 타입 전체를 `Record<Command['type'], Flags>`로 선언해 새 명령 추가 시 컴파일 에러가 나게 한다(P3-3 참조).

**[P1-2] `buildTransit`의 버스 경로 탐색이 문서 변경마다 반복되고 비용이 큼 — `render/busRoute.ts:27-72, 75-104`, 호출 `render/overlays.ts:323-332`**
- 근거: `routeBetween`은 호출마다 `nodePath()`를 부르고, `nodePath`는 모든 세그먼트에 대해 `sampleSegmentCurve`+`cumulativeLengths`로 인접리스트를 처음부터 만든다(`:30-42`). 노선당 정류장 수 × 노선 수만큼 반복. Dijkstra는 `open` Set 선형 스캔(`:48`)으로 O(V²). `stopPosition`/`curve`도 매번 곡선을 다시 샘플링(`:14-24`).
- 제안: (a) `routeBetween` 호출 묶음당 인접리스트를 1회만 만드는 `BusRouter(doc)` 객체 도입(같은 `buildTransit` 안에서 재사용), (b) P1-1로 버스·도로 변경 때만 실행, (c) 가능하면 `RoadNetworkGeom.segments[].centerline`(이미 샘플링됨)을 재사용. 같은 곡선 샘플링이 `roadNetwork.ts:130` `curveOf`, `tools/picking.ts` 생성자, `busRoute.ts:14`, `ui/Inspector.tsx:24-30`에 중복.
- 위험: 낮음(순수 함수, `render/*.test.ts`로 출력 동일성 비교 가능). 경로 결과는 바이트 단위로 동일해야 하므로 Dijkstra 타이브레이크(첫 최소 노드 선택 순서)를 바꾸지 말 것. 힙으로 교체하면 동률 시 경로가 달라질 수 있어 이 항목에서는 교체하지 않는다.

**[P1-3] 도구 프리뷰: 포인터 이동마다 새 MeshBuilder·BufferGeometry·JSON 직렬화 — `render/overlays.ts:169-200`, 호출 `tools/controller.ts:57,69`**
- 근거: `setPreview`는 pointermove마다 `new MeshBuilder()`(number[] 3개) → `preview.set(b)`가 `geometry.dispose()` + `b.build()`(`computeBoundingSphere/Box` 포함, `meshBuilder.ts:89-97`)를 한다. 건물 고스트 키는 `JSON.stringify(type.parts).length`(`:179`)로 매 호출 직렬화하며, **길이만 비교하므로 같은 길이의 편집은 충돌**(고스트가 갱신되지 않는 잠재 버그; `rev`가 키에 있어 실사용에서는 대부분 가려짐).
- 제안: (a) 직전 프리뷰와 구조적으로 같으면(lines/points 비어 있음 포함) 아무것도 하지 않기 — 특히 빈→빈 전환에서 `new BufferGeometry()` 생성 생략, (b) 고스트 키는 `type.id:rev` + 참조 동일성(`doc.buildingTypes[id] === lastRef`)로 대체, (c) `MeshBuilder`에 재사용 가능한 `reset()`을 두고 DynLayer가 용량을 키워가며 `setDrawRange`로 갱신(나중 단계, 위험 중간).
- 위험: (a)(b) 낮음 / (c) 중간(버퍼 재사용 시 `needsUpdate` 누락 주의).

**[P1-4] 도로 갱신 경로의 O(청크×세그먼트) 순회와 문자열 서명 — `render/roads.ts:39-51, 74-105, 107-130`**
- 근거: `segSig`가 모든 세그먼트에 대해 `JSON.stringify(g.roadType)`와 crossing 폴리곤 문자열화를 수행(`:45-49`). `rebuildChunk`는 더티 청크마다 `segRecords`·`nodeRecords` 전체를 순회하며 `rec.chunk !== key`로 걸러낸다(`:115-122`). `buildRoadNetwork`(= `compileNetwork` 전체)는 도로 명령마다 메인 스레드에서 도시 전체를 재컴파일한다(`CityRenderer.ts:195-200`).
- 제안: (a) `update()`에서 `chunk → id[]` 인덱스를 한 번 만들어 `rebuildChunk`가 해당 청크 항목만 순회, (b) `roadType` 서명은 `roadType` 객체 참조가 같으면 캐시(문서가 불변 교체 방식이라 참조 비교 가능 — 아래 "건드리면 안 되는 것" 참조), (c) `compileNetwork` 증분화는 sim 변경이 필요하므로 **Phase 3b 이후 별도 ADR**.
- 위험: (a) 낮음 (`roads.test.ts`의 `lastRebuilt` 단언이 안전망) / (b) 중간(참조 비교 가정 확인 필요) / (c) 높음.

### P2

**[P2-1] 신호등: 정적 데이터를 스냅샷(20Hz)마다 전부 재기록 — `render/signals.ts:45-85`**
- 근거: 기둥·램프 행렬은 신호기 위치가 바뀔 때(`graphRevision`)만 변하는데, 스냅샷마다 `setMatrixAt` ×(1+3)n과 `instanceMatrix.needsUpdate`가 실행된다(`:66-84`). 램프 3종 모두 같은 행렬을 별도로 씀(`:74`). `PedSignalLayer.update`(`:201-228`)는 **매 프레임** 행렬 3종 + 색 2종을 쓰고, 헤드마다 `pedLampState`가 `{red,green}` 객체를 할당(`:136-147`), `for (const m of [this.poles, this.red, this.green])` 배열도 프레임마다 할당(`:223`).
- 제안: 행렬은 `graphRevision`/`crossingSig` 변경 시에만 기록, 색은 점등 인덱스가 바뀐 슬롯만 `setColorAt`+`instanceColor.needsUpdate`(변경 없으면 플래그 생략). `pedLampState`는 정적 상수 객체 3개를 반환.
- 위험: 낮음~중간. 신호 스냅샷은 용량 증가(`:55-64`) 시 인스턴스 메시를 새로 만들므로, 그때는 반드시 정적 행렬을 다시 써야 한다.

**[P2-2] 점유율 어트리뷰트 20Hz 전체 재계산·업로드 — `render/buildings.ts:148-164`**
- 근거: 스냅샷마다 모든 타입의 `occ.array.fill()` + 전 건물 `slotOf.get()` + 모든 타입 `needsUpdate=true`. 값이 안 바뀌어도 GPU 업로드.
- 제안: 새 레벨을 쓰며 이전 값과 비교해 하나라도 달라졌을 때만 해당 타입의 `needsUpdate` 설정. 필요하면 점유율을 양자화(예: 1/32)해 업로드 빈도 감소(시각 동작 변경이므로 양자화는 선택).
- 위험: 낮음(비교만) / 양자화는 중간(시각 변경).

**[P2-3] 건물 `update()`가 변경 1건에도 모든 인스턴스 행렬 재기록 — `render/buildings.ts:90-142`**
- 근거: 건물 배치/이동마다 `counts` Map 생성, 모든 건물 행렬 재기록, `computeBoundingSphere` 전 타입(`:140`)(인스턴스 수에 비례).
- 제안: 건물 수천 채 규모 전에는 이득이 작다 → **측정 후 결정**(미측정). 우선 `slotOf` 증분 갱신은 보류하고, `computeBoundingSphere`가 `frustumCulled`에 필요한지 확인(건물 메시는 `frustumCulled=false`가 아니므로 필요).
- 위험: 중간(슬롯 매핑 오류 시 건물이 엉뚱한 점유율을 받음).

**[P2-4] 지연된 GPU 리소스 누수 후보**
- `render/buildings.ts:114-118`: 용량 증가 시 새 `occ` 어트리뷰트로 교체하지만 기존 `occ`의 GPU 버퍼는 지오메트리가 살아 있어 해제되지 않음(용량 2배 증가 횟수만큼, log2(N)회로 유계). 교체 전 `oldOcc.dispose()` 호출 필요 여부 확인.
- `render/CityRenderer.ts:283-291`: `dispose()`가 `roads`/`pedestrians`/`renderer`만 해제. `buildings`(머티리얼·지오메트리), `vehicles`(`mat`, 타입별 지오메트리), `signals`/`pedSignals`(지오메트리 3종, 머티리얼 2종), `overlays`(DynLayer 9개의 지오메트리·머티리얼, `ghostWallMat`, `cursorMesh`, 라벨 DOM), `ground`(지오메트리·머티리얼·경계선)에 `dispose()`가 없다. 실서비스에서는 `main.tsx`가 렌더러를 해제하지 않으므로 영향은 **HMR/테스트 환경**과 향후 방 전환뿐 → P2.
- `render/overlays.ts:182-185`: `ghostBuilding` 교체 시 지오메트리만 해제, 공유 `ghostWallMat`은 끝까지 유지(의도된 공유이므로 OK, `dispose()`에서만 해제).
- 제안: 각 레이어에 `dispose()` 추가 후 `CityRenderer.dispose()`에서 일괄 호출. 위험 낮음.

**[P2-5] 필지 레이어가 문서 변경마다 DOM 라벨 전부 재생성 — `render/parcels.ts:70-99`**
- 근거: `update()`가 라벨 `div`를 모두 `remove()` 후 `innerHTML`로 재생성하고, `violations`가 켜져 있으면 모든 필지에 `parcelCompliance(doc, pc)`를 실행(`:81`). 호출은 `overlays.ts:208`(`docChanged || violations 토글`) — 도로 명령에도 실행된다. `frame()`은 라벨마다 `l.el.className === 'parcel-label'` 문자열 비교(`:111`).
- 제안: P1-1에서 parcel/building 관련 명령에서만 호출. 라벨은 id별 `div` 재사용(텍스트가 바뀐 때만 `textContent` 갱신), `Label`에 `isParcel: boolean` 필드로 문자열 비교 제거.
- 위험: 낮음. 테스트가 `.violation-badge[data-building]` 셀렉터를 쓰므로(`:95`) 클래스·dataset 계약은 유지.

**[P2-6] 스튜디오 호버 핫패스 — `studio/StudioScene.ts:467-505, 510-518`**
- 근거: pointermove마다 `hover()` → `pick()`이 `rayArrays()`로 배열 2개 할당, `ed.doc.props.forEach` 전수 `propBox`/`rayBox`(`:408-428`), select 도구는 `ed.parts().sources.find(src => src.includes(voxelKey(...)))`로 **소스 셀 배열 선형 탐색**(`:477`), prop 도구는 `ghostProp()`이 포인터 이동마다 `bakeBuildingGeometry({parts:[],props:[prop]})` 전체 재베이크(`:511-513`). `ghostKey` 필드(`:79`)는 `''`로만 쓰이고 캐시 키로 사용되지 않는다 — 캐시를 의도했던 흔적.
- 제안: 마지막 `(prop 종류, size, rot, pos)` 키가 같으면 베이크 생략(키 필드는 이미 있음). `src.includes` 대신 `Set<string>` 역색인(`cellKey → sourceIndex`)을 `ed.parts()` 결과와 함께 캐시.
- 위험: 낮음.

**[P2-7] 건물 지오메트리 베이크 자체의 할당 — `render/buildingGeometry.ts:44-113, 119-142`**
- 근거: `GeometryBuilder.vertex()`가 `this.fac.push(...this.facade)`(스프레드, `:65`), `tri()`가 `[a,b,c]`·`n` 배열 할당(`:70-93`), `walls()`가 정점마다 V3 배열 생성(`:131-141`). 스튜디오는 편집마다 전체 재베이크하며 `lastBakeMs < 16ms`로 즉시 베이크와 지연 베이크를 전환(`StudioScene.ts:19-20, 304-318`) — 베이크가 빠를수록 큰 초안에서도 즉시 모드를 유지.
- 제안: 정점 버퍼를 성장형 `Float32Array`로, `facade`는 4개 필드 직접 push. **먼저 `bench`(예: 큰 voxel 초안 베이크 시간)를 만들어 실측** — 미측정.
- 위험: 낮음(출력 버퍼 바이트 동일성 테스트로 보호 가능; 동일 부동소수점 연산 순서 유지).

**[P2-8] 차량/보행자 인스턴스 매 프레임 재기록(일시정지 포함) — `render/vehicles.ts:296-358`, `render/pedestrians.ts:196-244`**
- 근거: 시뮬 속도 0일 때 스냅샷이 오지 않아 `alpha`가 1로 수렴하는데도 매 프레임 전 인스턴스 행렬 재기록 + `needsUpdate`. 이동 중에는 보간 때문에 필수.
- 제안: `(cur, prev, alpha==1)`이 직전과 같으면 `update()` 조기 반환. 기존 `stream.latest()`의 객체 동일성 비교 패턴(`signals.ts:52`)을 재사용.
- 위험: 낮음. 단 `grow()`/`allocate()` 직후와 `syncTypes` 직후에는 반드시 한 번 다시 써야 한다.

**[P2-9] 리액트: `simStats` 4Hz 객체 교체 → 시계/대시보드/상태바 리렌더 — `main.tsx:60-65`, `ui/App.tsx:27-35, 150-160`, `ui/Dashboard.tsx:37-43`**
- 근거: `{ ...snap.stats }`(`main.tsx:64`)가 250ms마다 새 객체 → `GameClock`의 `useStore(s => s.simStats?.clock)`가 `clock` 객체(참조가 매번 바뀜)를 반환해 4Hz 리렌더. `Dashboard`는 `simStats` 전체를 구독해 4Hz로 전체 리렌더(`designStats`는 `useMemo`로 보호됨, `:43`). `StatusBar`는 `s.doc.meta.trafficDensity` 하나 때문에 `docVersion`을 구독(`App.tsx:157-159`)해 모든 명령에 리렌더.
- 제안: `GameClock`은 `clock.dayTime` 분 단위 정수를 선택, `Dashboard`는 sim 통계 하위 컴포넌트를 분리(`<SimStats/>`)해서 `designStats` 부분이 리렌더되지 않게. `useDoc()` 훅 도입(P2-10).
- 위험: 낮음. 렌더 결과(텍스트)는 동일해야 하며 UI 테스트의 `data-clock` 셀렉터 유지.

**[P2-10] `doc`+`docVersion` 이중 구독 보일러플레이트 16곳 — `ui/*.tsx` (grep `useStore((s) => s.docVersion)` = 16건), 예: `ui/Inspector.tsx:67-68, 218-219, 290-291, 338-339, 363-364`, `ui/Toolbar.tsx:60-61`**
- 근거: 문서가 제자리 변경(in-place)이라 `docVersion` 구독이 리렌더 트리거 역할 — 의도된 설계이나 같은 두 줄이 16번 반복되고, 일부 `useEffect`/`useMemo` 의존성 배열에 `doc`(항상 같은 참조)이 들어 있다(`Inspector.tsx:81` `[id, custom, doc]`, `BuildingEditor.tsx:66` 등) — 읽는 사람을 오도.
- 제안: `useDoc(): { doc, version }` 훅 하나로 통합하고 의존성은 `version` 사용. 동작 변화 없음.
- 위험: 낮음. 단 `useMemo`의 `[doc, docVersion]`을 `[version]`으로 바꿀 때 의미 동일함을 확인할 것.

### P3

**[P3-1] 번들 분할 — `apps/web/vite.config.ts`, `ui/App.tsx:6-17`**
- 근거(실측, `npm run build -w @smartcity/web`): `dist/assets/index-*.js` **1,314.15 kB (gzip 367.60 kB)**, `sim.worker-*.js` 103.69 kB, CSS 15.10 kB(gzip 3.87 kB). 127 모듈, 빌드 3.1초. `chunkSizeWarningLimit: 1600`으로 경고를 숨기고 있다(`vite.config.ts:16`). 동적 `import()` 없음.
- three.js(`three.core.js` 1.4 MB 원본 / `three.module.js` 648 kB 원본)는 메인 렌더러가 즉시 필요하므로 lazy-load 불가. 가능한 후보(소스 크기 기준, 최소화·gzip 전 수치): `studio/` 85 kB + `ui/studio/` 30 kB + `ui/building/` 28 kB + `BuildingEditor` 16 kB + `VehicleEditor`/`RoadTypeEditor`/`PartPreview` 약 18 kB ≈ 145 kB → 추정 gzip 약 20 kB 이하 절감(**미검증, 번들 분석기 없이 추정**).
- 제안: `StudioHost`(`App.tsx:303`)를 `React.lazy`로 분리(스튜디오는 열릴 때만 마운트됨 — `useStudioRequest`), `BuildingEditor`도 탭이 열릴 때만. `manualChunks`로 `three`/`react`를 분리해 앱 코드 변경 시 캐시 재사용(이 쪽이 이득이 더 큼). 정적 `buildingGeometry`는 메인 도시 렌더에도 필요하므로 스튜디오 청크와 공유 청크가 생긴다.
- 위험: 낮음. 주의: Playwright e2e가 스튜디오 오픈 직후 캔버스를 기다린다면 lazy 로딩 지연 허용 필요(`studio/*.test.ts`는 영향 없음).

**[P3-2] 중복 코드 정리 (아래 "중복 인벤토리" 참조)** — 위험 낮음.

**[P3-3] 명령 분류표의 드리프트 방어 — `render/CityRenderer.ts:20-22`**
- 근거: 3개의 수기 `Set<Command['type']>`. 새 명령이 생기면 조용히 누락될 수 있다. 현재 명령 28종(+`batch`) 중 모두 반영되어 있음을 확인(누락 없음).
- 제안: `Record<Command['type'], {roads?:true; buildings?:true; ...}>` 한 장으로 바꿔 `satisfies`로 전수 검사. P1-1의 선행 작업.
- 위험: 낮음.

**[P3-4] 죽은 코드/미사용 (아래 "죽은 코드" 참조)** — 위험 낮음.

**[P3-5] `fallbackNetwork` 경로 — `render/roadNetwork.ts:76-114, 117-224`**
- 근거: `compileNetwork`는 `@smartcity/sim`의 정적 import이고 같은 코드가 이미 워커에서 필수로 돌아간다. 폴백은 `compile`이 throw할 때만 쓰이며 `nodeSetback`/`fallbackNetwork`은 테스트(17회 참조)에서만 외부 참조. 약 110줄.
- 제안: 삭제 후보이지만 **동작 보존 목적에서는 유지**하고 Phase 3b에서 별도 결정(ADR). 이 단계에서는 건드리지 않음.
- 위험: 중간.

## 큰 파일 분할 경계

| 파일 (줄) | 자연스러운 경계 | 비고 |
|---|---|---|
| `studio/StudioScene.ts` (730) | ① 장면 구성 `constructor` 60-195 → `studioWorld.ts`(잔디·길·그리드·조명; `CityRenderer`와 렌더러/조명 설정 중복) ② 입력 핸들러 `onDown/onMove/onUp/onKey` 약 524-705 → `studioInput.ts` ③ 고스트/하이라이트 `showGhost/clearGhost/hover/ghostProp` 431-518 → `studioGhost.ts` ④ 인스턴스 그리기 `showCells/drawUpper/drawSelection/drawPropMarks/setProblems` | 클래스 필드 접근이 많아 컨트롤러 객체(`{scene, editor, dirty()}`)를 넘기는 방식 권장. 위험 중간. |
| `render/buildingGeometry.ts` (689) | ① `GeometryBuilder`+`walls/cap/pitchedRoof` 44-206 ② 지붕 설비 `scanline…dronePad` 208-345(스캔라인 유틸 포함) ③ `PropBaker`+`bakeProp` 360-523 ④ **셰이더 머티리얼** `createBuildingMaterial` 556-689 → `buildingMaterial.ts` | ④가 가장 깔끔한 분리(문자열 셰이더만, 의존성 없음). 위험 낮음. |
| `render/overlays.ts` (511) | ① 그리기 헬퍼 `line/disc/ring/outline/arrow` 57-95 → `overlayShapes.ts`(`ParcelLayer`/`tools`와 공유 가능) ② `DynLayer` 36-55 ③ 개별 `build*` 6개 → 각각 순수 함수 `(doc, net, state) => MeshBuilder` ④ 고스트 건물 `ghostGeometries`+`setPreview` 97-200 → `ghostBuilding.ts` ⑤ 피어 커서/라벨 `update` 일부 → `peerLabels.ts` | P1-1 무효화 작업 시 ③ 분리가 선행되면 쉬움. |
| `tools/selectTool.ts` (440) | 드래그 상태 머신 `startDrag/updateDrag/finishDrag` 140-290 → `selectDrag.ts`, 회전 `rotateBy/commitRotation/onWheel` 275-330 → 회전 헬퍼, 프리뷰/고스트 `ghost()/buildingGhost()/preview()` 381-440 | 건물 고스트(`buildingGhost`)는 `buildingTool.ts:157,214`와 중복 → 공용화(아래). |
| `ui/Inspector.tsx` (399) | `NodeInspector`(65-215, 신호 위상 편집 포함) / `SegmentInspector` / `BuildingInspector` / `StopInspector`를 `ui/inspector/*.tsx`로 파일 분할. `suggestPhases`·`leaveBearing`·`withLegs`는 `ui/inspector/phases.ts`로 | 순수 이동, 위험 낮음. `suggestPhases`는 export되어 있으나 외부 사용처 없음(테스트 포함 0). |
| `studio/StudioEditor.ts` (367) | 도구/선택 상태 vs `History` vs 소품(`placeProp/removeProps/propGroup/propSnap` 216-262) vs 올리기(`beginRaise…endRaise` 305-340) | 클래스가 단일 책임에 가까움 — **분할 우선순위 낮음**. |
| `ui/BuildingEditor.tsx` (365) | 단일 함수 컴포넌트 `BuildingEditor`가 ~330줄: 저장 상태 머신(`useEffect` 71-107) / 볼륨 목록 / 프리뷰. 저장 로직을 `useDesignSave()` 훅으로, 볼륨 목록을 서브컴포넌트로 | `StudioOverlay.tsx`에 거의 같은 저장·낙관적 응답 처리(pending/results) 중복(`:43-46`) → 훅 공유 가능. 위험 중간. |
| `app/store.ts` (354) | `ERROR_KO` 번역표 128-166 → `app/errors.ts`; `ClientStore.receive` 메시지별 핸들러; `selectionExists` | `translateError`는 `tools/streetTool.ts:110`, UI에서 사용. 분리해도 re-export 필요. |
| `ui/App.tsx` (321) | `TopBar` 37-142 / `StatusBar` 150-262 / `SidePanel` 272-296 → 파일 분할 | 위험 낮음. |

## 중복 인벤토리 (web 내부 · web↔shared)

| # | 중복 | 위치 | 제안 |
|---|---|---|---|
| D1 | 폴리곤 닫기 `[...poly, poly[0]!]` 10회 | `render/overlays.ts:80`, `render/parcels.ts:84`, `tools/selectTool.ts:53`(로컬 `closed`), `tools/buildingTool.ts:157,214`, `tools/highlight.ts:20,30`, `tools/parcelTool.ts:89,169,176` | `closedRing(poly)`를 `tools/types.ts` 또는 shared 기하 유틸에 1개 |
| D2 | 건물 고스트(풋프린트 외곽선+가이드+기즈모) 구성 | `tools/selectTool.ts:393-401 buildingGhost`, `tools/buildingTool.ts:206-221 preview()`(유사 구성), `render/overlays.ts:301-311 buildSelection` | `tools/highlight.ts`의 `buildingGhostPreview(type, placement, status, step)` 하나로 통합 |
| D3 | 상태 색상 하드코딩: `'#f87171'`/`'#60a5fa'`/`'#4ade80'`/`'#38bdf8'` | tools 8개 파일 + `render/overlays.ts` 10곳 + `studio/StudioScene.ts` 4곳 + `ui/App.tsx`, `store.ts` | 공용 `ui/palette.ts`(`COLOR.ok/warn/block/select/hover`) — `STATUS_COLORS`(`buildingTool.ts:45`)가 이미 일부 |
| D4 | `ZONE_COLORS`가 `tools/parcelTool.ts:15`에 있는데 `render/parcels.ts:7`, `ui/Toolbar.tsx:4`, `ui/PlanningInspector.tsx:18`이 tools에서 import | 방향이 어색(render → tools 의존) | `ZONE_COLORS`를 `app/` 또는 shared(`planning.ts`의 `ZONE_LABELS` 옆)로 이동. `render/overlays.ts:24`도 `tools/highlight`를 import(렌더→도구 역의존) — `buildingGizmo`를 `render` 또는 shared로 |
| D5 | 호 길이 `curveLength` = shared `polylineLength` | `tools/roadTool.ts:27-32` vs `packages/shared/src/geometry.ts:69` | 삭제하고 shared 사용(동일 `dist` 합) |
| D6 | `bounds()` 중복 | `tools/picking.ts:168-178`(`{min,max}` 반환) vs shared `geometry.ts:355-367`(`{minX..}`) | shared `bounds` + 어댑터, 또는 현행 유지(필드 형태 다름) — 낮은 가치 |
| D7 | 곡선 샘플링 반복: `sampleSegmentCurve(a.pos,b.pos,s.control)` | `render/roadNetwork.ts:130-133`, `render/busRoute.ts:14-17`, `tools/picking.ts` 생성자, `ui/Inspector.tsx:24-30`, shared `apply.ts:210` | 문서 기준 곡선 캐시(`WeakMap<RoadSegment, Vec2[]>` — 단 세그먼트가 불변 교체되는지 확인 필요) 또는 `PickIndex.curveOf`를 단일 출처로 |
| D8 | 방향/방위 계산 3종: `bearing`(`tools/roadTool.ts:22`), `leaveDir`(`render/roadNetwork.ts:136`), `leaveBearing`(`ui/Inspector.tsx:24`) | | `leaveDir`+`bearing` 조합으로 `Inspector`가 재사용 |
| D9 | `centroid(poly)` 웹 전용 구현 | `render/parcels.ts:24-38` (shared/sim에 동일 기능 없음 확인) | shared `geometry.ts`로 이동 가능(`overlays.ts`, `parcels.ts`가 사용). **shared 변경이므로 별도 승인 필요** |
| D10 | 렌더러/조명 세팅 복붙 4곳 (ACES 톤매핑 1.05, PCF 그림자, `HemisphereLight('#dbeafe','#56603f',1.25)`, 태양 `'#fff3dd'`, bias −0.0004) | `render/CityRenderer.ts:72-95`, `studio/StudioScene.ts:92-110`, `ui/PartPreview.tsx:34-48` (×편집기 2개 인스턴스) | `render/sceneKit.ts`의 `createRenderer(opts)`/`addStandardLights(scene)` — 값만 공유, 장면별 상수(그림자 맵 크기 등)는 인자로 |
| D11 | "지오메트리 교체" 3중: `DynLayer.set`(`overlays.ts:50-54`), `ParcelLayer.setGeometry`(`parcels.ts:101-105`), `StudioScene.bake/ghostProp` 교체 후 `old.dispose()` | | `replaceGeometry(mesh, builder)`를 `meshBuilder.ts`에 |
| D12 | 투명 오버레이 머티리얼 옵션 묶음 (`transparent, depthWrite:false, polygonOffset…`) | `overlays.ts:42`, `parcels.ts:50,53` | `overlayMaterial(opacity, factor, units)` 헬퍼 |
| D13 | 메시 트리 해제: `disposeTree`(`PartPreview.tsx:8-17`) vs `StudioScene.dispose`의 traverse(`:213-218`) | | `render/dispose.ts` 공용 |
| D14 | 도구↔키 매핑: `TOOL_KEYS`(`tools/controller.ts:20`) vs `TOOLS[].key`(`ui/Toolbar.tsx:23-32`) | 두 곳이 어긋나면 단축키와 툴바 표시가 불일치 | 한쪽(`TOOLS`는 JSX 아이콘 포함이라 `TOOL_KEYS`가 `TOOLS`에서 파생되지 못함) → `tools/toolMeta.ts`에 `{id,key,label}` 정의 후 둘 다 import |
| D15 | `isTyping` 2종 | `tools/controller.ts:33-37`(activeElement), `studio/StudioScene.ts:40-44`(event target) | 의미가 다름(전역 키 vs 이벤트 타깃) — 합치지 말고 한 파일에 나란히 두는 정도 |
| D16 | 드래그 임계값 상수 5px 2곳 | `tools/gesture.ts:3 CLICK_SLOP_PX`, `studio/StudioScene.ts:17 DRAG_PX` | `CLICK_SLOP_PX` import |
| D17 | `ui/Inspector.tsx`의 `segmentLength(doc, seg)` 2회 계산 | `:224,230` (`len`이 이미 있음) | `len` 사용 |
| D18 | 삼각분할: `MeshBuilder.polygon`/`cap()`는 `THREE.ShapeUtils.triangulateShape`, shared에 `triangulate`(`geometry.ts:373`)가 이미 있음 | `render/meshBuilder.ts:78-87`, `render/buildingGeometry.ts:144-154` | 출력 삼각형 순서가 달라질 수 있어 **동작 보존상 보류**. 건드리지 않는 것을 권장 |

## 죽은 코드 / 미사용

방법: (1) `tsc --noEmit --noUnusedLocals --noUnusedParameters` (비테스트 오류 1건) (2) 비테스트 파일에서 한 번도 참조되지 않는 `export` 추출 스크립트(스크래치패드) + 수동 확인. `knip`/`ts-prune` 미설치(설치하지 않음).

- **실제 미사용 (비테스트·테스트 모두 0, 파일 내부 사용도 0)**
  - `render/roadNetwork.ts:227` `trimmedSpan` — 정의만 있음.
  - `tools/types.ts:42` `EMPTY_PREVIEW` — 정의만 있음.
- **미사용 지역 변수**: `tools/streetTool.ts:136` `lastPos` (tsc TS6133).
- **미사용 필드**: `studio/StudioScene.ts:79` `ghostKey` — 항상 `''`(읽기는 `=== ''` 비교만, `:447,450`). P2-6의 캐시로 쓰거나 삭제.
- **내부에서만 쓰이는데 export** (비테스트 외부 참조 0, 일부는 테스트가 참조): 예) `app/importExport.ts` `chunkCommands/parseImport/newRoomId`(`newRoomId`는 테스트도 0 — 내부 용도 확인 필요), `app/store.ts` `initialState/selectionExists`(외부 0), `render/buildingGeometry.ts` `FACADE_STYLE_ID/GROUND_ID/roofRows`, `render/pedestrians.ts` `PED_HIDE_DISTANCE/PED_JUMP/lerpPedestrian…`(테스트 전용), `tools/streetTool.ts` 다수(`projectOnSegment/featureNear/featureOf/featureError/featureReason/crossingGhost` — 테스트 전용), `ui/Inspector.tsx:39 suggestPhases`(외부 0), `ui/PlanningInspector.tsx` `violationText/parcelOf`(외부 0). 이들은 **죽은 코드가 아니라 export 표면 과다**이며, 테스트가 의존하므로 삭제 대상이 아니다. `export` 제거는 이득이 작아 P3 이하.
- `tools/roadTool.ts:27 curveLength` — 사용 중이나 shared `polylineLength`와 중복(D5).
- 전체 타입 export 중 상당수(`Connection`, `Toast`, `PendingEntry` 등 `store.ts` 타입들)는 비테스트 외부 참조가 없지만 타입이라 번들 영향 없음 → 무시.

## 번들 실측

```
vite v8.3.5  127 modules transformed, built in 3.13s
dist/index.html                    0.77 kB │ gzip   0.47 kB
dist/assets/sim.worker-*.js      103.69 kB
dist/assets/index-*.css           15.10 kB │ gzip   3.87 kB
dist/assets/index-*.js         1,314.15 kB │ gzip 367.60 kB
```
- 단일 앱 청크 + 워커 청크. 분석기 미사용이라 모듈별 기여는 **미검증**(소스 크기 기준 추정만 위 P3-1에 기재).
- 메인 번들에 `@smartcity/sim`의 `compileNetwork`(와 의존 모듈)가 포함된다(`render/roadNetwork.ts:21`). 워커 번들과 중복 포함이지만 메인에서 도로 지오메트리를 얻으려면 필요(P1-4 (c)에서 다룸).
- `dist/`는 `.gitignore`에 있음(`dist/`). 이번 빌드가 생성한 `apps/web/dist`는 커밋 대상이 아니다.

## 건드리면 안 되는 것 (이상해 보이지만 하중을 받는 것)

1. **스냅샷 버퍼 왕복** — `sim/sim.worker.ts:17-18,72-76,89-91`, `sim/simStream.ts:50-80`, `sim/protocol.ts:22-28`. 워커→메인 transfer(복사 없음) → 메인이 `latest+previous`만 유지하고 가장 오래된 것을 `returnBuffers`로 transfer 반환 → 워커 `pool`(최대 4)이 재사용. 정상 상태에서 할당 0. `previous()`를 보간에 쓰므로 반환 시점(세 번째 스냅샷 도착 시)을 앞당기면 **전송된(detached) 버퍼를 읽게 된다**. `snapshotTransferables`의 `includes` 중복 제거(`:25`)는 서로 다른 뷰가 같은 ArrayBuffer를 공유할 때 DataCloneError를 막는 용도. `giveBack`이 `buildingIds`/`stats`/`vehicleTypeIds`를 반환하지 않는 것도 의도(구조 복제 필드).
2. **문서는 제자리 변경, `docVersion`이 변경 카운터** — `app/store.ts:300-310`(`applyCommand(s.doc, …)` 후 `doc` 참조 유지, `docVersion+1`). 그래서 React/렌더러는 `doc` 참조 비교가 아니라 `docVersion`(`overlays.ts:206`, `Dashboard.tsx:43`)이나 하위 객체 참조(`buildings.ts:61-66` `e.ref === t`)로 변경을 감지한다. `useStore(s => s.doc)`만 쓰고 `docVersion`을 빼면 **리렌더가 멈춘다**. "doc을 불변으로" 리팩토링 금지.
3. **`BuildingLayer.sameDesign`의 이중 경로**(`buildings.ts:61-66`, `designSig` `:47`): 참조가 같으면 빠른 경로, 다르면 `rev`+서명 비교 후 `ref` 갱신. 재동기화(welcome)로 문서 객체가 전부 교체돼도 지오메트리 재베이크를 피하는 장치.
4. **`onApplied`에서 `trusted: true`로 적용**(`store.ts:300`) — 서버가 이미 수락한 명령은 정책 검사를 건너뜀(ADR 0007). 클라이언트 측 검증을 "추가"하지 말 것(재동기화 폭주).
5. **`CityRenderer.ts:79` `renderer.info.autoReset = false` + `:266` 수동 `reset()`** — 프레임 통계(드로우콜/삼각형)를 렌더 호출 한 번 기준으로 읽기 위함. 제거하면 통계가 누적된다.
6. **`roads.ts` 단일 머티리얼 + 높이 오프셋(Y_ROAD/Y_MARK/Y_WALK) + `polygonOffset`**, `DoubleSide` — 청크당 1 드로우콜의 근거. 레이어별 머티리얼로 "정리"하면 드로우콜이 급증한다. `Y_WALK`는 `signals.ts` 호출(`CityRenderer.ts:264`)에서도 쓰인다.
7. **`MeshBuilder.tri`의 수평면 위향 강제**(`meshBuilder.ts:26-35`) — 단면 머티리얼이 컬링하지 않도록 상향 법선·CCW 보장. 삼각분할 교체 시(D18) 회귀 위험.
8. **`ParcelLayer`/오버레이 라벨의 `display:none` + `transform` 직접 스타일 갱신**(`parcels.ts:108-117`, `overlays.ts:487-497`) — React가 아니라 프레임 루프에서 직접 DOM을 만지는 것은 의도(리렌더 회피). React 컴포넌트로 바꾸지 말 것.
9. **`StudioScene`의 온디맨드 렌더**(`:711-728`, `dirty`/`controls.update` 반환값) 및 `SLOW_BAKE_MS`/`BAKE_DELAY_MS` 이중 모드(`:304-318`, `sync` 내 분기) — 큰 초안 편집 시 입력 지연 방지. 베이크를 항상 동기로 단순화하지 말 것.
10. **`PartPreview`의 "새 객체를 먼저 추가한 뒤 이전 것 dispose"**(`:117-124`) — 공유 셰이더 프로그램 재컴파일 방지(주석에 명시). 순서를 바꾸면 프리뷰가 깜박인다. `customProgramCacheKey`(`buildingGeometry.ts:557`, `pedestrians.ts:98`)도 같은 목적.
11. **`PedestrianLayer`의 CPU 애니메이션 없는 정점 셰이더 스윙**과 `aGait` 인스턴스 어트리뷰트(`pedestrians.ts:101-138`) — `allocate()`는 지오메트리에 `aGait`를 다시 `setAttribute`하므로 용량 증가 시 새 어트리뷰트가 필요(재사용 불가).
12. **`vehicles.ts:277` `mesh.frustumCulled=false`** 와 용량 `grow()`가 **지오메트리를 재사용**(`:289-291`) — 베이크 비용을 피하는 의도. `syncTypes`의 `JSON.stringify(vt.parts)` 서명(`:263`)도 베이크 캐시 키 역할.
13. **오프라인 모드의 이중 문서**(`net/localTransport.ts:77-84` `cloneJson(this.doc)`와 스토어 문서) — 서버 권위 모델을 에뮬레이트하는 구조. "한 개로 합치기" 금지(불변식 1·3).
14. **`ToolController`의 `store.subscribe(onStore)`가 `docVersion`/`snapStep` 변경 시 마지막 포인터로 `onPointerMove` 재호출**(`controller.ts:101-115`) — 문서가 커서 아래에서 바뀐 뒤 스냅/유효성 갱신. 프리뷰 최적화(P1-3) 시 이 재호출이 여전히 프리뷰를 갱신해야 한다.
15. **`CityRenderer.syncScene` 순서**: 도로 → 건물 → 차량 타입 → `overlays.refresh()`(`:193-215`). 오버레이가 `this.network()`를 읽으므로 `buildRoadNetwork`가 먼저여야 한다. P1-1에서 무효화 방식을 바꿔도 이 순서 유지.

## 권장안 (MVP / 후속)

**MVP (Phase 3a, 위험 낮음 순서)**
1. P3-3: 명령 분류표를 `Record<Command['type'], …>`로 통합(타입 안전망). — 이후 P1-1의 토대.
2. P1-3 (a)(b): 프리뷰 빈→빈 생략, 고스트 키 개선(length 충돌 제거).
3. P1-2: `BusRouter` 1회 인접리스트 + P1-1로 transit 갱신 빈도 제한.
4. P1-1: 오버레이 레이어별 무효화(`CityRenderer.onApplied` 훅에서 전파).
5. P1-4 (a): 청크 인덱스(`chunk → id[]`).
6. P2-10 + P2-9: `useDoc()` 훅, `GameClock`/`Dashboard` 선택자 정리.
7. P2-1, P2-2, P2-8: 신호·점유율·정지 시 인스턴스 재기록 생략.
8. D1·D5·D11·D16·D17 소규모 중복 제거, 죽은 코드 제거(`trimmedSpan`, `EMPTY_PREVIEW`, `lastPos`, `ghostKey`).
9. 분할은 동작과 무관한 이동만: `buildingMaterial.ts`, `ui/inspector/*`, `App.tsx` 3분할부터.

**후속 (Phase 3b 이후)**
- P1-4 (c): 도로 컴파일 증분화 / 워커에서 네트워크 지오메트리 공유(메인·워커 이중 `compileNetwork` 제거) — ADR 필요.
- P2-7 베이크 할당 최적화 — 벤치 선행.
- P3-1 번들 분할(`React.lazy` + `manualChunks`), P3-5 폴백 경로 삭제 결정.
- D9 shared로 `centroid` 이동(shared 변경 승인 필요).

**측정 선행 권장 (이 감사에서 미실측)**: 건물 1,000채·도로 500구간 규모에서 (a) `refresh()` 총 소요, (b) `buildTransit` 소요, (c) `buildRoadNetwork`+`RoadLayer.update` 소요, (d) 큰 voxel 초안의 `bakeBuildingGeometry` 시간. 수정 전후 비교 기준으로 삼아야 한다.

## 근거 자료
- 코드 근거: 본문의 `파일:줄` 참조 (이 저장소, 2026-10-23 시점). 외부 링크 없음.
- 번들 수치: 이 세션에서 `npm run build -w @smartcity/web` 실행 출력(위 "번들 실측").
- 미사용 export 목록: 스크래치패드 스크립트 출력(정규식 기반 — 동적 참조·문자열 접근은 못 잡음, 수동 확인 필요).
- 미검증: 모든 "추정 절감량", 프레임/베이크 소요, `knip` 결과(미설치).

## 위험과 미해결 질문
- 테스트(vitest)는 이번 감사에서 **실행하지 않았다**. 리팩토링 착수 전 베이스라인 `npm test`/`npm run typecheck` 결과 기록이 필요하다.
- 세그먼트/건물 타입 객체가 항상 불변 교체되는지(P1-4 (b), D7의 `WeakMap` 캐시 전제)를 `packages/shared/src/apply.ts`에서 확인해야 한다. 제자리 변경되는 필드가 있으면 참조 비교 캐시는 틀린다.
- P1-1에서 `building.*` 명령이 `parcelCompliance`(규제 위반 배지)에 영향을 주므로 parcel 레이어 무효화 조건에 반드시 포함해야 한다. 같은 이유로 `buildingType.upsert`도 포함.
- `ParcelLayer`가 `tools/parcelTool`(ZONE_COLORS)에 의존하는 역방향 의존(D4)은 AGENTS.md의 의존 방향표와 충돌하지는 않지만(둘 다 web 내부) 렌더→도구 순환 위험이 있다.
- 오버레이 `buildPeers`의 DOM 라벨 재생성(`overlays.ts:222-238`)은 협업자 수가 적어 우선순위를 낮췄다. 접속자 수십 명 시나리오는 미검증.
