# 저녁 마감 게시 시각 검증

2026-09-08. 일일 운영 연결에 앞서 기존 EveningCloseoutStore를 대조했다.
서명/실행 ID/날짜/lease 검증은 있으나 서명 산출물 generated_at과 실제 settle at의
선후 관계는 검사하지 않는다. 유효한 서명이라도 미래에 생성됐다는 산출물을 현재
완료로 게시해서는 안 된다. 미래 산출물은 쓰기 전에 EVENING_CLOSEOUT_INPUT_INVALID로
거부한다. 같은 산출물의 완료 재생도 같은 시간 조건을 따른다.

과거 날짜의 마감 보고를 나중에 복구하는 것까지 금지하지 않는다. 기존 deadline/fence,
서명검사, 단계 저장 뒤 중단 복구를 유지한다. 이는 저녁 실행기/실제 원본 연결/일일
사용량/운영 timer 구현을 대체하지 않는다. 운영 활성화는 계속 보류한다.

검증: 신규 회귀1실패/4skip 후 관련3파일21개 통과. lint/typecheck/backend build exit0.
실제 compiled Node/SQLite/Ed25519 PID3924180에서 미래 산출물 거부/쓰기0,
생성 시각 경계의 저장 성공, 과거 시각 재생 거부, 동일 재생 추가 저장 없음을 확인했다.
증거: /home/jm/.cache/jarvis-test-runtime-qa-20260908/evening-settlement-time-*.log/mjs/json.
합성 원본을 사용하는 실제 실행파일 검증이며 운영 저녁 자동 실행 인수는 아니다.

독립 검토 /root/evening_settlement_time_review: ship, 지적0.
요청 gpt-5.6-luna/high, 실제 모델·effort 미노출.
