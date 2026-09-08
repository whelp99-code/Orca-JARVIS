# 일일 루프의 저장 원본 브리핑 실행과 실제 게시 사용량

2026-09-08. 기존 DailyControlLoop는 아침·저녁을 no_external_effect로 완료하고 아침
비용을128바이트로 계산한다. MorningBriefPublisher의 원본검증·원자게시를 cycle에 연결한다.

명시적 createStoredMorningDailyLoop 조립은 기존 prepare/claim/poll/recover/finish에
실제 단계 실행기를 연결한다. refresh_context는 기존 reader의 완료 상태를 평가하고,
morning_reconcile는 현재 저장 추천에서 게시한다. 처리기가 없는 저녁/이벤트는
DAILY_LOOP_HANDLER_UNAVAILABLE로 거부하며 완료 행을 만들지 않는다. 기존 fixture용
논리 루프의 동작은 보존하지만 이 조립을 실제 운영 완료로 표시하지 않는다.

사용량은 새 정본 없이 기존 완료 단계의 canonical detail과 digest로 재구성한다.
KST 같은 날짜의 모든 run을 집계하며 격리·삭제된 결과도 사용량에서 환불하지 않는다.
items는 게시된 브리핑 항목수(조회 단계1개), work는 완료 처리 단계수, bytes는 실제
canonical 산출물 UTF-8 바이트다. CPU시간·LLM토큰·실패시도 비용의 측정값이 아니다.
기존 placeholder/해석할 수 없는 완료 단계는 사용량0으로 간주하지 않고 거부한다.

각 단계 실행·사용량 재검사·게시를 한IMMEDIATE transaction으로 묶는다. 예산 초과는
해당 단계 게시를rollback한 뒤 run의 기존 실패코드에 기록한다. 재시작 시 완료 단계를
재호출하지 않고 원장으로 사용량을 복원한다. 현재날짜·lease·선행단계·정본계보 검사를
유지한다. 새 migration은 추가하지 않는다.

같은 날짜에 이전 event:* 또는 evening_summary 완료 산출물이 있으면 사용량 검증이
거부한다. 실제 처리기와 검증 가능한 사용량 계약을 연결하기 전 그 이력이 있는 운영
DB에서 factory 활성화는 HOLD다. 과거 비용을 0으로 해석하거나 필터로 제외하지 않는다.
finish의 최종 완료도 실행기에 위임해 같은 monotonic clock과 저장된 마지막 단계 시각을
검사한다. 마지막 완료 시계 역행은 SQLite 원문 오류 대신 DAILY_LOOP_STALE_LEASE다.

다음 연결: 서명된 저녁 처리기, 실제 입력 event와retention, service 구성·정책·운영 인수.
이번 조립은 default daemon을 활성화하지 않는다. 별도 provider fence·현재refresh 원본
수집의 운영 증거와 전체01–25 목표는 여전히 필요하다.

## 검증

- 초기9개 중8통과/1실패: 해석 불가 과거 결과를 거부하기 전에 시작 쓰기를 수행했다.
  사용량 검사를 시작 전으로 옮겨 쓰기 시도도 제거했다. 관련7파일54개통과.
- 최종시계역행·lease만료를 추가해2파일13개통과(실행11/형식2). lint/typecheck/build exit0.
- compiled 실제3Node프로세스: refresh 저장 직후SIGKILL1회, 다른PID의cycle으로
  완료1개, refresh호출1회, 단계1원본행보존, 재실행쓰기0, 읽기쓰기0.
  사용량items2/work2/bytes3440. 합성고정시각SQLite·공개cycle 인수이며 운영daemon은아니다.
- 증거 `/home/jm/.cache/jarvis-test-runtime-qa-20260908/daily-morning-execution-*`.
  최종체크와관련회귀는중복이있으므로합산하지않는다.
- 마지막 완료 역행·기존 이벤트 이력 fixture를 추가한 최종3파일24개통과/16.08초.
  lint/typecheck/backend build exit0. 기본 임시경로의 write -122로 최초 실행0개였고
  별도 TMPDIR로 재실행했다. 최종검증은 daily-morning-complete-*.log.
- 최종 compiled 재검증: PID3508902/3508909/3508932, SIGKILL1회,
  refresh1/완료1/재실행쓰기0/읽기쓰기0/사용량2·2·3440.
  KST07:15 전후 공개cycle: 완료1/refresh1/재실행쓰기0/no_data/사용량1·2·754.
- 이전b2e11a9 전체verify는exit1로종료됐다. 첫묶음1420통과/1실패,
  둘째1450통과. 실패는memory-correction-control의proof_signature fixture 준비 중
  MEMORY_OLD_DATABASE_FD_ACTIVE다. 전후HEAD와추적바이트동일. 원인미확정이며
  FD차단검사를완화하지않는다. 새일일실행전체gate 완료증거로사용하지않는다.
- 고정시각 acceptance와 CLI smoke exit0. 최종 fresh 검토
  /root/daily_morning_final_review는 운영 caller 누락을 이유로 처음 fix-first를 반환했다.
  사용자 지시의 개별 개발 단위 커밋과 전체 목표 완료를 구분한 후 중간 라이브러리
  단위에 한해 ship/추가 코드 결함0건으로 판정했다. 운영 연결은 다음 필수 구현이다.
  요청 gpt-5.6-terra/high, 실제 모델/effort 및 token 사용량은 도구에 노출되지 않았다.
