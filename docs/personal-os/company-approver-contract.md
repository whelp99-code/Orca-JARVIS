# 회사 승인자 공통 계약 v2

상태: **개발 구현 계약·TEST_ONLY fixture, 운영 승인·실행 활성화 금지**.
TASK-COMPANY-CONTRACT-FIXTURE-20261015 / attempt=a2468740-3266-4957-89ae-8161d60d12eb.
근거: [닫힌 설계 #88, 9fa2f0d](https://github.com/whelp99-code/Orca-JARVIS/blob/9fa2f0d9dc647ee1d3a8dad2626e41900e8dc32e/docs/personal-os/company-owner-approver-design.md).
기존 human wire는 유지한다. 아래 7~8절은 승인된
TASK-COMPANY-FRESHNESS-PLAN-20261016의 DB 제공자·정책 경로를 추가한다.
SB/Python과 JARVIS/TS의 공통 wire이며 운영 배포·활성화의 증거가 아니다.
fixture는 `fixtures/company-approver/company-approver-v2.test-only.json` 한 개다.
두 진행 오류 응답 예시는 `unconfigured_progress_responses`, 명령 유효구간의 고정 시각
예시는 `command_validity`에 둔다. 이 시험 metadata는 command나 서명 대상에 추가하지 않는다.

## 1. 값·직렬화·명령

모든 객체는 아래 열거한 필드만 허용하는 closed object다. 누락/unknown/중복 JSON key,
BOM/잘못된 UTF-8/단독 surrogate를 거절한다. 문자열은 NFC여야 하며 자동 정규화하지 않는다.
객체 key는 이 계약의 ASCII 이름만 사용한다. JSON 값은 null/bool/string/array/object와
`0..9007199254740991` 정수만 허용한다. 소수·지수 표기·음수·-0·NaN/Infinity는 금지한다.
`C(x)` = ASCII key 오름차순 재귀 정렬, array 순서 유지, 공백/마지막 LF 없는 JSON,
UTF-8 인코딩. 문자열은 JSON.stringify와 같은 escape(ensure_ascii=False), `/` 비escape다.
Python은 `json.dumps(x,ensure_ascii=False,sort_keys=True,separators=(",",":"),allow_nan=False)`.
TS는 `canonicalize(x)`다. profile 검증은 직렬화 전 필수이며 JSON 파일의 들여쓰기는 서명하지 않는다.
`H(b)="sha256:"+SHA256(b).hex()`; `D(s)=UTF8(s)+00`(정확히 NUL 한 byte).
digest/지문은 `sha256:<64 lowercase hex>`, 시각은 `YYYY-MM-DDTHH:mm:ss.sssZ` UTC다.

| 객체 | 필수 필드·조건 |
|---|---|
| binding | provider_instance_id, workspace_id(UUID), owner, processor_principal_id, approver_principal_id, approval_policy_version(양의 정수), wire_revision=2, approver_keys |
| approver_keys 원소 | key_id, algorithm="Ed25519", purpose="decision", public_key_fingerprint=H(DER SPKI bytes). key_id 순 정렬, ID·지문 각각 중복 금지 |
| target | provider_instance_id, workspace_id, candidate_id(NFC 비제어문자, 1..2048자), content_digest |
| args | owner, projects(ASCII ID 정렬·중복0·최대128), policy_revision, deletion_sequence, deletion_set_root, processor_principal_id, operations=["accept","reject","mark_processed"], approver_principal_id, approval_policy_version, approval_binding_digest |
| command | schema_version=2, request_id, action="company.candidate.transition", action_level=3, target, args, reversible=false, requested_by, requested_at, expires_at, nonce |

ID는 ASCII `[A-Za-z0-9][A-Za-z0-9._:-]{0,255}`(candidate/UUID/request_id 제외).
binding의 scope/owner/processor/approver/version과 args/target 복사본은 고정 등록과 같아야 한다.
approver != owner/processor, owner != processor; requested_by=args.owner를 유지한다.
대표/Mail/processor key ID와 material은 분리한다. 요청 복사본은 권한 원본이 아니다.
`binding_digest=H(D("second-brain/company-approval-binding/v1")+C(binding))`.
`handoff_key="company-handoff:v2:"+SHA256(D("second-brain/company-handoff/v2")+C({target,args})).hex()`.
`request_id=handoff_key+":"+generation`(양의 safe integer 십진수, 선행0 없음), nonce=request_id.
같은 handoff_key의 새 명령 generation은 보존한 최고 generation보다 엄격히 커야 하며
재사용/감소를 금지한다. 같은 request_id의 동일 bytes 재조회는 새 generation 발급이
아니다. 같은 ID로 시간 등 bytes를 바꾸면 replay conflict다. 증가만으로 terminal 상태나
미확정 작업을 재실행할 권한이 생기지 않는다.
명령 TTL은 정확히24시간이며 권한 행사 시 `requested_at <= 현재시각 < expires_at`도
별도로 검사한다. 시작 시각은 포함하고 만료 시각은 제외하며, 미래 시작/만료 명령은
24시간 길이가 맞아도 거절한다. C1~C4는 주입된 현재시각으로 이 구간을 다시 검사한다.
`command_digest=H(C(command))`; state/command_digest를 command에 넣지 않는다.
다른 action은 v1 그대로이며 과거 회사 v1 읽기와 새 v2 mutation 권한을 혼동하지 않는다.

## 2. 대표 승인 서명은 봉투 v1 유지

unsigned approval 필드: schema_version=1, receipt_id, request_id, decision="approve"|"reject",
command_digest, signer_principal_id, authenticated_session_id, key_id, algorithm="Ed25519",
issued_at, not_before, expires_at, nonce, max_uses=1, status="issued".
실제 서명 대상은 **`D("orca-jarvis/command-approval/v1")+C(unsigned_approval)`**다.
Ed25519 pure 모드(no prehash)로 서명한다. signature는 64byte 서명의 padding 없는 base64url(86자)다.
approval=unsigned 필드+signature. command 직접 서명/이중 hash/문자열 hex 서명은 금지한다.
receipt의 command_digest가 새 command2 전체를 묶는다. 옛 command1 receipt 이식은 거절한다.
`approval.request_id == command.request_id`도 필수다. 올바른 command_digest와 유효한
서명이 있어도 다른 request_id의 approval은 거절한다. fixture의 음성 예시는
의도적으로 test key로 다시 서명한 불일치 receipt다.
issued_at <= not_before <= 현재 < expires_at, 수명 최대30분, command TTL도 별도 검사한다.
이 회사 전용 30분 계약은 일반 명령의 15분 상한 및 `external.delegate`의 30분 상한과 구분한다.
검증 시 action은 저장·검증된 command에서 전달하며, 생략한 일반 검증은 15분 상한으로 거절한다.
C1은 approve/reject **기록 전** 실제 key principal/ID/purpose/SPKI와 고정 binding,
서명·시간·폐기·최신성을 검증한다. 실패 시 pending 유지·receipt/이벤트/상환0.
C2/C3/C4도 현재 pin/폐기/최신성을 다시 확인한다. 서명이 맞는 것만으로 허가하지 않는다.

C1은 제공자 호출 전에 원래 서명 receipt 전체를 `company_decision_receipt_intents`에
영속화한다. receipt 기록 트랜잭션 실패 후 inbox의 새 WebAuthn challenge를 통과한
같은 결정·command·현재 signer만 이 원본을 재사용한다. 새 receipt/nonce로 예약을
갈아끼우지 않는다. 원래 서명·만료·키·binding·폐기는 매번 다시 검증한다.
제공자 I/O 동안 결정 claim은 시간만으로 만료하거나 다른 호출자에게 넘어가지 않는다.
살아 있는 호출자는 finally에서 자기 token만 해제한다. 프로세스 crash 뒤 남은 claim은
자동 lease-steal 대상이 아니며 미확정 상태로 보존한다. 증명된 취소·진행 종결이나
별도 승인된 운영 복구 없이 token을 지우거나 provider mutation을 재전송하지 않는다.

## 3. accept/reject 원본 receipt 읽기

processor 전용 operation=`read_transition_receipt`, purpose=`company_memory_receipt_read`.
요청은 `{authority,arguments:Q}`. Q는 candidate_id, handoff_id(전체 command.request_id),
operation="accept"|"reject", transition_request_digest, command_digest, content_digest,
approval_policy_version, approval_binding_digest를 가진다. scope는 authority에서 고정한다.
transition_request_digest는 보존한 **원래** accept/reject arguments(approval 포함)의 요청 hash다.
두 operation의 arguments는 각각 정확히 `{candidate_id,handoff_id,approval}`인 closed
object다. candidate_id는 command.target.candidate_id, handoff_id는 command.request_id,
approval은 2절 봉투 전체이며 signature도 포함한다. accept는 decision="approve",
reject는 decision="reject"만 허용한다. 누락/추가 필드와 반대 결정은 거절하며, 시간이나
별도 transition 필드를 더하지 않는다. 두 경우 모두 approval.request_id/command_digest를
원래 command와 대조한다. fixture `transition_request_vectors`에 두 arguments 전체,
`C({operation,arguments})`의 UTF-8 hex와 domain 포함 최종 digest를 고정한다.
정확히 `H(D("second-brain/company-memory-request/v1")+C({operation:Q.operation,arguments:original_arguments}))`.
조회 hash는 `H(D("second-brain/company-memory-request/v1")+C({operation:"read_transition_receipt",arguments:Q}))`.
authority v1은 provider_instance_id/workspace_id/principal_id/agent_id/session_id/projects/
policy_revision/deletion_sequence/deletion_set_root/purpose/operation/request_digest/
issued_at/expires_at/nonce/signing_key_id/schema_version=1 및 signature를 갖는다.
기존 `D("second-brain/company-memory-authority/v1")+C(unsigned_authority)` 서명, TTL<=60초,
새 nonce를 사용한다. principal_id는 고정 processor, 만료된 mutation authority 재전송 금지.

정상 응답 필드: schema_version=2, provider_instance_id, workspace_id, selector=Q,
lookup_nonce=authority.nonce, lookup_request_digest=authority.request_digest,
outcome="found"|"not_found"|"evidence_absent", receipt.
found의 receipt는 receipt_id, receipt_digest, operation, state, handoff_id,
receipt_created_at, decision_at, accepted_at을 가진다. accept는 state="accepted",
accepted_at=원본 snapshot 시각; reject는 state="rejected", accepted_at=null,
decision_at=원래 reject 결정 시각이다. decision_at은 원래 결정의 불변 기록이다.
원본 시각이 없으면 evidence_absent/receipt=null이며 현재/issued_at/상환/created_at으로 추정하지 않는다.
not_found는 인증된 정확 조회에 행이 없는 경우만, receipt=null. unknown/timeout은 not_found 아님.
SB는 전체 저장 receipt hash·원래 decision/request를 검증 후 본문 없는 projection만 반환한다.
클라이언트는 축약 projection으로 전체 hash를 재계산했다고 주장하지 않는다.
고정 broker/peer·경로 소유/권한이 검증된 인증 채널 필수; nonce/hash echo 자체는 인증이 아니다.
읽기는 초기화/receipt 생성/accept/reject/상환/등록/삭제를 하지 않는다. reject found는 로컬 거절
증거만 복구하며 mark_processed하지 않는다. 부재/불확실을 성공/재전송 허가로 바꾸지 않는다.

## 4. completion verifier v2

운영자 고정 config=`{schema_version:2,executable,args}`(절대 trusted path, args<=16, private0600).
stdin은 `C({schema_version:2,command,acceptance})` 후 EOF. acceptance는 원래 검증된 SB
5필드 `{receipt_id,receipt_digest,operation:"accept",state:"accepted",handoff_id}`다.
stdout은 로그·추가 객체 없는 `{schema_version:2,state:"completed",request_id,command_digest,
candidate_id,content_digest,acceptance_receipt_digest,effect_digest}`.
모든 ID/hash를 원래 command/acceptance 및 독립 효과 증거와 대조한다. v1 fallback 없음.
shell:false/최소env/10초-SIGKILL/1MiB/stdin 실패 kill·lease 해제 유지.
효과는 request_id+command_digest 기반 멱등 처리, exit0/입력 echo만으로 완료하지 않는다.
완전한 결과 저장·현재 guard 확인 뒤에만 mark_processed, accept만으로 완료 아님.

## 5. 외부 최신성 제공자: 저장소 중립, 준비 전 비활성

이 절은 저장소 중립 인터페이스다. 기본값은 **미설정·항상 거절**이다.
`{schema_version:2,kind:"unconfigured"}`와 7절의 명시적 `sb_company_db` 설정만 허용하며,
등록/환경변수/TEST_ONLY 플래그로 준비 상태를 우회하지 않는다.
unconfigured의 read_freshness는 요청 scope/challenge를 그대로 돌려주되
`status:"unavailable",checkpoint:null`이다. reserve_progress/finish_progress는 항상
`{schema_version:2,outcome:"error",code:"COMPANY_FRESHNESS_REQUIRED"}`를 반환하고 기록/효과0.
ready/예약 성공/정상 완료를 반환하지 않는다. fixture에 config와 정확한 거절값을 고정했다.
아래 최신성·진행 조건은 인터페이스의 요구다. 아래 시험 전용 모델을 운영에 연결하지 않는다.
동일 호스트/동일 backup의 enabled 플래그·서로 같은 옛 DB·자체 hash chain은 독립 근거가 아니다.
scope=`{provider_instance_id,workspace_id}`. checkpoint는 아래 closed object다.
`{operational_epoch,approval_policy_version,approval_binding_digest,revocation_sequence,
revocation_root,stores:{jarvis:P,second_brain:P},intent_sequence,intent_root}`.
P=`{receipt_sequence,receipt_root,terminal_sequence,terminal_root,deletion_sequence,deletion_root}`.
sequence는 비감소 safe integer, root는 prefix 전체의 digest다. epoch는 양의 단조 정수다.
receipt에는 accept/reject/mark_processed 원본, terminal에는 최종 receipt/효과 완료,
deletion에는 삭제 intent·진행·완료/tombstone을 포함하며 소실된 사실을 재생성하지 않는다.
같은 sequence/다른 root, 더 낮은 sequence/epoch, 없는 prefix는 거절한다.

제공자는 복원 대상 밖의 고정 신뢰 registry가 scope별 **최신 epoch와 단조 head**를 선택해야 한다.
클라이언트의 epoch/경로/정렬 결과/복원된 config로 최신 값을 고르지 않는다.
epoch 전환은 별도 운영 승인·이전 head 연결·모든 폐기/진행/미확정 intent 보존을 요구하며,
새 epoch가 중복 방지 기록을 초기화해서는 안 된다. 관리자의 삭제/교체/우회도 위협에 포함한다.
무결성 hash/보존된 옛 객체만으로 최신성을 주장하지 않는다. 인증된 고정 제공자 채널과
fresh challenge 응답, rollback 불가능한 현재 head 선택·CAS의 보장이 필요하다.
그 보장을 검증할 수 없는 구현은 ready를 반환하거나 운영을 열 수 없다.

| 인터페이스 | 필수 입력 -> 응답 및 효과 |
|---|---|
| read_freshness | `{schema_version:2,scope,installation_id,challenge,observed_checkpoint}` -> `{schema_version:2,scope,challenge,status:"ready"|"mismatch"|"unavailable"|"uncertain",checkpoint}`. ready만 최신 checkpoint, 나머지는 checkpoint=null. observed는 비교값일 뿐 최신 선택권 없음 |
| reserve_progress | `{schema_version:2,scope,operation_id,operation,expected_checkpoint,event_digest,challenge}` -> `{schema_version:2,scope,challenge,outcome:"reserved"|"already_reserved"|"conflict",checkpoint,reservation_id}` **또는** `CompanyFreshnessRequiredError`. 현재 head에 CAS하여 영구 intent를 **효과 전** append, 원자적 one-winner; 재호출은 실행 권한 재발급 아님 |
| finish_progress | `{schema_version:2,scope,operation_id,reservation_id,expected_checkpoint,evidence_digest,terminal_state,challenge}` -> `{schema_version:2,scope,challenge,outcome:"recorded"|"already_recorded"|"conflict",checkpoint}` **또는** `CompanyFreshnessRequiredError`. 원래 사실/진행만 추가, 모순 결과 덮어쓰기 금지 |

`CompanyFreshnessRequiredError`는 closed object
`{schema_version:2,outcome:"error",code:"COMPANY_FRESHNESS_REQUIRED"}`다.
두 진행 응답은 정상/CAS 분기와 이 오류 분기의 명시적 합집합이다. 오류에는
scope/challenge/checkpoint/reservation_id를 요구하거나 추가하지 않는다.
소비자는 이 유효한 오류를 COMPANY_CONTRACT_INVALID로 바꾸지 않고 원래 코드를
유지하며, 예약·완료로 취급하거나 후속 효과를 실행하지 않는다.

진행 기록의 operation은 decide_approve/decide_reject/accept/reject/complete/mark_processed/delete다.
C1 결정·SB 전이·verifier 효과는 서로 다른 operation이며 호출 경계가 고정한다.
terminal_state의 closed enum은 approved/rejected/accepted/completed/processed_complete/deleted/cancelled다.
finish는 호출자가 보낸 operation을 믿지 않고 원래 reservation의 operation을 사용한다.

| 예약 operation | 허용하는 terminal_state |
|---|---|
| decide_approve | approved 또는 증명된 cancelled |
| decide_reject | rejected 또는 증명된 cancelled |
| accept | accepted |
| reject | rejected |
| complete | completed |
| mark_processed | processed_complete |
| delete | deleted |

enum 밖 값은 COMPANY_CONTRACT_INVALID다. enum 안이지만 위 대응과 다르면
finish는 conflict/checkpoint=null이며 기록/head를 바꾸지 않는다. cancelled는 실제
`control_command_revocations`의 request/command 및 정규화한 payload와 `payload_digest`가 일치하고
effect가 실행되지 않은 결정 예약에만 허용한다. JARVIS는 cancelled 상태와 execution fence 0,
`control_command_redemptions`의 부재를 함께 확인한다. 회사 실행은 별도 redemption을 사용하므로
일반 fence 0만으로 미실행을 증명하지 않는다. 이미 redeem된 요청은 실행 결과가 불명확한
상태로 남기며 진행 중인 회사 실행 lease를 해제하지 않는다. lease 해제도 이 조건을 원자적으로
확인하며, 기존 receipt가 있다면 원래 예약의 decision/event와 일치하는 사실만 보존한다.
cancelled는 승인·거절 receipt나 effect를 새로 만드는 값이 아니다. 같은 원래 예약을
종결한 provider ACK/checkpoint를 영속화한 뒤에만 workspace fence를 해제한다.
예약/intent는 삭제하지 않으며, ACK 유실은 같은 증거로 재시도한다. 원 요청의 철회는 유지한다.
SB provider와 JARVIS는 같은 계약을 채택하며, SB PR84의 채택은 운영 배포 선행조건이다.
unknown 값이나 증거 불일치로 예약을 풀지 않는다. uncertain/failed는
완료 상태가 아니며 미확정 예약을 finish로 없애는 데 쓰지 않는다.
`operation_id=H(D("second-brain/company-operation/v1")+C({scope,request_id,command_digest,operation}))`.
삭제는 같은 domain의 `C({scope,deletion_plan_digest,operation:"delete"})`다.
**epoch/재시도 시각을 넣어 다른 일로 만들지 않는다**.
reserved/already_reserved의 checkpoint와 reservation_id는 원래 durable 기록을 반환한다.
reserve의 conflict는 checkpoint/reservation_id=null, finish의 conflict는 checkpoint=null이다.
어느 conflict도 실행 허가가 아니며 finish 응답에 reservation_id를 추가하지 않는다.
순서: 최신성 검사 -> 독립 reserve_progress durable ack -> 한 번의 효과/불변 로컬 receipt ->
독립 finish_progress durable ack -> 정상 완료 응답. 둘의 DB에 공통 ACID가 있다고 가정하지 않는다.
reservation은 지워지거나 TTL로 자동 해제되지 않고 이전 epoch/복원 후에도 중복을 막는다.
이미 reserved/완료인 작업에는 effect 호출 권한을 다시 주지 않는다. 효과 수신자도 같은
operation_id로 dedup하거나, 재실행 없이 독립 조회로 결과를 증명할 수 있어야 한다.
효과 성공 뒤 외부 finish가 실패하거나 응답이 유실되면 durable intent와 **uncertain**을 유지한다.
로컬 DB에 기록이 없어도 재실행하지 않는다. 실제 원본 receipt/효과를 읽어 조정할 수
없으면 격리·비활성, 재활성화/복구 구현은 오모냥 담당 별도 과제다.
미확정 intent/관련 terminal·삭제 기록은 복원 가능한 backup보다 먼저 만료/삭제할 수 없다.

시작과 매 C1~C4는 정책/키 **및** 해당 store의 receipt/terminal/삭제 진행과 intent를 대조한다.
복원됐거나 증명 불가/오류/불일치/미확정이면 회사 승인·실행은 계속 비활성이다.
receipt-only 읽기는 별도 현재 권한 확인 아래 가능하며 mutation으로 승격하지 않는다.
ready는 운영 활성화 승인이 아니다. 대표의 별도 승인·운영자 검증과 후속 복구 과제가
없으면 재활성화하지 않는다. 이 계약·fixture·제공자 후보 조사는 운영 준비 증명이 아니다.

### TEST_ONLY 메모리 제공자: 성공 경로 시험 전용

논리 구현체 `TEST_ONLY_memory`는 시험 코드에서만 생성·불러오기·주입한다.
factory 입력은 `{scope,initial_checkpoint}`이며 복제한 초기 head와 operation별 map을 가진다.
제품 export/registry/CLI/env/운영 config로 선택할 수 없다. `TEST_ONLY_memory` 또는
테스트 플래그로 `unconfigured`/7절의 보호 경로를 우회하면 계약 오류다.
휘발성 메모리는 독립 저장·현재성·복구/운영 준비의 증거가 아니다.

- read_freshness: 고정 scope 검증 후 challenge를 echo. 미완료 reservation이 하나라도
  있으면 observed_checkpoint가 head와 같아도 uncertain+checkpoint=null이다.
  미완료 예약이 없을 때만 head 일치면 ready+checkpoint 복사본, 아니면 mismatch/null.
- reserve_progress: 같은 operation_id의 operation/event_digest/원래 expected_checkpoint가
  모두 같으면 이미 기록한 reservation_id/checkpoint로 already_reserved.
  다른 내용의 같은 ID, 또는 신규 ID의 expected_checkpoint가 현재 head와 다르면
  conflict+checkpoint=null+reservation_id=null. 신규 일치 요청만 원자적 CAS로
  reserved 기록+head를 갱신한다. 같은 head에 동시 신규 요청은 승자 정확히 하나다.
- finish_progress: 원래 reservation_id가 필요하다. 최초 일치 expected_checkpoint만
  원자적 CAS로 recorded. 완료 후 같은 evidence_digest/terminal_state/원래 finish
  expected_checkpoint면 already_recorded+원래 완료 checkpoint; 내용/예약/현재 head
  불일치는 conflict+checkpoint=null. 이미 완료한 내용을 덮거나 효과를 호출하지 않는다.
  서로 다른 예약의 같은 head 동시 finish도 승자 하나다. scope 불일치는 계약 오류다.
  위 operation별 terminal_state도 대조하며, 잘못된 상태는 예약을 완료하지 않는다.

시험 모델의 reservation_id는 `"reservation:TEST_ONLY:"+operation_id의 sha256: 뒤 64hex`.
reserve record는 `{operation_id,operation,event_digest,reservation_id,state:"reserved"}`,
finish record는 `{operation_id,reservation_id,evidence_digest,terminal_state,state:"finished"}`.
각 최초 성공만 intent_sequence를 1 늘리고
`intent_root=H(D("second-brain/TEST_ONLY-memory-progress/v1")+C({previous_root,sequence,record}))`
(sequence=새 intent_sequence)로 head를 갱신한다. 나머지 checkpoint 필드는 seed 그대로다.
재호출/conflict/read는 map/head를 바꾸지 않는다. fixture의 case 배열을 순서대로 독립
factory 한 개에 적용하면 ready/reserved/already_reserved/conflict/recorded/
already_recorded/uncertain/mismatch의 정확한 응답이 나온다. fixture는 reserve 직후 같은
checkpoint를 읽어도 uncertain인 경우와 해당 finish 후 다시 ready인 경우를 모두 고정한다.
이는 T7·T17·T11·T18 성공 경로에 주입할 시험 대역 계약이지 그 제품 통합 시험의 실행 결과가 아니다.

## 6. 오류와 미래 통합 시험

오류 wire는 `{schema_version:2,outcome:"error",code}`. 코드로 성공/자동 retry를 유도하지 않는다.
transport 실패/권한 실패/응답 불명을 합쳐 not_found로 처리하지 않는다.

| code | 의미 / 처리 |
|---|---|
| COMPANY_CONTRACT_INVALID | unknown/중복/누락/타입·정규화·canonical profile/version 오류, mutation0 |
| COMPANY_APPROVAL_INVALID | 서명·digest·purpose·principal·pin·시간 불일치, pending/receipt·이벤트0 |
| COMPANY_APPROVAL_REVOKED | 키/승인/binding 폐기, 키 폐기 rollback은 이 별도 경계로 차단 |
| ENROLLMENT_REQUIRED | 고정 등록 불일치/재활성화 미승인, 계속 비활성 |
| COMPANY_FRESHNESS_REQUIRED | 제공자 미준비/인증·현재성 증명 불가/읽기 실패, 시작/C1~C4 비활성 |
| COMPANY_OPERATIONAL_ROLLBACK | **정책·키가 같아도** epoch/receipt/terminal/삭제 진행이 외부보다 뒤이거나 root 불일치, 비활성·replay0 |
| COMPANY_PROGRESS_UNCERTAIN | 예약 이후 효과/외부 완료 여부 미확정, 재실행0·격리 |
| COMPANY_DUPLICATE_OPERATION | 이미 예약/완료된 operation_id, 원본 읽기만·효과0 |
| COMPANY_RECEIPT_EVIDENCE_ABSENT | 원본 receipt/결정 시각 부재·손상, 추정·blind resend0 |
| COMPANY_VERIFIER_INVALID | v1/오염·부분·과대 응답/잘못된 증거/exit·stdin·timeout, mark_processed0 |

1. F1: 양 언어가 fixture binding/command/unsigned approval canonical hex·hash·서명 bytes를
   같게 계산하고 실제 Ed25519 검증. 한 필드/서명/domain 변조는 실패.
   두 진행 응답 parser는 unconfigured의 정확한 오류 wire를 허용하되 정상/CAS 분기와
   혼합한 객체는 거절한다. 명령은 requested_at 직전/정각/만료 직전/정각/이후를 고정
   시각으로 시험해, 24시간 길이만 맞는 미래/만료 명령을 허용하지 않는다.
   유효하게 다시 서명한 request_id 불일치, 같은 handoff의 generation 재사용/감소,
   예약 operation과 terminal_state 불일치를 거절한다. head가 같은 미완료 예약에서도
   read_freshness는 uncertain/null이며, 완료 뒤에만 ready로 돌아오는지 시험한다.
2. F2(키 폐기 rollback): 키/정책 폐기 뒤 한쪽·양쪽 옛 DB/config 복원, C1~C4 승인·효과0.
3. F3([별도 P1 4278139710](https://github.com/whelp99-code/Orca-JARVIS/pull/88#discussion_r4278139710)):
   **binding/키/폐기 목록을 바꾸지 않고**, backup 뒤 accept·reject·완료·삭제를 각각 실행한
   뒤 양쪽 DB를 그 전으로 복원. 외부 epoch와 receipt/terminal/삭제 highwater 또는 intent가
   복원 상태와 달라야 하며 시작/C1~C4 비활성·기존 효과 재실행0·삭제 부활0.
4. F4: reserve 전 crash는 효과0; reserve ack 유실/효과 후 finish 실패/DB 복원은 미확정
   예약 보존·중복 효과0. 동시 동일 operation_id 승자1, epoch 교체 후에도 dedup 유지.
5. F5: 기준값 누락/옛 epoch 선택/옛 인증 응답 재생/admin 교체/불일치/timeout은 모두 비활성.
   unconfigured는 언제나 unavailable/거절·기록0·효과0이며 ready를 반환하지 않음.
6. F6: 실제 SB accept/reject commit 뒤 응답 유실→fresh readonly lookup, 원본 시각 복구,
   DB mutation0; not_found/불확실을 성공/재전송으로 바꾸지 않음.
7. F7: 실제 verifier child stdin2/EOF/stdout2→검증된 효과/mark_processed; v1·불완전 출력·
   timeout 거절, child 종료/lease 해제. 기존 T1~T18의 나머지 권한·scope 회귀도 유지.

F2~F7은 통합 인수 조건이며 최초 계약·fixture PR에서 실행한 시험이 아니다.
후속 구현의 실행 근거는 해당 PR의 정확한 head·시나리오·검증 장부로 구분한다.
fixture의 TEST_ONLY private key는 공개 시험 데이터다. 운영 registry/credential에 등록 금지.

## 7. SB 회사 DB 제공자와 JARVIS broker transport

세 freshness 메서드의 schema2, operation ID와 서명 domain은 바꾸지 않는다.
JARVIS 설정은 다음 strict union의 새 분기다. unknown kind/키는 거절한다.

```json
{
  "schema_version": 2,
  "kind": "sb_company_db",
  "client_config_file": "/var/lib/jarvis-svc/credentials/second-brain/company-freshness/client.json"
}
```

`loadCompanyFreshness(config, authorityDb)`는 검증된 JARVIS DB를 별도 내부 인자로 받는다.
이 인자는 SB 회사 DB 선택권이 아니다. DB 문맥 없이 만든 client는 읽기만 가능하며,
reserve/finish는 `COMPANY_FRESHNESS_REQUIRED`다. 설정만으로 DB·scope·epoch를 초기화하지 않는다.

client credential은 정확히 `{schema_version:2,role:"freshness",socket,signing_key_id,
signing_key_file,installation_id,context}`다. installation_id는 같은 SB registry의
설치 ID를 operator가 pin하며 caller 입력이 아니다. adapter는 read의 설치 ID를 이 값으로
고정한다. context는 provider_instance_id/workspace_id/principal_id/
agent_id/session_id/projects/policy_revision/deletion_sequence/deletion_set_root다.
principal은 `principal:jarvis-company-progress`, socket은 기존 processor broker의
`/run/sb-company-processor/broker.sock`이다. private dir0700/file0600, 소유권·신뢰 parent와
symlink 금지를 검사한다. progress key ID/material은 human/processor key와 분리한다.
기존 owner/processor credential을 progress로 해석하지 않는다.

동기 adapter는 고정 helper를 shell:false, 고정 argv, 최소 env,
10초 SIGKILL/출력1MiB로 실행한다. 세 메서드에 Promise를 반환하지 않는다.
helper는 기존 socket peer/경로 권한을 검사하고 다음 closed outer envelope만 보낸다.

```text
{schema_version:1,method,request,evidence,authority}
method = read_freshness | reserve_progress | finish_progress
read/reserve evidence = null
```

authority는 3절의 봉투1을 그대로 사용하되 purpose=`company_freshness_progress`,
operation=method, principal=고정 progress principal이다.
`request_digest=H(D("second-brain/company-freshness-request/v1")+C({method,request,evidence}))`.
서명은 기존 `D("second-brain/company-memory-authority/v1")+C(unsigned_authority)`이며
새 nonce/최대60초를 사용한다. nonce echo는 인증 채널의 대체물이 아니다.

기존 processor broker config schema1에 optional `freshness_config_file`을 고정한다.
없으면 route를 거절한다. 고정 dispatch는
`sb_company_bin freshness --config freshness_config_file`뿐이다.
요청의 argv/env/config/DB/registry/NV override를 받지 않는다. 기존 handoff/process
role과 human 봉투를 넓혀 자동 권한으로 해석하지 않는다.

### 실제 사실과 유일한 단계 소유자

| 단계 | reserve/finish 소유자 |
|---|---|
| decide_approve / decide_reject | JARVIS C1 |
| accept / reject / mark_processed | SB |
| complete | human은 JARVIS, auto_internal은 SB |
| delete | SB의 원래 승인된 삭제 경로 |

JARVIS는 새 kind에서 SB 단계를 다시 예약하지 않는다. 영구 peer-call marker를 먼저
커밋하고, 불확실한 전송은 원래 receipt의 fresh readonly 조회로만 복구한다.
3절 selector에 `operation:"mark_processed"`를 추가하며 원래 arguments는
`{candidate_id,handoff_id}`다. domain은 그대로다. found projection은
state=`processed_complete`, 원래 receipt_created_at/decision_at/accepted_at을 보존한다.
명령/승인이 만료돼도 새 효과 없이 원래 사실을 읽을 수 있으나 mutation 재전송은 금지한다.
기존 accept/reject arguments·canonical/signature vector는 그대로다.

로컬 outbox는 `jarvis_decision`의 원래 command2+대표 receipt 또는
`jarvis_completion`의 원래 command2+대표 approval+SB acceptance5+검증된 completion2와
해당 사실의 원래 커밋 시각 `original_at`을 보존한다.
finish wire evidence는 SB의 closed sidecar
`{schema_version:1,kind,source_record_id,original_at,command,record}`다.
decision의 kind=`representative_receipt`, source_record_id=원래 receipt_id,
record=원래 대표 receipt다. completion의 kind=`completion`,
source_record_id=`completion:`+request_id, record=원래 completion2다.
재시도 시 현재 시각으로 original_at을 바꾸지 않는다.
digest만 넘겨 성공시키지 않는다. JARVIS는 로컬 실제 receipt/completion과 outbox를
함께 커밋하고, transport는 실제 원본과 서명을 다시 대조한 자료만 전송한다.
outbox만 남고 원본이 사라졌으면 증거가 아니다. SB mirror는 JARVIS own stream에 더하지 않는다.

모든 broker/provider I/O는 JARVIS write transaction 밖이다. C1/등록은 readonly
preflight와 외부 ack 뒤 짧은 transaction에서 현재 pin·요청·실제 원본을 다시 확인한다.
finish ack 검증 뒤 local evidence acknowledgement/checkpoint/publication을 함께 커밋한다.
CAS 실패나 응답 유실은 uncertain이며 새 승인·효과를 만들지 않는다.

### retained prefix와 운영 경계

새 kind만 인증된 ready/latest를 받아 반대 store의 검증된 prefix를 채택할 수 있다.
자기 store의 실제 원본 coverage와 retained finish journal을 먼저 재검증한다.
자기 store6필드, epoch, policy/binding, revocation은 같아야 하며, 차이는 SB stream의
단조 전진과 intent prefix뿐이어야 한다. local cache는 이전 값 CAS로만 전진시키고
transaction 안에서도 실제 원본을 다시 확인한다. 같은 높이 다른 root, 자기 사실 소실,
정책/epoch/폐기 변경, unknown prefix는 rebase가 아니다.
기존 TEST_ONLY_memory의 완전 동일 read와 원래 opaque intent vector는 바꾸지 않는다.
네 번째 freshness 메서드나 새 wire proof 필드를 만들지 않는다.

업무 정본은 SB 회사 DB지만 같은 DB hash chain만으로 rollback을 막았다고 주장하지 않는다.
복원 제외 witness와 보호 TPM2 NV_EXTEND의 live Name/value·연속 prefix를 검증해야 한다.
migration은 bootstrap/ready가 아니다. 운영 registry·NV 보호·독립 pin·이행 inventory와
별도 활성화 승인이 검증되지 않으면 운영은 계속 unconfigured다.
일반 restore/re-enrollment engine, 외부 CRM/메일/캘린더 effect adapter는 이 확장에 없다.

## 8. 내부 자동 정책 receipt와 공개 시험 metadata

자동 처리는 SB가 source/provenance·typed span·고정 positive allowlist·보호 veto를 검증한다.
금액·계약·세금·외부 효과·고객 삭제·혼합/모호함은 human_required이며 기존 passkey 경로다.
JARVIS는 본문을 읽거나 정책 signer를 갖지 않고 별도 scope의 bounded trigger만 보낸다.

auto command는 정확히 `{schema_version:1,action:"company.internal.record",request_id,
scope,candidate_id,content_digest,policy_digest,assessment_digest,record_kind}`다.
`auto_request_id="company-auto:v1:"+hex(H(D("second-brain/company-auto/v1")+
C({scope,candidate_id,content_digest,policy_digest})))`, request_id/nonce는 이 ID다.
command_digest는 `H(C(auto_command))`다. operation ID에 epoch/actor/재시도 번호를 넣지 않는다.

정책 receipt는 schema_version=1, auto_request_id, scope, candidate_id, content_digest,
source_event_id, policy_version/digest, assessment_digest, command_digest,
allowed_operations=["accept","complete","mark_processed"], issuer_principal_id,
issued_at, expires_at, nonce, signature다. TTL은5분이며 별도
`principal:company-internal-automation`/purpose=`policy_auto` key만 사용한다.
Pure Ed25519 서명 대상은
`D("second-brain/company-policy-auto/v1")+C(unsigned_policy_receipt)`다.
이 receipt는 대표 approval이 아니며 기존 human parser가 받아서는 안 된다.
이미 human claim/outbox가 있는 후보를 자동 경로로 갈아타거나 공개 wire에 내부 permit을 넣지 않는다.

공개 fixture의 `db_provider_extension`은 새 config/actor ownership/prefix/outer envelope와
별도 TEST_ONLY progress·policy key의 crypto vector다. 기존 모든 root 값과 canonical/
signature vector는 보존한다. 이 metadata는 회사 명령·서명 대상의 추가 필드가 아니다.
예시 policy digest·assessment는 protocol 시험일 뿐 등록된 정책/실제 SQL 효과의 증거가 아니며,
어느 TEST_ONLY key/config도 운영 registry/credential로 설치하지 않는다.

### JARVIS bounded 실행과 일일 보고

dashboard의 operator-only `--company-internal-config PATH`는 기본 미지정/비활성이다.
closed 설정은 `{schema_version:1,enabled:false}` 또는
`{schema_version:1,enabled:true,activation_cutoff,report_client_config_file,
auto_client_config_file?,handoff_client_config_file?}`다. auto를 설정하면 기존 human
handoff client도 필수다. 파일은0700 private dir의0600 operator credential이며 요청이나
환경 변수가 경로·정책·scope를 선택하지 않는다. 운영 활성화는 별도 승인 범위다.

이미 실행 중인 dashboard의 tick에서 scope당 분당 최대1회 고정 `{limit:100}` 평가와
metadata-only handoff100건을 요청한다. SB가 human_required만 기존 handoff로 분류한다.
JARVIS는 정책 signer나 대표 receipt를 만들지 않는다. 실패한 평가가 보고 읽기를 막거나
알림 재시도가 업무 효과를 다시 실행하지 않는다. 종료는 진행 중인 bounded 작업을 drain한다.

processor broker의 optional `auto_config_file`은 고정
`auto-internal --config PATH`다. operation=`auto_process_internal`,
purpose=`company_internal_auto_trigger`이며 policy_auto wire capability가 아니다.
handoff broker의 optional `report_config_file`은 고정 `auto-report --config PATH`다.
operation=`read_auto_report`, purpose=`company_memory_auto_report`이며 네 인수
`{from_global_sequence,to_global_sequence,limit,cursor}`만 허용한다. limit은1~100이다.
두 scope 모두 별도 progress principal 서명과 기존 company-memory 두 domain을 쓴다.

SB의 실제 report는 정수 epoch/head_sequence, 원래 publication cutoff와 body-free
assessment를 반환한다. 첫 page에서 head를 고정하고 다음 page의 epoch/실제 cutoff/head가
바뀌면 전체 발행을 거절한다. 지연 tick/catchup은 고정 읽기 endpoint로 마감 이전 최대
sequence를 이진 탐색한다(최대53회, 전체 read budget10초). 18:00 이후 publication을
전날 보고에 섞거나 다음 날 cursor에서 건너뛰지 않는다. page100, report JSON2MiB 미만이며
본문·연락처 값·금액·비밀 필드가 들어온 응답은 보관하지 않는다.

18:00 KST 이전에는 당일 보고0건, 경계에서1건이다. 시작 시 최신 누락 일자만 catch-up하며
이미 발행한 scope/date는 provider 재조회 없이 원래 보고를 반환한다. PK와 immutable digest가
동시 발행/다른 본문 충돌을 막고 report와 mac intent는 같은 transaction에서 연결된다.
완료는 내부3종의 processed_complete와 원래 receipt/처리 시각이 모두 있어야 한다.
human_required·충돌·미확정은 별도 집계이며 완료가 아니다.
충돌·모호함은 human_required의 부분 집합으로도 집계해 SB의 원래 aggregate와 일치시킨다.

승인함의 읽기 전용 카드와 `/approvals/company-reports/:reportId`는 metadata만 보여 준다.
회사 notification은 독립 report reference이며 morning recommendation lineage가 아니다.
기존 claim/settle API를 재사용하고 새 타입 capability가 없는 client에는 회사 payload를 주지
않는다. unsupported/미전달은 원래 목록을 남기며 delivered로 표시하지 않는다.

수동 smoke는 구현된 명령
`company-candidates daily-report --date YYYY-MM-DD --company-config PATH --db PATH --json`이다.
명시적 JARVIS DB와 고정 report client 설정을 요구하고 미래 마감은 거절한다.
자동 평가·대표 승인·외부 송신은 이 수동 명령의 효과가 아니다.
