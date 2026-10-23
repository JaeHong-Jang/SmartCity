# SmartCity

브라우저에서 여러 사람이 **실시간으로 함께 짓는** Cities: Skylines 스타일 3D 스마트시티 시뮬레이터.
도로·교차로·신호 체계를 직접 설계하고, 건물과 차량·버스를 파트 단위로 직접 만들어 배치하면, 차량이 실제 차선 규칙과 신호에 따라 움직입니다.
최종 목표는 돌발 상황(사고·도로 폐쇄·재난) 발생 시 도시 전체의 대응을 시뮬레이션하는 것입니다.

## 빠른 시작
```bash
npm install
npm run dev        # 협업 서버(:8780) + 웹(:5280)
# 브라우저: http://localhost:5280/?room=main  (같은 room 으로 접속하면 함께 건설)
```
서버 없이 웹만 실행하면 자동으로 **단독 모드**(브라우저 저장)로 동작합니다.

| 명령 | 설명 |
|---|---|
| `npm test` | 전체 단위·통합 테스트 |
| `npm run typecheck` | 전체 타입체크 |
| `npm run build` | 타입체크 + 웹 빌드 |
| `npm run e2e` | Playwright 브라우저 스모크 테스트 |

## 조작
| 입력 | 동작 |
|---|---|
| 우클릭 드래그 / WASD | 이동 |
| 휠 클릭 드래그 / Q·E | 회전 |
| 휠 / R·F | 확대·축소 |
| 1~6 | 선택 · 도로 · 건물 · 철거 · 버스 노선 · 도로 폐쇄 |
| C (도로) / G | 곡선 도로 / 그리드 스냅 |
| Esc / 우클릭 | 도구 취소 |

## 구조
```
packages/shared   도시 문서 스키마, Command, applyCommand, 프로토콜, 도로 플래너
packages/sim      결정적 교통 시뮬레이션 (차선 그래프, A*, IDM, 예약 교차로, 신호, 버스)
apps/server       실시간 협업 서버 (명령 시퀀싱, 프레즌스, 로그+체크포인트 영속화)
apps/web          Three.js 3D 편집기 (도구, 에디터, 인스턴싱, 시뮬 워커)
harness/          오케스트라 팀 하네스 (역할, 워크플로, 템플릿, 실행 스크립트)
docs/             아키텍처, ADR, 조사 보고서, 로드맵
```
- 작업 규칙: [`AGENTS.md`](AGENTS.md)
- 아키텍처: [`docs/architecture/overview.md`](docs/architecture/overview.md) · 결정 기록: [`docs/adr/`](docs/adr/)
- 로드맵: [`docs/roadmap.md`](docs/roadmap.md)

## 개발 팀 (오케스트라 하네스)
| 계층 | 멤버 | 역할 |
|---|---|---|
| 오케스트라 | Claude Opus 5.5 | Lead Conductor — 분해·계약·통합·최종 결정 |
| 오케스트라 | GPT-6 Astra | Systems Orchestrator — 아키텍처·시뮬·서버 리뷰 |
| 오케스트라 | Gemini 4 Argon | Experience Orchestrator — 렌더링·UX·성능 리뷰 |
| 서브에이전트 | GPT-6.1 Sol | 조사·분석·교차 모델 코드 리뷰 |
| 서브에이전트 | Claude Sonnet 5.5 | 오픈소스 조사·검증(테스트·브라우저)·범위 구현 |

자세한 운영 절차: [`harness/README.md`](harness/README.md)

## 라이선스
미정. GPL/AGPL 코드는 복사하지 않는다는 원칙만 확정 — 참고한 오픈소스와 라이선스 주의사항은 [`docs/research/01-oss-survey.md`](docs/research/01-oss-survey.md).
