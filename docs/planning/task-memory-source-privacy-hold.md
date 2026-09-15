# 작업 완료 → 기억 후보 연결 보류: 원본 차단 전파

2026-09-08. 대상 기준 task completion `7129b9d`, 기억 접수 `b89dab6`. 독립 소스 검토에서 P1 두 건을 확인해 **collect-task 제품 진입점과 신규 collector 소스를 반영하지 않았다**. 초안은 `/var/tmp/jarvis-task-memory-deferred-20260908`에 개발 참고용으로 보관한다. 실행 또는 테스트 통과 산출물이 아니다. 기존 classify/owner confirmation/outbox는 유지한다.

## 발견한 공백

1. 수집 전 task_id 차단 누락. `TaskTimelineSummaryReader.isSuppressed`는 task_id를 검사한다. task.execute의 request_id/run_id는 task_id와 다르다. request/completion/run/source만 검사하는 collector는 숨긴 task를 원본으로 새 후보를 만들 수 있다.
2. 수집 후 원본→파생 후보 차단 연결 부재. candidate/source_refs만 생성하면 source suppression이 후보에 전파되지 않는다. `readCandidateReview`는 candidate_id만 검사하고, owner 결정 및 `hasSecondBrainWriteAuthority`는 task source 차단을 재검사하지 않는다. 후보 생성 후 원 task를 차단해도 이미 보존된 요약의 조회·승인·저장 경로가 열린다.

근거는 독립 코드 검토이며 실제 개인정보 유출이 발생했다는 관측이 아니다. `readTaskCompletion`의 완료/verification/publication 결합은 재사용 가능하지만 신규 요약의 내용 검증 권한이 아니다. 요약을 verified_outcome으로 서명하거나 권한 원장에 직접 넣는 우회는 하지 않는다.

## 재개 조건과 구현 순서

- 검증한 원래 task command/plan/workflow에서 request_id, task_id, run_id, completion_id 및 관련 source/문맥을 모두 확인한다.
- 원본→검토 원문→후보→결정 명령→dispatch/outbox→저장 record/검색의 영속 출처 관계를 정의한다. 기존 projection dependencies가 target 기반이며 원본 task와 새 provider record는 다른 식별자임을 반영한다.
- 수집 전 차단, 수집 후/승인 전 차단, 승인 후/dispatch 전 차단, 전송 중 차단, 저장 후 원본 삭제를 각각 처리한다. 화면에서만 숨기거나 저장 직전 한 번 검사하는 것으로 축소하지 않는다.
- candidate와 provider record의 파생 출처를 정정·삭제·재색인·백업 복원에서도 유지한다. 직접 MCP 클라이언트가 자비스 화면 차단을 우회해 삭제된 파생 기억을 회수하지 않는지 검증한다.
- 검토 원문 보존/폐기·privacy event·재시도/충돌 처리를 기존 단일 writer와 outbox에 연결한다. 별도 기억 DB나 승인 체계를 만들지 않는다.
- 정식 회귀: task_id만 차단한 경우, 후보 생성 후 원본 차단, 이미 준비한 승인 명령, uncertain 전송/재시작, 저장 후 두 클라이언트 조회, 복원 후 재유입 0. 정상 입력은 실제 작업 완료→사용자 검토→저장→출처 재조회까지 확인한다.

이 항목은 B4/I1·I7/G6의 필수 잔여다. 보류를 전체 기능 삭제나 완료 기준 축소로 취급하지 않는다. 현재 제품 classify는 외부 입력에 대한 기존 분류 경로이며 작업 자동 수집 완료가 아니다. 운영 배포·서비스 재시작·push는 수행하지 않았다.

## 2026-09-09 계약 재검증

자비스 기준 `6380e1d`, provider 작업공간 HEAD
`bddbc382dc00d8d4ca71acd7947552139efa4944`. 아래 확인한 provider 계약/모델 파일의
working-tree 변경은 0개였다. provider 배포 상태를 뜻하지 않는다.

