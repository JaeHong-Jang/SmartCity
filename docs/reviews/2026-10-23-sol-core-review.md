# Review: shared · sim · server 교차 모델 코드 리뷰
> 리뷰어: GPT-6.1 Sol · 관점: 정확성·입력 신뢰 경계·명령 원자성·협업 일관성

## 판정: reject

**blocker 2건, major 6건, minor 1건.** 아래 지적은 모두 직접 파일을 읽고 실행으로 확인했다. 서버 검증은 실제 WebSocket 대신 메모리 소켓을 사용했으며, 영속화 재생 검증은 메모리 파일시스템 대역을 사용했다. 파일은 수정하지 않았다.

## 지적 사항

| # | 심각도 | 위치 | 문제 | 재현/근거 | 제안 |
|---|---|---|---|---|---|
| 1 | **blocker** | `packages/shared/src/apply.ts:372`, `apps/server/src/room.ts:112` | 검증하지 않은 추가 필드가 문서에 저장되어 룸을 직렬화 불가능하게 만든다. | 유효한 세그먼트 `s`에 `busStop.add`를 보내되, `stop.extra`에 15,000중 중첩 배열을 넣는다. **30,117바이트 JSON이 파싱·적용에 성공 → 문서 직렬화가 `RangeError` 발생.** `Room.command()`는 이미 `seq=1`과 정류장을 반영했지만 `applied`를 보내지 못한다. 이후 다른 클라이언트의 `welcome`도 같은 오류로 실패했다. | 저장 객체는 허용한 필드만 재구성한다. 명령 전체의 깊이를 제한하고, 로그·브로드캐스트 직렬화 가능 여부를 문서 변경 전에 확인한다. |
| 2 | **blocker** | `packages/shared/src/apply.ts:50`, `packages/shared/src/apply.ts:255` | `__proto__` 쓰기는 실패한 batch에서도 롤백되지 않는다. 이후 동일 명령을 적용해도 서버와 클라이언트 결과가 달라진다. | batch에 `node.add(id="__proto__", pos=(0,0))`와 범위 밖 노드 추가를 넣는다. **batch는 실패하지만 `Object.getPrototypeOf(doc.nodes)`가 변경된 채 남는다.** 이어 `node.move("__proto__", (10,0))`를 적용하면 오염된 문서는 `{}`, 실패 batch를 받지 않은 문서는 `{"undefined":{"pos":{"x":10,"z":0}}}`로 직렬화된다. | `__proto__`를 거부하거나 setter를 호출하지 않는 안전한 own-property 쓰기를 사용한다. 신규·로드 문서 모두 같은 정책을 적용하고, 롤백 테스트에서 프로토타입도 비교한다. |
| 3 | **major** | `packages/shared/src/apply.ts:300`, `packages/shared/src/apply.ts:329` | 참조 ID의 문자열 검사와 own-property 검사가 빠져 문서 참조 무결성이 깨진다. | ① 유효한 세그먼트에 `segment.setType(roadTypeId="constructor")` → 상속된 생성자를 타입으로 인정하여 **`roadTypeId: undefined` 저장**, JSON에서는 필드가 사라진다. ② `building.place(typeId=["house"])` → 성공 후 `buildingType.remove("house")`도 성공하여 **타입 없는 건물이 남는다.** | 참조 ID에도 `checkId()`를 적용한다. 존재 여부는 모두 own-property로 확인하고, 검증한 문자열만 저장한다. |
| 4 | **major** | `apps/server/src/room.ts:104` | 로그 append 실패에도 명령을 승인하여 ADR 0002의 내구성 계약을 위반한다. | 저장 경로의 쓰기를 실패시키고 `node.add("n")` 실행 → **append 실패 로그가 출력되지만 `applied(seq=1)` 전송**, 서버 문서에도 노드가 남았다. 체크포인트까지 실패한 상태에서 프로세스가 종료되면 승인된 편집을 복구할 기록이 없다. | append 성공을 승인 조건으로 삼는다. 실패 시 문서·seq를 복원하고 거절하거나, 해당 룸의 쓰기를 중단한다. |
| 5 | **major** | `apps/server/src/persistence.ts:47`, `apps/server/src/persistence.ts:63` | 잘린 마지막 로그를 무시만 하고 제거하지 않아, 복구 직후 승인한 다음 명령도 재시작 시 유실된다. | 로그에 정상 `seq=1` 줄과 개행 없는 `{"seq":2,"cmd":{"type":"node.a`를 둔다. 로드 후 정상 `seq=2` 명령을 append하면 **깨진 마지막 줄에 새 JSON이 붙는다.** 실제 `loadRoom → appendLog → loadRoom` 실행 결과 두 번째 로드도 `seq=1`, 노드는 `n1`만 남았다. | 복구 시 마지막 유효 레코드까지 파일을 잘라낸 뒤 append를 허용한다. 복구 후 새 명령 추가와 두 번째 크래시까지 포함한 테스트를 추가한다. |
| 6 | **major** | `packages/sim/src/traffic/buses.ts:100` | 버스 생성이 동시 차량 상한을 무시한다. | 길이 300m 양방향 도로, 방향별 중간 정류장 2개, `buses:2`인 노선을 만든다. `new Simulation(doc,{demand:false,maxVehicles:1}).step()` → **`stats().vehicles === 2`**. 명세의 hard cap을 넘는다. | 일반 수요와 버스가 공통 생성 한도를 사용하게 한다. 한도가 차면 빈 버스 슬롯은 다음 틱에 재시도한다. |
| 7 | **major** | `packages/sim/src/simulation.ts:284` | 차량 타입을 수정해도 기존 차량의 물리 사양은 갱신되지 않는다. | 주행 중인 sedan의 타입을 `maxSpeed:2, length:20`으로 upsert하고 `step()` 실행 → 문서는 새 사양이지만 **기존 차량은 `maxSpeed=30.56`, `len=4.6` 유지**, 속도도 약 12.76m/s로 계속 증가했다. `refreshDerived()`는 `typeIdx`만 갱신한다. | 기존 차량의 물리 파라미터·경로·예약을 안전하게 재검증한다. 길이 확대를 즉시 반영하기 어렵다면 해당 차량을 제거·재생성하는 정책을 명시한다. |
| 8 | **major** | `packages/shared/src/editing/roadPlanner.ts:119` | 공선 중첩을 감지하지 않아 기존 도로 위에 별도 도로를 생성한다. | 기존 도로 `a(0,0) → b(96,0)`에서 `a → (192,0)`을 그린다. **플래너와 적용 모두 성공**, 기존 `a→b`와 새 `a→192`가 함께 남는다. `b`는 새 도로 중간에 있지만 연결되지 않는다. | 공선 중첩 구간을 별도로 검출한다. 기존 구간을 재사용하고 연장부만 생성하거나, 중첩 계획을 명시적으로 거부한다. |
| 9 | **minor** | `packages/shared/src/editing/roadPlanner.ts:66`, `packages/shared/src/apply.ts:455` | 스냅과 분할 검증의 허용 범위가 달라 플래너가 적용 불가능한 batch를 반환한다. | 기존 도로 `(-2000,0) → (2000,0)`에서 `(-1984,0) → (-1984,80)`을 그린다. 시작점은 `split(t=0.004)`로 해석되고 플래너 오류는 없지만, **적용은 `split t out of range [0.01, 0.99]`로 실패**한다. 양쪽 분할 길이는 최소 8m 조건을 만족한다. | 플래너와 적용기의 분할 허용 조건을 통일한다. 실제 분할 길이 검증을 기준으로 삼거나, 플래너 단계에서 같은 제한을 검사한다. |

