# ADR — 승인 실행기에 작업 런타임 연결

2026-09-08. 전체 개발 목표의 TaskSpec→실행→결과 경로를 기존 ApprovedCommandExecutor에 연결한다.
별도 큐나 승인 체계를 추가하지 않는다. task.execute는 구현된 handler를 갖지만 호스트에 명시적으로
구성한 provider/검증기와 현재 승인·계획을 통과해야 실행된다. 서비스 배포·운영 키 생성은 수행하지 않는다.

task 요청은 일반 claim/run/settle 분기 앞에서 전용 실행기로 라우팅한다. v2·정확한 기본 graph·현재
workflow binding, provider와 verifier 준비를 claim 전에 검사한다. 사전 검사가 실패하면 기존 승인을
소비하거나 실패 상태로 바꾸지 않는다. 준비는 로컬 실행파일·키 metadata·등록 공개키와 고정 sandbox
probe이며 모델 인증 성공을 보장하지 않는다. 모델 요청을 readiness probe에 사용하지 않는다.

호스트 구성은 JARVIS_TASK_CLAUDE_PATH, JARVIS_TASK_VERIFIER_KEY_PATH, JARVIS_TASK_VERIFIER_KEY_ID다.
요청 args는 실행파일·키 경로를 선택하지 못한다. 현재 완성된 Claude provider를 연결하며 Codex 계획은
지원 구현이 생길 때까지 명시적으로 거부한다. 기본 경로·새 키·샘플 인증을 암묵적으로 만들지 않는다.

claim은 계획 timeout(최대 10분) 범위로 요청하되 기존 요청·승인 만료가 항상 상한이다. 실행 중 현재
권한/공유 마감 재검사와 064 완료 정산을 유지한다. 성공 후 재호출은 저장된 완료 영수증만 반환한다.
실패 검증은 command failed, 실행 중 결과를 확정할 수 없는 예외는 uncertain으로 기록하며 provider를
재시도하지 않는다. 실패/미확정의 원문 오류는 반환하지 않고 코드와 결과 식별자만 노출한다.

실행 뒤 실패 정산은 자신이 claim한 request/fence/receipt의 operation만 변경한다. 이미 완료된 영수증은
실패로 덮어쓰지 않는다. 만료/취소로 기존 control 원장이 uncertain이 된 경우 그 상태를 존중한다.
원장 정산 자체가 실패하면 완료를 주장하지 않고 오류를 반환한다. 중단 후 새로운 권한으로의 복구·
다른 workflow gate 자동 실행은 별도 계약이 필요하며 이번 연결로 허용하지 않는다.

CLI의 기존 control.execute와 dashboard executor가 같은 handler를 사용한다. check-task는 실제 런타임
사전 검사 결과/사유를 반환하되 승인 여부와 인증 성공을 대체하지 않는다. UI 계획 작성·최종 결과 상세와
전체 운영 인수는 후속 범위를 유지한다.

자동 microloop의 순차 승인 큐에서는 task.execute를 명시 제외한다. 준비되지 않은 첫 요청의 반복 선택과
최대 10분 모델 호출이 관찰/GJC/복구 주기를 막는 것을 방지한다. 기본 큐 API는 기존 동작을 유지하고
microloop 호출자가 제외 조건을 전달한다. 자동 작업 스케줄링은 별도 비차단·복구 계약까지 보류한다.
dashboard 기본 executor에는 현재 시각 함수를 전달하며 요청 접수 시각을 고정 clock으로 재사용하지 않는다.
