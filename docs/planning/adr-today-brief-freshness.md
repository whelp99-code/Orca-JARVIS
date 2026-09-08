# Today의 브리핑·문맥 유효 시각

2026-09-08. compiled 로컬 저장 인수 뒤 2시간/다음 날 Today 조회에서도 brief 상태와
항목 수가 그대로이고 context freshness.state=fresh인 결함을 재현했다.

Today 응답에서 원본 생성 당시 품질과 현재 유효성을 구분한다. 현재 KST 날짜가 다른
브리핑 또는 항목의 freshness/validity 만료는 state=stale로 표시하며 유효 항목 수만 집계한다.
미래 생성·미래 유효시각은 no_data다. 저장 산출물의 원문·digest는 수정하지 않는다.
문맥 상태는 freshness 만료와 expires_at을 함께 검사하고 반환 freshness.state에도 반영한다.
만료 문맥의 freshness.state는 expired, 상위 리소스 품질은 기존 계약에 맞춰 stale이다.
프런트엔드 Today 계약에 stale을 추가하며 일반 상세/역사 조회의 계약은 변경하지 않는다.

## 검증

- backend 게시/조회/형식 4파일23개, dashboard 전체35파일248개 통과.
  초기 dashboard 재실행은 expired 파서 누락으로247통과/1실패였다. Today 파서만 확장했다.
- lint/typecheck/backend+dashboard build exit0. 증거는
  `/home/jm/.cache/jarvis-test-runtime-qa-20260908/today-freshness-final-*.log`와
  `today-freshness-accepted-dashboard.log`다.
- compiled 게시 후 SQLite를 닫고 다시 열어 실제 dashboard HTTP와 frontend parseToday로
  생성 전/생성 시/만료 시/다음 날의4응답을 검사했다. 모두 HTTP200이며 만료 후
  brief=stale/0items, freshness=expired, Today=stale이었다. 조회 DB쓰기0.
  실행·결과 `today-freshness-live.mjs/json`. 운영 서버가 아닌 임시 loopback 서버와 합성 원본이다.
- 생성 전 조회에서 brief/context는 no_data지만 기존 recommendation이 next_actions에 남아
  상위Today=ready임을 관측했다. 추천 자체의 미래 시각 검사는 별도 후속 수정 대상으로 유지한다.
- 후속58d3827에서 추천 시각 하한을 구현해 위 미래 NEXT 3를0개로 수정했고 실제HTTP에서
  상위Today=no_data를 재확인했다. 별도 fresh review가ship을 반환했다.
- Today fresh reviewer /root/today_freshness_review는ship/지적0건. 요청sol/high,
  실제설정미노출. 독립재실행backend6개/dashboard26개통과이며 초기환경오류/파일미발견은
  성공증거에서제외했다. 부모전체dashboard248개와별도최종parser26개는중복이므로합산하지않는다.