- 양쪽 `contracts/second-brain-mcp-v5.json` 바이트 일치.
  SHA256 `d137a7a7b0e4a577abef04d6ecb2768630e9912cd24b8f270c320cb45d60165d`.
- 양쪽 `contracts/second-brain-scoped-read-v2.json` 바이트 일치.
  SHA256 `a5af30045ba19eb6e79d07f649e3049842741822d75bdb7212d2ec7eabd9cb37`.
- remember V3의 payload 필드는 content이며, 요청에는 candidate/classification digest와
  승인 receipt가 있지만 task/request/run/completion 원본 관계를 전달하는 필드는 없다.
- provider `sb/mcp_remember_models.py`의 `MemoryRememberRequestV3Model`은
  `extra="forbid"`. 실제 provider 가상환경에서 공개 fixture를 model_validate하면 성공하고,
  같은 fixture에 제안 필드 source_lineage만 추가하면 해당 필드의 extra_forbidden 1건으로
  거부된다. 프로세스 exit0; provider 호출/DB 변경 없이 모델 파서만 검증했다.
- provider `tests/test_lineage_resolution.py`는 PageSpec의 prompt/model/derivation_key
  보존·복원 테스트다. 이 소스 검토만으로 자비스 task 삭제의 파생 record 차단을 증명할 수 없다.
- 자비스 `4c483a1`·`ca4fb77`은 기존 projection의 subject 차단과 알림 상태 전이를 보강했다.
  task→candidate→provider record 출처 관계의 생성·삭제 계약을 추가한 커밋은 아니다.

### 필요한 계약 변경안 — 미구현·미합의

1. 기존 frozen 계약은 유지하고 별도 버전/feature로 출처 연계를 협상한다. 후보 digest나
   summary 본문에 출처를 묻는 방식으로 새 권한을 암묵적으로 만들지 않는다.
2. 원래 승인 task의 request/task/run/completion 식별자와 검증된 결과 digest를
   프로젝트 범위 및 provider record identity에 결합한다. 외부에 노출할 식별자 형식,
   개인정보 보호 방식, 키 관리와 서명 주체를 양쪽 계약에서 정한다.
3. 출처 연결을 요청 digest·승인·저장 receipt에 포함하고, 동일 입력 재시도는 같은 관계를
   재사용한다. 임의 클라이언트가 다른 프로젝트의 출처나 삭제 권한을 연결할 수 없어야 한다.
4. 원본 차단을 provider가 관측한 시퀀스와 파생 record/색인/복원 상태를 증명한다.
   차단 전후 및 uncertain 전송의 재조정까지 포함하며 단순 accepted 응답을 완료로 삼지 않는다.
5. 기존 재개 조건의 여섯 회귀와 정상 저장 경로를 양쪽 클라이언트로 검증한 뒤
   collect-task 진입점을 활성화한다. 현재 모델 파서 검증은 이 인수를 대체하지 않는다.

즉시 가능한 자비스 작업은 원본 식별과 로컬 관계의 설계·격리 구현이다. provider의 출처
계약이 없는 상태에서 저장 후 삭제 전파까지 완성됐다고 표시하는 것은 보류한다.

## 후속 scoped provider 통합 검증 — 2026-09-09

자비스 main623afa6까지의16개 후속 커밋에는 scoped read v3–v5, 쓰기 v1,
원래 접수 복구·현재 읽기 증거·원자적 정산·gateway의 현재 권한 검증이 추가됐다.
별도 개발 브랜치에서 이 변경과 기존 차단/취소 수정을 병합하여 검증 중이다.
새 계약4개의 provider 바이트 일치와 양쪽 기존 migration 바이트 보존을 확인했다.

