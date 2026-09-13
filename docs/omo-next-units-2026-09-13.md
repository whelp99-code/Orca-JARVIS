# OmO 잔여 내부 작업 실행 지시 — 2026-09-13

이 지시서는 `docs/claude-completion-instructions-2026-09-11.md`를 대체하지 않고, 2026-09-13의 실제 코드 대조로 확인한 내부 잔여를 구체화한다. Codex의 명시적 구현권 반환 메시지 후에 실행한다. 그전에는 읽기 전용 리뷰어다.

## 기준과 소유권

- 제품 checkout `/home/jm/orca/workspaces/Orca-JARVIS/codex-routing-approval-ui`, branch `codex/routing-approval-ui`.
- 보호할 close-fence 제품 commit: `18b73ede9a369ae8cb34bb44885bf6cbef9f2687`; 검증/패키지 결과: `docs/codex-close-fence-verification-2026-09-13.md`.
- 해당 회귀를 빼거나 옛 동작으로 되돌리지 않는다. 기존 staged/dirty 변경이 있으면 소유자를 확인하고 덮지 않는다.
- 반환 후 기존 OmO 한 명이 구현·빌드·테스트·커밋 담당이다. Codex/감시는 읽기 검토와 인수 기준 확인을 맡는다. 같은 입력 full verify는 한 번만 실행하고 살아 있는 gate와 새 build/package를 겹치지 않는다.
- 지시 수신, 단위 테스트 통과, 커밋 한 건, 중간 gate 통과를 종료 조건으로 삼지 않는다. 아래 A–D와 master M0–M6의 외부 의존성 없는 작업을 완료하고 최종 후보를 한 번 제출한다.

## A. 실제 assembler에서 추천·brief까지의 생산 경로

확인한 사실: `classifyAssembledCitations`/`citationAvailable`은 `src/personal-context-citation-contract.ts`에 정의됐으나 2026-09-13 검색에서 생산 코드 호출자 0, 테스트 호출자만 있었다. `assemblePersonalContext`는 `context_observation`/`confirmed_memory`를 생산하고, `recommendation-evidence-binding.ts`는 DB의 evidence_kind가 `linux_live_fact`/`user_confirmed_principle`/`owner_decision`인지 직접 비교한다. `tests/fixtures/local-observation-chain.ts`는 context와 owner evidence kind를 직접 구성한다. 따라서 계약 함수와 소비 테스트만으로 생산 경로 완료가 아니다.

1. 실제 생산 진입점과 정책 입력/기억 확인/관측 출처/추천 저장/발행 호출을 추적하고, 변별되는 실패 회귀부터 만든다. 단순 함수 단위 매핑 성공으로 끝내지 않는다.
2. 관측의 출처와 현재 원본을 통해 인용 역할을 증명하는 정식 adapter/결속을 제품 경로에 연결한다. 기존 sealed context의 kind를 문자열 치환하거나, advisory task-timeline을 live Linux fact/owner decision으로 승격하지 않는다. confirmed memory sufficient 조건을 유지한다.
3. 서로 다른 인수를 분리한다: (a) 실제 로컬 관측만 있는 경우 advisory/기권이 정확히 나오는 경로, (b) 제품의 검증된 live adapter와 기존 승인 경로로 마련한 격리 owner/confirmed-memory 증거가 있어 실제 추천을 만들 수 있는 경로. 두 경우 모두 assemble→persist→recommendation 생성→daily publish를 실제 제품 API/handler로 통과시킨다. fixture에서 최종 recommendation/brief 행을 INSERT하거나 evidence kind를 위조하지 않는다.
4. master §7.2의 중복·재시작·hold/quarantine/replacement/expiry/missing/capped와 lineage ID/digest 연결을 새 생산 경로로 재확인한다. 기존 daily configured CLI/process harness를 재사용하고 고정 시계와 격리 승인임을 명시한다.
5. 필요한 실제 live source/owner API가 제품에 없으면 그것은 내부 설계·구현 잔여다. provider 운영 인증이 없다는 이유로 격리 인수까지 중단하지 않는다. 실제 운영 승인/권한은 만들지 않는다.

## B. 저장된 파생 기억의 현재 재사용 차단

현재 `candidateTaskSourceClosed`는 후보 검토·승인·쓰기·scoped dispatch를 차단한다. `memoriesAwaitingTaskWithdrawal`는 숨긴 task에서 이미 저장된 기억을 resolved target/content identity로 열거한다. 이 두 가지가 현재 context/추천/읽기에서 이미 저장된 파생 기억을 막는지 실제 호출과 회귀로 대조한다. “없다”는 추정만으로 중복 억제 체계를 만들지 않는다.

