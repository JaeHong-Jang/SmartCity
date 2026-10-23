# ADR 0005: 렌더링 = Three.js + 청크 병합 + 타입별 인스턴싱 + 워커 스냅샷 보간
- 상태: Accepted · 날짜: 2026-10-23

## 결정
- Three.js WebGLRenderer, 카메라 `camera-controls`. WebGPU는 안정성 확인 후.
- 도로: 256m × 256m 청크별 병합 지오메트리(노면, 표시선). 편집 시 변경 세그먼트 AABB에 걸린 청크만 재생성.
- 교차로 면: 접속 도로 끝 단면 꼭짓점을 각도순 정렬한 다각형.
- 건물: 파트 형태(박스/박공/피라미드)별 `InstancedMesh`, 셰이더로 층·창문 패턴.
- 차량: **차량 타입별 파트를 하나의 지오메트리로 베이크** → 타입별 `InstancedMesh`.
- 시뮬: Web Worker 20Hz. 스냅샷 헤더 `tick`, `graphRevision`, 차량 레코드에 안정 `vehicleId` → id 기준 보간. 버퍼는 메인↔워커 왕복 재사용.
- 렌더러는 `SimulationStream` 인터페이스만 구독(Phase 1 `WorkerSimStream`, Phase 3 `WebSocketSimStream`).
- 피킹: 지면 교차점 + 문서 공간 질의.

## council 의견 요약
Argon Q4·#4·#7, Astra Q4·#7 반영.