실제 병합 빌드와 별도 MCP·TLS·gateway·provider CLI를 연결한 격리 인수는
정상 accepted→proved, 접수 중 철회 거부, 실행 전 철회/세션 만료 failed를 확인했다.
이는 승인된 scoped 요청의 전송·처리 증거다. 운영 계정이나 task 원본 삭제 인수가 아니다.
receipt: shared QA cache scoped-merged-mcp-acceptance.json.

provider 후속 검사 HEAD07e59ec9df81dffdd4d65ed5a133ce5764958110의
sb/scoped_write_request.py는 source_request를 기존 parse_request_v3로 검증한다.
명시된 V4 최상위 키에도 task/run/completion 출처 관계 필드는 없다. 따라서 이
통합만으로 본 문서의 작업 원본→파생 기억 삭제 전파 재개 조건은 충족되지 않는다.
collect-task 보류를 유지하며 provider 작업공간의 진행 중인 구현은 변경하지 않는다.

## 2026-09-10 KST 제공자 재확인

제공자 HEAD `79ec701864227dc3cdff42c12eff06d849322e54`에서
`sb/mcp_remember_models.py`와 `sb/scoped_write_request.py`의 미커밋 변경은 0개다.
기존 기억 V3 모델은 여전히 extra=forbid이며 scoped 요청의 source_request는
parse_request_v3로 검증한다. 확인한 두 소스와 second-brain 계약 파일에서는
source_lineage/task_lineage/completion_id 필드를 찾지 못했다.
이 읽기 전용 소스 확인으로 기존 자동 수집 보류를 해제하지 않는다.
제공자 호출·운영 배포 검증은 수행하지 않았다. 시각·HEAD·파일 SHA256 근거:
`/home/jm/.cache/jarvis-test-runtime-qa-20260908/task-memory-hold-provider-recheck.json`.


## 2026-09-10 KST 제공자 후속 변경 대조

제공자 HEAD `a2861f38a82cb5ea1e00de7ed9e0c1e3982c7b37`를 확인했다. 기존 확인 뒤 제공자 커밋이 이동했으나
sb/mcp_remember_models.py와 sb/scoped_write_request.py의 SHA256은 이전79ec701
확인값과 각각 동일했다. 추가 확인한 sb/write_request_values.py를 포함한3파일의
미커밋 변경0개다. parse_request_v3는 ROOT_KEYS에 body_profile을 추가한 키 집합만
받고, scoped source_request는 여전히 이 파서를 사용한다. 기억 V3 모델도 extra=forbid다.

이 증거로 본 문서의 원본 task→candidate→provider record 및 삭제 전파 재개 조건이
충족됐다고 판단할 수 없다. 자동 collect-task 보류 유지. 제공자 검색 성능 변경을
출처 계약 지원으로 간주하지 않는다. 제공자 소스 수정·API 호출·배포는 수행하지 않았다.
기계적 근거: /home/jm/.cache/jarvis-test-runtime-qa-20260908/task-memory-provider-a2861f3.json.

다음 제공자 연동 검증은 새 버전의 명시적 출처 관계와 삭제·복원 전파 계약이
제시되면 수행한다. 현재 기억 저장 요청에 임의 필드를 추가하거나 요약 본문에
출처를 숨겨 넣어 자동 수집을 우회하지 않는다. 다른 자비스 개발 범위는 유지한다.


## 착수 지점 조사 — 2026-09-11

두 P1이 왜 같은 뿌리인지 코드에서 확인했다. **기억 후보 계약에 task 출처가 존재하지 않는다.**

- `src/memory-candidate-types.ts:15-18` `MEMORY_CANDIDATE_REF_NAMESPACES` =
  `control_command`, `control_receipt`, `verification_authority`, `verification_artifact`,
  `inference_evidence`, `memory_candidate`, `second_brain_conflict`, `rejected_input`.
  **task 네임스페이스가 없다.**
