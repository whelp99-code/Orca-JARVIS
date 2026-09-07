# JARVIS 실행 경로와 최적화 기록 (2026-09-07)

## 현재 실행 경로

| 기능 | 진입점 | 실제 동작 |
|---|---|---|
| 대시보드 작업 생성 | `src/dashboard/task-routes.ts` → `command-service.ts` | 팀 제안을 검증하고 `workflow.start` 승인 요청 저장 |
| 승인 명령 실행 | `src/dashboard/authority-service.ts` → `approved-executor.ts` | 승인 영수증을 소비하고 워크플로/런북/메모리 작업 수행 |
| 에이전트 전달 | `src/cli-gjc-commands.ts` → `gjc-configuration-store.ts` → `gjc-intent-store.ts` | 승인된 continuation과 설정을 검증해 GJC 큐 등록 |
| 큐 처리 | `src/service.ts` | GJC 전달·상태 확인·질문 답변 및 결과 원장 기록 |
| 관찰 | `src/live-supervisor.ts` | 등록된 대상의 구조화 신호를 읽고 보고 |

`workflow.start`의 완료는 워크플로 생성의 완료다. 코드 수정, 에이전트 전달 또는
최종 업무 완료를 뜻하지 않는다. 대시보드 일반 작업을 GJC에 전달하는 연결은 아직 없다.
위키의 메일·문서·Sangfor 라우팅 표도 목표 계약이며 실행자가 연결된 상태가 아니다.

## 이번 변경

- `ControlPlane.get(requestId)`는 기본 키 인덱스로 한 행을 조회한다.
  기존 `list().find()` 사용 네 곳을 교체했다. 목록/단건 조회가 같은 억제 검사와
  역직렬화 함수를 사용해 삭제·격리된 메모리의 표시 규칙을 보존한다.
- 큐 선택 전에 만료된 GJC claim을 복구한다. `sync`는 `pending`으로 복구하고,
  `dispatch`/`answer`는 `uncertain` 및 `GJC_CLAIM_EXPIRED_UNCERTAIN`으로 기록한다.
  이미 보냈는지 확인할 수 없는 명령은 자동 재전송하지 않는다.
- 복구 이벤트는 `gjc_intent_events.event_type = lease_expired`로 기록한다.
  같은 만료 claim의 복구 이벤트를 반복 생성하지 않는다.
- `service status`에 `work_readiness`를 추가했다. GJC 설정/동작 여부, 관찰 바인딩 수,
  대기/불확실 intent 수를 반환한다. 서비스 프로세스 생존만으로 업무 준비를 판정하지 않는다.
- `npm run verify`에서 중복 빌드 1회를 제거했다. `npm test`의 `pretest` 빌드와
  acceptance, CLI smoke는 유지한다.

## 운영 관측과 남은 연결

2026-09-07 이 작업에서 운영 DB를 읽기 전용으로 조회했다.

- `jm-jarvis.service`, `jm-jarvis-dashboard.service`: 각각 `active/running`.
- `gjc_runtime_config`, `live_supervisor_bindings`, `work_items`, `gjc_intents`,
  `control_command_requests`, `workflow_runs`: 각각 0행.
- 소스 `src`: TypeScript 계열 430파일, 52,663행 (수정 전).

업무를 실제로 맡기려면 사용할 실행 환경·세션·대상을 정하고 등록해야 한다.
대시보드 경로는 작업 범위, 완료 증거, 승인, 디스패치, 결과 연결을 하나의 계약으로
이어야 한다. 이번 복구 수정만으로 운영 연결이 완료됐다고 간주하지 않는다.
운영 릴리스 활성화는 `docs/personal-os/release.md`를 따른다.

## 검증 실행

일반 검증: `npm run verify`.
이 호스트에서는 `/tmp` 쓰기가 `EDQUOT`(122)로 실패해 아래와 같이 실행했다.

```bash
mkdir -p .runtime-tmp/optimization
TMPDIR="$PWD/.runtime-tmp/optimization" npm run verify
```

추가 회귀: `tests/integration/gjc-lease-recovery.test.ts` 및
`tests/integration/control-command-lookup.test.ts`.
복구 회귀는 수정 전 5개 중 4개 실패, 수정 후 5개 통과를 확인했다.
단건 조회는 100개 요청에서 가시성 검사 1회, 인덱스 사용, 조회 전후 DB 변경 수 불변을 검증한다.

단건 조회 성능 표본 (격리된 메모리 DB, 요청 1,000행, 방식별 25회 중앙값):

| 방식 | 중앙값 |
|---|---:|
| 기존 `list().find()` | 12.027ms |
| 신규 `get()` | 0.030ms |

쿼리 계획은 `sqlite_autoindex_control_command_requests_1 (request_id=?)` 사용을
확인했다. 이 수치는 합성 표본이며 운영 HTTP 지연 시간의 측정치가 아니다.

최종 검증 결과:

- 전체 backend 실행: 329파일 / 1,817테스트, 327파일 / 1,815테스트 통과,
  2파일 / 2테스트 실패, exit 1 (762.49초).
- 실패 원인: `service.ts` 비어 있지 않은 줄 251개(상한 250개),
  자동 Xvfb 화면에서 Electron 초기화 실패/60초 제한 초과.
- 전자는 오래된 launchd 설명 한 줄을 제거해 250개로 맞췄다.
  후자는 이 호스트에 이미 실행 중인 가상 화면 `DISPLAY=:102`와 짧은 쓰기 가능
  임시 경로 `TMPDIR=/home/jm/.cache/jvtest`로 검증했다.
- 최종 코드로 신규 회귀 및 두 실패 파일 재검증: 4파일 / 12테스트 통과, exit 0.
- 최종 lint, typecheck, build: 각 exit 0.
- dashboard: 25파일 / 136테스트 통과, exit 0.
- 고정 시계 pre-GJC acceptance와 CLI smoke: exit 0.
- 전체 backend suite를 최종 수정 후 다시 전부 실행한 것은 아니다.
- 독립 에이전트 정적 리뷰: actionable finding 0건. 테스트 실행은 주 작업에서 담당.

운영 DB 변경, GJC 세션 등록, 서비스 재시작 및 릴리스 전환은 수행하지 않았다.
현재 코드 변경은 로컬 작업 트리에 있다.
