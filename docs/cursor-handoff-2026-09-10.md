# Cursor 작업 인계 지시서 — JARVIS, 2026-09-10

## 1. 사용자 결정과 작업 경계

사용자는 현재 진행 중인 작업을 마무리하고 남은 작업을 Cursor에 인계하도록 요청했다. 현재 진행 중이던 전체 verify는 완료했다. 이 문서 작성 이후 새 기능 개발은 시작하지 않았다.

1차 목표는 **자비스와 세컨드브레인의 실제 운영**이다. 개발 중인 다른 프로젝트도 이 두 시스템을 통해 지원한다. 코드가 섞였다는 문제를 파일 수 감소만으로 해결하지 말고, 책임·권한·증거·운영 경계를 정리한다.

세컨드브레인은 유지·발전시키고 다른 오픈소스의 장점을 선별 흡수한다는 것이 사용자 결정이다. dev-wiki 폐기나 외부 제품으로 전면 교체가 확정된 것은 아니다. 모든 에이전트가 연결할 수 있는 공통 계약을 지향하되, 아직 검증하지 않은 실행자를 지원한다고 표시하지 않는다.

사용자가 제시한 검토 대상은 HKUDS/LightRAG, TencentCloud/TencentDB-Agent-Memory, t1seungy/code-brain, jung-wan-kim/memory-bank이다. 기능·라이선스·채택 여부는 Second Brain 작업에서 원문과 실제 코드를 검증한다. 여기서는 이들의 기능을 새로 조사하거나 구현 사실로 단정하지 않았다. 기존 인계 문서 `docs/second-brain-oss-absorption-handoff-2026-09-07.md`를 함께 읽는다.

## 2. 반드시 사용할 checkout

- 개발 worktree: `/home/jm/orca/workspaces/Orca-JARVIS/codex-routing-approval-ui`
- branch: `codex/routing-approval-ui`
- 최종 제품 구현 및 전체 검증 SHA: `b5c13babe220d21dd63da648bb0a9ebea959275a`
- 이 문서의 커밋은 위 SHA 이후의 문서 변경이다. 문서 HEAD를 제품 검증 SHA와 혼동하지 않는다.
- 앱의 기본 cwd `/home/jm/orca/projects/Orca-JARVIS`는 별도 checkout이다. 그곳의 기존 사용자 변경을 덮어쓰지 않는다.
- 검증 종료 시 개발 worktree 상태: `?? node_modules` 1개, tracked 변경 0개. 공유 의존성 경로이므로 추가·삭제·커밋하지 않는다. Cursor 시작 시 상태를 다시 측정한다.
- Second Brain workspace: `/home/jm/orca/projects/second-brain-app`. 해당 작업의 최신 HEAD·진행 상태는 별도로 확인한다.
- Second Brain 대상 task: `codex://threads/01a07b30-3b47-7552-879e-adae5ab6ec33`. 이 문서 작성은 해당 task로 전송했다는 뜻이 아니다.

먼저 AGENTS.md, CONTROL_TOWER.md, ORCA_MASTER_CHARTER.md, `docs/personal-os/release.md`, 적용되는 하위 지침을 읽는다. 리포 간 관례는 dev-wiki 정본을 확인한다. 이전 Mac/launchd 문서를 현재 Linux 실행 절차로 복사하지 않는다.

기존 migration SQL은 수정하지 않는다. 필요한 스키마 변경은 새 migration으로 추가한다. raw git worktree 대신 Orca 절차를 사용한다. 배포·운영 DB 변경·서비스 재시작·운영 설정 변경은 현재 인계에 포함되지 않는다. 고정 모델 라우팅이나 임의의 에이전트 위임 정책을 복구하지 않는다.

## 3. 이번에 완료한 검증

`npm run verify` 종료 코드 **0**. 완료 시각 2026-09-10 11:12:00 KST.

| 구간 | 실측 결과 |
|---|---|
| backend shard 1 | 270파일 / 1,850테스트 통과 |
| backend shard 2 | 270파일 / 1,887테스트 통과 |
| dashboard | 38파일 / 263테스트 통과 |
| 합계 | 578파일 / 4,000테스트 통과 |
| runtime/lint/architecture/typecheck/build/고정 시각 acceptance/CLI smoke | 전체 명령 exit 0 |
| 정적 내부 ESM 의존성 | 654모듈 / 중복 제거 2,428간선 / 순환 0 |
| 검증 전후 | HEAD 동일, tracked 1,866파일 내용 동일 |

