# 저녁 게시와 일일 예산의 원자 정산

2026-09-08. EveningCloseoutStore에 settleWithinBudget을 추가한다. 기존 settle은
단계 저장 후 중단 복구 계약을 유지한다. 새 경로는 외부 신뢰 키로 산출물을 검증하고,
기존 settle과 같은 날짜의 dailyLoopUsage 검사를 하나의 immediate transaction으로 묶는다.
예산 초과나 게시 중 예외는 단계·run 변경을 모두 롤백한다. 예산은 기존 일일 설정의
닫힌 정수 파서를 재사용하며 morning의 DailyBudgetExceeded 오류도 공통 집계 모듈로 옮긴다.

예산 초과 후 run 실패 기록 여부는 상위 실행기의 책임이다. 이 메서드는 완료를 남기지
않으며 원래 claim/step을 보존한다. 원장에 이미 있는 같은 날짜의 완료 사용량을 포함한다.
누락된 신뢰 키를 artifact 키로 대체하지 않는다. 실제 원본/서명 구성/저녁 실행기와
service/timer·retention 연결은 계속 필수 후속이며 운영 활성화를 의미하지 않는다.

검증: 새 메서드 도입 전3회귀 실패, 구현 후 첫3파일28통과. 추가 검증을 포함한 최종3파일29통과,
lint/typecheck/backend build exit0. 단계저장 직후 예외·아침 사용량 합산·잘못된 예산·
세 예산 차원의 초과 롤백·정확경계·동일재생을 확인했다. 테스트 횟수는 중복 합산하지 않는다.
실제 compiled Node/SQLite/Ed25519 부모PID4008427/자식4008515에서 단계저장 직후 SIGKILL,
DB재개방 원상태동일·재실행완료·추가재생없음 및5/1/3636집계를 확인했다.
증거 /home/jm/.cache/jarvis-test-runtime-qa-20260908/evening-budget-*.log/mjs/json.
합성 원본과 시험키의 실제 프로세스 검증이며 운영 저녁 실행 인수가 아니다.

독립 검토 /root/evening_budget_review: ship, 코드 수정 요구0. 요청gpt-5.6-sol/high,
실제 모델·effort 미노출. 단일 신뢰 키 집계의 키 교체/당일 복수 키 지원은 후속 구성 범위다.
