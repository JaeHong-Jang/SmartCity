# Review: Phase 3b·3c 교차 리뷰
> 리뷰어: Sol · 관점: 조사·분석·검증  
> 기준: ADR 0009 및 council 결정 · 대상: `git diff HEAD`와 신규 파일  
> HEAD: `d875685de0a73301993b6ade8ac1d887c9d87450` · 파일 수정 없음

## 판정: reject

추가 전용 제안의 사용자 데이터 보호, AI 비용·시간 제한, 도로 편집의 렌더 무효화에서 재현 가능한 결함이 있습니다.

**실행 증거**

- `npm run typecheck`: 전체 통과.
- `npm test -- --no-cache --configLoader runner`: **59개 파일·403개 테스트 통과**, 서버 테스트 27개 실패. 실패는 모두 읽기 전용 환경의 `mkdtemp` 오류에서 시작했으므로 제품 결함으로 판정하지 않았습니다.
- 아래 반례는 `TSX_DISABLE_CACHE=1 node --import tsx --input-type=module`의 표준입력 스크립트로 실행했습니다.
- 빌드·브라우저·실제 Claude API 호출·대규모 문서 성능은 **미검증**입니다.

## 지적 사항

| # | 심각도 | 위치 | 문제 | 재현/근거 | 제안 |
|---|---|---|---|---|---|
| 1 | blocker | `apps/server/src/ai/tools.ts:407`, `apps/web/src/app/proposal.ts:35`, `packages/shared/src/apply.ts:207` | AI 조닝 제안이 기존 사용자 필지를 덮어쓸 수 있습니다. | **조닝 제안 생성 → 다른 사용자가 제안의 필지 ID로 수동 필지를 생성 → 제안 적용.** 실행에서 수동 필지는 `public`, 다른 위치, `auto` 없음이었지만 드라이런 결과는 `{}`였습니다. 적용도 성공해 `residential`, 원래 제안 위치, `auto=true`로 덮어썼습니다. `parcel.upsert`에는 신규 ID 전제조건이 없습니다. | 신규 필지임을 서버 커밋 시 원자적으로 검사하는 전제조건을 추가하십시오. 클라이언트 충돌 표시만으로는 검사 이후 경쟁을 막을 수 없습니다. |
| 2 | major | `apps/web/src/app/proposal.ts:35` | 드라이런이 AI 배치 시 적용한 건물 간 겹침 검사를 재실행하지 않습니다. | **AI가 `(100,100)`에 주택 제안 → 다른 사용자가 같은 위치에 주택 배치 → 드라이런·적용.** `invalid={}`, 적용 `{ok:true}`였으며 서로 다른 ID의 주택 두 채가 같은 좌표에 남았습니다. 서버 도구의 `overlapsBuildings` 검사는 제안 생성 시에만 작동합니다. | 현재 문서에 대한 footprint 점유 검사를 드라이런에 포함하고, 적용 시에도 같은 점유 전제조건을 보장하십시오. |
| 3 | blocker | `apps/server/src/ai/agent.ts:76`, `apps/server/src/ai/model.ts:27`, `apps/server/src/ai/service.ts:82` | 120초 제한이 외부 호출을 중단하지 않습니다. 호출 전에만 시간을 검사합니다. | **`maxMillis=10`, abort 신호를 기다리는 모델 주입 → 50ms 경과.** 출력은 `aborted:false, jobs:1`이었고 다른 룸 요청은 “AI가 바쁩니다”로 거절됐습니다. 별도 60ms 지연 모델도 10ms 제한을 넘겨 정상 응답을 반환했습니다. 명시적 취소 후에는 슬롯이 해제됐습니다. | 요청 시작 시 deadline 타이머로 외부 호출을 abort하고, 제한 시간 이후 응답 폐기와 슬롯 해제를 보장하십시오. |
| 4 | major | `apps/server/src/ai/agent.ts:84–100` | `finish`, 일반 텍스트 응답, `pause_turn`이 누적 토큰 검사보다 먼저 처리됩니다. | **응답마다 입력 70,000·출력 15,000 토큰인 각본 모델 → overview 두 번 → finish.** 기본 상한이 입력 200k·출력 40k인데 `{input:210000, output:45000, turns:3}`이 정상 반환됐습니다. | 사용량을 합산한 직후 모든 분기보다 먼저 검사하십시오. 다음 호출의 출력 한도도 남은 예산으로 제한해야 합니다. |
| 5 | major | `apps/server/src/ai/tools.ts:201` | 제안 명령 200개 제한이 batch의 하위 명령을 세지 않습니다. | **길이 3km 도로 양쪽에 `zone_along_road` 각 1회 → 양쪽 모두 성공.** 결과는 최상위 명령 2개, 실제 `parcel.upsert` **250개**였습니다. | 실제 적용되는 leaf 명령 수를 누적하고, batch 적용 전에 남은 예산을 검사하십시오. |
| 6 | major | `apps/server/src/ai/service.ts:36` | ADR의 `SC_AI_MAX_PER_HOUR` 설정을 읽지 않습니다. | **`AiService.fromEnv({ANTHROPIC_API_KEY:'dummy', SC_AI_MAX_PER_HOUR:'1'})` → gate 설정 확인.** 출력은 `perHour:60`이었습니다. 실제 API 호출 없이 확인했습니다. | 환경변수를 검증·파싱해 `AiGate`에 전달하고, 유효하지 않은 값의 처리 정책을 정하십시오. |
| 7 | major | `apps/web/src/render/dirty.ts:17–23`, `CityRenderer.ts:96`, `overlays.ts:250` | 도로 편집으로 필지·건물이 삭제돼도 해당 렌더 계층이 무효화되지 않습니다. | **자동 필지 9개·성장 건물 3개 생성 → `segment.setType(ab, road-6)`.** 문서에서는 모두 삭제됐지만 `commandDomains=1`, `D_BUILDINGS=false`, `D_PARCELS=false`였습니다. 삭제된 건물에 대한 `touchesSelection`도 false입니다. 따라서 건물·필지 메쉬가 이전 상태로 남는 경로입니다. | prune 또는 frontage 변경이 가능한 도로 명령의 영향 도메인과 선택 무효화를 확장하십시오. |
| 8 | major | `packages/sim/src/citizens/citizens.ts:649–652` | 도보 경로가 없으면 유효한 버스 후보를 검토하기 전에 통행을 실패 처리합니다. | **1.6km 도로의 양끝 300m만 보도 설치, 중간 1km는 보도 없음 → 양끝 건물과 직행 버스 연결.** `routeLength=null`이지만 `busOption={line:'L', board:'Af', alight:'Bf', time:309.32}`였습니다. 20,000틱 실행 결과 **통행 114건·실패 114건·최대 대기/탑승 0명**이었고 시민들은 실패 처리로 직장에 도착했습니다. | 최초 도보 경로 실패에서 버스 접근·이탈 경로를 별도로 평가하십시오. 버스 후보가 없는 경우에는 기존 분기를 유지해야 합니다. |
| 9 | major | `packages/shared/src/apply/validate.ts:220–221, 320–325`, `editing/docToCommands.ts` | 편집 후 합법적으로 남는 비활성 필드가 왕복 복원에서 거절돼 데이터가 소실됩니다. | **① 조닝 후 frontage 도로 삭제 → JSON 내보내기·가져오기:** `unknown frontage segment`로 필지 **9개 누락**. **② scramble 설정 후 4지 중 두 도로 삭제 → 가져오기:** 컴파일 시 무시돼야 할 scramble 때문에 `intersection.set` 전체가 거절되어 제어 설정 **1개 누락**. 모두 `parseImport`로 재현했습니다. | 생성 시 검증과 저장 문서 복원 정책을 구분하십시오. ADR이 허용한 dangling frontage와 비활성 scramble의 보존·왕복 테스트가 필요합니다. |

