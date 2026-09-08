# 서명된 저녁 산출물의 일일 사용량

2026-09-08. dailyLoopUsage는 morning/refresh만 해석하며 evening_summary 완료를
무결성 오류로 거부한다. 저녁 실행기를 연결하기 전에 같은 날짜의 실제 완료 산출물을
예산에 포함해야 한다. 선택적 TrustedCloseoutKey를 소비자 구성에서 제공받고, 서명과
artifact.run_id/local_date/correlation_id가 원장과 일치할 때만 집계한다.
키를 artifact 자체에서 신뢰하거나 키가 없을 때 검사를 건너뛰지 않는다.

작업 수는 완료 단계당1, 바이트는 저장된 canonical JSON의 UTF-8 길이다. 항목 수는
verified_completions/open_or_failed/decisions_made/owner_decisions_required/
unresolved_risks/memory_candidate_support와 tomorrow_first_action이 존재할 때1의 합이다.
eligible_memory_candidate_ids는 support의 중복 인덱스이므로 다시 계수하지 않는다.
삭제·숨김 산출물도 이미 소비한 사용량에서 환불하지 않는다. 기존 날짜/원장 무결성,
미지원 event/legacy 완료 차단을 유지한다. 기존 morning 호출은 키 없이 계속 동작한다.

이 변경은 집계만 확장한다. 실제 저녁 원본·서명 키 공급·게시와 예산의 원자 정산·
service/timer 연결은 후속 필수 범위이며 이번 변경으로 자동 운영을 활성화하지 않는다.

검증 기록
- 이전 집계기가 신뢰 키를 제공해도 저녁 산출물을 거부하는 것을1fail/5skip로 재현했다.
- 첫 관련2파일24통과, 추가 신원 불일치 회귀를 포함한 최종2파일23통과. 중복이 있어 합산하지 않는다.
- lint/typecheck/backend build exit0. 실제 compiled Node/SQLite/서명 PID3957933에서
  5항목/1작업/3636바이트 집계 및 키 누락/불일치 거부를 확인했다.
- 증거: /home/jm/.cache/jarvis-test-runtime-qa-20260908/evening-usage-*.log/mjs/json.
  합성 원본·시험 서명 키이며 운영 자동화 인수는 아니다.

독립 검토 /root/evening_usage_review: ship, 지적0. 요청 gpt-5.6-luna/high, 실제 모델·effort 미노출.
