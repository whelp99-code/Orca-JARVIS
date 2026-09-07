# 작업 완료 → 기억 후보 연결 보류: 원본 차단 전파

2026-09-08. 대상 기준 task completion `7129b9d`, 기억 접수 `b89dab6`. 독립 소스 검토에서 P1 두 건을 확인해 **collect-task 제품 진입점과 신규 collector 소스를 반영하지 않았다**. 초안은 `/var/tmp/jarvis-task-memory-deferred-20260908`에 개발 참고용으로 보관한다. 실행 또는 테스트 통과 산출물이 아니다. 기존 classify/owner confirmation/outbox는 유지한다.

## 발견한 공백

1. 수집 전 task_id 차단 누락. `TaskTimelineSummaryReader.isSuppressed`는 task_id를 검사한다. task.execute의 request_id/run_id는 task_id와 다르다. request/completion/run/source만 검사하는 collector는 숨긴 task를 원본으로 새 후보를 만들 수 있다.
2. 수집 후 원본→파생 후보 차단 연결 부재. candidate/source_refs만 생성하면 source suppression이 후보에 전파되지 않는다. `readCandidateReview`는 candidate_id만 검사하고, owner 결정 및 `hasSecondBrainWriteAuthority`는 task source 차단을 재검사하지 않는다. 후보 생성 후 원 task를 차단해도 이미 보존된 요약의 조회·승인·저장 경로가 열린다.

근거는 독립 코드 검토이며 실제 개인정보 유출이 발생했다는 관측이 아니다. `readTaskCompletion`의 완료/verification/publication 결합은 재사용 가능하지만 신규 요약의 내용 검증 권한이 아니다. 요약을 verified_outcome으로 서명하거나 권한 원장에 직접 넣는 우회는 하지 않는다.

## 재개 조건과 구현 순서

- 검증한 원래 task command/plan/workflow에서 request_id, task_id, run_id, completion_id 및 관련 source/문맥을 모두 확인한다.
- 원본→검토 원문→후보→결정 명령→dispatch/outbox→저장 record/검색의 영속 출처 관계를 정의한다. 기존 projection dependencies가 target 기반이며 원본 task와 새 provider record는 다른 식별자임을 반영한다.
- 수집 전 차단, 수집 후/승인 전 차단, 승인 후/dispatch 전 차단, 전송 중 차단, 저장 후 원본 삭제를 각각 처리한다. 화면에서만 숨기거나 저장 직전 한 번 검사하는 것으로 축소하지 않는다.
- candidate와 provider record의 파생 출처를 정정·삭제·재색인·백업 복원에서도 유지한다. 직접 MCP 클라이언트가 자비스 화면 차단을 우회해 삭제된 파생 기억을 회수하지 않는지 검증한다.
- 검토 원문 보존/폐기·privacy event·재시도/충돌 처리를 기존 단일 writer와 outbox에 연결한다. 별도 기억 DB나 승인 체계를 만들지 않는다.
- 정식 회귀: task_id만 차단한 경우, 후보 생성 후 원본 차단, 이미 준비한 승인 명령, uncertain 전송/재시작, 저장 후 두 클라이언트 조회, 복원 후 재유입 0. 정상 입력은 실제 작업 완료→사용자 검토→저장→출처 재조회까지 확인한다.

이 항목은 B4/I1·I7/G6의 필수 잔여다. 보류를 전체 기능 삭제나 완료 기준 축소로 취급하지 않는다. 현재 제품 classify는 외부 입력에 대한 기존 분류 경로이며 작업 자동 수집 완료가 아니다. 운영 배포·서비스 재시작·push는 수행하지 않았다.
