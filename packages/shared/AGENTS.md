# packages/shared — 작업 규칙

루트 [`AGENTS.md`](../../AGENTS.md)를 확장한다.

## apply 모듈 구조
`src/apply.ts`가 `tryApplyCommand`/`applyCommand`/`applyOne` 디스패처이며 공개 import 경로(`./apply.js`)는 그대로다.
- `apply/limits.ts` — `LIMITS`
- `apply/tx.ts` — `ApplyError`/`fail`, 롤백용 `Tx`, 정책 플래그 `policy.enforce`(trusted면 false)
- `apply/validate.ts` — 문서·엔티티 검증기, 정리(clean) 함수, 시설 끝 거리·간격 규칙(`FEATURE_EPS`)
- `apply/roads.ts` — 세그먼트 분할/삭제 cascade, `pruneFeatures`, `dropCrosswalks`, `replaceApproach`

검증 캐시는 호출 안에서만 만들고 호출 사이에 유지하지 않는다.
