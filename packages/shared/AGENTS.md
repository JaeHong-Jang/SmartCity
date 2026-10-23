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
- `growthPresets.ts`: 성장용 기본 설계 6종. `createEmptyDoc`와 v3→v4 마이그레이션에서만 추가한다.
- `editing/zoning.ts`: `lotsAlongSegment`는 도로변 8m 셀 기반 lot(auto, frontage)을 만들고, `lotsToCommand`는 이를 `parcel.upsert` batch로 묶는다. batch는 최대 1000개다.
- `growth.ts`: `demand(doc)`는 RCI 수요를 계산한다. `growthStep`과 `growthTick`은 문서만 읽고 해시 RNG를 쓰는 성장 명령을 만든다. 서버 `GrowthDirector`와 웹 `LocalTransport`가 호출한다.
- 도로 편집(`segment.add`, `node.move`, 폭이 넓어지는 `segment.setType`·`roadType.upsert`)은 같은 트랜잭션에서 차도와 겹치는 auto 필지와 그 안의 auto 건물을 지운다(`apply/roads.ts pruneAutoLots`). 분할 시에는 frontage를 재매핑한다.
- `protocol.ts`: AI 도우미 메시지(`ai.ask`, `ai.cancel`, `ai.status`, `ai.progress`, `ai.proposal`, `ai.error`).
