# 우선순위와 아침 브리핑의 서울 날짜

2026-09-08, P1-12 일일 운영 연결의 선행 수정.

## 문제와 결정

일일 루프의07:15/21:30 일정은 Asia/Seoul인데 우선순위 생성과 브리핑 입력/출력의 today 판정은
UTC timestamp 앞10문자로 비교했다. 서울07:15→당일17:00 마감이 today에서 제외되고,
서울23:59:59.999→다음 날00:00 마감이 today로 들어갔다. 경계 검사15개 중10개 실패로 재현했다.

세 지점 모두 기존 `kstLocalDate(new Date(...))`를 재사용하여 UTC+9 달력 날짜를 비교한다.
호스트의 TZ/locale과 무관하게 일일 루프와 같은 기준을 쓴다. 시간 전송·저장은 계속 UTC이다.
기한이 now보다 이르면 overdue, 같으면 today이며 이 순서는 유지한다. within_seven_days는
기존처럼 now부터7×24시간 이하, 이후는 later이고 달력 주 단위로 바꾸지 않는다.

## 호환성과 범위

새 생성물의 bucket·순위·digest는 UTC 경계 사례에서 달라진다. 같은 입력을 이전 코드와
byte 동일하게 재생성하는 변경은 아니다. 기존 저장된 추천과 브리핑의 byte/digest를 변경하지
않으며 새 생성기로 과거 저장물을 자동 재작성하지 않는다. 저장된 PriorityEngineResult와
Recommendation provenance의 읽기는 bucket/rank를 재계산하지 않고 기존 구조와 해시를 검사한다.
동일한 요청의 재시도는 기존 결과를 사용하고, 같은 ID를 새 계산 결과로 덮는 요청은 계속 거부한다.

기존 추천에는 원래 기한의 전체 값이 아닌 bucket과 근거 ref만 담긴다. 과거 UTC bucket을 새
브리핑 입력으로 그대로 사용하는 변환은 보류한다. 실제 handler는 현재 검증된 근거에서 기한을
확인하고 새 입력을 구성해야 한다. 미래에 과거 알고리즘의 정확 재생성이 필요하면 별도 정책
버전 계약을 설계한다. 이번 변경은 저장 schema나 승인·실행 권한 변경이 아니다.

`kstLocalDate`의 내부 날짜 문자열은 비교에만 사용한다. 이 함수가 반환하는1~3자리나5자리
연도를4자리 wire 날짜로 재파싱하지 않는다. 일일 루프 날짜 생성/연도 입력 범위를 변경하지 않는다.
브리핑·서명 마감의 실제 handler, 예약/복구 및 원본 차단 연결 전 자동 운영 HOLD는 유지한다.

## 검증 계획

생산자→브리핑 parser→generator, 독립 today 필드 검증, 기한1ms 경계,7일 상한,
KST/UTC 자정·월말·연말·윤일·연도 경계를 검사한다. 변경 전 compiled 코드가 남긴 실제 SQLite
추천을 변경 후 다른 프로세스로 열어 원본·조회·정확 재시도와 변경 재시도 거부를 확인한다.
서로 다른 TZ의 실제 Node 프로세스와 HTTP Today 응답도 대조한다.

## 검증 결과

- 경계 red15개 중10fail/5pass. 수정 후 경계18개를 포함한6파일56개/3.63초와
  추천·출처·reviewability13파일61개/40.70초 pass: 고유19파일117개.
- backend build/typecheck/lint exit0. 독립 정적 리뷰 필수 결함0.
- 이전 compiled 코드가 만든 추천1개/행동3개를 새 코드에서 그대로 읽고 정확 재시도했으며
  쓰기0이었다. 최초 실사용 probe는 JSON 복원 문맥을 정식 parser에 통과시키지 않아 이후
  재생성 검사에서 실패했다. 제품 실패와 구분하여 로그를 보존했다.
- 검증기를 고친 뒤 `cf4e9c8235b0c1886424693c5a9d1a754fc23932`의 ranking/engine 소스2개를
  캐시에 transpile하고 재생성한 이전 요청이 최초 compiled 요청과 deepEqual임을 확인했다.
  별도 Node 프로세스가 저장한 DB를 현재 코드의 다른 프로세스로 열어 최종 전체 인수를 수행했다.
- 기존 canonical envelope/digest와3개 action 유지, 정확 재시도 쓰기0. 새 계산은 해당 fixture의
  next-day 마감을 today→within_seven_days로 바꾸며 같은 ID로 쓰려 하면
  RECOMMENDATION_IDENTITY_CONFLICT/쓰기0. Today HTTP200/조회쓰기0.
- UTC/Asia/Seoul/America/Los_Angeles/Pacific/Kiritimati 실제4개 Node 프로세스에서
  각4개 경계의 ranking과 brief canonical bytes가 일치했다. 임시 DB·서버 제거 완료.

증거 루트 `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`:
`seoul-deadline-{red,green,contracts,types,lint,build,before,before-final}.log`,
`seoul-deadline-live.mjs/json/log`, `seoul-deadline-before.json`,
`seoul-deadline-legacy-code.mjs` 및 `seoul-deadline-live-unparsed-context.log`.
실측은 격리 자료의 compiled 생성·저장·HTTP 조회이며 운영 예약 실행은 아니다.
