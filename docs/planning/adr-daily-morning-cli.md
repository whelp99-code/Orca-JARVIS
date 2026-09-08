# 아침 일일 실행의 CLI 진입점

2026-09-08. 기존 아침 조립은 라이브러리에서만 호출된다. 명시적 DB와 예산 설정으로
`jarvis daily morning --once --db PATH --input CONFIG`를 실행해 저장 원본의 아침 작업을
기존 startup/claim/finish 경로로 처리한다. 이는 oneshot 실행 진입점이며 운영 timer의
설치·활성화는 이번 변경에 포함하지 않는다. GJC 서비스의 coordinator 경로는 유지한다.

설정은 버전1의 닫힌 JSON이며 시간대·lease·deadline·복구 창·조회 신선도·예산을 명시한다.
owner는 프로세스마다 UUID로 생성한다. 기존 DB migration 준비 검사를 거치며 암묵적으로
schema를 갱신하지 않는다. 출력은 실행 원장 결과와 실제 사용량이며 브리핑 본문을 복제하지 않는다.
결과 조회는 한 읽기 snapshot에서 run/step/brief의 suppression·quarantine, 원장 무결성,
완료 상태, 브리핑 유효 시각을 확인한다. 활성 lease·미확정·만료 run은 typed error/exit2다.
삭제·숨김은 RESULT_UNAVAILABLE, 오래된 완료 산출물은 RESULT_STALE이며 현재 완료로
표시하지 않는다. 사용량 집계는 삭제로 환불하지 않는 기존 정책을 유지한다.
응답 시각이 저장된 완료 시각보다 이르거나 startup의 KST 날짜와 다르면 STALE_LEASE다.

아침 전용 실행은 morning 일정만 생성·복구·claim한다. 저녁과 event 이력을 삭제하거나
사용량에서 제외하지 않는다. 기존 미완료 타 phase는 이 명령이 변경하지 않고, 해석 불가
완료 이력은 기존 사용량 차단을 유지한다. 일반 DailyControlLoop의 기본 전체 phase는 유지한다.

일정 분류기는 예정 시각과 정확히 일치할 때만 due를 반환한다. cycle의 생성 시각과
scheduled_at 차이로 충돌한다는 초기 가설은 성립하지 않아 해당 변경은 제외했다.
새 oneshot CLI는 startup을 사용해 늦게 시작해도 복구 창 안의 예정 작업을 회수한다.
자정을 넘는 복구 창에서는 전날 브리핑이 현재 날짜 검사에 거부되는 것을 테스트로 재현했다.
아침 전용 실행은 현재 KST 날짜만 claim하며 과거 pending 일정은 missed로 기록한다.
일반 루프의 과거 날짜 복구 동작은 유지하고, 실제 아침 생성기의 현재 날짜 조건과 조립을 맞춘다.

현재 refresh 완료의 신뢰 가능한 생산자 연결은 없으므로 CLI의 refresh reader는 null이다.
출력에 provider refresh 미연결과 자동 운영 HOLD를 명시하며 refresh 성공을 꾸미지 않는다.
이 명령은 이미 저장된 추천의 로컬 브리핑 실행이다. provider fence·현재 refresh 완료 원본·
서명된 저녁·실제 event·retention·운영 배포 인수는 전체 목표의 필수 후속 항목이다.

검증: 지연된 첫 cycle→다른 프로세스 startup, 동일 DB의 두 CLI 경쟁, 재실행,
미처리 저녁 보존, 잘못된 설정/명령 거부, 예산 실패의 구조화 결과를 확인한다.

설정 예시는 config/daily-morning.example.json이다. 준비된 시험 DB에 다음 명령을 사용한다.

```bash
node dist/src/cli.js daily morning --once --db /absolute/path/to/test-authority.sqlite --input config/daily-morning.example.json
```

실제 시계의 KST07:15부터 복구 창 안이면 그날 아침을 수행한다. 그날 일정이 아직 없으면
run=null, 이미 완료됐으면 기존 완료 run과 빈 completed_run_ids를 반환한다. 예산 실패와
복구 창 초과는 원장에 실패를 남기고 CLI는 구조화 오류/exit2로 종료한다. 과거 완료 run의
예산·deadline·복구 정책을 바꿔 재실행시키지 않는다. 설정 변경으로 immutable 일정 정체성이
달라지면 기존 identity 검사가 거부한다. 이 문서는 운영 DB·timer 활성화 지시가 아니다.

## 검증 기록

- 초기7파일123통과 후 lint 미사용 변수3건을 수정했다. 자정 복구 red는1실패/8통과,
  원인은 전날 아침 실행기의 DAILY_LOOP_STALE_LEASE다. 현재 날짜 제한 후 해당9개통과.
- 모듈250행 제한 위반255행은 일정/단계 정의를 기존 daily-loop-schedules로 옮겨238행으로
  정리했다. 최종7파일124통과/61.68초, lint/typecheck/backend build exit0.
- 실제 compiled CLI5프로세스 PID3621722/3621743/3621760/3621815/3621816,
  refresh단계commit후SIGKILL→새CLI startup완료1, 재실행추가완료0, refresh행동일.
  실제 저장 추천의브리핑항목1·사용량2/2/3440. 두CLI동시실행완료run1/단계2.
  시험용시계preload와crash관측기를사용한합성DB검증이며운영daemon실행이아니다.
- 고정시각 acceptance와CLI smoke exit0. 증거는
  /home/jm/.cache/jarvis-test-runtime-qa-20260908/daily-morning-cli-*.log 및 live.mjs/json.
  반복/추가시험은중복이있어합산하지않는다.
- 실제 실패CLI PID3657398: exit2/DAILY_LOOP_BUDGET_WORK_EXHAUSTED,
  run failed/refresh completed/morning pending을DB에서확인했다.
  별도증거 daily-morning-cli-failure-live.mjs/json.
- 첫 독립검토 /root/daily_morning_cli_review는 fix-first/2건이다. 숨겨진 과거 완료와
  active/uncertain/expired run에 성공을 반환하는 것을6실패/9통과로재현했다.
  authority-aware 결과조회와typed상태오류로수정후7파일130통과/64.36초.
  실제CLI에서도 stale/hidden은각exit2로확인했다. 요청sol/high, 실제모델/effort미노출.
- 응답 시각의 자정 이동과 저장된 완료 이후 시계 역행을 각각1실패로재현하고
  날짜/완료시각검사를추가했다. 최종집중3파일32통과/21.31초.
- 이전465ec00의전체npm run verify는exit0으로종료했다. backend1434+1450통과,
  dashboard248통과, 고정시각acceptance/CLI smoke통과. 전후HEAD/추적바이트동일.
  이는현재CLI변경의전체gate결과가아니며새커밋에서별도로확인한다.

- 최종 독립 검토 /root/daily_morning_cli_final_review: ship, findings 0.
  요청 gpt-5.6-terra/high, 실제 모델·effort 미노출. 최종 lint/typecheck/build/acceptance/CLI smoke exit0.
  최종 실제 CLI 7프로세스와 별도 예산 실패 1프로세스의 기록은 개발 실행 원장 P1-12와
  daily-morning-cli-final-live.log/failure.log에 보존했다. 자동 운영 HOLD는 유지한다.
