# ADR — 런타임 읽기·통신·공개 API 경계 정리

## 2026-09-09 — 문맥 정책 입력 경계의 순환 제거

`context-policy.ts` 평가기는 입력 parser를 사용하고, parser는 평가기에서 오류
클래스와 코드를 가져온다. 오류는 입력 경계가 소유하도록 기존 `context-policy-input.ts`로
옮긴다. `context-policy.ts`는 같은 클래스·코드·타입을 re-export하여 기존 소비자의
import와 instanceof를 보존한다. 새 파일이나 별도 오류 클래스는 추가하지 않는다.
정책 판단·입력 검증·권한 조건은 변경하지 않는다. 정적 ESM import/re-export 그래프와
공개 TypeScript export 이름의 전후 대조, 기존 정책 회귀, compiled ESM의 두 진입 순서로 검증한다.
정적 그래프는 동적 import/require와 전체 런타임 호출 관계를 포함하지 않는다.

검증: backend build, 관련12파일106테스트(7.50s), lint, 3typechecks exit0(handle5360).
정적 모듈562개 유지·순환3→2·나머지 순환 그룹 동일·공개 export843개 이름 변경0.
compiled Node ESM을 입력 모듈 먼저/평가기 먼저 불러온 실제 프로세스1767181/1767195
모두 exit0: parser/evaluator/package의 오류 클래스 동일, 잘못된 입력·설정의 오류 코드와
instanceof 유지, 정상 eligible·untrusted abstain 확인. DB나 모델 호출은 하지 않았다.
증거는 `/home/jm/.cache/jarvis-test-runtime-qa-20260908/context-cycle-{before,after}.json`,
`context-cycle-{input,policy}-receipt.json`이며 같은 경로의 `runtime-import-graph.mjs`,
`context-cycle-live.mjs`로 측정했다. 남은 authority/memory25모듈·task21모듈 순환은 후속이다.

2026-09-08. 개선 항목 14의 첫 구조 정리 단위다. 기존 250 nonblank/160자 검사는 유지하며
상한을 피하기 위한 문장 압축이나 파일별 예외는 추가하지 않는다. 전체 디렉터리 이동과
모든 기존 압축 코드 재작성은 이 단위의 완료 조건으로 대체하지 않고 후속으로 유지한다.

- ControlPlane은 승인·claim·정산을 담당한다. 저장 행 해석과 suppression을 반영한 조회는
  읽기 전용 함수 모듈로 분리한다. 내부 정산의 원본 행 해석은 동일 decoder를 사용하며
  사용자 조회의 suppression 필터를 내부 권한 확인에 대신 적용하지 않는다.
- MemoryOutboxRecordReader가 기존 command/request/attempt 복원뿐 아니라 saga 조회와
  완료 결과 재조회 결합 검사를 담당한다. MemoryOutboxStore는 같은 transaction 안에서
  상태 전이를 수행한다. terminal replay는 기존처럼 새 권한을 소비하지 않는다.
- Second Brain adapter는 검색·페이지·충돌 응답 조합을 담당한다. 통신, 원본 값 정규화,
  signed fence 및 generation 결합, 오류 분류는 전용 호출 경계로 옮긴다. 세대 비교 Map은
  기존 public read별 수명을 유지하며 전역·세션 공유 상태로 바꾸지 않는다.
- Orca/GJC 관찰·진행 관련 공개 export를 하나의 공개 API 파일로 묶고 index의 공개 이름은
  그대로 유지한다. 내부 구현은 공개 barrel을 역으로 import하지 않는다.
- Python whitespace 정규식은 동일 문자 집합을 한 상수로 정의한다. 원문 digest·record
  경계·BOM/NEL 처리 등 기억 계약은 바꾸지 않는다.

검증은 기존 권한/취소/복구·outbox 재전송/receipt·generation/예산·공개 API 회귀와 전체
verify를 사용한다. 이전/이후 공개 export 이름 및 관련 모듈의 순환 의존을 기계적으로
대조한다. DB schema·운영 서비스·클라이언트 계약·권한 정책은 이 정리에서 변경하지 않는다.


## 검증 관측

기준 HEAD `9762b53`. 정리 후 기존 reviewability 2개, 공개 API 4개, 기억 정규식/산출물
4개 테스트가 통과했다. 타입 검사·lint·backend build exit 0이다. 전체 verify의 최종 결과와 실패 후 재검증은 아래 및 개발 실행 원장에 기록한다.

| 모듈 | nonblank 이전 → 이후 | 최대 줄 길이 이후 |
|---|---:|---:|
| control-plane.ts | 267 → 246 | 160 |
| memory-outbox-store.ts | 270 → 242 | 137 |
| second-brain-adapter.ts | 278 → 243 | 146 |
| index.ts | 255 → 205 | 156 |
| memory-remember-artifact.ts | 65 → 65 | 146 (이전 202) |