증거 디렉터리: `/home/jm/.cache/jarvis-test-runtime-qa-20260908`
- `verify-local-observation.log`
- `verify-local-observation-before.json`
- `verify-local-observation-result.json`

이 경로는 로컬 QA 증거이며 git에 포함되지 않는다. 다른 머신에서 접근할 수 없으면 해당 결과를 직접 검증했다고 주장하지 말고 필요한 검증을 재현한다.

고정 시각 acceptance는 `pre_gjc_ready`, `aggregate_status=stopped`, `completion_promoted=true`, `gjc_dispatched=false`였다. 실제 외부 실행이나 production 적용의 증거가 아니다. 이번 전체 verify에는 Playwright E2E·새 실행 패키지 검증이 포함되지 않았다.

## 4. 방금 완료한 제품 변경: 로컬 task 관측의 명시적 접수

기존 로컬 timeline cache를 advisory observation으로 접수하고 context 소비 시 현재 원본과 재대조한다. 자동 반복 생산자는 연결하지 않았다.

| 코드 | 현재 책임 |
|---|---|
| `src/local-timeline-collection.ts` | 실제 TaskTimeline의 제한된 수집 및 내용 digest |
| `src/local-timeline-snapshot-store.ts` | 대상별 교체형 cache, 최대 64대상, 수집 시작+300,000ms 만료, 정확한 collection ID 재검증 |
| `src/local-timeline-refresh-service.ts` | 명시 등록 대상 refresh, 각 service clock 관측의 단조성 검증 |
| `src/local-timeline-observation.ts` | prepareLocalTimelineObservation / readCurrentLocalTimelineObservation / admitLocalTimelineObservation |
| `src/personal-context-evidence.ts` | local observation을 context 증거로 소비할 때 현재 cache/원본 검증 |
| `src/context-assembler-sources.ts` | 정확한 local source/kind/host/payload 조합을 선택 |
| `src/cli-local-timeline.ts` | 명시적 CLI 접수 |
| `src/cli-runtime.mts` | CLI 도움말 |

CLI: `node dist/src/cli.js timeline admit-observation TASK_ID COLLECTION_ID --db PATH`

불변 조건:
- 기존 DB와 정확한 현재 collection ID를 요구한다. 대상 자동 등록은 하지 않는다.
- source는 `src:pos:v1:task-timeline:local`, kind=timeline, host=linux-control-plane, payload kind=local_task_state다.
- payload는 로컬 task ID/종류/상태/승인 대기/원본 갱신 시각/collection ID와 digest만 담는다. 제목·이벤트 본문·터미널 생존을 추정해 넣지 않는다.
- trust=verified는 SQLite 사실의 검증이다. authority=none인 advisory 관측이며 실행 권한이 아니다.
- 같은 collection의 ID는 안정적이고 새 collection은 별도 ID다. checkpoint/cursor는 null이다. collection ID를 전역 단조 checkpoint로 사용하면 동일 시각 복수 수집이 충돌한다.
- 접수는 immediate transaction 안에서 준비→기존 observation store 저장→현재 원본 재검증 후 commit한다. 같은 collection 재접수는 inserted=false다. 저장 후 만료되면 audit를 포함한 전체 DB 변경이 rollback된다.
- 소비 시 저장된 canonical envelope/digest를 확인하고 현재 원본에서 재생성한 canonical bytes와 일치해야 한다. hold/replacement/expiry/원본 변경/관측 quarantine은 거절한다.
- context assembler는 여전히 **confirmed memory가 있어야 sufficient**다. local 관측만 넣고 sufficient로 바꾸지 않는다.
- 기존 context 저장 replay는 저장된 metadata 반환이다. 모든 replay가 최신 증거를 검증한다고 주장하지 않는다.

자동 회귀: `tests/integration/local-timeline-observation.test.ts` 4개, `tests/integration/cli-local-timeline.test.ts` 2개. 별도 실제 compiled CLI 증거 `local-admission-cli-live.json`: 최초 inserted=true, 재접수 동일 ID/inserted=false, hold 후 exit 2 / LOCAL_OBSERVATION_SOURCE_UNAVAILABLE. fixture는 합성 task와 격리 DB이며 운영 업무 실행이 아니다.

