# Review: 기존 9개 지적 수정 재검증
> 리뷰어: GPT-6.1 Sol · 관점: 입력 검증·명령 원자성·영속화·시뮬레이션 정확성

## 판정: reject

**해결 6건, 부분 해결 3건.** 원래 재현 시나리오는 모두 통과했으나, 확장 검증에서 major 4건을 확인했다. 새 blocker는 확인하지 못했다.

## 지적 사항

| # | 판정 | 재실행 결과 |
|---|---|---|
| 1 | 해결 | 15,000중 중첩 `stop.extra`는 shared에서 저장되지 않는다. 서버는 적용 전에 거절하며 `seq`, 정류장 상태, 후속 가입이 정상이다. |
| 2 | 해결 | `__proto__` 포함 batch가 거절되고 컬렉션 프로토타입이 유지된다. 후속 `node.move("__proto__")`도 거절된다. |
| 3 | 해결 | `roadTypeId="constructor"`와 `typeId=["house"]` 모두 거절된다. |
| 4 | **부분** | 쓰기 전 실패에서는 문서·seq가 복원되고 거절된다. 부분 쓰기 후 실패에는 잔여 로그가 남는다(#10). |
| 5 | **부분** | 원래의 잘린 JSON 꼬리는 제거되며 다음 명령도 재로드된다. 개행 누락과 복구 도중 실패는 처리하지 못한다(#11·#12). |
| 6 | **부분** | `demand:false, maxVehicles:1`에서 200틱 동안 상한을 지킨다. 일반 수요와 함께 생성하면 초과한다. |
| 7 | 해결 | 주행 중 sedan을 `maxSpeed:2, length:20`으로 수정한 뒤 다음 틱에 기존 차량이 제거되고 `removed=1`로 집계된다. 버스 교체·외관 변경 유지 회귀 테스트도 통과했다. |
| 8 | 해결 | 기존 `0→96m` 도로 위에 `0→192m`를 그리면 중첩 오류로 거절된다. |
| 9 | 해결 | `(-2000,0)→(2000,0)`에서 `(-1984,0)→(-1984,80)` 계획과 batch 적용이 모두 성공한다. |

잔여·추가 발견 사항:

| # | 심각도 | 위치 | 문제 | 재현/근거 | 제안 |
|---|---|---|---|---|---|
| 6 | **major** | [buses.ts:89](packages/sim/src/traffic/buses.ts:89), [simulation.ts:321](packages/sim/src/simulation.ts:321) | 버스가 대기 중인 일반 통행을 고려하지 않고, 큐 처리도 상한을 재검사하지 않는다. | 원래 300m 도로·방향별 중간 정류장·버스 2대 구성에 **seed=7, density=3, maxVehicles=1**, 기본 수요 사용 → 첫 `step()` 후 **버스 1대+sedan 1대, vehicles=2**. | 실제 생성 지점에서 공통 상한을 검사하고, 상한 도달 시 대기 통행을 보류한다. |
| 10 | **major** | [room.ts:114](apps/server/src/room.ts:114), [persistence.ts:70](apps/server/src/persistence.ts:70) | append 실패 시 메모리만 복원하여 부분 로그를 남긴다. | 첫 명령의 로그 **35바이트 기록 후 ENOSPC** 주입 → 거절·seq=0. 다음 명령은 `applied(seq=1)`이나 앞의 깨진 꼬리에 붙는다. 체크포인트 전 재로드 → **seq=0, 승인된 노드 유실**. | append 전 길이를 기록해 실패 시 복구하거나, 복구가 확인될 때까지 룸 쓰기를 중단한다. |
| 11 | **major** | [persistence.ts:47](apps/server/src/persistence.ts:47), [:62](apps/server/src/persistence.ts:62) | 마지막 JSON이 완전하고 개행만 없으면 정상 로그로 남겨 둔다. | 개행 없는 정상 `seq=1` 로그 → 첫 로드 성공 → `seq=2` append → 두 JSON이 붙음 → 재로드에서 **seq=0, 두 노드 모두 유실**. | 마지막 레코드의 개행도 확인해 append 가능한 경계로 복구한다. |
| 12 | **major** | [persistence.ts:62](apps/server/src/persistence.ts:62) | 새 복구 코드가 로그 전체를 덮어써 정상 기록까지 잃을 수 있다. | 정상 `seq=1`+깨진 꼬리 → 복구의 `writeFileSync`가 **파일 truncate 후 ENOSPC**를 내도록 주입 → 로그 0바이트 → 재시도에서 **seq=0, 기존 승인 노드 유실**. | 꼬리만 안전하게 truncate하거나, 임시 파일 작성 후 원자적 교체로 복구한다. |

실행 증거와 한계:

- `npm run typecheck`: **종료 코드 0**.
- `npm test -- --configLoader runner --no-cache`: **20개 파일·91개 테스트 통과**. 서버 13개는 `beforeEach`의 `/tmp` 생성이 `EROFS`로 실패하여 본문 **미검증**.
- 원래 9개 시나리오는 `TSX_DISABLE_CACHE=1 node --import tsx --input-type=module`로 별도 실행했다. 서버는 메모리 소켓, 영속화는 Node 파일 API의 메모리 대역을 사용했다. 실제 디스크 장애·WebSocket 통합 검증을 대체하지는 않는다.
- 빌드는 쓰기 제한으로 실행하지 않았다. 저장소 파일은 수정하지 않았다.

## 동의하는 점 (짧게)

- 허용 필드만 저장하고 참조를 own-property로 조회하는 수정은 원래 입력 검증 결함을 해결한다.
- 차량 물리 사양 변경 시 제거 정책과 `removed` 집계가 일치한다.
- 영속화 실패 시 명령을 거절하는 방향은 타당하며, 로그 파일 자체의 복구까지 보완해야 한다.