실행 증거와 검증 한계:

- 재현은 `TSX_DISABLE_CACHE=1 node --import tsx --input-type=module`로 실제 소스 함수를 호출했다. #5만 Node 파일 API를 메모리 대역으로 교체했다.
- `npm run typecheck`는 종료 코드 **1**. `packages/shared/src/apply.test.ts:125`, `:132`에서 `TS2304: Cannot find name 'structuredClone'`이 발생했다.
- Vitest 전체 실행은 **76개 통과**, 서버 테스트 11개는 `/tmp` 생성의 `EROFS`, 교차로 테스트 suite는 캐시 디렉터리 생성 실패로 실행되지 못했다. 캐시 비활성 재시도도 임시 디렉터리 생성 단계에서 막혔다. 이 결과로 전체 테스트 통과를 주장할 수 없다.
- 빌드는 산출물 쓰기가 필요하여 실행하지 않았다.

## 동의하는 점 (짧게)

- 정상 입력의 `welcome` 전송과 룸 가입은 동기적으로 처리되어 이후 `applied`와의 경계가 명확하다.
- 일반 필드 변경은 undo log를 사용하고, 중첩 batch를 거부한다.
- sim의 문서 ID 정렬, 시드 RNG, 후미 기준 예약 해제 구현은 명세 방향과 일치한다.