- `MemoryCandidateSourceMetadata`(같은 파일)는 `request_id`, `receipt_id`, `outcome_id`,
  `attempt_id`, `instruction_id`, `verification_evidence_id`를 갖지만 `task_id`가 없다.
- 접수 경로 `src/cli-memory-intake.ts:41-64`는 입력 문서와 정책 문서만 받고 task 식별자를 요구하지
  않는다. 따라서 “수집 전 task_id 차단”은 검사를 추가하는 문제가 아니라 **결속을 만드는 문제**다.
- 소비 경로 `src/dashboard/memory-candidate-review.ts:12`는 `isProjectionIdSuppressed(candidateId)`만
  본다. 원본 task가 차단돼도 후보 자체가 차단되지 않았으면 열람된다.
- 차단 판정 자체는 이미 있다: `TaskTimelineSummaryReader.isSuppressed`
  (`src/task-timeline-summary.ts:44-45`) → `TaskTimelinePopulation.isSuppressed`
  (`src/task-timeline-population.ts:136`).

그러므로 다음 작업 순서는 이렇게 고정한다.

1. 후보가 원본 task를 기록할 자리를 만든다. 네임스페이스 추가는 닫힌 계약 변경이고 identity/source
   digest 도메인(`MEMORY_CANDIDATE_DIGEST_DOMAINS`)에 영향을 주므로, 새 migration과 digest 호환
   규칙을 함께 설계한다. 기존 배포 migration 바이트는 건드리지 않는다.
2. 접수 시 그 task의 `isSuppressed`를 검사한다. request/run/completion만 검사하는 현재 판정을
   대체하는 것이 아니라 **추가**한다.
3. 소비 5지점(검토 열람, 소유자 결정, 승인 명령 실행 직전, dispatch 직전, 전송 중)에서 후보의 task
   출처 차단을 다시 검사한다. 화면에서 숨기는 것으로 대체하지 않는다.
4. 저장 후 삭제·재색인·백업 복원에서 파생 기억의 tombstone이 유지되는지 검증한다. 직접 MCP 클라이언트
   2개 확인은 provider 측 계약이 필요하므로 그 부분만 외부 의존으로 남는다.

### 배제한 우회로 (같은 날 확인)

“기존 열로 task에 닿을 수 있으니 계약 변경 없이 소비측만 고치면 된다”는 우회로를 먼저 검토하고
배제했다. 근거는 다음과 같다.

- `memory_candidate_classifications.control_request_id`(`migrations/038:47`)는 존재하고,
  `control_command_requests.target_json`의 `$.task_id`는 실제로 색인돼 있다
  (`migrations/079_task_execution_read_indexes.sql:8`). 여기까지는 경로가 있어 보인다.
- 그러나 기억 후보가 만드는 control command의 target은 `{candidate_id, correlation_id}`다
  (`tests/fixtures/memory-candidate-store.ts`의 instruction/decision seed). 즉 이 action에서
  `target_json`에는 `task_id`가 **없다**.
- 따라서 `control_request_id`를 따라가도 원본 task에 도달하지 못한다. `$.task_id` 색인은 task 실행
  계열 action을 위한 것이고 기억 후보 계열과는 다른 요청이다.

결론은 바뀌지 않는다: 위 1단계(후보가 원본 task를 기록할 자리를 만들고 digest 호환을 설계)를 건너뛸 수
있는 경로는 현재 스키마에 없다.

### 제외 프로젝트(§8.2.3)가 왜 설계 결정인지 — 2026-09-11

네 층위에서 확인했고, 어디에도 프로젝트 정체성이 없다.

