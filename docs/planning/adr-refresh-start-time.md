# Legacy 상태 로그의 시작 시각과 refresh 완료 시각 분리

2026-09-08. 일일 루프의 실제 refresh 연결을 준비하며 생산자와 소비자를 대조했다.
Second Brain sb/pipeline.py의 _run_locked는 started로 runs.log 문장을 구성한다.
finished는 별도로 ledger.record_run에 저장한다. read_status는 마지막 로그 문장을 반환한다.
또한 run은 ingest/compile/brief 단계를 수행하므로 마지막 단계의 ok가 전체 refresh 완료를
증명하지 않는다. 이번에는 Second Brain 코드나 운영 데이터를 수정하지 않았다.

자비스 parseSecondBrainLegacyStatus가 started를 last_successful_refresh_at으로,
runtimeSecondBrainReadinessProbe가 이를 completed_at으로 노출하는 오류를 수정한다.
Legacy 성공 이력 자체는 파서에 유지하되 완료 시각은 null, runtime refresh는 missing으로
보고한다. 평가기의 신선도는 unknown이다. 명시적으로 완료 시각을 가진 구조화 관측은
기존 평가를 유지한다. capped/failed의 attempted_at도 기존 시작 시각 의미를 유지한다.

일일 루프의 RefreshCompletion에 로그의 시각이나 ID를 임의 매핑하지 않는다.
전체 refresh 결과·완료 시각·provider/generation 연결 증거를 갖춘 생산자 계약이 필요하다.
이번 수정은 상태 보고의 정확성 개선이며 refresh 연결 또는 자동 운영 인수가 아니다.

회귀: 신규 테스트에서 completed_at 노출을 1 fail/5 skipped로 재현했다.
수정 후 readiness 관련 4파일86개 통과. 전체 아침 CLI 검증은 별도 고정 트리에서
진행 중이며 memory-correction-control의 purge_digest 증거 손실 케이스에 5초 timeout이
기록됐다. 그 검증 및 이전 oldFD 실패 원인은 이번 변경으로 해결했다고 주장하지 않는다.

검증 증거: /home/jm/.cache/jarvis-test-runtime-qa-20260908/refresh-start-time-{red,tests,lint,types,build}.log.
lint/typecheck/backend build exit0. compiled runtime PID3841918과 시험용 status/doctor 생산자
PID3841929/3841936의 입력에서 완료시각 null·freshness unknown을 확인했다.
refresh-start-time-live.json에 결과를 보존했다. 합성 생산자의 실제 프로세스 인수이며
운영 Second Brain의 전체 refresh 검증은 아니다.

독립 검토 /root/refresh_start_time_review: ship, P0–P2 지적0.
요청 gpt-5.6-luna/high, 실제 모델·effort 미노출. 운영 refresh 연결은 계속 보류한다.
