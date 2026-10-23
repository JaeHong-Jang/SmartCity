# 오케스트라 팀 하네스

SmartCity는 5개 모델이 역할을 나눠 일하는 구조로 개발한다. 멤버와 모델 정의는 [`team.json`](team.json)이 단일 원본이다.

```
                    ┌───────────────────── 오케스트라 (결정 계층) ─────────────────────┐
                    │                                                                  │
                    │   Claude Opus 5.5  ──  Lead Conductor (Claude Code 세션)          │
                    │        │  분해·계약 정의·통합·최종 결정·구현                         │
                    │        ├── GPT-6 Astra     Systems Orchestrator  (codex)          │
                    │        │     아키텍처·시뮬레이션·서버 설계 리뷰                       │
                    │        └── Gemini 4 Argon  Experience Orchestrator (antigravity)   │
                    │              3D 렌더링·UX·성능 설계 리뷰                            │
                    └──────────────────────────────┬───────────────────────────────────┘
                                                   │ 작업 지시 (templates/task-brief.md)
                    ┌──────────────── 조사 · 분석 · 검증 팀 (서브에이전트) ───────────────┐
                    │   GPT-6.1 Sol (codex)          Claude Sonnet 5.5 (Claude subagent) │
                    │   · 알고리즘/도메인 조사          · 오픈소스/웹 조사                   │
                    │   · 설계 분석                    · 코드베이스 분석                    │
                    │   · 교차 모델 코드 리뷰           · 테스트/빌드/실브라우저 검증          │
                    │                                 · 범위가 명확한 구현                  │
                    └──────────────────────────────────────────────────────────────────┘
```

## 역할 매트릭스

| 활동 | 책임(R) | 리뷰(A) | 비고 |
|---|---|---|---|
| 요구사항 분해·계약 정의 | Opus | Astra, Argon | `packages/shared` 타입이 계약 |
| 아키텍처 결정 | Opus | Astra + Argon council | 결과는 `docs/adr/` |
| 도메인 조사 (교통·도시공학) | Sol | Opus | `docs/research/` |
| 오픈소스·라이브러리 조사 | Sonnet | Opus | `docs/research/` |
| 구현 | Opus 또는 Sonnet(`sc-executor`) | — | 계약 범위 안에서만 |
| 코드 리뷰 | 작성자와 **다른** 모델 (Sol/Sonnet/Astra) | Opus | 자기 승인 금지 |
| 실행 검증 (테스트·빌드·브라우저) | Sonnet(`sc-verifier`) | Opus | 증거 필수 |

## 표준 워크플로

| 워크플로 | 언제 | 문서 |
|---|---|---|
| Feature | 새 기능 | [`workflows/feature.md`](workflows/feature.md) |
| Research | 기술/도메인 조사 | [`workflows/research.md`](workflows/research.md) |
| Council | 되돌리기 어려운 설계 결정 | [`workflows/council.md`](workflows/council.md) |
| Review | 병합 전 검증 | [`workflows/review.md`](workflows/review.md) |

## 실행 도구

```bash
# 외부 멤버에게 단일 질의 → harness/runs/ 에 기록
harness/scripts/ask.sh sol   prompt.md [out.md]    # GPT-6.1 Sol
harness/scripts/ask.sh astra prompt.md [out.md]    # GPT-6 Astra
harness/scripts/ask.sh argon prompt.md [out.md]    # Gemini 4 Argon (agy CLI)

# 오케스트라 council: Astra·Argon 병렬 리뷰
harness/scripts/council.sh prompt.md adr-0002-roads
```

Sonnet은 Claude Code 안에서 `.claude/agents/sc-*.md` 서브에이전트로 호출한다.
요구 CLI: `codex` (Astra/Sol), `agy` (Argon; 구 `gemini` CLI는 개인 티어 지원 종료로 사용 불가).

## 폴더
- `roles/` 각 멤버에게 붙이는 역할 프롬프트(프리앰블)
- `workflows/` 표준 작업 절차
- `templates/` 작업 지시서, 조사 보고서, 리뷰 보고서, ADR 템플릿
- `scripts/` 실행 스크립트
- `runs/` 실행 기록(git 제외). 남길 가치가 있는 결과는 `docs/`로 옮긴다.