세부 경위와 각 단위 검증은 `docs/planning/local-timeline-daily-consumption.md`에 있다. 이 문서는 누적 기록이므로 앞쪽의 미구현 문장보다 뒤의 구현 항목과 실제 코드를 우선 확인한다.

## 5. Cursor가 이어갈 순서와 완료 조건

### A. JARVIS: local observation → recommendation → morning brief 완결

**다음 개발 우선순위다.** 기존 접수 기능을 재작성하지 말고, 현재 소비 경로의 누락부터 확인한다.

1. `personal-context-evidence.ts`, `morning-recommendation-context.ts`, `morning-recommendation-source.ts`, `morning-brief-publisher.ts`, `morning-publication-lineage.ts`, `daily-loop-morning-execution.ts`의 실제 호출과 transaction 경계를 조사한다.
2. 적법하게 확정된 memory fixture와 local observation을 기존 assembler/추천 생성 경로에 넣는다. source→collection→observation→context→recommendation→brief의 ID/digest/유효기간 연결을 기록한다.
3. 접수 이후 및 추천/보고 발행 이후 hold·quarantine·replacement가 발생했을 때 각 현재 조회 경로가 무엇을 반환하는지 검증한다. 과거 저장물 보존과 현재 실행 가능한 정보 노출 정책을 분리하여 명문화한다. 오래된 보고를 유효한 현재 증거로 취급하지 않는다.
4. 누락이 입증된 소비 경로에만 재검증을 추가한다. 현재 원본을 재검증하는 transaction 경계를 보존한다.
5. 격리 DB와 실제 compiled service/daily CLI로 정상 경로 및 재시작·재접수·hold·replacement·발행 도중 만료·capped·원본 부재를 검증한다. 중복 actionable recommendation/brief가 0개여야 한다. 일일 lease·fence·budget 검증을 우회하지 않는다.

주의: `MemoryProjectionLineage.inherit`는 memory identity를 복사하며 일반 부모-자식 quarantine 연결을 저장하지 않는다. 실험에서 parent_suppressed=true, inherited_child_suppressed=false였다(`local-daily-lineage-boundary.json`). 전역 inherit 의미를 추측으로 변경하지 않는다. 로컬 검증기를 재사용하고 누락된 경로를 증거로 특정한다.

### B. JARVIS: 반복 생산자의 증가량·중복·보존 정책

A의 명시적 경로 검증과 별도로, 자동 접수 활성화 전에 완료한다.

- cache는 교체되지만 observation은 immutable이다. 최대 64대상을 계속 갱신하면 cache 상한과 무관하게 저장 관측이 증가한다.
- 새 collection/같은 내용/같은 task 상태에서 관측 ID와 추천의 업무상 중복 판단을 구분한다. collection별 새 ID 요구를 제거하여 중복을 숨기지 않는다.
- observation/context/recommendation/notification 참조, quarantine, 감사 증거, 삭제 계보를 조사한 뒤 보존 cutoff와 참조 중인 자료 처리 계약을 정한다.
- adapter 없는 retention을 completed로 표시하거나 단순 DELETE로 FK/감사/삭제 계보를 끊지 않는다. migration 필요 여부는 실제 기존 구조로 판단한다.
- 재시작, 같은 시각, 중복 service 기동, cutoff 경계에서 저장 증가량과 중복 actionable output을 측정한다.
- 계약과 검증 완료 후 명시적 opt-in service 설정에만 연결한다. 자동 전체 task 등록은 하지 않는다.

### C. Second Brain + JARVIS: provider refresh publication 계약

`docs/planning/daily-refresh-publication-contract.md`를 기준으로 상대 workspace와 조율한다. 현재 local cache는 provider refresh를 대체하지 않는다. 기존 configured daily 경로의 null refresh reader를 성공으로 포장하지 않는다.

Second Brain 담당: request/scope/provider/release/completion/cap outcome/활성 manifest가 결속된 receipt, 실패·중복·재시작 계약을 제공한다. generation build 완료와 실제 published/activated 상태를 구분한다. 기존 `sb_generation_status`에 필요한 refresh receipt 필드가 있는지는 최신 코드로 재확인한다.

JARVIS 담당: IO 후 권한·lease를 재확인하고 consumption 시 현재 generation/manifest를 대조한다. 미설정·미완료·실패·capped·완료를 구분한다. 두 격리 설치물을 실제 프로세스로 연결하여 오래된 release, 철회, 만료, 중복 요청을 검증한다. provider 파일을 이 checkout에서 임의로 변경하지 않는다.