| 확인한 곳 | 결과 |
|---|---|
| `MEMORY_CANDIDATE_REF_NAMESPACES` (`src/memory-candidate-types.ts:15-18`) | control/verification/inference/memory/conflict/rejected 뿐. project 없음 |
| `MemoryCandidateSourceMetadata` (같은 파일) | request/receipt/outcome/attempt/instruction/verification 식별자뿐. project 없음 |
| `work_items` (`migrations/001_authority.sql:4`) | `scope_json`·`forbidden_json`은 있으나 project 열은 없음 |
| Personal OS 정책 (`config/personal-os-policy.json`, `src/personal-os-policy.ts`) | purposes·sensitivity_tiers·actions·retention·quiet_hours·**prohibited_fields**. 제외는 **내용 필드 단위**이고 프로젝트 단위가 아님 |

따라서 “제외 프로젝트를 접수와 소비 양쪽에서 검사”하려면 먼저 **프로젝트 정체성을 어디에 둘지** 정해야
한다. 후보가 지목할 수 있는 선택지는 최소 세 가지이고 결과가 서로 다르다.

1. task 쪽에 두기: `work_items.scope_json`에서 저장소를 파생. 기존 JSON 형태에 의존하며 task가
   저장소를 명시하지 않는 경로에서는 성립하지 않는다.
2. 정책 쪽에 두기: `personal-os-policy-v2`에 `excluded_projects`를 추가. 운영 설정 문서의 스키마
   변경이며, 후보가 프로젝트를 지목할 방법은 여전히 필요하다.
3. 결속 쪽에 두기: `memory_candidate_task_sources`에 project 열을 더하고 접수 때 호출자가 제공.
   가장 작지만 프로젝트 taxonomy를 호출자에게 위임한다.

세 선택지는 운영 문서·CLI 계약·검사 지점이 전부 달라지므로, 추측으로 닫힌 계약을 바꾸지 않았다.
`hide(task)` 경로는 이미 동작하므로 프로젝트 단위 차단이 시급하면 그 프로젝트의 task들을 숨기는 것이
현재 가능한 조치다.

### 저장분 철회가 어디에서 멈추는가 — 2026-09-11

철회의 준비 지점은 `MemoryDeletionSaga.prepare(input)`이며, 이 함수는 **소유자 승인용
`ControlCommandRequestInput`을 반환한다**(`src/memory-deletion-saga.ts`). 즉 준비는 JARVIS,
승인은 소유자라는 경계가 이미 코드에 있다.

문제는 그 입력의 `targets: ResolvedMemoryTargetV2[]`다. 이 계약이 요구하는 필드와 authority DB의
`memory_resolved_target_metadata`(`migrations/040:50-66`)가 담는 필드를 대조하면 다음이 **없다**.

| `ResolvedMemoryTargetV2` 필드 | authority DB에 있는가 |
|---|---|
| `target_id`, `target_digest`, `provider_instance_id` | 있음 |
| `generation_id`, `generation_manifest_digest`, `page_content_digest` | 있음 |
| `source_identity_full`, `content_identity_full`, `citation_identity_full` | 있음(digest 열) |
| `sensitivity`, `source_owner_class`, `source_owner_id_digest`, `resolved_at`, `expires_at` | 있음 |
| **`vault_head`, `vault_tree`** | **없음** |
| **`page_id`, `page_blob_oid`** | **없음** |
| **`citation_span_start`, `citation_span_end`** | **없음** |
| **`valid_from`, `valid_until`** | **없음** |
| `subject_digest` | `keyed_subject_digest`로 이름이 다름 |

없는 값들은 provider가 **지금** 해당 기록이 어디에 있는지 되짚어줘야 나오는 것들이다(vault head/tree와
page blob oid는 provider 저장소의 현재 상태이고, citation span은 그 페이지 안의 위치다). 따라서
“이미 저장된 파생 기억의 철회”는 provider에 재해석을 요청하는 단계가 선행되어야 하며, 그 요청은
refresh receipt와 마찬가지로 아직 계약이 없다.

