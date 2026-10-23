# apps/server — 실시간 협업 서버

루트 `AGENTS.md` 확장. 근거: ADR 0001(협업), 0002(영속화). 프로토콜: `packages/shared/src/protocol.ts`.

## 구조
```
src/
  main.ts          진입점: PORT(기본 8780), DATA_DIR(기본 ./data), HTTP + WebSocket(/ws), SIGINT/SIGTERM 시 체크포인트 후 종료
  http.ts          GET /health → {ok, rooms, clients}; apps/web/dist 가 있으면 정적 서빙(경로 탈출 방지)
  room.ts          Room: doc, seq, clients, 명령 처리·브로드캐스트·프레즌스 중계
  roomManager.ts   룸 생성/조회/유휴 언로드(마지막 클라이언트 퇴장 60s 후 체크포인트 + 메모리 해제)
  persistence.ts   추가 전용 로그(.log.jsonl) + 원자적 체크포인트(.json.tmp → rename), 로드 시 재생
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
- 의존: `@smartcity/shared`, `ws`. 로깅은 console 한 줄 형식.
