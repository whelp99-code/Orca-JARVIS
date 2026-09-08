# 아침 보고서 저장 결과와 Today 조회 검증

- 범위: 개선 목록12 실제 보고서 연결의 선행 단위.
- 작업공간: `/home/jm/orca/workspaces/Orca-JARVIS/codex-daily-publication`
- 상태: 개발 후보. 집중 회귀·격리 HTTP 검증 후 리뷰 지적을 수정했으며 최종 재리뷰·전체 gate는 남는다.
- 결정: `docs/planning/adr-daily-artifact-publication.md`.

## 변경과 재현

기존 Today는 최상위 해시를 다시 계산했지만 내부 항목이 `{copy:"unverified"}`뿐이어도
정상 항목으로 세었다. 다른 날짜의 daily run에 저장된 보고서도 읽었으며 no_data는 degraded로
표시했다. 수정 전 신규 조회 회귀는3실패/1통과였다.

공통 verifyMorningBriefResult가 닫힌 객체·배열·기본 값·출처 및 항목 해시·최상위 해시·brief ID,
인용 연결·contributor 중복·분량·섹션 조건과 생성 시각을 검사한다. 입력 parser의 기존
기본 값 검사를 별도 모듈로 공유하고 public parser/오류 클래스는 재수출한다.
UTF-8 절단 결과가 공백으로 끝나는 유효한 생성 결과도 수용한다. 미래 관측은 generator에서
insufficient_citation으로 제외한다. 반환 객체는 입력 객체의 수정 가능한 참조를 공유하지 않는다.
같은 semantic key의 섹션 또는 확정 마감일이 다르면 conflicting으로 제외한다.
서로 다른 우선순위와 마감일을 합쳐 생성 결과가 조회에서 실패하는 경우를 회귀로 재현했다.
마감일 미상(null)은 확정 마감일과의 충돌로 취급하지 않는다.
생성 ID와 원본 식별자가 같아지는 입력은 parser에서 거부한다. 산출물 체크섬은 내용 해시로
검증하고 원본 식별자의 중복 검사에 섞지 않는다. 각각 계산된 값을 사용한 회귀로 확인했다.
no_data 입력에는 기록이 없어야 하고 저장 결과도 항목0·생략0·정확한 no_data 기권 사유를
요구한다. 항목이 있는데 no_data로 표시되던 리뷰 재현을 양쪽 계약에서 차단했다.

Today는 기존 삭제/격리 판정 뒤 daily run 무결성과 brief 검증을 적용하며 phase와 KST 날짜를
대조한다. 정확한 기존 no_external_effect placeholder는 no_data로 유지한다. 다른 잘못된
artifact는 실패하며 해시를 다시 맞춘다고 검사에 통과하지 않는다. no_data 상태를 그대로 반환한다.

## 검증 증거

캐시: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`.

- morning-brief-read-red.log: 수정 전3실패/1통과.
- morning-brief-focused-final.log: 최초10파일65개 통과,11.32초.
- morning-brief-mixed-red.log, morning-brief-deadline-red.log: 섹션/마감일 충돌 각각1실패 재현.
- morning-brief-corrected.log:6파일61개 통과,5.98초.
- morning-brief-corrected-contracts.log:4파일12개 통과,4.31초. 앞 검사와7개 중복, 합계 고유66개.
- morning-brief-corrected-{lint,types,build}.log: 최종 섹션·마감일 수정 후 exit0.
- morning-brief-identity-final-v2.log: 식별자 후속 수정 후9파일68개 통과,8.71초.
- morning-brief-identity-{lint,types,build}-v2.log: 후속 수정 후 exit0. compiled HTTP5개도 재통과.
- morning-brief-no-data-final.log: no_data 후속 수정 후9파일69개 통과,8.39초.
- morning-brief-no-data-{lint,types,build}.log: exit0. compiled 재개방 HTTP5개 재통과, GET쓰기0.
- morning-brief-dashboard.log:34파일240개 통과,30.12초. UI 코드는 이번 단위에서 변경하지 않았다.
- morning-brief-acceptance.log, morning-brief-smoke.log: acceptance/CLI smoke exit0.
- morning-brief-http-live.mjs/json/log: 실제 compiled 제품의 독립 Node 프로세스에서 SQLite를
  저장·완료·닫기·재개방하고 loopback HTTP GET을 실행했다. 정상200/ready·빈 자료200/no_data,
  내부 항목 위조500·다른 날짜500·기존 placeholder200/no_data.5개 모두 조회DB쓰기0.
  합성 근거 원문을 사용했으며 실사용 업무 수집과 운영 활성화의 증거는 아니다. 임시DB는 제거했다.

## 통합 선행 gate와 잔여

고정 a24600e의 verify는 backend2713통과/2실패로 종료했다. 실패2개는
memory-reference-deliveries.ts의 최장225자였으며 b21ee38에서 줄바꿈/들여쓰기로 수정했다.
수정 후 가독성4개·전달원장14개 통과 및 ESLint/diff-check exit0.
검증 전후 HEAD동일·추적바이트 변경0이며 로그는 verify-daemon-integrated-{before,after}.json 및
verify-daemon-integrated.log다. verify 전체 성공은 아직 주장하지 않는다.
verify-morning-artifact.log는 식별자 충돌 리뷰 지적 이후 의도적으로 중단(exit130)했다.
이 중간 실행을 전체 gate 통과로 취급하지 않는다.
verify-morning-artifact-final.log도 no_data 리뷰 지적 이후 중단(exit130)했다.

이번 verifier는 원본 사실의 진실·서명·실행 권한을 증명하지 않는다. 실제 생산자와
서비스 연결, 영속 사용량, 삭제 lineage, 저녁 신뢰 키, 복구/중복 운영 인수는 다음 단위다.
전체01–25 목표와 자동 기억 원본 보존/폐기 HOLD는 유지한다. 새 서비스·DB·운영 설정 변경은 없다.

생산자 연결의 추가 선행 조건: 추천 ranking은 deadline bucket/ref만 저장하고 정확한 due_at은
보존하지 않는다. compiled rankPriorityActions에 같은 근거와22시/23시 마감을 각각 입력했을 때
두 ranked/today 결과가 같았다. morning-source-deadline-loss.json에 결과를 보존했다.
원본 근거의 정확한 시각을 복원하거나 버전이 있는 저장 계약을 보강한 뒤 연결한다.