1. 현재 구현만으로 되면 그 연결을 변별하는 정식 회귀로 고정한다. 안 되면 task의 기존 승인된 숨김/hold/프로젝트 scope 상태와 target/content identity를 읽기 소비 경계에 결속해, 이미 저장된 내용이 현재 context·추천·조회에 재사용되지 않도록 구현한다.
2. provider 비동기 IO 뒤에도 현재 원본 권한을 다시 확인한다. provider에 저장된 과거 이력과 현재 사용 가능 여부를 구분한다. 메모리 본문 비교·출처 손실·불명확한 target으로 임의 전체 차단/삭제를 하지 않는다.
3. provider가 실제로 삭제/철회됐다고 합성하지 않는다. 원격 effect는 기존 owner approval·suppression/tombstone·signed receipt 계약이 있어야 한다. 외부 계약이 없더라도 내부 차단·pending withdrawal 목록·정확한 재개 입력·회귀·준비물은 완료한다.
4. 저장 전 숨김, 저장 후 숨김, IO 중 숨김, 재시작, restore/rebuild 후 재유입, scope 변경, 승인 취소를 기존 suppression/cancellation 경로와 함께 시험한다. 이미 있는 테이블과 immutable migration을 재사용하고 schema가 꼭 필요하면 새 migration만 추가한다.

## C. 최종 패키지의 프로세스 인수

close-fence 패키지와 그 이후 A/B 제품 입력을 구분한다. 최종 변경이 끝난 뒤 새 complete runtime package와 pinned receipt를 만든다.

1. master §10.3과 기존 회신서 §6.2의 순서대로 packager→개발 checkout에서 receipt SHA256을 독립 QA에 먼저 고정→그 pin을 읽는 trusted verifier→packaged dashboard HTTP를 실행한다. package 자신에게서 검증 때 기대값을 재생성하지 않는다. `deployment_ready=false` 유지.
2. M2/M3 실제 handler/프로세스 인수를 packaged runtime으로 수행한다. 개발 checkout의 src/node_modules를 암묵 참조하지 않고 package의 production dependencies와 dist만 사용하게 한다. runtime identity/source head/input digest/receipt를 기록한다.
3. Second Brain 격리 설치물/프로세스와 정상 읽기·쓰기, scope, 활성 generation, 철회/거절을 가능한 실제 계약 범위에서 인수한다. 운영 DB/config/current를 건드리지 말고 기존 계약 harness를 재사용한다. fixture principal/key/clock, native 모델 호출 여부, 실행한 provider 바이너리/release 식별자를 정확히 구분한다.
4. 설치물에 아직 없는 refresh/cancellation contract는 실제 API/프로필 버전 결과와 prepared bundle로 한정한다. “provider 외부”라며 package의 실행 가능한 내부 프로세스 인수를 빼지 않는다.

## D. 최종 제출과 중단 복구

1. 각 단위를 실패 회귀→최소 수정→대상/인접 회귀→독립 리뷰→안정 입력 gate→로컬 커밋으로 완료한다. full verify 시작 시 HEAD/tree/내용 hash, 명령, UTC 시작을 저장하고 동일 프로세스의 RC/종료 UTC/log hash를 회수한다. 취소/실패/오염된 입력을 PASS에서 제외한다.
2. M0–M6/원본01–25 원장을 실제 코드와 인수로 갱신한다. 과거 §0/§4/“A/B 닫힘” 문구의 모순을 최신 문서 상단에서 정정하고, 역사 기록을 현재 상태로 읽게 두지 않는다.
3. 최종 문서에는 제품 SHA, 전체 gate 입력 tree, 문서 HEAD, 최신 package/receipt pin, 실제 source→brief 인수, 저장 기억 차단/철회, 외부 blocker별 owner·필요 입력·준비 파일·재개 명령·통과 조건을 담는다. 실제 사용자 키 없이 만든 시험은 격리 fixture로 표기한다.
4. 실패나 설계 난점이 생기면 실패 근거와 다음 가설을 checkpoint에 남기고 더 작은 재현/구현 단위로 계속한다. 같은 prompt를 두 번 받았다는 이유로 멈추거나 실패 회귀를 suite 밖으로 빼지 않는다. 긴 컨텍스트는 짧은 checkpoint/증거 경로로 정리한다.
5. 종료 상태는 master §11.1 그대로다. 내부 구현/실패 gate/패키지 누락이 있으면 `IN_PROGRESS`. 외부 계약·인증·운영 승인만 남고 가능한 준비·격리 인수가 모두 완료되었을 때 `READY_FOR_CODEX_FINAL_REVIEW_WITH_EXTERNAL_BLOCKERS`. 문구만으로 상태를 올리지 않는다.
6. 최종 회신서·manifest·패키지·로컬 커밋이 준비되면 Codex에 최종 검증 자료를 전달한다. 목표 완료를 이유 없이 미루려고 새 개선 작업을 만들지 않는다.

push/merge/deploy/서비스 재시작/운영 DB·설정·current 변경/새 운영 credential·authority 생성은 금지한다. /tmp 또는 타 작업 산출물을 정리하지 않는다. 로컬 수정·격리 검증·패키지·로컬 커밋은 이미 사용자 승인 범위다.