JARVIS 측에서 이번에 끝낸 것은 그 앞까지다: 어떤 후보가 어떤 task에서 나왔고, 아직 suppression이 없고,
어느 `target_id`/`target_digest`를 겨냥해야 하는지(`memoriesAwaitingTaskWithdrawal`). 남은 것은
provider 재해석 계약과 그 응답을 위 타입으로 옮기는 어댑터이며, 후자는 전자 없이는 실행해볼 수 없다.

### 저장분 철회가 실제로 동작한다 — 2026-09-15

위 2026-09-11 항목의 "provider 재해석 계약이 없다"는 결론은 **사실이 아니었다**. 재확인한 결과 provider는
이미 그 읽기를 구현하고 있고 frozen 계약에 선언되어 있다. 따라서 이번에 provider 변경은 없다.

| 확인한 곳 | 결과 |
|---|---|
| `contracts/second-brain-mcp-v5.json`(`schema_version` 7)의 `tools.sb_resolve_memory_target` | 선언되어 있음. 요청 `record_id`/`record_digest`/`generation_id`/`generation_manifest_digest`(+선택 `read_fence`), `additionalProperties:false` |
| 같은 항목의 `happy.raw_response` | `vault_head`·`vault_tree`·`page_id`·`page_blob_oid`·`citation_span_start`/`_end`·`valid_from`/`valid_until` 포함 24개 필드 전부 |
| provider `sb/targets.py:resolve_memory_target` | 위 필드를 커밋된 blob에서 계산하고 `target_digest`가 전부를 묶음 |
| provider `sb/mcp.py:1149` | 계약 profile ≥4면 `sb_resolve_memory_record`, 그 이하면 page/exact_record 선택자를 같은 도구 이름으로 노출 |

즉 공백은 provider 쪽이 아니라 **자비스 쪽에 그 읽기를 호출하는 제품 경로가 없었다는 것**이었다.
`SecondBrainEffectService.resolveTarget`은 이미 있었지만 호출자는 테스트뿐이었다.

이번에 닫은 것:

- `MemoryWithdrawalEffect`(`src/memory-withdrawal-effect.ts`)가 `memoriesAwaitingTaskWithdrawal`의 각
  항목에 대해 정착된 outbox 행의 목적지(`expected_page_id`/`expected_sid`)를 읽고, 기존 bounded read로
  그 레코드를 찾아, provider 읽기로 target을 다시 해석한다. 실패는 전부 닫는 방향이다: 기록된
  `target_id`/`target_digest`와 다르면 거부(페이지가 변한 경우도 같은 검사로 거부된다), 후보의 source
  identity가 아니면 거부, 읽은 레코드의 content/citation identity와 다르면 거부, 만료면 거부, 계약에 없는
  필드는 공용 target 파서가 먼저 거부한다.
- 준비는 기존 `MemoryDeletionSaga.prepare()`(또는 `MemoryLifecycleService.prepareDeletion`)로 넘긴다.
  scope는 target에서 파생하며 새 승인 체계나 provider 삭제 합성은 없다.
- `memoriesAwaitingTaskWithdrawal`이 완료된 철회를 목록에서 빼도록 고쳤다. 기존 content identity 비교는
  provider가 레코드 본문으로 계산하는 값과 이 DB가 후보 재료로 계산하는 값이 달라 절대 맞지 않았다.
  연결되는 것은 쓰기가 실어 보낸 source identity다.
- CLI: `memory withdrawals`(DB만 읽음), `memory withdraw-prepare <candidate-id>`.

회귀: `tests/integration/memory-withdrawal-effect.test.ts`. 숨긴 task → 실제 정착된 저장분 → 재해석 →
준비 → 서명 receipt 승인 → 실제 deletion saga dispatch → 목록이 빈다. 음성: 다른 target 거부, 페이지 변경
후 거부, 계약 외 필드 거부, 승인 철회 시 dispatch 0.

남은 외부 항목은 provider 증명 관측(`observer.deletion`)이며, 이는 철회 준비·승인·전송과 별개의 기존
잔여다. 운영 배포·push는 하지 않았다.