새 내부 조회/통신/공개 API 모듈은 각각 32/43/52 nonblank다. 기존 outbox record reader는
46 → 80 nonblank다. 함수 이동으로 전체 기능 복잡성이 제거됐다는 뜻은 아니다.
공개 런타임 이름 339개, TypeScript checker가 확인한 타입 포함 export 이름 791개는
각각 추가 0/삭제 0이다. 내부 조회·통신 helper는 package root에 노출하지 않는다.

TypeScript AST의 정적 런타임 import/re-export 그래프는 src 483 → 486 모듈이다.
기존 순환 그룹 3개가 동일하게 남았고 새 순환 그룹은 0개다. type-only와 외부 패키지,
동적 import/require는 이 측정에서 제외했다. 기존 순환은 context policy 2개,
authority/기억 projection 25개, task 실행/TaskSpec 공개 경계 16개 모듈이며 후속 정리 대상이다.
정적 그래프는 동적 실행의 전체 호출 관계나 메모리/성능 보장이 아니다.

실제 격리 Python MCP와 built 자비스 CLI 순환에서 후보 입력·사용자 확인 fixture·저장·
완료 반영·64개 sensitive record의 두 클라이언트 재조회가 통과했다. 삭제 sequence 1 이후
무서명/과거 fence는 거부됐고 삭제 evidence는 0개다. 다른 process의 compile 준비 중에도
조회·완료 cycle 1,441.98344ms, control completed/outbox settled, dashboard stored=true,
재전송 0회, terminal replay settled, 잔여 review 파일 0개, cleanup/control 오류 null이다.
이는 격리 fixture 검증이며 실제 사용자 앱 로그인·운영 서비스 전환 시험은 아니다.


정규식 추가 대조는 U+0000~U+10FFFF의 코드포인트 1,114,112개 각각을 비어 있지 않은
기록의 양 끝에 놓고 HEAD의 이전 parser와 built 현재 parser의 record 배열을 비교했다.
불일치 0개다. 이 검사는 각 문자 경계의 동등성 근거이며 모든 가능한 문자열 조합의 증명은 아니다.
독립 정적 리뷰의 필수 회귀 지적은 0건이다.

전체 verify 중 확인한 별도 검증 문제는 두 가지다. 메모리 HTTP 시험의 전체 migration
기대 목록에서 기존 064가 누락되어 추가했으며 SQL 파일과 schema 검사는 변경하지 않았다.
Task33 Electron 시험은 DISPLAY 미설정 시 xvfb-run 경로에서 60초에 중단됐다. 현재 살아 있는
Xvfb :102를 명시한 실제 packaged driver와 해당 Vitest 3개는 통과했다. 이것을 기본 자동
화면 생성 경로까지 수정한 것으로 보지 않는다. 호스트 검증은 사용 가능한 DISPLAY와
TMPDIR를 명시하며, 기본 GUI 기동 사전 검사·시간 초과 자식 정리는 개선 항목 18로 유지한다.


## 전체 검증의 최종 판정

최초 npm run verify는 backend 372파일, 2,282 pass/6 fail, 1,013.88초 후 exit 1이었다.
이미 설명한 HTTP migration 기대값 및 GUI 환경 외 추가 실패는 migration 최신값을 060으로
고정한 시험 1개, 새 provider access 검사에서 가상 파일을 실제로 조회한 fixture 2개,
ControlPlane에 주석 제외 245행의 별도 상한을 적용한 과거 reviewability 1개였다.

최신 migration 064까지 기대값을 보존하고, filesystem 대역에 access를 명시했다. 실제
provider X_OK 검사는 제품에 유지되며 별도 실제 파일 권한 검증도 유지한다. 읽기 전용 조회에
필요하지 않은 reader 객체·상태를 제거하고 함수로 위임하여 ControlPlane은 nonblank 246,
해당 과거 기준의 주석 제외 245행이 됐다. 검사 상한·migration SQL·권한 검사는 완화하지 않았다.

실패가 있었던 모든 5개 파일을 포함하는 후속 회귀는 두 번의 실행을 합해 고유 10파일
69개 pass였다. 최종 읽기 위임의 권한·quarantine·정산·승인 task 회귀도 이 수치에 포함된다.
대시보드 26파일 143개, typecheck/lint/backend build/고정 시각 pre-GJC acceptance/CLI smoke가
각각 통과했다. 전체 verify를 처음부터 다시 실행해 exit 0을 얻은 것은 아니며,
최초 실패 및 후속 검증 결과를 함께 보존한다.

최종 built CLI/MCP 순환을 다시 실행해 64개 record·삭제 후 fence·compile 중 조회·완료·
두 번째 client·재전송 0·잔여 review 파일 0을 확인했다. 최종 compile 중 cycle은
1,405.000328ms다. 독립 마지막 정적 검토 필수 지적 0건, 타입 포함 API 791개 불변,
새 정적 순환 그룹 0개도 최종 소스에서 재확인했다.
