# P1-13 관측 실패 격리의 구현 경계

2026-09-08. 상태: 읽기 오류·프로세스 경계 구현/검증, backoff·독립 건강 상태 미완료.

## 현재 구현

`orca-read-envelope.ts`는 성공/실패 분기 전에 전체 JSON의 중복 키·깊이·유한 숫자·문자열을
검증한다. 원문 UTF-8 출력은 1,000,000bytes 이하이며 특수 키는 own data property로
보존하여 상위 envelope 검사에서 거부한다. 큰 터미널 목록을 위해 노드 상한은 별도로
두되, `strict-json.ts`로 옮긴 공통 파서의 Second Brain 기존 제한은 변경하지 않았다.

확인한 Orca CLI 구조화 오류 중 `runtime_unavailable`과 `runtime_timeout`만 일시적이다.
권한/설치/설정/스키마/stale handle/미분류 오류는 fatal이다. exit1의 stdout에 있는 오류
코드를 보존하며 stderr 문장을 원인 판정에 사용하지 않는다. unknown 코드를 임의로
transient로 승격하지 않는다. 공개 오류 메시지는 고정 코드이며 원본 오류 문구를 담지 않는다.

`orca-read-runner.ts`의 기본 실행 파일은 Linux `orca-ide`, 개발 환경 `orca-dev`이며
명시적 `ORCA_CLI_COMMAND`는 하나의 실행 파일 경로로 사용한다. shell은 사용하지 않는다.
기본 runner는 첫 사용 때 설정을 고정한다. 읽기 1회당 timeout 5,000ms, stdout/stderr 합계
1,000,000bytes 상한이다. 이 경계 안에서 재시도하지 않는다.

POSIX에서는 소유 프로세스 그룹을 만들고 timeout/출력 초과/정상 종료/구조화 오류 종료
모두에서 그룹에 SIGKILL을 보낸다. 종료 확인에는 추가 250ms 상한을 둔다. 확인 실패나
그룹 종료 권한 오류가 있으면 `ORCA_CLI_CLEANUP_FAILED`로 실행기를 재사용하지 않는다.
프로세스 그룹을 벗어난 자손은 이 방식만으로 종료를 보장할 수 없으며, 상속된 파이프가
남은 경우에는 위 실패 경계로 차단한다. Windows는 직접 자식 종료와 close 상한만 적용하며
자손 정리의 운영 검증은 미완료다. 이번 실측은 Linux에 한정한다.

`observeBound`와 원격/비활성 작업공간 discovery는 명시적인 일시적 오류만 unknown/skip으로
처리한다. cursor는 보존한다. schema/권한/식별자 오류는 service callback 밖으로 전파되어
coordinator 호출 이전에 중단된다. 기존 전체 supervisor 예외 무시 방식은 계속 HOLD다.

## 전체 콜백 격리를 보류하는 이유

`GjcRuntimeService.processOnce`는 supervisor 콜백을 await한 뒤 pending intent를 claim한다.
실제 `cli-gjc-commands.ts` 콜백은 순수 조회가 아니다. `LiveSupervisor.cycleWithShadow`는
`drainStructured`로 입력을 처리하고 보고서를 출력한 후 `acknowledgeReport`를 기록한다.
모든 예외를 무시하면 권한 처리 실패와 불확실한 출력 확인을 숨기므로 도입하지 않는다.

## 검증

- 성공 분기 앞의 중복 ok/escaped ok/중첩 키, prototype 위장, 큰 터미널 목록 및 기존
  Second Brain node cap 유지, CLI exit0/1, stderr/UTF-8/출력 상한/설치/권한 오류 회귀.
- 실제 fixture 프로세스의 timeout, wrapper 종료 후 상속된 stdout, 별도 stdio 자손,
  소유 그룹을 벗어난 자손의 close 실패와 runner 재사용 차단을 검사했다.
- service에 pending sync intent를 넣고 list/read 각 실패 시점을 검사했다. 일시적 오류는
  unknown과 기존 cursor를 유지하고 sync가 completed됐다. 권한/stale/schema/unknown 오류는
  coordinator 호출0, intent pending을 유지했다. remote/idle discovery도 같은 원인을 구분했다.
- 빌드된 runner의 격리 실측: timeout507.16ms, stdout을 붙잡은 자손505.10ms,
  조용한 자손의 정상/오류 종료31.92/27.89ms, close 미확인752.55ms.
  부모5/자손4 종료 확인. 그룹을 벗어난 fixture는 재사용 차단 확인 후 probe가 직접 종료했다.
- 실제 설치된 Orca를 기본 runner로 읽어 status 전후 성공과 stale handle 오류를 확인했다.
  운영 터미널 입력/서비스 재시작/DB 변경은 하지 않았다.
- 증거: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/orca-read-*.log`,
  `orca-read-live-probe.mjs/json`. 독립 정적 리뷰 최종 필수 결함0.

## 남은 완료 조건

1. 다음 관측 시도 시각과 제한된 backoff를 두고 incarnation 변경 시 낡은 회로 상태가
   새 binding을 차단하지 않게 한다. lease 안에서 장시간 sleep하지 않는다.
2. 관측 건강 상태와 coordinator 실행 상태를 별도 저장·노출한다. 성공하지 않은 관측은
   last successful observation 시각을 갱신하지 않으며 상태 조회 자체는 쓰지 않는다.
3. 보고서 출력 실패의 무단 ack0, lease 상실 후 외부 호출0, backoff 복구 및 새 incarnation
   격리를 실제 service 경로에서 검증한다. 기존 관련 회귀는 유지한다.

P1-13 및 전체01–25 목표를 완료 처리하지 않는다. 자동 기억 수집의 원본 차단 전파 HOLD도 유지한다.
