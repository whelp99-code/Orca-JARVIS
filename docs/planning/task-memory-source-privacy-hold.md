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
