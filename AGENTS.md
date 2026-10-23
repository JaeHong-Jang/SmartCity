# AGENTS.md — SmartCity 공통 작업 규칙

모든 AI 에이전트(Claude Code, Codex, Antigravity)와 사람이 따르는 단일 규칙 문서다.
세부 모듈 규칙은 각 패키지의 `AGENTS.md`가 이 문서를 확장한다.

## 프로젝트 한 줄 요약
브라우저에서 여러 사람이 실시간으로 함께 만드는 Cities: Skylines 스타일 3D 스마트시티 시뮬레이터.
최종 목표는 돌발 상황(사고·도로 폐쇄·재난) 발생 시 도시 전체의 대응을 시뮬레이션하는 것.

## 저장소 지도
| 경로 | 역할 | 의존 가능 대상 |
|---|---|---|
| `packages/shared` | 명령(Command), 도시 상태 스키마, 네트워크 프로토콜, 기하 유틸, 편집 플래너 | 없음 |
| `packages/sim` | 결정적 시뮬레이션 코어: 도로 그래프, 경로 탐색, 차량(IDM), 신호 | `shared` |
| `apps/server` | 실시간 협업 서버: 룸, 명령 시퀀싱, 영속화 | `shared` (Phase 3에 `sim` 추가) |
| `apps/web` | Three.js 3D 클라이언트: 카메라, 도구, 에디터, 렌더링 | `shared`, `sim` |
| `harness/` | 오케스트라 팀 구조, 역할 프롬프트, 워크플로, 실행 스크립트 | — |
| `docs/` | 아키텍처, ADR, 조사 보고서, 로드맵 | — |

의존 방향은 위 표만 허용한다. `sim`은 DOM/Three.js/Node API를 절대 import 하지 않는다.

## 핵심 불변식 (깨면 안 되는 것)
1. **모든 도시 변경은 Command로만** 일어난다. UI·서버·테스트 모두 `applyCommand()`를 거친다. (협업 동기화, 되돌리기, 재현, 사고 시뮬레이션의 기반)
2. **sim은 결정적**이다. 난수는 `shared`의 시드 RNG만 사용하고 `Math.random`/`Date.now` 금지.
3. **서버가 명령 순서의 권위자**다. 클라이언트는 서버가 부여한 `seq` 순서대로 적용한다.
4. 렌더러는 sim 상태를 **읽기만** 한다. 렌더링 코드에서 상태를 변경하지 않는다.

## 명령어
```bash
npm install            # 루트에서 1회
npm run dev            # 서버(8780) + 웹(5280) 동시 실행
npm test               # 전체 테스트 (vitest)
npm run typecheck      # 전체 타입체크
npm run build          # 전체 빌드
```

## 작업 규칙
- 요청 범위 밖의 리팩토링·포맷 변경 금지. 변경된 모든 줄은 요청과 연결되어야 한다.
- 새 기능 = 테스트 먼저 또는 함께. 버그 수정 = 재현 테스트 먼저.
- 설계 결정은 `docs/adr/NNNN-제목.md`로 남긴다 (템플릿: `harness/templates/adr.md`).
- 완료 주장에는 실행 증거(테스트 출력, 빌드 결과, 스크린샷 경로)를 붙인다.
- 작성자 모델은 자기 코드를 승인하지 않는다. 검증은 다른 모델이 한다 (`harness/README.md`).

## 오케스트라 팀
팀 구성, 역할, 의사결정 흐름은 [`harness/README.md`](harness/README.md) 참고.
