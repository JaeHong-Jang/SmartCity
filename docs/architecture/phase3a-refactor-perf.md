# Phase 3a — 동작 불변 리팩토링·성능

근거: [`research/08-web-refactor-audit.md`](../research/08-web-refactor-audit.md)(Sonnet), Sol 감사(`harness/runs/3a/sol-audit.md`), Opus 프로파일(`harness/runs/3a/prof.ts`, `phases.ts`).

## 원칙
- **동작 불변**: 같은 seed·명령 열이면 매 tick 스냅샷 바이트와 stats가 같아야 한다. 게이트는 `packages/sim/src/golden.test.ts`(소도시 7200틱: 시민 출근·버스·시설 편집 / 격자 2400틱: 신호·분할·노드 이동·폐쇄·삭제). 해시가 바뀌는 변경은 3a 범위가 아니다.
- 웹·shared·server는 기존 단위 테스트 + e2e 5개가 게이트다.
- 파일 분할은 순수 이동으로만 한다. 공개 API(패키지 `exports` = 각 패키지 `src/index.ts` 배럴)는 유지하고, 패키지 내부 모듈 경로는 바뀔 수 있다(`@smartcity/sim`은 `"."`만 export).

## 기준 측정 (Node 22, tsx, 차량 3000 + 보행 5000)
| 항목 | 값 |
|---|---|
| tick(step+snapshot) | 평균 5.4ms, p50 5.0ms, p95 10.3ms, p99 13.1ms |
| 시설 1개 추가 후 재컴파일 step | 약 370~500ms |
| 재컴파일 단계 | compileNetwork 76~90ms(그중 충돌표 buildConflicts가 대부분), buildZones 18~20ms, **restoreZones 154ms(차량마다 횡단 Map 재생성)**, buildPedGraph 14~20ms, reprojectPeds 61ms, routeCrossers 65ms |
| step 상위 self | snapshot 19%, writePose 14%, computeAccelerations 11%, processRequests 10%, Router.find 7%, movePeds 6%, pedRequests 6%, tailOverhang 5% |
| 웹 번들 | 단일 청크 1,314 kB(gzip 368 kB), 워커 104 kB |

## 작업
### sim (Opus)
1. `restoreZones`: crossing id→index Map과 old→new edge 대응표를 재컴파일당 1회 생성.
2. `writePose`/스냅샷: 폴리라인 조각 탐색을 이전 위치에서 시작(차량별 커서) 또는 조각 방향 사전 계산 — **같은 산술 순서**로 바이트 동일 유지. laneFlow·stats 순회 통합.
3. `processRequests`: 요청 배열·레코드 재사용(정렬 키·순서 동일).
4. **증분 컴파일**: 노드별 교차로 결과(커넥터·충돌표)를 입력 서명(노드 위치, 접속 세그먼트의 id·타입·끝 기하·setback, 제어)으로 캐시하고, 바뀐 노드만 다시 계산. 전역 index·정렬은 기존과 같은 순서로 조립. 검증: 무작위 편집 열에서 `compileNetwork(doc, cache)`가 `compileNetwork(doc)`와 깊은 동등.
5. 큐 `splice(0,k)` → head index.
6. 큰 파일 분할: `simulation.ts`(스냅샷 작성기), `peds.ts`(풀·띠 / 이동 / 재투영), `citizens.ts`(일정 heap / 인구 조정 / 통행), `pedGraph.ts`(빌더 / 질의·라우터), `compile.ts`(충돌 기하).

### shared·server (Sonnet executor A)
- `apply.ts`(912줄) 분할: 검증 / Tx / dispatch / 도로 분할·삭제 cascade. 시설 끝 거리·간격 판정 공통화(`FEATURE_EPS` 일치).
- 검증 호출 내 기하 캐시(파츠 outline, 도로 샘플).
- server 영속화: 룸 수명 동안 디렉터리 준비 1회(동기 append 순서·rollback 유지).

### web (Sonnet executor B)
- 오버레이 무효화를 명령 종류별로(`render/dirty.ts`), 버스 경로 인접리스트 1회 + 버스/도로 변경 때만, 고스트 키 버그(파츠 JSON 길이 비교) 수정, 신호 정적 행렬 1회 기록, 점유율 버퍼 dispose·`CityRenderer.dispose` 누락 해제.
- `useDoc` 훅으로 doc+docVersion 이중 구독 통합, `simStats` 갱신 시 값 변화 없으면 객체 유지.
- 중복 제거(D1~D18 중 위험 낮음), 실제 죽은 코드 4건 제거, `manualChunks`로 three/react 분리, 스튜디오 lazy.

## 하지 말 것 (감사 합의)
재컴파일 예약 복구 생략, `routeCrossers`를 예산 큐로 미루기, 재경로·재투영 생략, 전역 index·동률 규칙 변경, OD만 키로 한 차량 경로 캐시, 보행 그래프 지연 빌드, 로그 기록 전 broadcast, 스냅샷 transfer 왕복 변경, doc 불변화·docVersion 구독 제거.

## 수용 기준
- `npm test`, `npm run typecheck`, `npm run build`, e2e 5/5 통과, golden 해시 불변.
- sim: tick p95와 재컴파일 step을 같은 하네스로 재측정해 표로 보고(목표 tick p95 ≤ 4ms, 재컴파일 ≤ 150ms — 미달이면 원인과 수치를 그대로 보고).
- Sol 교차 리뷰 승인.

## 결과 측정 (2026-10-23, 같은 기계에서 HEAD worktree와 교대 실행, esbuild 번들 = 프로덕션에 가까운 코드)
기계 부하가 높아(load ≈ 31, 무관한 작업) 절대값은 흔들린다. 같은 시점에 기준선과 번갈아 잰 쌍을 비교한다.

| 회차 | 기준선 tick 평균 / p95 | 3a tick 평균 / p95 | 기준선 재컴파일+step (6회) | 3a 재컴파일+step (6회) |
|---|---|---|---|---|
| 1 | 8.24 / 15.83 ms | 6.75 / 13.11 ms | 469 405 374 384 388 363 | 291 227 224 163 179 167 |
| 2 | 5.48 / 10.30 ms | 4.96 / 9.61 ms | 544 503 440 426 428 402 | 279 247 206 148 180 146 |

- 재컴파일: 6회 전체 평균 기준 약 2.1배(397→209ms, 457→201ms), JIT가 데워진 후반 3회 기준 약 2.4배(399→164ms) 빨라졌다. 목표 150ms 이하는 12회 중 2회뿐이라 **미달**이다.
- tick(step+snapshot): 평균 18.1%·9.5%, p95 17.2%·6.7% 감소했다. 한가한 시점의 단독 측정은 평균 3.9ms, p95 7.4ms였다.
- **목표 tick p95 ≤ 4ms는 미달**이다. 남은 비용은 프로파일상 차량 A*(heuristic 40m/s로 탐색이 넓다), IDM 가속, 교차로 요청이다. 경로 예산 burst가 p95를 만든다는 것은 추정이다(미검증). 셋 다 동작을 바꾸지 않고는 더 줄이기 어렵다. 다음 후보는 경로 비용 모델과 예산 재설계로, 동작 변경이라 별도 ADR이 필요하다.
- 실제 워커는 배속과 무관하게 50ms마다 스냅샷 1회만 만든다. 그래서 4배속 부담은 4×step + 1×snapshot ≈ 50ms 예산의 약 40%로 **추정**한다(워커 실측 아님).
