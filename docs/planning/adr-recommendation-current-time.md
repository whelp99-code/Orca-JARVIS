# 추천의 현재 사용 시각 하한

2026-09-08. 실제 compiled 추천 저장 후 생성1ms전 조회에서 NEXT 3에 미래 추천3개가
current=true로 반환됐다. 조회 쓰기는0이었다. 만료 상한만 검사한 것이 원인이다.

현재 추천 판정에는 canonical 추천의 생성·관측·유효·freshness 확인 시각과 연결된
문맥의 생성·관측·유효 시각, 최신 이벤트의 발생·기록 시각이 모두 조회 시각 이하라는
조건을 추가한다. 시각 역행 시 미래 이벤트를 과거 pending으로 복원하지 않고 current=false로
표시한다. lifecycle_actions의 감사 이력은 보존하며 NEXT 3와 승인 대기 목록에서 제외한다.
이는 역사 시점 복원 API가 아니라 현재 사용 가능성 검사다. 원본/기존 migration 수정은 없다.

재현: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/recommendation-future-repro.mjs/json`.

검증: 최초2개 모두 실패 후 관련7파일52개 통과. lint/typecheck/backend build exit0.
같은 compiled 저장 재현의 미래 current 행동은3→0이며 감사 이력3개 보존·조회쓰기0이다.
Today 실제HTTP+frontend parser에서도 생성1ms전 상위상태가ready→no_data로 바뀌었고
생성 시·만료 시·다음 날의 기존 결과를 유지했다. 로그/결과는 같은 증거 루트의
`recommendation-current-time-{tests,lint,types,build,http}.log`와
`recommendation-current-time-live.mjs/json`이다. 합성DB·로컬HTTP 인수이며 운영변경은 없다.
