# ADR — 검증된 작업 결과의 원자적 정산

2026-09-08. 사용자 승인 개발 범위의 다음 구현 단위다. 운영 활성화는 별도 인수 조건을 따른다.

v2 task.execute의 승인된 검사와 Git 게시 산출물이 충족되면 동일 TaskSpec의 기본 agentops workflow를
완료 사실로 정산한다. 자연어 목표 전체나 배포 성공을 자동 증명하는 의미는 아니다. 과거 단계의 관측·평가·
승인 이벤트를 재생하지 않고 `workflow.task_completed` 한 전환에 실제 결과와 현재 node를 기록한다.
이 전환도 기존 전체 step/node 시도 예산을 소비한다. 기본 loop ID와 canonical 정의/digest를 함께 확인하며
사용자 정의 graph는 통합 실행 전에 거부한다. 추가 업무/승인 node를 임의로 건너뛰지 않는다.

현재 실행 승인·receipt·fence·철회·마감과 독립 proof의 전체 PASS, immutable publication 및 실제 ref를
재확인한다. Git 관측과 SQLite는 원자적이지 않다. 완료 영수증은 관측 시각과 immutable commit/tree를
기록하며 이후 ref 이동이 과거 완료 사실과 같다고 해석하지 않는다.

run별 단일 immutable completion receipt를 추가한다. 한 IMMEDIATE transaction 안에서 receipt,
operation confirmed, control completed/effect, workflow 완료/transition/event를 결합한다. 기존 일반
정산 API와 직접 SQL도 receipt 없는 task 완료를 거부한다. task_spec workflow의 일반 complete 전환도
영수증 없이 통과할 수 없다. v1 후보 전용 결과와 실패 검증은 workflow 전체 성공으로 정산하지 않는다.

완료 전 상태/서명 검증과 COMMIT 직전 시각·철회·예산 검사를 분리한다. INSERT/UPDATE/이벤트 기록 중
실패는 전부 rollback한다. 완료된 동일 요청의 재호출은 기록된 결과만 반환하고 다른 요청/계획은 자기
성공으로 재사용할 수 없다. 게시 이후 만료·취소·강제 종료는 자동 실행 재개/권한 연장으로 처리하지 않는다.

기존 executeTaskPlan의 후보/게시 반환 계약을 보존하고 통합 workflow 호출을 추가한다. Approved executor,
CLI/UI 및 운영 준비 연결은 이 정산 단위의 후속 작업이며 task.execute 운영 활성화는 아직 하지 않는다.