**추가 검증 결과와 한계**

- 기존 버스·스크램블·성장·제안·transfer 테스트는 위 403개 통과에 포함됩니다.
- 하차 대기 상태를 직접 구성해 버스 제거, 노선 삭제, 집 철거, 정류장 삭제, 재컴파일, 정원 감소를 각각 실행했습니다. 240틱 후 시민 불변식 오류는 모두 `[]`였고, 실패 대상 승객은 한 번만 집계됐습니다. 이는 내부 상태를 구성한 검증이며 실제 UI 흐름 검증은 아닙니다.
- 도로 prune의 `tryApplyCommand().rollback()`은 깊은 동등성 검사를 통과했고, trusted replay 결과도 일치했습니다. 로그 실패 롤백과 서버 재시작 복원은 환경 제약으로 **미검증**입니다.
- 무노선 회귀 및 `BUS_CORRIDOR` 골든 테스트는 통과했습니다. 현재 참조 상수의 일치는 확인했으나, HEAD의 3a 구현을 별도로 실행한 독립 비교는 프로세스 실행 제한으로 **미검증**입니다.
- 키가 서버에 머무는 구조와 문서 문자열을 데이터로 취급하라는 system 지시는 확인했습니다. 실제 프롬프트 인젝션 저항성은 **미검증**입니다.
- `claude-sonnet-5-5`, adaptive thinking, effort 설정 및 `fallbacks:'default'`와 July beta 헤더 조합은 설치 SDK 타입과 공식 문서에 부합합니다. 실제 API 성공 여부는 **미검증**입니다. [모델 문서](https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5), [fallback 문서](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback)

## 동의하는 점 (짧게)

- 사용자·시스템 성장 명령이 공통 커밋 경로를 사용하는 구조.
- 승객 관계 정리의 공통화와 중복·고아 참조 검사.
- 독점 보행 위상에서 차량 허가를 차단하고 잔류 점유를 보호하는 방식.
- 성장 프리셋의 버전 한정 마이그레이션, 스냅샷의 `busLoad`·`stopWaiting` transfer 반영.