### D. JARVIS + 운영자: 실제 업무 준비 및 적용

- 과거 확인에서 Claude 실행 경로/검증 키 관련 JARVIS_TASK_CLAUDE_PATH, JARVIS_TASK_VERIFIER_KEY_PATH, JARVIS_TASK_VERIFIER_KEY_ID 설정이 미완료였다. 현재 상태는 읽기 전용으로 재확인하고 값/비밀을 로그에 노출하지 않는다.
- 준비 상태, 승인된 대상/범위, 실행자 인증, 검증 키, rollback 및 release identity를 점검한 뒤 구체적인 적용안을 만든다.
- 개발 성공과 운영 활성화를 구분한다. 운영자 지시 없이 deploy/restart/current 전환을 수행하지 않는다.
- 실제 허용 업무 한 건의 TaskSpec→승인→durable dispatch→실행 증거→서명 검증→완료를 추적한다. probe만으로 실행 성공을 선언하지 않는다.

## 6. 원본 01–25 잔여 관리표

원본 정의: `docs/improvement-backlog-2026-09-07.md`. 아래 ‘구현’은 현재 개발 checkout의 범위이며 production 적용 완료를 뜻하지 않는다. 상세 증거는 `docs/jarvis-development-execution-2026-09-07.md`의 해당 항목을 찾는다.

| ID | 인계 시 상태 | Cursor의 잔여 범위/완료 조건 |
|---|---|---|
| 01 | redaction 구현 | 후속 변경 시 비밀 표식 비노출 회귀 유지 |
| 02 | owner/fence 구현 | 실제 두 프로세스 배타성 계약 유지 |
| 03 | 만료 settle 차단 구현 | 만료/이전 fence 정산 금지 유지 |
| 04 | TaskSpec 제약·예산·digest 보존 구현 | 승인부터 최종 검증까지 결속 유지 |
| 05 | 구조화 liveness 구현 | 등록 사실을 live로 승격하지 않음 |
| 06 | 전체 활성 SQL count 구현 | 최근 목록과 전체 count 분리 유지 |
| 07 | 미지원 retention 상태 구분 구현 | 일반 lifecycle retention 잔여는 B에서 수행 |
| 08 | 조회의 암묵적 초기화 제거 구현 | 첫 읽기 포함 DB 무변경 유지 |
| 09 | retry 만료 권한 검증 구현 | 재계획/재승인 없이 권한 연장 금지 |
| 10 | 준비 상태 및 격리 실행 검증, 운영 미완료 | D의 실제 설정/등록/승인된 업무 인수 |
| 11 | Claude 승인→실행→검증 경로 구현 | D의 운영 준비 및 실제 적용 검증 |
| 12 | 일일 service/restart, 일부 retention 구현 | A/B/C, 일반 관측·문맥·추천·알림 retention |
| 13 | supervisor/coordinator 장애 분리 구현 | 권한 오류와 일시 관측 실패 구분 유지 |
| 14 | runtime 순환 0 및 자동 검사 구현 | 실측 결합 문제가 있을 때만 도메인 개선; 파일 수 목표 금지 |
| 15 | 서버/Electron 설치·빌드 분리 구현 | 서버 실행에 GUI 설치 강제 금지 |
| 16 | SQL pagination·조회 메모리 개선 구현 | legacy 전체 결과 배열은 무제한임을 유지 문서화; 필요 시 호환 API 설계 후 streaming 검토 |
| 17 | SSE backpressure/재연결/구독 상한 구현 | 전체 RSS·클라이언트 공정성 보장까지 입증된 것은 아님 |
| 18 | 테스트 profile/직렬 shard/환경 점검 구현 | 변경 범위에 맞는 회귀와 실제 프로세스 검증 유지 |
| 19 | runtime identity/패키지 무결성 도구 구현 | sealed manifest·실제 배포 적용 및 최신 패키지 인수 잔여 |
| 20 | 버전 routing config/설명 preview 구현 | 외부 자동 행동은 검증·권한 전 보류 |
| 21 | Claude 실행자 registry 구현 | Codex는 unsupported 보류; 실제 adapter와 실행 증거 전 선택 금지 |
| 22 | Second Brain scoped 쓰기/조회/철회 실증 | task 결과 자동 기억화의 동의·privacy·원본/삭제 계보·중복 계약 필요 |
| 23 | 구조화 Orca/로컬 cache 및 명시적 관측 구현 | A/B/C 및 실제 외부 입력 connector 1개; calendar/mail/messenger 연결 미완료 |
| 24 | 코드 수정/장애 보고/기술 검토 3템플릿 구현 | 실제 운영 인수; 메일·견적 외부 행동은 별도 검증 전 보류 |
| 25 | 서명 결과 기반 성과/승인 p95/재작업/shadow 구현 | 실제 청구 비용·외부 중복 효과·실행된 후보 비교 증거 필요; 정책 자동 승격 금지 |

