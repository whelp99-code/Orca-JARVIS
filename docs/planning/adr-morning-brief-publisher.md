# 아침 브리핑의 원본 재조회와 원자적 저장

2026-09-08, 개선 목록12. 기존 generic binder는 contributing_recommendation_ids 배열을
연결하지 않아 병합된 두 번째 추천의 삭제가 브리핑을 숨기지 못한다.

MorningBriefPublisher는 외부에서 만든 브리핑 본문을 받지 않는다. 현재 lease·날짜·morning_reconcile
단계와 선행 단계 완료를 확인한 뒤 IMMEDIATE transaction 안에서 MorningRecommendationSource를
호출한다. 같은 transaction에서 모든 후보 문맥·추천·행동의 기존 계보와 현재 차단 상태를
검사하고, daily_run/daily_step/morning_brief에 전체 의존성을 연결한다. 기존 DailyLoopStore의
본문·digest·checkpoint와 계보가 함께 commit 또는 rollback된다.

출처 없는 후보·격리·삭제·legacy 삭제 재조정은 발행 실패다. 이미 완료한 단계는 같은 유효
lease에서 재발행하지 않는다. 읽은 스냅샷의 실제 바이트 한도와 최종 저장 시각의 유효기간도
검사한다. 원본 후보가 없으면 검증된 no_data 산출물을 저장할 수 있다.

이 단위는 실제 저장과 Today 조회까지의 로컬 경계다. 현재 generic binder의 다른 호출자,
서비스 스케줄 연결·실제 비용 장부·별도 FYI/대기 소스·provider read fence·운영 배포는 후속이다.
외부 provider와 로컬 SQLite를 하나의 transaction으로 취급하지 않는다.

기존 dependency PK는 target_digest까지만 구분한다. 같은 target에 서로 다른 출처/문맥
identity가 있으면 INSERT OR IGNORE가 일부를 생략할 수 있다. 저장 후 모든 identity가
그대로 존재하는지 대조하고 누락 시 transaction 전체를 거부한다. 이러한 충돌의 자동
병합은 보류하며 기존 migration 바이트와 전역 lineage 계약은 바꾸지 않는다.

## 검증 기록

- 관련 source/Today/저장/형식 회귀4파일40개 통과. 기존 DailyLoop 무결성·동시성 및
  context 형식 회귀3파일8개 통과. 최종 저장 회귀13개+형식2개=2파일15개/10.44초 통과.
- 최종 lint/typecheck/backend build exit0. `morning-publisher-accepted-{tests,lint,types,build}.log`.
  마지막 시각 역행 검사를 추가하는 중 이전 build는 BACKEND_BUILD_SOURCE_CHANGED로 거부됐다.
  변경을 마친 뒤 위 최종 체크를 다시 실행했다. 이전 실패를 성공 증거로 사용하지 않는다.
- 실제 compiled 별도 Node2프로세스: 정상 후보6개→병합 항목1개·출처2개·본문3376bytes;
  저장 후 두 번째 출처 삭제 시 Today no_data. 잠금 대기 전 미리보기6개에서 부모가
  출처를 삭제/commit한 후 자식은 현재 후보3개·출처1개·본문3167bytes만 저장했다.
  두 시나리오의 Today 조회 DB쓰기0, 임시 DB 정리 완료.
- 증거 루트 `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`, 실제 프로세스 도구/결과
  `morning-publisher-live.mjs/json`, 최종 실행 `morning-publisher-accepted-live.log`.
- 자료·삭제 권한은 합성 fixture이며 로컬 저장·읽기 검증이다. 실제 provider·서비스·운영
  인수로 확대하지 않는다. generic binder 전체 교체나 충돌 schema 변경은 이 변경에 포함되지 않는다.
