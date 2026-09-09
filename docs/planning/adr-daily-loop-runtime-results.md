# 일일 루프의 완료 보고와 관측 종료 시각

- 날짜: 2026-09-08
- 범위: 개선 목록12의 서비스 연결 전 결과·만료 경계 수정
- 현재 상태: 제품 반영·관련 회귀·격리 실제 프로세스 검증 완료. 실제 일일 운영 연결은 보류.

## 확인한 결함

1. processRun이 finish 반환 뒤 무조건 completed_run_ids에 추가한다. 예산0의 실제
   cycle에서 실패 run1개, startup에서 실패 run3개가 완료 목록에도 들어갔다.
2. refresh_reader가 lease 만료 시각까지 지연돼도 completeStep에 조회 시작 시각을
   전달해 step1개를 completed로 기록했다. 다음 단계에서만 STALE_LEASE가 발생했다.
3. 모든 step 뒤 실제 deadline에 도달하면 runNext가 failed로 정산하고 finish가
   completed step 목록만 보고 complete를 재시도하여 STALE_LEASE를 던졌다.
4. freshness1000ms의 갱신 기록을 조회하는 동안2000ms가 지나도 시작 시각으로
   evaluateRefreshContext를 호출하여 ready를 기록했다.

## 구현 결정

기존 public runNext의 boolean 의미는 유지한다. 내부 advance의 결과를 step_completed,
all_completed,failed로 구분하고 finish는 store.complete 성공 이후에만 true를 반환한다.
processRun은 true일 때만 완료 ID를 보고한다. 실패 후에는 완료 정산을 재시도하지 않는다.
문맥 조회가 끝난 현재 시각으로 freshness를 평가하고, step 저장 직전 시각도 새로 조회하여
기존 store의 lease/deadline 검사를 적용한다. migration·wire 결과 구조·새 scheduler는 추가하지 않는다.

## 캐시 검증 증거

`/home/jm/.cache/jarvis-test-runtime-qa-20260908/`:

- daily-loop-result-probe.mjs 및 before/after.json/log: 실제 격리 SQLite의 cycle/startup,
  늦은 refresh, 마지막 단계 후 deadline, 정상 실행5시나리오. false completion4→0,
  만료 refresh의 completed step1→0, 정상 완료 ID1개 유지.
- daily-loop-results-red.log:10fail/1pass. daily-loop-freshness-red.log: 추가1fail/11skip.
- daily-loop-results-draft-final.log:12pass/8.04초. 캐시 사본과 현재 dist 의존성의 검증이며
  제품 소스·타입 검사·기존 전체 daily 회귀 완료로 확대하지 않는다.
- 독립 정적 리뷰 필수 결함0건. freshness 추가 델타도0건.
- daily-loop-process-live.mjs 및 daily-loop-process-draft.json/log: 별도 Node4프로세스의
  격리 SQLite 실행. 실제 약80ms reader 지연이40ms lease를 넘으면 step완료0,
  다른 프로세스의 fence2 재획득 후 완료·result_digest 재개방 대조를 확인했다.
  freshness5ms를 넘은 약81ms 조회는 degraded/refresh_stale로 저장했다.
  주입 reader와 논리 단계의 프로세스 인수이며 운영 SB나 실제 일일 업무 인수가 아니다.
- 첫 probe의 recovery_lookback_days 설정 오류와 새 테스트의 type assertion 줄바꿈 오류는
  각각 daily-loop-result-invalid-config.log, daily-loop-freshness-test-syntax.log에 보존했다.

## 제품 반영 검증

a4a2ebc 전체 verify가 종료된 후 제품에 반영했다. 중복 Cost 필드 선언을 Readonly<Used>로
공유하여 별도 모듈 분할 없이 pure248행/최대156자와 기존 reviewability gate를 유지한다.

- 관련 daily·시간·복구·동시성·integrity·reviewability11파일147개/74.15초 통과.
- 신규 테스트의 prefer-const2건을 정리한 후 해당12개/9.91초 재통과.
- backend build/typecheck/lint exit0. 실제 제품 소스의 독립 리뷰 필수 결함0건.
- daily-loop-result-product.log: 실제 compiled 제품의5시나리오 재검증 통과.
- daily-loop-process-product.json/log: 별도 Node4프로세스. 실제 reader 지연80.126ms에서
  lease40ms의 단계 완료0개, 새 프로세스 fence2→completed/result_digest 재개방 일치.
  freshness5ms/reader80.115ms는 degraded/refresh_stale, 예산 실패 완료ID0개.
  임시 DB 제거. 외부 SB 대신 주입 reader를 사용한 논리 단계 인수다.
- 제품 로그는 daily-loop-product-{tests,tests-final,build,types-final,lint-final}.log다.

전체 verify 최신 완료는 수정 전 a4a2ebc(backend2535/dashboard187)이며 이번147개 관련
검증을 새 전체 gate 완료로 확대하지 않는다. 운영DB/서비스/release/push 변경은 없다.

## 당시 일일 운영 연결 보류 — 후속 구현 전 기록

아래는 이 ADR 검증 당시의 상태와 재현 결과다. 현재 구현 상태로 해석하지 않는다.
2026-09-10 소스 재확인 기준, `src/daily-service-cycles.ts`와
`src/cli-gjc-commands.ts`는 명시적 설정이 있는 service run/once에서 저장된 아침
실행기와 서명된 native 저녁 실행기를 연결한다. 상세 검증 기록은
[service composition](task-daily-service-composition.md)을 따른다.
`PersonalOsRuntime` 단독 생성 여부로 CLI의 전체 조립 상태를 판정하지 않는다.

현재 잔여는 provider refresh·외부 event 입력·retention 정책/어댑터·운영 활성화다.
`src/cli-evening-inputs.ts`의 refresh reader는 null, event source는 빈 배열을
반환하며 `src/personal-os-runtime.ts`의 기본 retention adapter map은 비어 있다.
`LocalTimelineRefreshService`의 수집 수치는 durable readiness receipt가 아니므로
일일 refresh 성공으로 대체하지 않는다. `ObservationRefreshStore`도 로컬 admission
계약이며 provider 인증·호출을 수행하지 않는다.

현재 morning_reconcile과 evening_summary, event 단계는 no_external_effect 기록이며,
refresh_context도 주입 reader의 완료 정보만 평가한다. PersonalOsRuntime.forServiceRun은
DailyControlLoop를 구성하지 않고 retention adapter도 빈 맵이다. 논리 단계의 completed를
실제 아침/마감 보고·retention의 성공으로 표시하지 않는다.

daily-loop-activation-gap.mjs/json/log에서 실제 built loop→HTTP를 대조했다. 아침 논리
완료1건 후 Today200/brief.no_data, 저녁 논리 완료1건 후 Today500/INTERNAL_ERROR였다.
GET DB쓰기0. 저녁 no_external_effect detail은 latestCloseout이 요구하는 검증된 서명
artifact가 아니다. 기존 generateMorningBrief와 generateEveningCloseout/EveningCloseoutStore를
연결할 필요가 있으며 placeholder를 검증 산출물로 수용하는 parser 완화는 하지 않는다.
첫 probe의 staticRoot 누락은 별도 missing-static-root.log로 보존하고 수정했다.

재개 조건은 실제 단계별 adapter와 결과/출처/실패 계약, 서비스에서의 명시적 구성,
놓친 일정·재시작·중복 기동 및 retention 정책별 검증이다. 실행 권한·외부 발신·운영 배포를
이번 수정으로 활성화하지 않는다. 전체01–25와 기존 자동기억 원본 차단 HOLD도 유지한다.
