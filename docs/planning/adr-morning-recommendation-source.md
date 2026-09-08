# 저장된 추천에서 아침 브리핑 생성

2026-09-08, 개선 목록12의 실제 일일 생산자 연결 작업.

## 결정

운영용 추천 조회기는 하나의 SQLite 읽기 트랜잭션에서 추천·문맥·출처·최종 행동 상태를
검증하고, 기존 브리핑 생성기와 산출물 검증기를 호출한다. 테스트용 morningRecord의
기본 우선순위·마감·신뢰 값을 생산 코드에 사용하지 않는다.

- 추천 lifecycle이 eligible/presented/selected이고 현재 유효한 pending/accepted 행동만 사용한다.
  삭제·격리된 추천/문맥은 envelope를 읽기 전에, 행동은 개별 행동·이벤트 행을 읽기 전에
  제외한다. 공유 canonical envelope 전체의 무결성 검사는 유지한다. 조회는 DB를 변경하지 않는다.
- 추천 canonical envelope, 행 복제 필드, 행동·이벤트와 문맥 해시·출처 결합을 재검증한다.
- v2 우선순위의 원래 마감 시각과 근거를 사용하며 브리핑 생성 시각으로 날짜 구간을
  다시 계산한다. 마감 근거가 만료된 행동은 제외한다.
- v1 우선순위는 복원 불가능한 근거를 추정하지 않고 legacy_ranking으로 제외한다.
- 모든 추천은 advisory/inferred로 표시한다. accepted는 실행 완료·사용자 사실 확인을
  의미하지 않으며, owner 결정 요구만 pending 상태일 때 유지한다.
- 원본 action ID는 recommendation ID와 함께 이름 공간을 나누고, semantic identity는
  operation과 target_digest를 함께 사용한다. 같은 대상의 다른 작업을 합치지 않는다.
- 출처 링크는 원본 ref·source·evidence digest를 보존하는 식별자로 연결한다.
- 생성 결과와 함께 모든 문맥·추천·행동의 계보를 반환한다. 저장자는 이를 같은 쓰기
  트랜잭션에서 재조회·결합해야 한다. 읽은 스냅샷만으로 나중의 발행 권한을 얻지 않는다.
- 조회 상한과 제외 건수를 반환하고, 일부 제외/원본 충돌·누락이 있으면 degraded로
  표시한다. 아무 후보도 없는 경우에만 no_data다.

## 후속 필수 범위

이번 변경은 실제 저장 자료를 사용하는 추천 기반 생성 경로이다. work execution의 대기 상태,
독립 FYI 소스, 서비스 스케줄·정산, 실제 사용량 장부, 저장 시점 삭제·권한 계보 결합은
같은 일일 운영 목표의 후속 작업이며 완료로 간주하지 않는다. 운영 배포는 하지 않는다.

발행 HOLD 실측: 기존 bindDailyLoopProjection에 대표 recommendation_id와
contributing_recommendation_ids 2개를 전달하면 daily_run/daily_step에 연결된 고유
출처는 1개뿐이다. 배열의 두 번째 추천은 연결되지 않는다. 신규 조회기가 반환하는
전체 lineage를 원자적으로 재검증·결합하기 전에는 저장·서비스 연결을 활성화하지 않는다.
재현: `morning-source-lineage-gap.mjs/json` (아래 증거 루트).

## 검증

- 관련 회귀 7파일69개/15.23초 통과. 미래 결정·반복 action ID와 semantic 병합,
  유효 시작 시각을 보강한 최종 신규 통합+reviewability 2파일16개/10.43초 통과.
- 최종 lint/typecheck/backend build exit 0. dashboard build도 exit 0.
- 최초 신규 실행은 12pass/2fail이었다. fixture의 마감 출처와 KST 다음 날 마감을
  테스트가 잘못 기대한 것으로 확인해 출처와 항목 수 기대를 수정했다.
- 별도 Node 프로세스가 격리 SQLite를 재개방하여 추천 행동3개→브리핑1개, 계보3개,
  정확한 마감 시각, inferred 신뢰 및 조회 DB쓰기0을 확인했다. 자료 준비만 fixture이며
  조회·변환·생성은 compiled 제품 경로다. 운영 업무·스케줄 실증으로 확대하지 않는다.
- 증거 루트: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`.
  `morning-recommendation-source-{tests,final-tests,final-lint,final-types,final-build}.log`,
  `morning-recommendation-source-live.mjs/json/log`.

## 독립 리뷰 수정과 재검증

- 첫 독립 리뷰 `morning_source_review`: fix-first. 추천 lifecycle 누락으로 거절된 추천이
  다시 노출되고, 격리된 행동을 전체 행 검증에서 다시 읽어 형제 행동까지 실패하는 결함을 재현했다.
- lifecycle 8종을 검사하고, 후보로 선택된 rank만 개별 행동·이벤트 검증에 전달하도록 수정했다.
  기존 호출자는 rank를 생략해 전체 검증을 유지한다. 선택된 rank의 손상은 계속 거부한다.
- 수정 후 6파일50개 통과(24.64초), lint/typecheck/backend build exit 0.
  증거: `morning-source-review-fixes-{regression,lint,types,build}.log`.
- 부모 브랜치 27c1fd8의 전체 verify는 exit 1: 첫 shard 1401pass/1fail, 두 번째1391pass.
  실패는 process stress의 Unix socket ECONNREFUSED다. tracked bytes 변경0이며 실패를
  이 기능의 전체 gate 통과로 표시하지 않는다. 별도 수정·전체 gate 재검증이 필요하다.
- compiled 실제 Node3프로세스 재개방 인수: 정상 추천3개→브리핑1개, 거절 추천 행동3개 제외,
  격리된 손상 행동/이벤트 제외 후 형제 rank2·3 유지. 각 조회 쓰기0이다. 원본 자료는 합성이며
  운영 스케줄 인수와 구분한다. `morning-recommendation-source-live.json`에 3개 PID와 결과를 기록했다.
- 수정 후 fresh readonly review `morning_source_final_review`: ship, findings0.
  요청 모델 gpt-5.6-terra/high, 실제 모델/effort와 토큰 사용량은 도구에서 관측 불가다.
