# 일일 루프의 폴링·lease 복구

2026-09-08, P1-12.

## 범위와 결정

`classifyDailyLoopInstant`의 정확한07:15/21:30 판정은 유지한다. 런타임은 성공한
startup/cycle의 관측 시작 시각을 기억하고 다음 cycle까지 통과한 일정을 복구한다.
관측 중 callback이 시계를 넘겨도 끝 시각으로 커서를 이동하지 않는다. 실패하면 커서를
전진시키지 않고, 시계가 뒤로 가면 이전 최대 시각을 유지한다.

프로세스 첫 기동은 기존 `startup()`으로 과거 일정을 복구한 후 cycle을 반복한다. 첫 cycle만
호출하는 기존 직접 사용은 정확 시각 판정을 유지한다. 메모리 관측 커서는 재시작 저장소가 아니며
재시작 시에는 기존 영속 run/step과 startup lookback이 기준이다. 스캔은 설정된 최대31일로 제한한다.

기존 DailyLoopReadStore.due는 pending만 찾았다. 이제 유효 기한 내의 claimed/running/verifying 중
lease가 만료된 실행도 발견한다. 활성 lease·기한 만료·차단된 실행은 반환하지 않는다. 기존
claim의 원자적 fence 증가와 완료된 단계 건너뛰기를 재사용한다.

놓친 복구 창 처리의 omit은 pending만 failed로 전환한다. 이미 시작되었거나 완료/실패/uncertain인
실행은 원래 상태를 보존한다. 없는 실행은 계속 오류다. 이전 완료가 창 밖으로 밀려난 다음
startup에서 오류를 발생시키거나 원래 결과를 덮어쓰지 않는다.

startup/cycle 모두 준비 목록을 직접 실행하지 않고 현재 `due()`에서 발견된 실행만 처리한다.
자동 claim은 최신 시각에서 pending 아침/저녁의 복구 창을 같은 IMMEDIATE transaction 안에서
재검사한다. 초과하면 fence를 올리지 않고 MISSED_RECOVERY_WINDOW를 확정한 뒤 건너뛴다.
따라서 drain 실패 후 재시도, 새 loop 인스턴스, 느린 drain에서도 미시작 작업이 창을 우회하지 않는다.
발견 뒤 deadline이 지난 자동 claim은 건너뛰되 수동 claim과 실행 중 발생한 stale lease 오류는
그대로 전파한다. 이 정책 인자는 0~2,592,000,000ms 정수로 제한한다.

기존 claim의 fence/상태 갱신을 `daily-loop-claim.ts`로 분리하여 store 모듈의 크기 제한을 지킨다.
legacy verifying 실행은 모든 단계 완료와 기존 verifying tail 전이 검사를 거쳐 completed만
추가한다. verifying checkpoint를 다시 기록하지 않으며 과거 단계·checkpoint bytes를 보존한다.
정확 일정과 관측 구간이 겹칠 때 prepared에는 해당 실행을 한 번만 넣는다.

## 재현·실행 증거

- 초기 폴링 경계9개 중8fail을 재현하고 수정했다. 리뷰 경계5개 추가 실행은9pass/5fail이었다.
  별도로 migration034의 완료 단계와 verifying checkpoint를 저장하고 전체 migration 후
  lease equality에서 재개하여 checkpoint transition invalid를 재현했다.
- 기존 다음날 반복 폴링 회귀1개는 이전에 누락하던 전날 저녁이 이제 failed/MISSED로 남는
  의도된 동작 때문에 실패했다. phase와 failure_code까지 기대값에 명시했다.
- 최종 제품5모듈 독립 정적 리뷰의 잔여 필수 결함0건. backend build/typecheck/lint exit0.
- 최종 관련 회귀는13파일163개/73.17초 pass다. 신규 폴링14개·legacy verifying1개와 기존
  수동 claim·만료·동시성·migration·무결성·읽기 차단·코드 크기 회귀를 함께 실행했다.
  전체 `npm run verify` 재실행 결과는 아니며 최종 로그는 `daily-poll-final-contracts.log`다.
- compiled API를 별도 Node5프로세스와 격리 SQLite에서 실행했다. 실제80.327ms 지연으로
  정확 일정을 건너뛴 폴링이 실행1개를 완료했고 반복 조회의 DB 추가쓰기0이었다.
- 부분 단계1개 저장 후 SQLite를 연 채 SIGKILL했다. 다른PID의 cycle이 만료 lease를
  fence2로 재획득하고 완료1개를 반환했다. 원래 단계와 checkpoint bytes 및 재개방 DB가 일치했다.
- 별도 부분 실행도 SIGKILL 후 deadline 시점에 다른PID의 startup으로 조회했다.
  완료ID0, 기한 지난 원래 run bytes 보존, startup 오류0. 임시 DB 디렉터리 제거 확인.

증거 루트는 `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`다.
`daily-poll-red.log`, `daily-poll-review-red.log`, `daily-poll-verifying-red.log`,
`daily-poll-contracts.log`, `daily-poll-final-targeted.log`, `daily-poll-*-final.log`,
`daily-poll-live.mjs/json/log`에 최초 실패와 최종 결과를 구분해 보존한다.
실제 프로세스 검증은 개발 API의 논리 단계이며 업무 브리핑·서명 마감·예약 서비스 운영 인수가 아니다.

## 브리핑 저장 API 보류

이번에 검토한 임의 MorningBriefInput→저장 API는 구현하지 않는다. 현재 입력의 digest는
자체 일관성 검사이며 정상 recommendation ID와 다른 copy/source를 결합하는 것을 증명 없이
막을 수 없다. lineage가 있는 ID만 확인하는 설계로는 충분하지 않다. 먼저 검증된 추천 action과
실제 근거의 본문·출처·기한을 대조하는 mapper가 필요하다. 과거 추천에는 절대 기한 전체가 없다.

lineage 상속도 예외 없음만으로 성공을 판정할 수 없다. hasLineage는 quarantine에도 true이며,
parent/펼친 의존성64개 초과는 throw 대신 quarantine된다. 향후 저장 경로는 모든 parent 검증,
상속 후 가용성 재검사, artifact와 lineage의 단일 IMMEDIATE transaction, replay의 현재 차단
검사를 포함해야 한다. 원본에 연결되지 않은 브리핑 자동 저장·일일 서비스 활성화 HOLD를 유지한다.

이 변경은 기존 논리 단계의 시간·복구 동작이다. 실제 브리핑/서명 마감 생성·일일 총량 budget·
예약 service 연결·retention·운영 인수의 완료를 뜻하지 않는다.
