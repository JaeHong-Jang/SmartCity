# packages/shared — 작업 규칙

루트 [`AGENTS.md`](../../AGENTS.md)를 확장한다.

## apply 모듈 구조
`src/apply.ts`가 `tryApplyCommand`/`applyCommand`/`applyOne` 디스패처이며 공개 import 경로(`./apply.js`)는 그대로다.
- `apply/limits.ts` — `LIMITS`
- `apply/tx.ts` — `ApplyError`/`fail`, 롤백용 `Tx`, 정책 플래그 `policy.enforce`(trusted면 false)
- `apply/validate.ts` — 문서·엔티티 검증기, 정리(clean) 함수, 시설 끝 거리·간격 규칙(`FEATURE_EPS`)
- `apply/roads.ts` — 세그먼트 분할/삭제 cascade, `pruneFeatures`, `dropCrosswalks`, `replaceApproach`

검증 캐시는 호출 안에서만 만들고 호출 사이에 유지하지 않는다.

## Phase 3b 모듈 (ADR 0009)
- `growthPresets.ts`: 성장용 기본 설계. 기본 6종은 `createEmptyDoc`와 v3→v4 마이그레이션에서 추가한다. 변형 18종(ADR 0010)은 v4→v5 마이그레이션에서 추가한다. 어느 단계든 문서에 없는 id만 추가한다.
- `facilityPresets.ts`: 시설 설계 4종(`svc-*`, `BuildingType.service`, ADR 0010 §8). `createEmptyDoc`와 v5→v6 마이그레이션에서 문서에 없는 id만 추가한다.
- `editing/zoning.ts`: `lotsAlongSegment`는 도로변 8m 셀 기반 lot(auto, frontage)을 만들고, `lotsToCommand`는 이를 `parcel.upsert` batch로 묶는다. batch는 최대 1000개다.
- `growth.ts`: `demand(doc)`는 RCI 수요를 계산한다. `growthStep`과 `growthTick`은 문서만 읽고 해시 RNG를 쓰는 성장 명령을 만든다. 서버 `GrowthDirector`와 웹 `LocalTransport`가 호출한다.
- 도로 편집(`segment.add`, `node.move`, 폭이 넓어지는 `segment.setType`·`roadType.upsert`)은 같은 트랜잭션에서 차도와 겹치는 auto 필지와 그 안의 auto 건물을 지운다(`apply/roads.ts pruneAutoLots`). 분할 시에는 frontage를 재매핑한다.
- `protocol.ts`: AI 도우미 메시지(`ai.ask`, `ai.cancel`, `ai.status`, `ai.progress`, `ai.proposal`, `ai.error`).

## Phase 7 도로 단면·프리셋 (ADR 0014 §4·§5)
- `roads.ts`: `RoadType.median?: {width, planted}`(중앙분리대, 생략 = 없음). `drivableWidth` = 차선 폭 합(주행 가능 폭), `medianWidth`, `carriagewayWidth` = **보도 사이 전체 폭**(차선 + 분리대; 분리대 없으면 차선 합과 같음). 보도·연석·횡단보도·센서·보행 경로·`roadHalfWidth`는 모두 `carriagewayWidth` 기준. `laneOffset`은 분리대가 있으면 `±(width/2 + (i+0.5)·laneWidth)`.
- 분리대는 `lanesForward === lanesBackward > 0`인 도로만, 폭 `MEDIAN_MIN_WIDTH..MEDIAN_MAX_WIDTH`. 검사는 `medianShapeError` 하나(`roadType.upsert`·`docProblem` 공용).
- `modernPresets.ts`: 중앙녹지 대로 2종(`road-6-median`·`road-8-median`)과 고층 설계 4종(`apt-slab-25`·`apt-tower-35`·`mixed-tower`·`glass-podium`, `growth` 없음). `createEmptyDoc`와 v8→v9 마이그레이션에서 문서에 없는 id만 추가한다. DOC_VERSION 9·PROTOCOL_VERSION 4.
