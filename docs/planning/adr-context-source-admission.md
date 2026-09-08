# 문맥 조립기의 관측 신뢰도와 일일 생산자 연결

상태: 관측 입장 조건 수정·단위 및 compiled DB 검증 완료. 자동 추천·브리핑 생산자 연결은 아래 계약을 해결할 때까지 HOLD.

## 재현과 결정

`context-assembler-sources.ts`는 Linux control-plane/live_adapter/live_task와 freshness만 검사했다.
`payload.trust`를 verified/user_confirmed/inferred/untrusted로 각각 바꿔 실제 compiled API로
관측 저장→문맥 조립→SQLite 문맥 저장을 수행한 4건 모두 sufficient/allow, 관측1/근거2였다.
추론 또는 불신 관측을 현재 기계 사실로 선택하는 것은 Task15의 trust 요구를 충족하지 않는다.

정상 `normalizePersonalObservations` 생산자는 기계 관측에 `verified`를 부여한다.
문맥 조립기는 그 값을 요구하고 나머지는 UNVERIFIED_SOURCE 해시 토큰과 critical omission으로
남긴다. 다른 정상 관측이 함께 있어도 불충분 상태를 유지한다. 비Linux/비live_task 및 stale
판정 순서는 기존대로 유지하고, 기억에는 기존 user_confirmed 기준을 적용한다.

이 검사는 입력이 선언한 신뢰 수준의 입장 조건이다. verified 문자열 자체가 원본 생산자,
서명, 본문 진위 또는 승인 권한을 증명하지 않는다. 저장된 과거 문맥은 수정하지 않는다.

## 자동 연결 HOLD와 다음 구현 범위

1. 조립기 근거는 context_observation/confirmed_memory인데 추천의 원장 결합은
   linux_live_fact/user_confirmed_principle/owner_decision을 요구한다. 실제 조립·저장된 문맥에
   fixture ranking을 결합한 요청은 RECOMMENDATION_EVIDENCE_CONFLICT, 쓰기0으로 거부됐다.
   이는 계약 불일치 재현이며 실제 업무 우선순위 생산자 검증이 아니다.
2. context-policy의 ContextFact trust에는 verified가 없고 Linux 사실에도 user_confirmed를
   요구한다. 이 의미 차이는 단순 문자열 치환으로 해소하지 않는다. 생산자의 검증 사실,
   사용자가 확인한 원칙, 오너 결정의 근거를 분리해 전달할 계약이 필요하다.
3. memory-reference-context는 검색 본문을 reference_only/untrusted로 명시한다. 검색 결과의
   record/source/digest만으로 사용자가 확인한 원칙이나 오너 승인으로 승격하지 않는다.
4. 저장된 priority 결과는 절대 due_at 대신 bucket과 evidence ref만 갖는다. 새 날짜 브리핑에는
   현재 근거의 절대 기한과 원래 행동 자료가 필요하다. 과거 bucket 재사용이나 기한 추정은 제외한다.
5. src의 rankPriorityActions/assemblePersonalContext/아침·저녁 generator 호출 검색은 정의와
   export만 확인했다. PersonalOsRuntime.forServiceRun은 GJC service와 retention 객체를 만들지만
   실제 일일 생산자와 스케줄을 연결하지 않는다. 이 보강만으로 P1-12를 완료 처리하지 않는다.

후속 순서는 검증된 출처·원칙·승인의 분류 계약 및 절대 기한 보존 → 현재 source adapter와
추천 생산자 → 모든 부모의 삭제/차단을 검사하는 원자적 브리핑 저장 → 실제 서명 마감 처리기 →
service 예약·retention 연결이다. 빈 단계나 no_data 산출물만으로 전체 사용 인수를 대체하지 않는다.

## 검증 증거

증거 루트: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`.

- `context-source-admission-live.mjs`, `context-source-admission-before.json`: 서로 격리된 DB4개와
  근거 유형 대조 DB1개. 프로브 종료 시 모두 close/remove.
- `context-source-history-live.mjs`, `context-source-history-before.log`: 이전 compiled 프로세스에서
  inferred 관측의 sufficient 문맥1개를 저장하고 DB를 닫았다. 수정 후 다른 프로세스로 재개방했다.
- 독립 읽기 전용 사전 리뷰: 정상 observation 생산자와 verified-only 선택 일치. 정책 trust 표현
  차이, 혼합 입력·기존 분류 우선순위·과거 원장 보존을 별도 검증하도록 지적했다.

- 변경 전 `010281c3c19e3dc370abf86c26f3ecff7ea5ffb3` canonical verify exit0:
  backend199파일1321개/554.52초 +199파일1285개/589.38초, dashboard32파일187개/28.73초.
  runtime/lint/typecheck/build/고정시각 acceptance/CLI smoke exit0, HEAD 동일·tracked 바이트 변경0.
  `verify-010281c.log`, `verify-010281c-before.json`, `verify-010281c-after.json`에 기록했다.
- 새 trust 회귀11개는 수정 전6fail/5pass/2.18초였다. 수정 후 assembler·context persistence·
  reviewability 관련9파일42개/17.13초 pass, typecheck/lint/backend build exit0.
  `context-source-trust-{red,green,typecheck,lint,build}.log`에 기록했다.
- 최종 독립 정적 리뷰 필수 결함0건. 추가 지적된 Mac host와 freshness equality 반례도 회귀에 포함했다.
- `context-source-admission-after.json/log`: PID1929932, verified는 sufficient/allow·관측1/근거2,
  나머지 trust3종은 insufficient/abstain·관측0/근거1로 각각 DB 저장됐다. 근거 유형 불일치의
  fixture ranking 요청은 그대로 거부되며 추천 쓰기0이다.
- `context-source-history-after.json/log`: PID1929940이 이전 PID1884754의 DB를 재개방했다.
  기존 row bytes 보존, 정확 replay 쓰기0, 정상 verified 결과 bytes 동일, 새 inferred 문맥은
  다른 ID/insufficient로 저장됐다. 최종 문맥2개. 테스트 루트3개 모두 제거 확인(잔여0).

위 42개와 DB 검증은 이번 변경의 검증이다. 변경 전 전체 verify를 이번 HEAD의 전체 통과로
표시하지 않는다. 자동 source adapter·추천 생산자·예약 일일 운영 및 전체01–25 인수는 미완료다.
