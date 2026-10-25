# apps/server — 실시간 협업 서버

루트 `AGENTS.md` 확장. 근거: ADR 0001(협업), 0002(영속화). 프로토콜: `packages/shared/src/protocol.ts`.

## 구조
```
src/
  main.ts          진입점: PORT(기본 8780), DATA_DIR(기본 ./data), HTTP + WebSocket(/ws), SIGINT/SIGTERM 시 체크포인트 후 종료
  http.ts          GET /health → {ok, rooms, clients}; apps/web/dist 가 있으면 정적 서빙(경로 탈출 방지)
  room.ts          Room: doc, seq, clients, 명령 처리·브로드캐스트·프레즌스 중계
  roomManager.ts   룸 생성/조회/유휴 언로드(마지막 클라이언트 퇴장 60s 후 체크포인트 + 메모리 해제)
  persistence.ts   추가 전용 로그(.log.jsonl) + 원자적 체크포인트(.json.tmp → rename), 로드 시 재생, 체크포인트 백업·정리
  rateLimit.ts     토큰 버킷
  *.test.ts        실제 ws 클라이언트로 통합 테스트 (임시 DATA_DIR, 포트 0)
```

## 동작 계약
- 첫 메시지는 5초 내 `hello`여야 함(아니면 close 4000). `protocol !== PROTOCOL_VERSION` → error 후 close. 룸 ID는 `ROOM_ID_RE`.
- `welcome`: clientId(uuid), tag(서버 전역 고유, 짧은 base36), color(팔레트 순환), seq, doc, peers. 이후 `peers` 브로드캐스트.
- `cmd`: `applyCommand(room.doc, cmd)` → 성공: seq++ → 로그 append(동기) → 모든 클라이언트(보낸 사람 포함)에 `applied {seq, cmd, by, ref(보낸 사람에게만)}`. 실패: 보낸 사람에게 `rejected {ref, error}`.
- `presence`: 최대 20Hz/클라이언트, 보낸 사람 제외 브로드캐스트. 퇴장 시 `peers` 갱신.
- `ping` → `pong`.
- 제한: 메시지 `MAX_MESSAGE_BYTES`(ws maxPayload), 명령 토큰 버킷 20/s(버스트 40) 초과 시 `rejected 'rate limited'`, 룸당 클라이언트 50, 파싱 실패 메시지는 `error` 응답(연결 유지), 연속 20회 실패 시 close.
- 체크포인트: 200 명령 또는 30초마다, 종료 시. 파일 `{schema:1, seq, doc}`.
- 로드 실패(ADR 0011): 체크포인트가 파싱·형식 검사·마이그레이션·구조 검사(`docProblem`: 모든 컬렉션이 키 객체(배열 불가), 엔티티 id = 키, 필수 필드 타입, 핵심 참조)를 통과하지 못하면 **빈 도시로 시작하지 않고** 그 룸을 거부한다(`error '도시 파일을 읽을 수 없습니다 — 관리자 확인 필요'` 후 close 1011, 다른 룸은 정상). 원본은 그대로 두고 `<room>.corrupt-<파일 수정 시각>.json` 사본을 1회 남긴다. `doc.version > DOC_VERSION`도 거부(덮어쓰기 방지). 로그 손상(`LogCorruptedError`)도 같은 방식으로 거부하고 로그는 건드리지 않는다: `{seq, cmd}`가 아닌 레코드, 빈 줄, seq 역행·중복, 체크포인트 이후의 seq 건너뜀, 재생 실패. 허용하는 것은 줄바꿈 없는 마지막 레코드(쓰는 중 중단)뿐이며 그 꼬리만 잘라낸다. 체크포인트 seq 이하 레코드(로그 비우기 실패 잔여)는 건너뛴다. 재생은 `trusted`(정책 검사·용량 한도 생략, 구조 검증 유지) — 마이그레이션이 추가한 프리셋 때문에 승인된 로그가 한도에 걸리지 않게.
- 백업 정책: 체크포인트를 쓰기 직전 기존 `<room>.json`을 `data/backups/<room>/<UTC ISO, ':'→'-'>[-n][.prewipe].json`으로 배타적 복사(`COPYFILE_EXCL`, 이름이 있으면 `-1`, `-2`… — 절대 덮어쓰지 않음, 가장 최근 백업과 내용이 같으면 생략). 정렬은 시각 다음 접미사 번호. 보존: 최근 30개 + 최근 14일은 UTC 날짜별 가장 늦은 1개, 나머지는 자동 삭제. 백업 실패는 로그만 남기고 체크포인트를 막지 않는다.
- 비움 경고: 직전 체크포인트(또는 로드) 대비 건물+도로가 10 이상이던 도시가 둘 다 0이 되면 `console.warn` 후 쓰기는 진행하되 이전 파일을 `<시각>.prewipe.json`으로 반드시 백업(14일 보존, 최근 30개 계산에서 제외).
- 복구: 서버 정지 → 백업을 `<room>.json`으로 복사 → `<room>.log.jsonl` 비우기 → 서버 시작.
- 의존: `@smartcity/shared`, `ws`. 로깅은 console 한 줄 형식.