## 7. 기존 검증물을 재사용할 때의 한계

- 최신 보관 패키지 `/home/jm/.cache/jarvis-test-runtime-qa-20260908/jarvis-runtime-o06V8W`는 source `20328f62c8f6914999308bc67d65548aedf12455`다. **현재 b5c13ba의 local observation 접수를 포함하지 않는다.**
- 그 패키지의 실제 HTTP 6개 응답과 독립 service 두 번의 local refresh는 검증했다. `package-local-refresh-clock-*`, `packaged-local-refresh-service.json` 참조. 이를 현재 제품 전체의 패키지 인수로 소급하지 않는다.
- 이전 Second Brain paired package 검증은 `latest-packaged-provider-pair-adapted.json`에 있다. 실제 TLS/gateway/CLI/MCP, 승인 쓰기/조회/철회 경로를 검증했지만 합성 identity/policy/clock이며 native 모델 호출은 없었다. 개발용 시험 harness import 경로를 조정한 결과다. provider refresh/자동 기억화 증거가 아니다.
- `scripts/verify-runtime-package.mjs`는 신뢰 checkout에서 이전에 기록한 receipt SHA를 사용해 검사한다. candidate 코드를 신뢰해 실행하는 방식으로 변경하지 않는다. integrity match는 서명 검증·배포 권한·운영 활성화가 아니다.
- 정적 import 검사 범위는 내부 static ESM이다. dynamic import/require/외부 모듈까지 순환 없음을 보장하지 않는다.

## 8. 작업 및 검증 절차

1. 정확한 worktree에서 git branch/HEAD/status와 Node 버전을 읽고 위 기준과 차이를 기록한다. 다른 작업자의 수정이 있으면 보존한다.
2. 이 문서, 실행 기록, local timeline 설계, refresh publication 계약, runtime 경계 ADR을 읽는다. 기존 구현은 코드로 확인한다.
3. A의 아직 검증되지 않은 소비 경로 하나를 골라 재현 가능한 acceptance를 먼저 정의한다. B/C 의존성이 없는 명시적 경로부터 완결한다.
4. 구현 단위마다 관련 테스트와 필요한 실제 compiled 프로세스 검증을 실행하고, 결과와 남은 제한을 기록한 뒤 작은 커밋으로 남긴다.
5. 제품 변경 후 관련 gate를 통과하면 통합 시점에 전체 verify를 실행한다. 실패 원인 없이 같은 전체 검증을 반복하지 않는다. 문서만 바뀌었으면 diff/링크/명령 검토로 충분하다.

현재 확인된 명령(개발 worktree에서 실행):

```bash
npm run runtime:check
npm run architecture:check
npm run build:backend
npm run test:integration -- tests/integration/local-timeline-observation.test.ts tests/integration/cli-local-timeline.test.ts
npm run test:unit
npm run typecheck
npm run lint
npm run verify
```

integration profile은 unit 경로를 제외한다. 경로를 전달했다고 실행된 것으로 집계하지 말고 실제 파일/테스트 수를 확인한다. 전체 verify는 backend 두 직렬 shard를 포함해 이번에 약 20분이 소요됐다. UI 변경 시 필요한 `npm run test:e2e`를 별도로 수행하고, 운영 smoke는 운영 환경을 대상으로 하므로 무심코 실행하지 않는다. 임시 공간 부족 시 test runner의 scratch 절차를 확인하고 다른 작업의 생성물을 광범위하게 지우지 않는다.

완료 보고에는 구현 SHA, 실행한 명령과 exit code/테스트 수, 실제 프로세스 여부, 증거 경로, production 적용 여부, 남은 HOLD와 재개 조건을 적는다. 전체 01–25 또는 자비스·세컨드브레인 운영이 완료됐다는 선언은 위 잔여가 실제 충족된 뒤에만 한다.
